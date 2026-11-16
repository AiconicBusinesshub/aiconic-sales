const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { actionPlan, ABANDONED_TAG, nextCallType, onDailyOutreach } = require("../public/actions");

const LOST_WHAT = "Only after a held Interview or Review call. An intro call alone is never Lost; use Not Qualified or Abandoned.";
const NQ_WHAT = "They do not qualify. Moves them to Not Qualified, cancels the call and stops all messages. If we just couldn't get a booking, use Abandoned.";

function tags(plan) {
  return plan.after.map((a) => a.tag);
}

function labels(plan) {
  return plan.after.map((a) => a.label);
}

test("the Abandoned tag is the single word abandoned", () => {
  assert.equal(ABANDONED_TAG, "abandoned");
});

test("Abandoned sits with Not Qualified on every card that offers them", () => {
  const cards = [
    [{ status: "booked", stage: "✅ Intro Booked" }, "calls"],
    [{ status: "booked", stage: "✅ Interview Booked", stageId: "fbb75036-ca89-43ee-948a-ed9f60d324f8" }, "calls"],
    [{ status: "booked", stage: "✅ Review Booked", stageId: "ae66e02e-8a8a-446d-a26f-85bce067126c" }, "calls"],
    [{ status: "lost", stage: "😞 Lost" }, "pipeline"],
    [{ status: "noshow", stage: "⏳ Sending Intro Reminders" }, "calls"],
    [{ status: "abandoned", stage: "❌ Abandoned" }, "pipeline"],
  ];
  for (const [lead, ctx] of cards) {
    const plan = actionPlan(lead, ctx);
    const got = labels(plan);
    assert.ok(got.includes("Not Qualified"), ctx + " " + lead.stage);
    assert.ok(got.includes("Abandoned"), ctx + " " + lead.stage);
    const abandoned = plan.after.find((a) => a.label === "Abandoned");
    assert.equal(abandoned.tag, "abandoned");
    const nq = plan.after.find((a) => a.label === "Not Qualified");
    assert.equal(nq.what, NQ_WHAT);
  }
});

const CLOSED = ["Baking/Nurturing", "Not Qualified", "Abandoned", "Client Won"];
const CLOSED_WITH_LOST = ["Baking/Nurturing", "Lost", "Not Qualified", "Abandoned", "Client Won"];
const INTRO_TAGS = ["noshow-intro", "booklater-intro", "pending-interview"];

test("a diagnostic card offers only the closing options, never the intro tags", () => {
  const lead = {
    status: "booked",
    stage: "🩺 Diagnostic Call",
    appointment: { title: "Business Diagnostic Call" },
  };
  for (const ctx of ["calls", "pipeline"]) {
    const plan = actionPlan(lead, ctx);
    assert.equal(plan.title, "After the diagnostic call");
    assert.deepEqual(labels(plan), CLOSED);
    for (const tag of INTRO_TAGS) {
      assert.equal(tags(plan).includes(tag), false, ctx + " emitted " + tag);
    }
    assert.equal(plan.after.some((a) => a.needKind), false);
  }
});

test("a diagnostic call title is not filed as an intro by the generic picker", () => {
  const plan = actionPlan({
    status: "survey",
    stage: "Other",
    appointment: { title: "Business Diagnostic Call" },
  }, "pipeline");
  assert.deepEqual(labels(plan), CLOSED);
  for (const tag of INTRO_TAGS) assert.equal(tags(plan).includes(tag), false);
});

test("the next call after a diagnostic is the interview", () => {
  assert.equal(nextCallType({ status: "booked", stage: "🩺 Diagnostic Call" }), "interview");
  assert.equal(nextCallType({ status: "booked", stage: "✅ Intro Booked" }), "interview");
  assert.equal(nextCallType({ status: "booked", stage: "✅ Interview Booked" }), "review");
  assert.equal(nextCallType({ status: "booked", stage: "✅ Review Booked" }), "");
});

