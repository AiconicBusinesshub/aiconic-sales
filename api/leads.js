// GET /api/leads
// Reads the live pipeline from GoHighLevel. Returns the live stage list (in the
// exact order they are in the CRM) and every open lead, each tagged with the
// stage it is in, what we already sent, the call-prep links, and any flags.
// The browser never sees the GHL token.
//
// The heavy per-lead reads (contact + conversation history) only run for the
// stages a rep actually works from a card: the booked calls and the follow-up
// lanes. Reference stages are built from the opportunity itself. Stages a
// call can be moved into still show on the Past list, so those get a capped,
// time-boxed read of the call date and nothing more.

const { requireUser } = require("../lib/auth");
const {
  searchOpportunities,
  getPipeline,
  getUsers,
  getContact,
  getComms,
  getContactAppointment,
  LOCATION_ID,
} = require("../lib/ghl");
const { RULE, ALL_STAGES, statusFromStageName, callType, autoFromStageName, evaluate } = require("../lib/evaluate");

// Fixed links, same as the GoHighLevel call-prep email. Change here if they move.
const LINKS = {
  hubBase: "https://app.theiconicceo.com/v2/location",
  conversify: "https://conversifi.io/dashboard",
  script: "https://docs.google.com/document/d/1CXYZJrlmfJxLXVL10Lg04sGHbqfFgve2FKqv0MyeWW8/edit",
  interviewQuestions: "https://docs.google.com/document/d/1obuxJO9o69lKt3i52-iLLtScCgm1vzL9rdluUESggfY/edit",
  interviewCarlos: "https://app.aiconichub.ai/leads-engine-interview",
  bookLkdn: "https://app.aiconichub.ai/leads-engine-lkdn",
  bookDefault: "https://app.aiconichub.ai/leads-engine",
};

// The stages a rep works from a card, so only these get the heavy CRM reads.
// Diagnostic Call classifies as "booked", so it gets the same contact, email
// and SMS reads as intro, interview and review.
const NEEDS_PREP = new Set(["booked", "noshow", "rescheduling", "bookinginterview", "bookingreview", "cancelled"]);

// Stages a lead can be moved to after a call. Their appointment date is read too
// (only for leads touched in the last 15 days), so the Daily Outreach Past view
// can show a call that has already been moved on.
// neverrescheduled is the old name of Abandoned. Live names now classify as
// abandoned. The old status stays in this set so a past call date is still read.
const DATED_AFTER_CALL = new Set(["baking", "notqualified", "lost", "abandoned", "clientwon", "neverrescheduled"]);
const PAST_WINDOW_MS = 15 * 24 * 3600 * 1000;
function touchedRecently(o, now = Date.now()) {
  const ts = [o.lastStageChangeAt, o.lastStatusChangeAt, o.updatedAt]
    .map((x) => (x ? Date.parse(x) : NaN))
    .filter((x) => Number.isFinite(x));
  if (!ts.length) return true; // no date to judge by, so read it to be safe
  return Math.max(...ts) >= now - PAST_WINDOW_MS;
}

// A pipeline cleanup can touch a large batch of old cards at once. Reading
// call history for every one of them (two or three GoHighLevel calls each,
// a few at a time) runs past the function limit, and Vercel then answers
// with an HTML error page. The Past list only needs a date for the stages a
// call is moved into, and only for the cards updated most recently.
const PAST_HISTORY_CAP = 40;
// Eight at a time, up from four. Each worker holds one GoHighLevel call.
const PAST_HISTORY_CONCURRENCY = 8;
// Starts are spaced under GoHighLevel's ~10 requests/second limit.
const HISTORY_RATE_PER_SEC = 8;
// Stop starting history reads after this. Leads still waiting come back
// without a call date, which is what the Past list already does when it
// has no date.
const PAST_HISTORY_BUDGET_MS = 12000;
// Stop starting new reads after this, and answer with the leads already built.
const REQUEST_DEADLINE_MS = 25000;
// If a call is still hung after that, answer anyway. This stays under the
// 60s platform limit, so the browser gets JSON instead of an HTML error page.
const RESPONSE_BACKSTOP_MS = 45000;
const PREP_CONCURRENCY = 4;

