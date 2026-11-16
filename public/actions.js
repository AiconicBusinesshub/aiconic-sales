// Outcome buttons on a lead card. Each one adds a single tag. The matching
// GoHighLevel workflow moves the opportunity and then removes the tag.
// This file is plain script in the browser (window.SalesActions) and
// module.exports under Node, so the button list can be tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SalesActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ABANDONED_TAG = "abandoned";

  // A diagnostic card is the Diagnostic Call stage, or a call titled like
  // "Business Diagnostic Call". Those cards never take the intro outcome buttons.
  function isDiagnosticCard(l) {
    if (/diagnostic/i.test(l.stage || "")) return true;
    var title = (l.appointment && l.appointment.title) || l.callTitle || "";
    return /diagnostic/i.test(title);
  }

  // Which call the lead books next. Diagnostic sits between intro and
  // interview, so the next booking is the interview.
  function nextCallType(l) {
    var st = String(l.stage || "").toLowerCase();
    if (/diagnostic/.test(st)) return l.status === "booked" ? "interview" : "";
    if (l.status === "bookingreview" || (l.status === "booked" && /interview/.test(st))) return "review";
    if (l.status === "bookinginterview" || (l.status === "booked" && /intro/.test(st))) return "interview";
    return "";
  }

  // Whether a lead belongs on Daily Outreach. Upcoming is any booked call with
  // a time from the start of today onward, including a diagnostic. Past is any
  // intro, diagnostic, interview or review in the last 14 days, matched on the
  // appointment title (for example "Business Diagnostic Call").
  function onDailyOutreach(l, mode, nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    if (mode === "past") {
      if (/test/i.test(l.name || "")) return false;
      var at = (l.appointment && l.appointment.at) || l.callAt || null;
      if (!at) return false;
      var t = new Date(at).getTime();
      var startToday = new Date(now);
      startToday.setHours(0, 0, 0, 0);
      var pastFrom = startToday.getTime() - 14 * 86400000;
      if (!(t <= now && t >= pastFrom)) return false;
      var title = (l.appointment && l.appointment.title) || l.callTitle || "";
      return !title || /intro|interview|review|diagnostic/i.test(title);
    }
    if (!(l.status === "booked" && l.appointment && l.appointment.at)) return false;
    var start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return new Date(l.appointment.at).getTime() >= start.getTime();
  }

  // Interview and Review stages. Lost is a real outcome only once a lead is
  // here, or once a held Interview or Review is already on the record.
  var INTERVIEW_REVIEW_STAGE_IDS = {
    "52d0b1ab-88b1-452b-8966-88e269e9ec75": true, // Sending Interview Reminders
    "fbb75036-ca89-43ee-948a-ed9f60d324f8": true, // Interview Booked
    "948a6e28-7669-402e-b632-d84b452ebac0": true, // Sending Review Reminders
    "ae66e02e-8a8a-446d-a26f-85bce067126c": true, // Review Booked
  };

  function isInterviewOrReviewStage(l) {
    if (l.stageId && INTERVIEW_REVIEW_STAGE_IDS[l.stageId]) return true;
    var st = String(l.stage || "");
    if (/diagnostic/i.test(st)) return false;
    return (/interview/i.test(st) || /review/i.test(st)) && (/reminder/i.test(st) || /booked/i.test(st));
  }

  // An intro card is the intro stage, an intro appointment, or any other
  // booked call that is not a diagnostic, interview, or review. An intro call
  // alone is never Lost.
  function isIntroCard(l) {
    if (isDiagnosticCard(l) || isInterviewOrReviewStage(l)) return false;
    var st = String(l.stage || "");
    var title = ((l.appointment && l.appointment.title) || l.callTitle || "");
    if (/intro/i.test(st)) return true;
    if (/intro/i.test(title) && !/interview|review|diagnostic/i.test(title)) return true;
    if (l.status === "booked" && !/interview|review|diagnostic/i.test(st) && !/interview|review|diagnostic/i.test(title)) return true;
    return false;
  }

  // Held Interview or Review, from signals the toolkit already has. No new
  // CRM read. Two signals, either one is enough:
  //
  // 1. Tags already loaded onto the lead. Prep cards use the contact's tags.
  //    Lightweight cards use the opportunity's relation tags. A tag counts
  //    when it names an interview or a review and it is not one of the
  //    not-held outcomes the toolkit itself writes: pending-interview,
  //    noshow-interview, booklater-interview, noshow-review, booklater-review.
  //    pending-review counts: that tag is applied only after the interview
  //    was held and the review was not booked on the call.
  // 2. The appointment activity already stored on the lead: appointment.title
  //    from the conversation history, or callTitle from that same history or
  //    from the past-calendar fallback. The title must say interview or
  //    review (and not diagnostic). When a time is present it must already
  //    have started, so a future booking is not treated as held. The stored
  //    activity has no show/no-show flag, so a past non-cancelled interview
  //    or review title is the held signal.
  function heldInterviewOrReview(l) {
    var tags = Array.isArray(l.tags) ? l.tags : [];
    for (var i = 0; i < tags.length; i++) {
      var t = String(tags[i] || "").toLowerCase().trim();
      if (!t || !/interview|review/.test(t)) continue;
      if (t === "pending-interview" || t === "noshow-interview" || t === "booklater-interview" || t === "noshow-review" || t === "booklater-review") continue;
      if (/noshow|booklater|no-show|book-later/.test(t)) continue;
      return true;
    }
    var title = ((l.appointment && l.appointment.title) || l.callTitle || "");
    if (!/interview|review/i.test(title) || /diagnostic/i.test(title)) return false;
    var at = (l.appointment && l.appointment.at) || l.callAt || null;
    if (!at) return true;
    var ms = Date.parse(String(at).replace(" ", "T"));
    if (!isFinite(ms)) return true;
    return ms <= Date.now();
  }

  // Lost is not on intro cards, diagnostic cards, or the generic mover.
  // A Pipeline-tab card uses that same generic mover, so it loses the button
  // too, unless the lead is in an Interview or Review stage (those stages are
  // opened from the Pipeline tab) or the held-call signal above is present.
  function offersLost(l) {
    if (isDiagnosticCard(l) || isIntroCard(l)) return false;
    if (isInterviewOrReviewStage(l)) return true;
    return heldInterviewOrReview(l);
  }

  // Which buttons show depends on where the lead is now. Not Qualified and
  // Abandoned are on every one of these lists. Lost is not.
  function actionPlan(l, ctx) {
    var s = l.status, st = l.stage || "";
    var isInterview = /interview/i.test(st), isReview = /review/i.test(st);
    var B = {
      noshowIntro: { label: "No Show", tag: "noshow-intro", tone: "noshow", icon: "👻", what: "They did not turn up to the intro call. Starts the reminders asking them to rebook the intro call." },
      booklaterIntro: { label: "Book Later", tag: "booklater-intro", tone: "chase", icon: "🔁", what: "They asked to move the intro call to another time. Starts the same reminders asking them to rebook the intro call." },
      noBookInterview: { label: "Qualified Next Call Not Booked", tag: "pending-interview", tone: "blue", icon: "✅", what: "They qualified but did not book the interview on the call. They will book it themselves. Starts the reminders with the interview booking link." },
      noshowInterview: { label: "No Show", tag: "noshow-interview", tone: "noshow", icon: "👻", what: "They did not turn up to the interview. Starts the reminders asking them to rebook the interview." },
      booklaterInterview: { label: "Book Later", tag: "booklater-interview", tone: "chase", icon: "🔁", what: "They asked to move the interview to another time. Starts the same reminders asking them to rebook the interview." },
      noBookReview: { label: "Qualified Next Call Not Booked", tag: "pending-review", tone: "blue", icon: "✅", what: "The interview went well but they did not book the review on the call. They will book it themselves. Starts the reminders with the review booking link." },
      noshowReview: { label: "No Show", tag: "noshow-review", tone: "noshow", icon: "👻", what: "They did not turn up to the review call. Starts the reminders asking them to rebook the review." },
      booklaterReview: { label: "Book Later", tag: "booklater-review", tone: "chase", icon: "🔁", what: "They asked to move the review call to another time. Starts the same reminders asking them to rebook the review." },
      baking: { label: "Baking/Nurturing", tag: "baking", tone: "gray", icon: "🍿", what: "Interested but not ready yet. Moves them to Baking/Nurturing." },
      nq: { label: "Not Qualified", tag: "not-qualified", tone: "dark", icon: "⛔️", what: "They do not qualify. Moves them to Not Qualified, cancels the call and stops all messages. If we just couldn't get a booking, use Abandoned." },
      lost: { label: "Lost", tag: "lost", tone: "dark", icon: "😞", what: "Only after a held Interview or Review call. An intro call alone is never Lost; use Not Qualified or Abandoned." },
      abandoned: { label: "Abandoned", tag: ABANDONED_TAG, tone: "dark", icon: "❌", what: "They kept getting the book-a-call reminders, or we never got them through the funnel properly. It is obviously never going to happen and we have tried everything. Moves them to Abandoned and stops the chase." },
      won: { label: "Client Won", tag: "won", tone: "green", icon: "🔥", what: "They signed. Moves them to Client Won." },
    };
    // Diagnostic is checked first so a title like "Business Diagnostic Call"
    // is never filed as an intro.
    var kindOf = function (t) {
      if (/diagnostic/i.test(t)) return "";
      return /interview/i.test(t) ? "interview" : /review/i.test(t) ? "review" : /intro/i.test(t) ? "intro" : "";
    };
    var kind = kindOf((l.appointment && l.appointment.title) || l.callTitle || "") || kindOf(st);
    var any = function (base, label, tone, icon, what) {
      return kind
        ? { label: label, tag: base + "-" + kind, tone: tone, icon: icon, what: what + " Call type: " + kind + "." }
        : { label: label, tag: "", needKind: base, tone: tone, icon: icon, what: what + " You pick the call type when you tap." };
    };
    var closed = [B.baking, B.nq, B.abandoned, B.won];
    if (offersLost(l)) closed.splice(1, 0, B.lost);
    // Carlos takes diagnostic calls himself. No no-show, book-later, or
    // "next call not booked" button, and never the intro tags.
    if (isDiagnosticCard(l)) return {
      title: "After the diagnostic call",
      auto: "Carlos takes this call himself and follows up or cancels personally. There is no reminder sequence.",
      after: closed,
    };
    var generic = { title: "Move this lead", auto: "Move this lead to the right stage from here. Tap the same one again later to move it again.", after: [
      any("noshow", "No Show", "noshow", "👻", "They did not turn up. Starts the reminders asking them to rebook."),
      any("booklater", "Book Later", "chase", "🔁", "They asked to move the call. Starts the same rebook reminders."),
    ].concat(closed) };
    if (ctx === "pipeline" || s !== "booked") return generic;
    if (s === "booked" && isReview) return { title: "After the review call", auto: "Tap the one that matches what happened.", after: [B.noshowReview, B.booklaterReview].concat(closed) };
    if (s === "booked" && isInterview) return { title: "After the interview call", auto: "If they booked the review during the interview, do nothing. The lead moves to Review Booked on its own.", after: [B.noshowInterview, B.booklaterInterview, B.noBookReview].concat(closed) };
    if (s === "booked") return { title: "After the intro call", auto: "If they booked the interview during the call, do nothing. The lead moves to Interview Booked on its own.", after: [B.noshowIntro, B.booklaterIntro, B.noBookInterview].concat(closed) };
    return generic;
  }

  return {
    actionPlan: actionPlan,
    ABANDONED_TAG: ABANDONED_TAG,
    nextCallType: nextCallType,
    onDailyOutreach: onDailyOutreach,
  };
});