test("Daily Outreach includes a diagnostic call in upcoming and in the past 14 days", () => {
  const now = Date.parse("2026-11-14T15:00:00Z");
  const upcoming = {
    status: "booked",
    stage: "🩺 Diagnostic Call",
    name: "Maya Chen",
    appointment: { at: "2026-11-16T17:00:00Z", title: "Business Diagnostic Call" },
  };
  const past = {
    status: "booked",
    stage: "🩺 Diagnostic Call",
    name: "Maya Chen",
    appointment: { at: "2026-11-10T17:00:00Z", title: "Business Diagnostic Call" },
  };
  const tooOld = {
    status: "booked",
    name: "Maya Chen",
    appointment: { at: "2026-10-01T17:00:00Z", title: "Business Diagnostic Call" },
  };
  const other = {
    status: "booked",
    name: "Maya Chen",
    appointment: { at: "2026-11-10T17:00:00Z", title: "Coffee chat" },
  };
  assert.equal(onDailyOutreach(upcoming, "upcoming", now), true);
  assert.equal(onDailyOutreach(past, "upcoming", now), false);
  assert.equal(onDailyOutreach(past, "past", now), true);
  assert.equal(onDailyOutreach({ ...past, callTitle: "Business Diagnostic Call", appointment: null, callAt: past.appointment.at }, "past", now), true);
  assert.equal(onDailyOutreach(tooOld, "past", now), false);
  assert.equal(onDailyOutreach(other, "past", now), false);
  assert.equal(onDailyOutreach({ status: "other", name: "Maya Chen", appointment: upcoming.appointment }, "upcoming", now), false);
});

test("Abandoned and Lost buttons describe the two different endings", () => {
  const plan = actionPlan({ status: "booked", stage: "✅ Interview Booked", stageId: "fbb75036-ca89-43ee-948a-ed9f60d324f8" }, "calls");
  const abandoned = plan.after.find((a) => a.label === "Abandoned");
  const lost = plan.after.find((a) => a.label === "Lost");
  assert.equal(abandoned.tag, "abandoned");
  assert.match(abandoned.what, /tried everything/i);
  assert.match(abandoned.what, /funnel/i);
  assert.equal(lost.tag, "lost");
  assert.equal(lost.what, LOST_WHAT);
});

test("a booked intro still tags the intro-specific outcomes and does not offer Lost", () => {
  const plan = actionPlan({ status: "booked", stage: "✅ Intro Booked" }, "calls");
  assert.deepEqual(tags(plan).slice(0, 3), ["noshow-intro", "booklater-intro", "pending-interview"]);
  assert.ok(tags(plan).includes("abandoned"));
  assert.ok(tags(plan).includes("not-qualified"));
  assert.equal(tags(plan).includes("lost"), false);
  assert.deepEqual(labels(plan).slice(-4), CLOSED);
});

test("Lost is offered on the four Interview and Review stages, including from the Pipeline tab", () => {
  const stages = [
    { status: "bookinginterview", stage: "⏳ Sending Interview Reminders", stageId: "52d0b1ab-88b1-452b-8966-88e269e9ec75" },
    { status: "booked", stage: "✅ Interview Booked", stageId: "fbb75036-ca89-43ee-948a-ed9f60d324f8" },
    { status: "bookingreview", stage: "⏳ Sending Review Reminders", stageId: "948a6e28-7669-402e-b632-d84b452ebac0" },
    { status: "booked", stage: "✅ Review Booked", stageId: "ae66e02e-8a8a-446d-a26f-85bce067126c" },
  ];
  for (const lead of stages) {
    for (const ctx of ["calls", "pipeline"]) {
      const plan = actionPlan(lead, ctx);
      assert.ok(labels(plan).includes("Lost"), ctx + " " + lead.stage);
      assert.equal(plan.after.find((a) => a.label === "Lost").what, LOST_WHAT);
    }
  }
  // The stage id is enough on its own, even if the live name was renamed.
  const byId = actionPlan({ status: "booked", stage: "Renamed", stageId: "fbb75036-ca89-43ee-948a-ed9f60d324f8" }, "pipeline");
  assert.deepEqual(labels(byId).slice(-5), CLOSED_WITH_LOST);
  // A name that still says Interview Booked matches when the id is absent.
  const byName = actionPlan({ status: "booked", stage: "Interview Booked" }, "calls");
  assert.ok(labels(byName).includes("Lost"));
});