function opportunityAppointmentAt(o) {
  const cal = (o && o.calenders && o.calenders[0]) || null;
  return (cal && cal.startTime) || null;
}

function updatedAtMs(o) {
  const n = o && o.updatedAt ? Date.parse(o.updatedAt) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Light leads that can still show on Daily Outreach Past. Survey and the
// other reference stages are not in DATED_AFTER_CALL, so they stay light.
// A lead that already has an appointment on the opportunity does not need
// another read.
function pastHistoryCandidates(tagged, now = Date.now()) {
  return (tagged || []).filter((t) => {
    if (!t || !t.o || !DATED_AFTER_CALL.has(t.status)) return false;
    if (opportunityAppointmentAt(t.o)) return false;
    return touchedRecently(t.o, now);
  });
}

// Most recently updated first. A tie keeps pipeline order.
function takePastHistory(candidates, cap = PAST_HISTORY_CAP) {
  const ranked = (candidates || [])
    .map((t, index) => ({ t, index, updated: updatedAtMs(t.o) }))
    .sort((a, b) => b.updated - a.updated || a.index - b.index);
  const n = Math.max(0, Number.isFinite(Number(cap)) ? Number(cap) : 0);
  return ranked.slice(0, n).map((row) => row.t);
}

// Hands out start-slots so concurrent workers cannot burst past the rate.
function createSlotPacer(perSecond) {
  const gap = 1000 / perSecond;
  let next = 0;
  return function waitSlot() {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + gap;
    const delay = slot - now;
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delay));
  };
}

// `worker` runs with a concurrency cap. After `deadline`, items that have
// not started go through `onSkip` instead, so the batch still finishes.
async function mapWithBudget(items, limit, worker, { deadline, onSkip }) {
  const list = items || [];
  const out = new Array(list.length);
  let skipped = 0;
  if (!list.length) return { results: out, skipped };
  let cursor = 0;
  const workers = Math.min(Math.max(Number(limit) || 1, 1), list.length);
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) return;
      if (Date.now() >= deadline) {
        skipped += 1;
        out[idx] = await onSkip(list[idx], idx);
      } else {
        out[idx] = await worker(list[idx], idx);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()));
  return { results: out, skipped };
}

// The work's value, or { timedOut: true } if the deadline wins. A failure
// that arrives after the deadline has already won does not crash the process.
async function withDeadline(work, deadlineMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, deadlineMs));
  });
  const pending = Promise.resolve()
    .then(work)
    .then((value) => ({ timedOut: false, value }))
    .catch((error) => ({ timedOut: false, error }));
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Work out where the lead really came from, from the opportunity's own
// attribution (the pages and referrers GoHighLevel recorded), not a guess.
function sourceOf(attributions, contact, tags) {
  const attrs = attributions || [];
  const web = attrs.map((a) => (a.pageUrl || "") + " " + (a.url || "") + " " + (a.referrer || "")).join(" ").toLowerCase();
  const channel = (attrs.map((a) => (a.utmSessionSource || "") + " " + (a.medium || "")).join(" ") + " " + ((contact && contact.source) || "") + " " + (tags || []).join(" ")).toLowerCase();
  const social = attrs.some((a) => String(a.utmSessionSource || "").toLowerCase() === "social media");

  if (web.includes("linkedin") || web.includes("lkdn") || channel.includes("linkedin") || channel.includes("lkdn") || social) {
    return { label: "LinkedIn", check: "They came in from LinkedIn. Check their profile and the Conversify conversations." };
  }
  if (channel.includes("email") || channel.includes("cold") || channel.includes("stamina")) {
    return { label: "Email campaign", check: "From our email campaigns. Try to find them on LinkedIn first." };
  }
  if (/https?:\/\//.test(web) || web.includes("apply") || web.includes("survey") || web.includes("schedule") || web.includes("leads-engine") || web.includes("iconicbusinesshub") || web.includes("aiconichub") || web.includes("discovery") || web.includes("connect")) {
    return { label: "Website", check: "They came through our website funnel. Read their survey answers before you dial." };
  }
  return { label: "Source unknown", check: "No clear source on file, so open the contact card to check where they came from." };
}

