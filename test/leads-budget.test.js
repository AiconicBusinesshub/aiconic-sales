const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ALL_STAGES } = require("../lib/evaluate");
const {
  pastHistoryCandidates,
  takePastHistory,
  mapWithBudget,
  createSlotPacer,
  buildLeadsResponse,
  PAST_HISTORY_CAP,
  PAST_HISTORY_CONCURRENCY,
  PAST_HISTORY_BUDGET_MS,
  HISTORY_RATE_PER_SEC,
  REQUEST_DEADLINE_MS,
  RESPONSE_BACKSTOP_MS,
} = require("../api/leads");

const NOW = Date.parse("2026-11-16T12:00:00.000Z");

function stage(re) {
  const found = ALL_STAGES.find((s) => re.test(s.name));
  assert.ok(found, String(re));
  return found;
}

const ABANDONED = stage(/Abandoned/);
const LOST = stage(/\bLost\b/);
const BAKING = stage(/Baking/);
const NOT_QUALIFIED = stage(/Not Qualified/);
const CLIENT_WON = stage(/Client Won/);
const SURVEY = stage(/Survey/);
const BOOKED = stage(/Intro Booked/);

function row(id, status, updatedAt, lastStageChangeAt, appointmentAt) {
  return {
    status,
    o: {
      id,
      updatedAt: updatedAt || undefined,
      lastStageChangeAt: lastStageChangeAt || undefined,
      calenders: appointmentAt ? [{ startTime: appointmentAt }] : undefined,
    },
  };
}

function opp(id, stageRow, extra = {}) {
  return {
    id,
    name: extra.name || id,
    contactId: "c-" + id,
    pipelineStageId: stageRow.id,
    updatedAt: extra.updatedAt,
    lastStageChangeAt: extra.lastStageChangeAt,
    calenders: extra.at ? [{ startTime: extra.at, selectedTimezone: "UTC" }] : undefined,
    relations: [{ fullName: extra.name || id, recordId: "c-" + id, tags: extra.tags }],
  };
}

function harness(opps, hooks = {}) {
  const comms = [];
  const appointments = [];
  return {
    comms,
    appointments,
    deps: {
      searchOpportunities: hooks.searchOpportunities || (async () => opps),
      getUsers: async () => ({}),
      getPipeline: async () => ALL_STAGES,
      getContact: hooks.getContact || (async () => ({ phone: "+15551212", email: "a@b.c", tags: ["review-booked"] })),
      getComms: hooks.getComms || (async (id) => {
        comms.push(id);
        return { lastEmail: null, lastSms: null, appointment: null, rescheduleLink: null };
      }),
      getContactAppointment: hooks.getContactAppointment || (async (id) => {
        appointments.push(id);
        return null;
      }),
    },
  };
}

test("the history budget stays inside the function limit and under the rate cap", () => {
  assert.ok(PAST_HISTORY_CAP >= 10 && PAST_HISTORY_CAP <= 50);
  assert.ok(PAST_HISTORY_CONCURRENCY > 4 && PAST_HISTORY_CONCURRENCY <= 10);
  assert.ok(HISTORY_RATE_PER_SEC >= 1 && HISTORY_RATE_PER_SEC <= 10);
  assert.ok(PAST_HISTORY_BUDGET_MS >= 1000);
  assert.ok(PAST_HISTORY_BUDGET_MS < REQUEST_DEADLINE_MS);
  assert.ok(REQUEST_DEADLINE_MS < RESPONSE_BACKSTOP_MS);
  assert.ok(RESPONSE_BACKSTOP_MS <= 50000);
  assert.ok(RESPONSE_BACKSTOP_MS < 60000);
});

test("past history is only the moved-on stages, most recent updatedAt first", () => {
  const tagged = [
    row("old-touch", "abandoned", "2026-11-01T00:00:00.000Z", "2026-11-16T11:00:00.000Z"),
    row("newest", "lost", "2026-11-16T10:00:00.000Z"),
    row("survey", "survey", "2026-11-16T11:30:00.000Z"),
    row("has-appt", "abandoned", "2026-11-16T11:45:00.000Z", null, "2026-11-12T15:00:00.000Z"),
    row("stale", "notqualified", "2026-10-01T00:00:00.000Z"),
    row("second", "baking", "2026-11-15T00:00:00.000Z"),
    row("undated", "clientwon"),
    row("old-name", "neverrescheduled", "2026-11-14T00:00:00.000Z"),
  ];
  const candidates = pastHistoryCandidates(tagged, NOW).map((t) => t.o.id);
  assert.deepEqual(candidates, ["old-touch", "newest", "second", "undated", "old-name"]);
  assert.equal(candidates.includes("survey"), false);
  assert.equal(candidates.includes("has-appt"), false);
  assert.equal(candidates.includes("stale"), false);
  const chosen = takePastHistory(pastHistoryCandidates(tagged, NOW), 2).map((t) => t.o.id);
  assert.deepEqual(chosen, ["newest", "second"]);
});