test("Lost is removed from intro, diagnostic, generic, and other Pipeline-tab cards", () => {
  const cards = [
    [{ status: "booked", stage: "✅ Intro Booked", stageId: "31264788-1dc2-4f34-abcc-191b0cf0d856" }, "calls"],
    [{ status: "booked", stage: "✅ Intro Booked", stageId: "31264788-1dc2-4f34-abcc-191b0cf0d856" }, "pipeline"],
    [{ status: "booked", stage: "🩺 Diagnostic Call", stageId: "fe7607be-16b4-466d-9a19-b387a96a3ea1", appointment: { title: "Business Diagnostic Call" } }, "calls"],
    [{ status: "booked", stage: "🩺 Diagnostic Call", appointment: { title: "Business Diagnostic Call" } }, "pipeline"],
    [{ status: "noshow", stage: "⏳ Sending Intro Reminders" }, "calls"],
    [{ status: "noshow", stage: "⏳ Sending Intro Reminders" }, "pipeline"],
    [{ status: "lost", stage: "😞 Lost" }, "pipeline"],
    [{ status: "abandoned", stage: "❌ Abandoned" }, "pipeline"],
    [{ status: "survey", stage: "📑 Survey Qualified" }, "pipeline"],
    [{ status: "baking", stage: "🍿 Baking/Nurturing" }, "calls"],
    [{ status: "other", stage: "Other" }, "pipeline"],
  ];
  for (const [lead, ctx] of cards) {
    const got = labels(actionPlan(lead, ctx));
    assert.equal(got.includes("Lost"), false, ctx + " " + lead.stage);
    assert.ok(got.includes("Not Qualified"), ctx + " " + lead.stage);
    assert.ok(got.includes("Abandoned"), ctx + " " + lead.stage);
  }
});

test("Lost is offered when tags or a past call show a held Interview or Review", () => {
  const past = "2020-05-01T15:00:00Z";
  const future = "2099-05-01T15:00:00Z";
  // Past appointment title already stored from conversation activity or the calendar fallback.
  assert.ok(labels(actionPlan({
    status: "baking",
    stage: "🍿 Baking/Nurturing",
    callTitle: "Interview",
    callAt: past,
  }, "calls")).includes("Lost"));
  assert.ok(labels(actionPlan({
    status: "baking",
    stage: "🍿 Baking/Nurturing",
    appointment: { title: "Review Call", at: past },
  }, "pipeline")).includes("Lost"));
  // pending-review is applied only after the interview was held.
  assert.ok(labels(actionPlan({
    status: "baking",
    stage: "🍿 Baking/Nurturing",
    tags: ["pending-review"],
  }, "pipeline")).includes("Lost"));
  // A future booking has not been held.
  assert.equal(labels(actionPlan({
    status: "baking",
    stage: "🍿 Baking/Nurturing",
    appointment: { title: "Interview", at: future },
  }, "calls")).includes("Lost"), false);
  // These tags record a call that did not happen.
  assert.equal(labels(actionPlan({
    status: "baking",
    stage: "🍿 Baking/Nurturing",
    tags: ["pending-interview", "noshow-interview", "booklater-interview", "noshow-review", "booklater-review"],
  }, "calls")).includes("Lost"), false);
  // An intro card stays Not Qualified / Abandoned even if a review tag is also present.
  assert.equal(labels(actionPlan({
    status: "booked",
    stage: "✅ Intro Booked",
    tags: ["pending-review"],
    callTitle: "Interview",
    callAt: past,
  }, "calls")).includes("Lost"), false);
  // A diagnostic card never offers Lost, even with an interview title on the record.
  assert.equal(labels(actionPlan({
    status: "booked",
    stage: "🩺 Diagnostic Call",
    appointment: { title: "Business Diagnostic Call", at: past },
    callTitle: "Interview",
    callAt: past,
  }, "calls")).includes("Lost"), false);
});

test("the approved Lost and Not Qualified sentences replace the old copy everywhere", () => {
  const files = ["public/actions.js", "public/app.js", "public/resources.html"];
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.ok(text.includes(LOST_WHAT), file);
    assert.equal(text.includes("never had the opportunity to win"), false, file);
    assert.equal(text.includes("Not a fit or the call is off"), false, file);
  }
  const actions = fs.readFileSync(path.join(__dirname, "..", "public/actions.js"), "utf8");
  assert.ok(actions.includes(NQ_WHAT));
});