// Build the /api/leads body. `deps` are the GoHighLevel reads. `options.now`
// is the clock for the 15-day window, so tests can pin it. The deadline is
// real time: when it passes, whatever leads are already in hand are returned.
async function buildLeadsResponse(deps, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : REQUEST_DEADLINE_MS;
  const historyCap = Number.isFinite(options.historyCap) ? options.historyCap : PAST_HISTORY_CAP;
  const historyBudgetMs = Number.isFinite(options.historyBudgetMs) ? options.historyBudgetMs : PAST_HISTORY_BUDGET_MS;
  const historyConcurrency = options.historyConcurrency || PAST_HISTORY_CONCURRENCY;
  const prepConcurrency = options.prepConcurrency || PREP_CONCURRENCY;
  const rate = options.historyRatePerSecond || HISTORY_RATE_PER_SEC;
  const deadline = Date.now() + deadlineMs;
  const waitSlot = createSlotPacer(rate);

  const fetched = await withDeadline(
    () => Promise.all([deps.searchOpportunities(), deps.getUsers(), deps.getPipeline()]),
    Math.max(0, deadline - Date.now()),
  );
  if (fetched.timedOut) {
    return {
      status: 503,
      body: {
        error: "The pipeline took too long to read. Try Refresh.",
        partial: true,
        leads: [],
        stages: [],
        totals: {},
      },
    };
  }
  if (fetched.error) throw fetched.error;
  const [opps, users, livePipeline] = fetched.value;

  // The stage list, live from the CRM (with a fallback if the read failed).
  const pipeline = (livePipeline && livePipeline.length ? livePipeline : ALL_STAGES);
  const stageById = {};
  pipeline.forEach((s) => { stageById[s.id] = s; });
  const stages = pipeline.map((s) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    color: s.color || "",
    auto: autoFromStageName(s.name),
    status: statusFromStageName(s.name),
  }));

  let overrides = {};
  try { overrides = JSON.parse(process.env.REP_NAMES || "{}"); } catch (_) {}

  // Tag every open opportunity with its stage and status.
  const tagged = (opps || []).map((o) => {
    const stageId = o.pipelineStageId;
    const stageName = (stageById[stageId] && stageById[stageId].name) || "Other";
    return { o, stageId, stageName, status: statusFromStageName(stageName) };
  });

  // Build a full lead object. `enrich` carries the contact + comms when we
  // fetched them; when null, the lead is built lightweight from the opp alone.
  function buildLead({ o, stageId, stageName, status }, enrich) {
    const rel = (o.relations && o.relations[0]) || {};
    const contactId = o.contactId || rel.recordId;
    const contact = enrich ? enrich.contact : null;
    const comms = (enrich && enrich.comms) || { lastEmail: null, lastSms: null, appointment: null, rescheduleLink: null };
    const commsOk = enrich ? enrich.commsOk : true;

    let phone = rel.phone || "";
    let email = rel.email || "";
    let tags = rel.tags || [];
    let emailBounced = false;
    let timezone = "";
    if (contact) {
      phone = contact.phone || phone;
      email = contact.email || email;
      tags = contact.tags || tags;
      timezone = contact.timezone || "";
      const em = contact.dndSettings && contact.dndSettings.Email;
      emailBounced = Boolean(em && em.status === "active");
    }

    const cal = (o.calenders && o.calenders[0]) || null;
    const apptAt = (cal && cal.startTime) || (comms.appointment && comms.appointment.at) || null;
    const apptTz = (cal && cal.selectedTimezone) || timezone || "";
    const appointment = apptAt
      ? { at: apptAt, title: (comms.appointment && comms.appointment.title) || "" }
      : comms.appointment;

    const src = sourceOf(o.attributions, contact, tags);
    const smsStatus = comms.lastSms ? comms.lastSms.status : null;
    const hasPhone = Boolean(phone);
    // Flags only matter on the stages a rep reaches out from. Reference stages
    // are not flagged, so the board stays quiet.
    const v = enrich ? evaluate({ hasPhone, smsStatus, emailBounced }) : { flagged: false, flags: [], primaryFlag: null, channels: hasPhone ? ["sms", "linkedin", "email"] : ["linkedin", "email"] };

    const repId = o.assignedTo || "unassigned";
    const repName = overrides[repId] || users[repId] || "Unassigned";
    const generalBooking = src.label === "LinkedIn" ? LINKS.bookLkdn : LINKS.bookDefault;
    const rebook = comms.rescheduleLink || generalBooking;

    return {
      id: o.id,
      contactId,
      status,
      name: o.name || rel.fullName || rel.contactName || "Unknown",
      company: rel.companyName || "",
      email,
      phone,
      timezone: apptTz,
      stage: stageName,
      stageId,
      callType: callType(stageName),
      repId,
      repName,
      source: src.label,
      sourceCheck: src.check,
      appointment,
      lastEmail: comms.lastEmail,
      lastSms: comms.lastSms,
      commsOk,
      rebookLink: rebook,
      rebookIsPersonal: Boolean(comms.rescheduleLink),
      bookingLink: generalBooking,
      links: {
        contact: `${LINKS.hubBase}/${LOCATION_ID}/contacts/detail/${contactId}`,
        pipeline: `${LINKS.hubBase}/${LOCATION_ID}/opportunities`,
        conversify: LINKS.conversify,
        script: LINKS.script,
        interviewQuestions: LINKS.interviewQuestions,
        interviewBooking: LINKS.interviewCarlos,
        interviewCarlos: LINKS.interviewCarlos,
      },
      flagged: v.flagged,
      flags: v.flags,
      primaryFlag: v.primaryFlag,
      channels: v.channels,
      // Contact tags when this lead was enriched, otherwise the opportunity
      // relation tags already on the pipeline read. The Lost button uses
      // them to recognise a held Interview or Review. See public/actions.js.
      tags: (Array.isArray(tags) ? tags : []).map((t) => String((t && t.name) || t || "")).filter(Boolean),
    };
  }

  // Heavy reads only for the stages a rep works from a card.
  const prep = tagged.filter((t) => NEEDS_PREP.has(t.status));
  const light = tagged.filter((t) => !NEEDS_PREP.has(t.status));

  let degraded = false;
  const prepRun = await mapWithBudget(prep, prepConcurrency, async (t) => {
    if (Date.now() >= deadline) { degraded = true; return buildLead(t, null); }
    const contactId = t.o.contactId || (t.o.relations && t.o.relations[0] && t.o.relations[0].recordId);
    let contact = null;
    try { contact = await deps.getContact(contactId); } catch (_) {}
    if (Date.now() >= deadline) {
      degraded = true;
      return buildLead(t, { contact, comms: { lastEmail: null, lastSms: null, appointment: null, rescheduleLink: null }, commsOk: false });
    }
    let comms = { lastEmail: null, lastSms: null, appointment: null, rescheduleLink: null };
    let commsOk = true;
    try { comms = await deps.getComms(contactId); } catch (_) { commsOk = false; }
    return buildLead(t, { contact, comms, commsOk });
  }, { deadline, onSkip: (t) => buildLead(t, null) });

  // Moved-on leads stay lightweight. The most recently updated ones, and
  // only the stages that show on the Past list, get a call date from history
  // while the budget lasts. callAt is only used on that list.
  const historyDeadline = Math.min(Date.now() + historyBudgetMs, deadline);
  const lightBuilt = light.map((t) => ({ t, lead: buildLead(t, null) }));
  const chosen = takePastHistory(pastHistoryCandidates(light, now), historyCap);
  const chosenIds = new Set(chosen.map((t) => t.o.id));
  const queue = lightBuilt.filter((row) => chosenIds.has(row.t.o.id));
  let cutShort = false;
  async function readMovedCall(lead) {
    if (Date.now() >= historyDeadline) { cutShort = true; return lead; }
    let appt = null;
    try {
      await waitSlot();
      if (Date.now() >= historyDeadline) { cutShort = true; return lead; }
      const c = await deps.getComms(lead.contactId);
      appt = c && c.appointment;
    } catch (_) {}
    // Fallback: the contact's own calendar events, when the history has none.
    if (!(appt && appt.at)) {
      if (Date.now() >= historyDeadline) { cutShort = true; return lead; }
      try {
        await waitSlot();
        if (Date.now() >= historyDeadline) { cutShort = true; return lead; }
        appt = await deps.getContactAppointment(lead.contactId);
      } catch (_) {}
    }
    if (appt && appt.at) {
      lead.callAt = appt.at;
      if (appt.title) lead.callTitle = appt.title;
    }
    return lead;
  }
  const historyRun = await mapWithBudget(queue, historyConcurrency, (row) => readMovedCall(row.lead), {
    deadline: historyDeadline,
    onSkip: (row) => row.lead,
  });
  const enriched = new Map(historyRun.results.map((lead) => [lead.id, lead]));
  const lightLeads = lightBuilt.map((row) => enriched.get(row.lead.id) || row.lead);
  const leads = prepRun.results.concat(lightLeads);

  // Counts per status, for anyone who wants a quick total.
  const totals = {};
  leads.forEach((l) => { totals[l.status] = (totals[l.status] || 0) + 1; });
  totals.flagged = leads.filter((l) => l.flagged).length;

  const body = {
    generatedAt: new Date().toISOString(),
    rule: RULE,
    stages,
    totals,
    leads,
  };
  if (prepRun.skipped > 0 || historyRun.skipped > 0 || cutShort || degraded) body.partial = true;
  return { status: 200, body };
}