test("mapWithBudget does not start work after the deadline", async () => {
  const expired = await mapWithBudget([1, 2, 3], 2, async () => {
    throw new Error("should not run");
  }, { deadline: Date.now() - 5, onSkip: (n) => "skip-" + n });
  assert.deepEqual(expired.results, ["skip-1", "skip-2", "skip-3"]);
  assert.equal(expired.skipped, 3);

  const open = await mapWithBudget([1, 2, 3], 2, async (n) => n * 2, {
    deadline: Date.now() + 2000,
    onSkip: () => "no",
  });
  assert.deepEqual(open.results, [2, 4, 6]);
  assert.equal(open.skipped, 0);

  let started = 0;
  const mid = await mapWithBudget([1, 2, 3, 4], 1, async (n) => {
    started += 1;
    await new Promise((r) => setTimeout(r, 40));
    return n;
  }, { deadline: Date.now() + 20, onSkip: () => "x" });
  assert.ok(started <= 1);
  assert.equal(mid.results.length, 4);
  assert.ok(mid.results.includes("x"));
  assert.equal(mid.skipped, mid.results.filter((x) => x === "x").length);
});

test("the slot pacer spaces history reads under 10 per second", async () => {
  const wait = createSlotPacer(10);
  const start = Date.now();
  await wait();
  await wait();
  await wait();
  assert.ok(Date.now() - start >= 180);
});