async function handler(req, res) {
  const who = await requireUser(req, res);
  if (!who) return;
  if (!process.env.GHL_TOKEN || !process.env.GHL_LOCATION_ID) {
    res.status(500).json({ error: "Server is missing GHL_TOKEN or GHL_LOCATION_ID." });
    return;
  }
  try {
    // buildLeadsResponse stops starting work at its own deadline and returns
    // the leads it has. This outer limit is only for a call that never comes
    // back: the response is still JSON, sent before the platform cuts in.
    const raced = await withDeadline(() => buildLeadsResponse({
      searchOpportunities,
      getUsers,
      getPipeline,
      getContact,
      getComms,
      getContactAppointment,
    }), RESPONSE_BACKSTOP_MS);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    if (raced.timedOut) {
      res.status(503).json({
        error: "The pipeline took too long to read. Try Refresh.",
        partial: true,
        leads: [],
        stages: [],
        totals: {},
      });
      return;
    }
    if (raced.error) throw raced.error;
    res.status(raced.value.status).json(raced.value.body);
  } catch (e) {
    if (res.headersSent) return;
    res.status(502).json({ error: String(e.message || e) });
  }
}

// Give Vercel room to read the pipeline plus the per-lead history under load.
// vercel.json sets the same 60s. That file is what the platform actually uses.
module.exports = handler;
module.exports.config = { maxDuration: 60 };
module.exports.DATED_AFTER_CALL = DATED_AFTER_CALL;
module.exports.NEEDS_PREP = NEEDS_PREP;
module.exports.touchedRecently = touchedRecently;
module.exports.pastHistoryCandidates = pastHistoryCandidates;
module.exports.takePastHistory = takePastHistory;
module.exports.mapWithBudget = mapWithBudget;
module.exports.createSlotPacer = createSlotPacer;
module.exports.buildLeadsResponse = buildLeadsResponse;
module.exports.PAST_HISTORY_CAP = PAST_HISTORY_CAP;
module.exports.PAST_HISTORY_CONCURRENCY = PAST_HISTORY_CONCURRENCY;
module.exports.PAST_HISTORY_BUDGET_MS = PAST_HISTORY_BUDGET_MS;
module.exports.HISTORY_RATE_PER_SEC = HISTORY_RATE_PER_SEC;
module.exports.REQUEST_DEADLINE_MS = REQUEST_DEADLINE_MS;
module.exports.RESPONSE_BACKSTOP_MS = RESPONSE_BACKSTOP_MS;