test("only the capped moved-on leads get a history read", async () => {
  const opps = [
    opp("survey", SURVEY, { updatedAt: "2026-11-16T11:30:00.000Z" }),
    opp("newest", LOST, { updatedAt: "2026-11-16T10:00:00.000Z", tags: ["interview-held", { name: "vip" }] }),
    opp("second", ABANDONED, { updatedAt: "2026-11-16T09:00:00.000Z" }),
    opp("third", BAKING, { updatedAt: "2026-11-16T08:00:00.000Z" }),
    opp("booked-card", BOOKED, { updatedAt: "2026-11-16T12:00:00.000Z" }),
    opp("already", NOT_QUALIFIED, { updatedAt: "2026-11-16T11:00:00.000Z", at: "2026-11-14T15:00:00.000Z" }),
    opp("stale", CLIENT_WON, { updatedAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const h = harness(opps, {
    getComms: async (id) => {
      h.comms.push(id);
      if (id === "c-newest" || id === "c-second") {
        return {
          lastEmail: null,
          lastSms: null,
          appointment: { at: "2026-11-12T15:00:00.000Z", title: "Intro Call" },
          rescheduleLink: null,
        };
      }
      return { lastEmail: null, lastSms: null, appointment: null, rescheduleLink: null };
    },
  });
  const result = await buildLeadsResponse(h.deps, {
    now: NOW,
    historyCap: 2,
    deadlineMs: 5000,
    historyBudgetMs: 5000,
    historyRatePerSecond: 1000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, undefined);
  assert.equal(result.body.leads.length, opps.length);
  assert.deepEqual(h.comms.slice().sort(), ["c-booked-card", "c-newest", "c-second"].sort());
  assert.deepEqual(h.appointments, []);
  const byId = Object.fromEntries(result.body.leads.map((l) => [l.id, l]));
  assert.equal(byId.newest.callAt, "2026-11-12T15:00:00.000Z");
  assert.equal(byId.newest.callTitle, "Intro Call");
  assert.equal(byId.second.callAt, "2026-11-12T15:00:00.000Z");
  assert.equal(byId.third.callAt, undefined);
  assert.equal(byId.survey.callAt, undefined);
  assert.equal(byId.stale.callAt, undefined);
  assert.equal(byId.already.appointment.at, "2026-11-14T15:00:00.000Z");
  assert.equal(byId["booked-card"].email, "a@b.c");
  assert.deepEqual(byId["booked-card"].tags, ["review-booked"]);
  assert.deepEqual(byId.newest.tags, ["interview-held", "vip"]);
});

test("a spent history budget returns the moved-on leads without a call date", async () => {
  const opps = [
    opp("moved", ABANDONED, { updatedAt: "2026-11-16T10:00:00.000Z" }),
    opp("booked-card", BOOKED, { updatedAt: "2026-11-16T12:00:00.000Z" }),
  ];
  const h = harness(opps);
  const result = await buildLeadsResponse(h.deps, {
    now: NOW,
    historyCap: 10,
    deadlineMs: 5000,
    historyBudgetMs: 0,
    historyRatePerSecond: 1000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.leads.length, 2);
  assert.deepEqual(h.comms, ["c-booked-card"]);
  assert.deepEqual(h.appointments, []);
  const moved = result.body.leads.find((l) => l.id === "moved");
  assert.equal(moved.callAt, undefined);
  assert.equal(moved.status, "abandoned");
});

test("a missing history appointment falls back to the contact calendar", async () => {
  const opps = [opp("moved", LOST, { updatedAt: "2026-11-16T10:00:00.000Z" })];
  const h = harness(opps, {
    getContactAppointment: async (id) => {
      h.appointments.push(id);
      return { at: "2026-11-11T16:00:00.000Z", title: "Business Diagnostic Call" };
    },
  });
  const result = await buildLeadsResponse(h.deps, {
    now: NOW,
    historyCap: 5,
    deadlineMs: 5000,
    historyBudgetMs: 5000,
    historyRatePerSecond: 1000,
  });
  assert.deepEqual(h.comms, ["c-moved"]);
  assert.deepEqual(h.appointments, ["c-moved"]);
  const lead = result.body.leads[0];
  assert.equal(lead.callAt, "2026-11-11T16:00:00.000Z");
  assert.equal(lead.callTitle, "Business Diagnostic Call");
});

test("a history read that throws still returns the lead", async () => {
  const opps = [opp("moved", ABANDONED, { updatedAt: "2026-11-16T10:00:00.000Z" })];
  const h = harness(opps, {
    getComms: async (id) => {
      h.comms.push(id);
      throw new Error("GHL 429 on /conversations/search");
    },
    getContactAppointment: async (id) => {
      h.appointments.push(id);
      throw new Error("down");
    },
  });
  const result = await buildLeadsResponse(h.deps, {
    now: NOW,
    deadlineMs: 5000,
    historyBudgetMs: 5000,
    historyRatePerSecond: 1000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.leads.length, 1);
  assert.equal(result.body.leads[0].callAt, undefined);
  assert.deepEqual(h.comms, ["c-moved"]);
  assert.deepEqual(h.appointments, ["c-moved"]);
});

test("a pipeline read that overruns the deadline returns JSON", async () => {
  let settled = false;
  const h = harness([], {
    searchOpportunities: () => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error("late failure")), 250);
      setTimeout(() => { settled = true; resolve([]); }, 400);
    }),
  });
  const result = await buildLeadsResponse(h.deps, { deadlineMs: 40 });
  assert.equal(result.status, 503);
  assert.equal(typeof result.body.error, "string");
  assert.match(result.body.error, /too long/i);
  assert.deepEqual(result.body.leads, []);
  assert.equal(result.body.partial, true);
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(settled, false);
});

test("work still in flight when the deadline passes is returned as JSON", async () => {
  const opps = [
    opp("b1", BOOKED, { updatedAt: "2026-11-16T12:00:00.000Z" }),
    opp("b2", BOOKED, { updatedAt: "2026-11-16T11:00:00.000Z" }),
    opp("moved", ABANDONED, { updatedAt: "2026-11-16T10:00:00.000Z" }),
  ];
  const h = harness(opps, {
    getComms: async (id) => {
      h.comms.push(id);
      await new Promise((r) => setTimeout(r, 80));
      return { lastEmail: null, lastSms: null, appointment: { at: "2026-11-16T18:00:00.000Z", title: "Intro Call" }, rescheduleLink: null };
    },
  });
  const result = await buildLeadsResponse(h.deps, {
    now: NOW,
    deadlineMs: 40,
    historyBudgetMs: 5000,
    historyCap: 10,
    prepConcurrency: 1,
    historyRatePerSecond: 1000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.partial, true);
  assert.deepEqual(result.body.leads.map((l) => l.id).sort(), ["b1", "b2", "moved"]);
  assert.equal(h.comms.includes("c-moved"), false);
});
