// Card lifecycle scheduler — the v3 ("2021") scheduler, both the legacy SM-2
// path and the FSRS path. Faithful port of anki/rslib/src/scheduler/states/* and
// answering/*.
//
// States are plain tagged objects:
//   { kind: "new",        position }
//   { kind: "learning",   remainingSteps, scheduledSecs, elapsedSecs, memoryState }
//   { kind: "review",     scheduledDays, elapsedDays, easeFactor, lapses, leeched, memoryState }
//   { kind: "relearning", learning, review }
//
// memoryState is { stability, difficulty } | null (FSRS). easeFactor is a float
// (2.5 == 2500 permille). Transition functions are pure; the Scheduler class
// reads/writes the stored card columns and emits revlog entries.
//
// Deferred vs. Anki (documented, not silently dropped): interval fuzz is OFF by
// default (deterministic, matching rslib's fuzz_factor=None test path); filtered
// deck preview mode + custom ordering, easy days UI (the load balancer honors
// imported easy-days settings), and the a*1000 "reps left today" component of
// `left` are not yet implemented.
import { CardType, CardQueue, RevlogType, Revlog, cardFlagSet, writeCardFlags } from "./model.js";
import { FSRS, DEFAULT_PARAMETERS } from "./fsrs.js";
import { nowMs, nowSec } from "./ids.js";
import { collectionTiming } from "./timing.js";

const DAY = 86400;
const INITIAL_EASE_FACTOR = 2.5;
const MINIMUM_EASE_FACTOR = 1.3;
const EASE_AGAIN = -0.2;
const EASE_HARD = -0.15;
const EASE_EASY = 0.15;

// --- Learning steps (port of states/steps.rs) ---

class LearningSteps {
  /** @param {number[]} steps step delays in MINUTES */
  constructor(steps) {
    this.steps = steps ?? [];
  }
  get length() {
    return this.steps.length;
  }
  isEmpty() {
    return this.steps.length === 0;
  }
  _secsAt(i) {
    return i >= 0 && i < this.steps.length ? Math.trunc(this.steps[i] * 60) : null;
  }
  // Strip "learning today" (the a*1000 part) and clamp into range.
  _index(remaining) {
    const total = this.steps.length;
    return Math.min(Math.max(total - (remaining % 1000), 0), Math.max(total - 1, 0));
  }
  againDelaySecs() {
    return this._secsAt(0);
  }
  hardDelaySecs(remaining) {
    const idx = this._index(remaining);
    let current = this._secsAt(idx);
    if (current === null) current = this._secsAt(0);
    if (current === null) return null;
    return idx === 0 ? this._hardForFirstStep(current) : current;
  }
  _hardForFirstStep(againSecs) {
    const next = this._secsAt(1);
    if (next !== null) return maybeRoundInDays(Math.trunc((againSecs + next) / 2));
    const secs = Math.min(Math.trunc((againSecs * 3) / 2), againSecs + DAY);
    return maybeRoundInDays(secs);
  }
  goodDelaySecs(remaining) {
    return this._secsAt(this._index(remaining) + 1);
  }
  currentDelaySecs(remaining) {
    return this._secsAt(this._index(remaining)) ?? 0;
  }
  remainingForGood(remaining) {
    return this.steps.length - (this._index(remaining) + 1);
  }
  remainingForFailed() {
    return this.steps.length;
  }
}

function maybeRoundInDays(secs) {
  return secs > DAY ? Math.round(secs / DAY) * DAY : secs;
}

// --- interval kind helpers (states/interval_kind.rs) ---

/** Convert an intra-day seconds interval to days if it crosses the rollover. */
function maybeAsDays(kind, secsUntilRollover) {
  if (kind.secs === undefined) return kind;
  if (kind.secs >= secsUntilRollover) {
    return { days: Math.trunc((kind.secs - secsUntilRollover) / DAY) + 1 };
  }
  return kind;
}
const asRevlogInterval = (kind) =>
  kind.days !== undefined ? kind.days : -Math.min(kind.secs, 2 ** 31 - 1);

// --- StateContext: scheduling params derived from a deck config ---

/** Clamp helper for review intervals: maximum >= 1, minimum in [1, maximum]. */
function minMax(ctx, minimum) {
  const maximum = Math.max(ctx.maximumReviewInterval, 1);
  return [Math.min(Math.max(minimum, 1), maximum), maximum];
}

// Interval fuzz (rslib states/fuzz.rs). fuzzFactor in [0,1) picks within the
// range; null => deterministic round+clamp (used in tests / previews).
const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 },
];

function fuzzDelta(interval) {
  if (interval < 2.5) return 0.0;
  return FUZZ_RANGES.reduce(
    (delta, r) => delta + r.factor * Math.max(Math.min(interval, r.end) - r.start, 0.0),
    1.0,
  );
}

function constrainedFuzzBounds(interval, minimum, maximum) {
  minimum = Math.min(minimum, maximum);
  interval = Math.min(Math.max(interval, minimum), maximum);
  const delta = fuzzDelta(interval);
  let lower = Math.round(interval - delta);
  let upper = Math.round(interval + delta);
  lower = Math.min(Math.max(lower, minimum), maximum);
  upper = Math.min(Math.max(upper, minimum), maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

function withReviewFuzz(ctx, interval, minimum, maximum) {
  if (ctx.fuzzFactor == null) {
    return Math.min(Math.max(Math.round(interval), minimum), maximum);
  }
  // Load balancer (when enabled) replaces the blind fuzz pick.
  if (ctx.loadBalancePick) {
    const picked = ctx.loadBalancePick(interval, minimum, maximum);
    if (picked != null) return picked;
  }
  const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
  return Math.floor(lower + ctx.fuzzFactor * (1 + upper - lower));
}

// --- Load balancer (port of rslib states/load_balancer.rs) ---
// Instead of picking uniformly within the fuzz range, days are weighted by
// existing load: weight = (1/cards_due)^2.15 × (1/interval)^3 × sibling
// modifier × easy-days modifier; a day with no due cards gets weight 1.0.

const MAX_LOAD_BALANCE_INTERVAL = 90;
const LOAD_BALANCE_DAYS = 99; // 90 × 1.1, like rslib
const SIBLING_STEPS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
const SIBLING_RANGE = [1.0, 0.8, 0.6, 0.4, 0.2, 0.000001, 0.2, 0.4, 0.6, 0.8, 1.0];

/** Easy-day load modifier per weekday percentage: 1.0 normal, 0.0 minimum, else reduced. */
function easyDayLoadModifier(p) {
  return p === 1.0 ? 1.0 : p === 0.0 ? 0.0001 : 0.5;
}

/** Per-candidate-day on/off weights from easy-day settings (load_balancer.rs). */
function easyDayModifiers(easyPercents, weekdays, reviewCounts) {
  const percents = easyPercents?.length === 7 ? easyPercents : [1, 1, 1, 1, 1, 1, 1];
  const total = reviewCounts.reduce((a, b) => a + b, 0);
  const totalPercents = weekdays.reduce((a, w) => a + easyDayLoadModifier(percents[w]), 0);
  return weekdays.map((w, i) => {
    const p = percents[w];
    if (p !== 1.0 && p !== 0.0) {
      // Reduced: only allowed when this day isn't above the reduced threshold.
      const threshold = (total - reviewCounts[i]) / (totalPercents - 0.5);
      return reviewCounts[i] / 0.5 > threshold ? 0.0001 : 1.0;
    }
    return easyDayLoadModifier(p);
  });
}

/** Sibling-dispersal weights: days near an existing sibling get downweighted. */
function siblingModifiers(byPreset, before, after, nid) {
  const mods = new Array(after - before + 1).fill(1.0);
  if (nid == null) return mods;
  const siblingDays = new Set();
  for (const days of byPreset.values()) {
    days.forEach((day, i) => { if (day.notes.has(nid)) siblingDays.add(i); });
  }
  for (const sd of siblingDays) {
    for (let k = 0; k < SIBLING_STEPS.length; k++) {
      const t = sd + SIBLING_STEPS[k] - before;
      if (t >= 0 && t < mods.length) mods[t] *= SIBLING_RANGE[k];
    }
  }
  return mods;
}

/** Deterministic fuzz factor in [0,1) from a card's id + reps. */
function fuzzFactorFor(card) {
  let x = ((Number(card.id) >>> 0) ^ ((card.reps * 2654435761) >>> 0)) >>> 0;
  x = ((x ^ (x >>> 15)) * 2246822519) >>> 0;
  x = ((x ^ (x >>> 13)) * 3266489917) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** Deterministic ordering hash in [0,1), salted by day (Anki salts with
 *  days_elapsed, so "random" orders are stable within a day). */
function orderHash(id, salt) {
  let x = ((Number(id) >>> 0) ^ ((salt * 2654435761) >>> 0)) >>> 0;
  x = ((x ^ (x >>> 15)) * 2246822519) >>> 0;
  x = ((x ^ (x >>> 13)) * 3266489917) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

function leechThresholdMet(lapses, threshold) {
  if (threshold <= 0) return false;
  const half = Math.max(Math.ceil(threshold / 2), 1);
  return lapses >= threshold && (lapses - threshold) % half === 0;
}

// --- Review transitions (states/review.rs) ---

function constrainPassing(ctx, interval, minimum) {
  const scaled = ctx.fsrs ? interval : interval * ctx.intervalMultiplier;
  const [min, max] = minMax(ctx, minimum);
  return withReviewFuzz(ctx, scaled, min, max);
}

function passingReviewIntervals(r, ctx) {
  if (ctx.fsrs) {
    const greaterThanLast = (ivl) => (ivl > r.scheduledDays ? r.scheduledDays + 1 : 0);
    const hard = constrainPassing(ctx, ctx.fsrs.hard.interval, Math.max(greaterThanLast(Math.round(ctx.fsrs.hard.interval)), 1));
    const good = constrainPassing(ctx, ctx.fsrs.good.interval, Math.max(greaterThanLast(Math.round(ctx.fsrs.good.interval)), hard + 1));
    const easy = constrainPassing(ctx, ctx.fsrs.easy.interval, Math.max(greaterThanLast(Math.round(ctx.fsrs.easy.interval)), good + 1));
    return [hard, good, easy];
  }
  // non-early (common) path
  const current = Math.max(r.scheduledDays, 1);
  if (r.elapsedDays < r.scheduledDays) {
    // Early review (filtered deck / review-ahead): penalized formulas, no
    // fuzz (rslib review.rs passing_early_review_intervals).
    const early = (v) => {
      const max = Math.max(ctx.maximumReviewInterval, 1);
      return Math.min(Math.max(Math.round(v * ctx.intervalMultiplier), 0), max);
    };
    const hard = early(Math.max(r.elapsedDays * ctx.hardMultiplier, (current * ctx.hardMultiplier) / 2));
    const good = early(Math.max(r.elapsedDays * r.easeFactor, current));
    const reducedBonus = ctx.easyMultiplier - (ctx.easyMultiplier - 1) / 2;
    const easy = early(Math.max(r.elapsedDays * r.easeFactor, current) * reducedBonus);
    return [hard, good, easy];
  }
  const daysLate = r.elapsedDays - r.scheduledDays;
  const hardFactor = ctx.hardMultiplier;
  const hardMin = hardFactor <= 1 ? 0 : r.scheduledDays + 1;
  const hard = constrainPassing(ctx, current * hardFactor, hardMin);
  const goodMin = hardFactor <= 1 ? r.scheduledDays + 1 : hard + 1;
  const good = constrainPassing(ctx, (current + daysLate / 2) * r.easeFactor, goodMin);
  const easy = constrainPassing(ctx, (current + daysLate) * r.easeFactor * ctx.easyMultiplier, good + 1);
  return [hard, good, easy];
}

function failingReviewInterval(r, ctx) {
  // Anki defers fuzz on the FSRS lapse path, but the max-ivl cap still applies.
  if (ctx.fsrs) return [Math.min(ctx.fsrs.again.interval, Math.max(ctx.maximumReviewInterval, 1)), fsrsMem(ctx.fsrs.again)];
  const [min, max] = minMax(ctx, ctx.minimumLapseInterval);
  const interval = withReviewFuzz(ctx, Math.max(r.scheduledDays, 1) * ctx.lapseMultiplier, min, max);
  return [interval, null];
}

const fsrsMem = (s) => (s ? { stability: s.state.stability, difficulty: s.state.difficulty } : null);

function reviewNextStates(r, ctx) {
  const [hardI, goodI, easyI] = passingReviewIntervals(r, ctx);
  return {
    current: { kind: "review", ...r },
    again: reviewAnswerAgain(r, ctx),
    hard: { kind: "review", ...r, scheduledDays: hardI, elapsedDays: 0, easeFactor: Math.max(r.easeFactor + EASE_HARD, MINIMUM_EASE_FACTOR), memoryState: ctx.fsrs ? fsrsMem(ctx.fsrs.hard) : r.memoryState },
    good: { kind: "review", ...r, scheduledDays: goodI, elapsedDays: 0, memoryState: ctx.fsrs ? fsrsMem(ctx.fsrs.good) : r.memoryState },
    easy: { kind: "review", ...r, scheduledDays: easyI, elapsedDays: 0, easeFactor: r.easeFactor + EASE_EASY, memoryState: ctx.fsrs ? fsrsMem(ctx.fsrs.easy) : r.memoryState },
  };
}

function reviewAnswerAgain(r, ctx) {
  const lapses = r.lapses + 1;
  const leeched = leechThresholdMet(lapses, ctx.leechThreshold);
  const [schedDays, memoryState] = failingReviewInterval(r, ctx);
  const againReview = {
    kind: "review", scheduledDays: Math.max(Math.round(schedDays), 1), elapsedDays: 0,
    easeFactor: Math.max(r.easeFactor + EASE_AGAIN, MINIMUM_EASE_FACTOR), lapses, leeched, memoryState,
  };
  const againDelay = ctx.relearnSteps.againDelaySecs();
  if (againDelay !== null) {
    return { kind: "relearning", learning: { remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: againDelay, elapsedSecs: 0, memoryState }, review: againReview };
  }
  if (ctx.fsrs && (ctx.fsrsShortTermWithSteps || ctx.relearnSteps.isEmpty()) && schedDays < 0.5) {
    return { kind: "relearning", learning: { remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: Math.trunc(schedDays * DAY), elapsedSecs: 0, memoryState }, review: againReview };
  }
  return againReview;
}

// --- Learning transitions (states/learning.rs) ---

function learnNextStates(l, ctx) {
  return {
    current: { kind: "learning", ...l },
    again: learnAnswer(l, ctx, "again"),
    hard: learnAnswer(l, ctx, "hard"),
    good: learnAnswer(l, ctx, "good"),
    easy: learnAnswerEasy(l, ctx),
  };
}

function graduate(ctx, interval, minimum, memoryState) {
  const [min, max] = minMax(ctx, minimum);
  return {
    kind: "review", scheduledDays: withReviewFuzz(ctx, Math.max(Math.round(interval), 1), min, max),
    elapsedDays: 0, easeFactor: ctx.initialEaseFactor, lapses: 0, leeched: false, memoryState,
  };
}

function learnAnswer(l, ctx, button) {
  const mem = ctx.fsrs ? fsrsMem(ctx.fsrs[button]) : l.memoryState;
  let delay, remaining;
  if (button === "again") {
    delay = ctx.steps.againDelaySecs();
    remaining = ctx.steps.remainingForFailed();
  } else if (button === "hard") {
    delay = ctx.steps.hardDelaySecs(l.remainingSteps);
    remaining = l.remainingSteps;
  } else {
    delay = ctx.steps.goodDelaySecs(l.remainingSteps);
    remaining = ctx.steps.remainingForGood(l.remainingSteps);
  }
  if (delay !== null) {
    return { kind: "learning", remainingSteps: remaining, scheduledSecs: delay, elapsedSecs: 0, memoryState: mem };
  }
  // No further step -> graduate (or FSRS short-term stay in learning).
  const interval = ctx.fsrs ? ctx.fsrs[button].interval : ctx.graduatingIntervalGood;
  const shortTerm = ctx.fsrs && (ctx.fsrsShortTermWithSteps || ctx.steps.isEmpty()) && interval < 0.5;
  if (shortTerm) {
    return { kind: "learning", remainingSteps: l.remainingSteps, scheduledSecs: Math.trunc(interval * DAY), elapsedSecs: 0, memoryState: mem };
  }
  return graduate(ctx, interval, 1, mem);
}

function learnAnswerEasy(l, ctx) {
  let [min, max] = minMax(ctx, 1);
  let interval;
  if (ctx.fsrs) {
    const good = withReviewFuzz(ctx, ctx.fsrs.good.interval, min, max);
    min = good + 1;
    interval = Math.max(Math.round(ctx.fsrs.easy.interval), 1);
  } else {
    interval = ctx.graduatingIntervalEasy;
  }
  return {
    kind: "review", scheduledDays: withReviewFuzz(ctx, interval, min, max), elapsedDays: 0,
    easeFactor: ctx.initialEaseFactor, lapses: 0, leeched: false,
    memoryState: ctx.fsrs ? fsrsMem(ctx.fsrs.easy) : l.memoryState,
  };
}

// --- Relearning transitions (states/relearning.rs) ---

function relearnNextStates(rl, ctx) {
  return {
    current: { kind: "relearning", ...rl },
    again: relearnAnswerAgain(rl, ctx),
    hard: relearnAnswerStep(rl, ctx, "hard"),
    good: relearnAnswerStep(rl, ctx, "good"),
    easy: relearnAnswerEasy(rl, ctx),
  };
}

function relearnAnswerAgain(rl, ctx) {
  const [schedDays, memoryState] = failingReviewInterval(rl.review, ctx);
  const againDelay = ctx.relearnSteps.againDelaySecs();
  if (againDelay !== null) {
    return {
      kind: "relearning",
      learning: { remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: againDelay, elapsedSecs: 0, memoryState },
      review: { ...rl.review, scheduledDays: Math.max(Math.round(schedDays), 1), elapsedDays: 0, memoryState },
    };
  }
  if (ctx.fsrs) {
    const [min, max] = minMax(ctx, 1);
    const interval = ctx.fsrs.again.interval;
    const againReview = { ...rl.review, scheduledDays: withReviewFuzz(ctx, Math.max(Math.round(interval), 1), min, max), memoryState };
    if ((ctx.fsrsShortTermWithSteps || ctx.relearnSteps.isEmpty()) && interval < 0.5) {
      return { kind: "relearning", learning: { remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: Math.trunc(interval * DAY), elapsedSecs: 0, memoryState }, review: againReview };
    }
    return { kind: "review", ...againReview };
  }
  return { kind: "review", ...rl.review };
}

function relearnAnswerStep(rl, ctx, button) {
  const mem = ctx.fsrs ? fsrsMem(ctx.fsrs[button]) : rl.review.memoryState;
  const delay = button === "hard"
    ? ctx.relearnSteps.hardDelaySecs(rl.learning.remainingSteps)
    : ctx.relearnSteps.goodDelaySecs(rl.learning.remainingSteps);
  const remaining = button === "hard" ? rl.learning.remainingSteps : ctx.relearnSteps.remainingForGood(rl.learning.remainingSteps);
  if (delay !== null) {
    return {
      kind: "relearning",
      learning: { ...rl.learning, remainingSteps: remaining, scheduledSecs: delay, elapsedSecs: 0, memoryState: mem },
      review: { ...rl.review, elapsedDays: 0, memoryState: mem },
    };
  }
  if (ctx.fsrs) {
    const [min, max] = minMax(ctx, 1);
    const interval = ctx.fsrs[button].interval;
    const review = { ...rl.review, scheduledDays: withReviewFuzz(ctx, Math.max(Math.round(interval), 1), min, max), memoryState: mem };
    if ((ctx.fsrsShortTermWithSteps || ctx.relearnSteps.isEmpty()) && interval < 0.5) {
      return { kind: "relearning", learning: { ...rl.learning, remainingSteps: remaining, scheduledSecs: Math.trunc(interval * DAY), elapsedSecs: 0, memoryState: mem }, review };
    }
    return { kind: "review", ...review };
  }
  return { kind: "review", ...rl.review };
}

function relearnAnswerEasy(rl, ctx) {
  let scheduledDays;
  if (ctx.fsrs) {
    let [min, max] = minMax(ctx, 1);
    const good = withReviewFuzz(ctx, ctx.fsrs.good.interval, min, max);
    min = good + 1;
    scheduledDays = withReviewFuzz(ctx, Math.max(Math.round(ctx.fsrs.easy.interval), 1), min, max);
  } else {
    scheduledDays = rl.review.scheduledDays + 1;
  }
  return { kind: "review", ...rl.review, scheduledDays, elapsedDays: 0, memoryState: ctx.fsrs ? fsrsMem(ctx.fsrs.easy) : rl.review.memoryState };
}

// --- New transition: acts like a failed learning card, current stays New ---

function newNextStates(position, ctx) {
  const learn = { kind: "learning", remainingSteps: ctx.steps.remainingForFailed(), scheduledSecs: 0, elapsedSecs: 0, memoryState: null };
  const states = learnNextStates(learn, ctx);
  states.current = { kind: "new", position };
  return states;
}

/** Dispatch transitions for any state. */
function nextStatesFor(state, ctx) {
  switch (state.kind) {
    case "new": return newNextStates(state.position, ctx);
    case "learning": return learnNextStates(state, ctx);
    case "review": return reviewNextStates(state, ctx);
    case "relearning": return relearnNextStates(state, ctx);
    default: throw new Error(`unknown state kind: ${state.kind}`);
  }
}

/** The displayed interval of a state, as an {secs} or {days} kind. */
function intervalKindOf(state) {
  switch (state.kind) {
    case "new": return { secs: 0 };
    case "learning": return { secs: state.scheduledSecs };
    case "relearning": return { secs: state.learning.scheduledSecs };
    case "review": return { days: state.scheduledDays };
    default: throw new Error(`unknown state kind: ${state.kind}`);
  }
}

const revlogKindOf = (kind) =>
  kind === "review" ? RevlogType.Review : kind === "relearning" ? RevlogType.Relearn : RevlogType.Learn;

// --- Scheduler: reads/writes card columns, emits revlog ---

export class Scheduler {
  /**
   * @param {import("./model.js").Collection} collection
   * @param {{ now?: number, fsrsParameters?: number[] }} [opts]
   */
  constructor(collection, opts = {}) {
    this.col = collection;
    this.now = opts.now ?? nowSec();
    this.fuzz = opts.fuzz ?? false; // off by default → deterministic intervals
    this.fsrsEnabled = collection.conf?.fsrs === true;
    this.fsrsParameters = opts.fsrsParameters ?? collection.conf?.fsrsParams6 ?? DEFAULT_PARAMETERS;
    // Timing: local scheduling days with a rollover hour (default 4 AM),
    // matching rslib's v2/v3 timing rather than raw 86400s multiples of crt.
    const timing = collectionTiming(collection, this.now);
    this.daysElapsed = timing.daysElapsed;
    this.secsUntilRollover = timing.secsUntilRollover;
    this.nextDayAt = timing.nextDayAt;
    this._lbData = null; // load-balance cache, built on first use
  }

  /** Resolve the deck options group (dconf) for a card's deck. */
  deckConfigFor(card) {
    let deck = this.col.decks[String(card.did)];
    // Filtered decks use the card's original (home) deck options.
    if (deck?.dyn && card.odid) deck = this.col.decks[String(card.odid)] ?? deck;
    const dcId = deck && deck.conf != null ? String(deck.conf) : "1";
    return this.col.dconf[dcId] ?? this.col.dconf["1"] ?? {};
  }

  /**
   * FSRS memory state for a card that lacks one (Anki fsrs/memory_state.rs):
   * replay the card's revlog through FSRS; seed with the SM-2 approximation
   * when the history is truncated; plain SM-2 approximation when there's no
   * usable history; null for new cards.
   */
  _memoryStateFor(card, fsrs) {
    const entries = this.col.revlog.filter((e) => e.cid === card.id).sort((a, b) => a.id - b.id);
    const item = this._fsrsItemFor(entries, fsrs);
    if (item) return fsrs.forwardReviews(item.reviews, item.startingState);
    if (card.type !== CardType.New && card.ivl > 0) {
      return fsrs.memoryStateFromSm2((card.factor || 2500) / 1000, card.ivl);
    }
    return null;
  }

  /**
   * Build { reviews, startingState } from a card's revlog (params.rs
   * reviews_for_fsrs + memory_state.rs fsrs_item_for_memory_state,
   * non-training path). reviews are [{ rating, deltaT }] chronological.
   */
  _fsrsItemFor(entries, fsrs) {
    const isCramming = (e) => e.type === RevlogType.Filtered && e.factor === 0;
    const isReset = (e) => e.type === RevlogType.Manual && e.factor === 0;
    let firstOfLastLearn = null, firstUserGrade = null, complete = false;
    // Working backwards from the latest review…
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (isCramming(e)) continue;
      const userGraded = e.ease > 0;
      const interday = e.ivl >= 1 || e.ivl <= -DAY; // day-based interval ≥ 1d
      if (userGraded && interday) firstUserGrade = i;
      if (userGraded && e.type === RevlogType.Learn) {
        firstOfLastLearn = i;
        complete = true;
      } else if (isReset(e)) {
        if (firstOfLastLearn !== null) { complete = true; break; }
        if (firstUserGrade !== null) { complete = false; break; }
        return null; // reset with no graded review after it
      } else if (firstOfLastLearn !== null) break;
    }
    if (firstOfLastLearn !== null) entries = entries.slice(firstOfLastLearn);
    else if (firstUserGrade !== null) entries = entries.slice(firstUserGrade);
    else return null;
    entries = entries.filter((e) => e.ease > 0 && !isCramming(e));
    if (!entries.length) return null;

    // delta_t in whole days between consecutive entries, measured back from
    // the next day boundary (revlog/mod.rs days_elapsed).
    const daysAgo = (e) => Math.max(Math.floor((this.nextDayAt - e.id / 1000) / DAY), 0);
    const reviews = entries.map((e, i) => ({
      rating: e.ease,
      deltaT: i === 0 ? 0 : daysAgo(entries[i - 1]) - daysAgo(e),
    }));
    if (complete) return { reviews, startingState: null };
    // Truncated history: seed from the first entry via the SM-2 approximation.
    const first = entries[0];
    const ease = (first.factor === 0 ? 2500 : first.factor) / 1000;
    const startingState = fsrs.memoryStateFromSm2(ease, Math.max(first.ivl, 1));
    // Ease ≤ 1.1 marks an FSRS-generated entry — reinterpret it as difficulty.
    if (ease <= 1.1) startingState.difficulty = (ease - 0.1) * 9 + 1;
    return { reviews: reviews.slice(1), startingState };
  }

  /** The dconf id for a card's deck (load balancer groups by preset). */
  _deckConfigIdFor(card) {
    let deck = this.col.decks[String(card.did)];
    if (deck?.dyn && card.odid) deck = this.col.decks[String(card.odid)] ?? deck;
    return deck && deck.conf != null ? String(deck.conf) : "1";
  }

  // --- Load balancer (Scheduler-side plumbing) ---

  /** Due-load per day per preset for the next LOAD_BALANCE_DAYS days. */
  _buildLoadBalance() {
    const byPreset = new Map(); // dcid -> [{cards:Set, notes:Set} × LOAD_BALANCE_DAYS]
    const easyDays = new Map();
    for (const [id, dc] of Object.entries(this.col.dconf)) easyDays.set(id, dc.easyDays);
    for (const card of this.col.cards.values()) {
      if (card.queue !== CardQueue.Review && card.queue !== CardQueue.DayLearning) continue;
      const t = card.due - this.daysElapsed;
      if (t < 0 || t >= LOAD_BALANCE_DAYS) continue;
      const dcid = this._deckConfigIdFor(card);
      let days = byPreset.get(dcid);
      if (!days) {
        days = Array.from({ length: LOAD_BALANCE_DAYS }, () => ({ cards: new Set(), notes: new Set() }));
        byPreset.set(dcid, days);
      }
      days[t].cards.add(card.id);
      days[t].notes.add(card.nid);
    }
    return { byPreset, easyDays };
  }

  _lb() {
    if (!this._lbData) this._lbData = this._buildLoadBalance();
    return this._lbData;
  }

  /** Weekday (Monday=0) of the day `offset` days from today (load_balancer.rs). */
  _weekdayOf(offset) {
    const d = new Date((this.nextDayAt + (offset - 1) * DAY) * 1000);
    return (d.getDay() + 6) % 7;
  }

  /**
   * Load-weighted day pick within the fuzz bounds, or null to fall back to
   * plain fuzz (long intervals, or no due load for this preset).
   */
  _balancedInterval(interval, minimum, maximum, card, fuzzFactor) {
    if (interval > MAX_LOAD_BALANCE_INTERVAL || minimum > MAX_LOAD_BALANCE_INTERVAL) return null;
    const [before, after] = constrainedFuzzBounds(interval, minimum, maximum);
    const data = this._lb();
    const dcid = this._deckConfigIdFor(card);
    const days = data.byPreset.get(dcid);
    if (!days) return null;

    const counts = [], weekdays = [];
    for (let t = before; t <= after; t++) {
      counts.push(days[t]?.cards.size ?? 0);
      weekdays.push(this._weekdayOf(t));
    }
    const easy = easyDayModifiers(data.easyDays.get(dcid), weekdays, counts);
    const sib = siblingModifiers(data.byPreset, before, after, card.nid);

    let total = 0;
    const weights = [];
    for (let i = 0; i < counts.length; i++) {
      const t = before + i;
      const w = counts[i] === 0 ? 1.0
        : Math.pow(1 / counts[i], 2.15) * Math.pow(1 / t, 3) * sib[i] * easy[i];
      weights.push(w);
      total += w;
    }
    let r = fuzzFactor * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return before + i;
    }
    return after;
  }

  /** Keep the load cache in step after an answer moves a card's due day. */
  _loadBalanceUpdate(card) {
    if (!this._lbData) return; // only maintain if built
    for (const days of this._lbData.byPreset.values()) {
      for (const day of days) {
        if (day.cards.delete(card.id)) {
          if (![...day.cards].some((cid) => this.col.cards.get(cid)?.nid === card.nid)) {
            day.notes.delete(card.nid);
          }
        }
      }
    }
    if (card.queue === CardQueue.Review || card.queue === CardQueue.DayLearning) {
      const t = card.due - this.daysElapsed;
      if (t >= 0 && t < LOAD_BALANCE_DAYS) {
        const days = this._lbData.byPreset.get(this._deckConfigIdFor(card));
        if (days) {
          days[t].cards.add(card.id);
          days[t].notes.add(card.nid);
        }
      }
    }
  }

  desiredRetentionFor(dc) {
    return dc.desiredRetention ?? this.col.conf?.desiredRetention ?? 0.9;
  }

  /** Build the StateContext (scheduling params + optional FSRS outcomes) for a card. */
  contextFor(card, current) {
    const dc = this.deckConfigFor(card);
    const nu = dc.new ?? {};
    const rev = dc.rev ?? {};
    const lapse = dc.lapse ?? {};
    const ints = nu.ints ?? [1, 4, 7];

    const ctx = {
      steps: new LearningSteps(nu.delays ?? [1, 10]),
      relearnSteps: new LearningSteps(lapse.delays ?? [10]),
      graduatingIntervalGood: ints[0] ?? 1,
      graduatingIntervalEasy: ints[1] ?? 4,
      initialEaseFactor: (nu.initialFactor ?? 2500) / 1000,
      hardMultiplier: rev.hardFactor ?? 1.2,
      easyMultiplier: rev.ease4 ?? 1.3,
      intervalMultiplier: rev.ivlFct ?? 1.0,
      maximumReviewInterval: rev.maxIvl ?? 36500,
      leechThreshold: lapse.leechFails ?? 8,
      lapseMultiplier: lapse.mult ?? 0.0,
      minimumLapseInterval: lapse.minInt ?? 1,
      fsrs: null,
      fsrsShortTermWithSteps: false,
      fuzzFactor: this.fuzz ? fuzzFactorFor(card) : null,
      // Load balancer (default on, like Anki): replaces the blind fuzz pick
      // with a load-weighted day within the same fuzz bounds.
      loadBalancePick: null,
    };
    if (this.fuzz && this.col.conf?.loadBalancer !== false) {
      const f = ctx.fuzzFactor;
      ctx.loadBalancePick = (ivl, min, max) => this._balancedInterval(ivl, min, max, card, f);
    }

    if (this.fsrsEnabled) {
      const fsrs = new FSRS(dc.fsrsParams6 ?? this.fsrsParameters, this.desiredRetentionFor(dc));
      const elapsed = current.kind === "review" ? current.elapsedDays
        : current.kind === "relearning" ? current.review.elapsedDays : 0;
      let mem = current.kind === "review" ? current.memoryState
        : current.kind === "relearning" ? current.review.memoryState
        : current.kind === "learning" ? current.memoryState : null;
      if (mem == null && (current.kind === "review" || current.kind === "relearning")) {
        // Cards with no FSRS state (e.g. imported SM-2 collections): derive
        // one from the revlog like Anki (fsrs/memory_state.rs) — full replay
        // when the history is complete, SM-2-seeded replay when truncated,
        // plain SM-2 approximation when there's no usable history.
        mem = this._memoryStateFor(card, fsrs);
      }
      ctx.fsrs = fsrs.nextStates(mem, elapsed);
    }
    return ctx;
  }

  /** Read the current scheduling state from a card's stored columns (current.rs). */
  cardToState(card) {
    const memoryState = card.memoryState;
    const easeFactor = (card.factor || INITIAL_EASE_FACTOR * 1000) / 1000;
    const remaining = card.left;
    switch (card.type) {
      case CardType.New:
        return { kind: "new", position: Math.max(card.due, 0) };
      case CardType.Learning:
        return { kind: "learning", remainingSteps: remaining, scheduledSecs: 0, elapsedSecs: 0, memoryState };
      case CardType.Review: {
        // In a filtered deck the state is computed from the home due (odue),
        // which may be in the future — that's how early reviews are detected
        // (rslib answering/current.rs). Normal decks clamp due to today.
        const due = card.odid && card.odue ? card.odue : Math.min(card.due, this.daysElapsed);
        return {
          kind: "review", scheduledDays: card.ivl,
          elapsedDays: Math.max(card.ivl - (due - this.daysElapsed), 0),
          easeFactor, lapses: card.lapses, leeched: false, memoryState,
        };
      }
      case CardType.Relearning:
        return {
          kind: "relearning",
          learning: { remainingSteps: remaining, scheduledSecs: 0, elapsedSecs: 0, memoryState },
          review: { kind: "review", scheduledDays: card.ivl, elapsedDays: card.ivl, easeFactor, lapses: card.lapses, leeched: false, memoryState },
        };
      default:
        throw new Error(`unknown card type: ${card.type}`);
    }
  }

  /** Deck ids belonging to `deckId`: the deck itself plus its descendants. */
  _deckAndDescendants(deckId) {
    const deck = this.col.decks[String(deckId)];
    const ids = new Set([Number(deckId)]);
    if (deck) {
      const prefix = `${deck.name}::`;
      for (const [id, d] of Object.entries(this.col.decks)) {
        if (d.name && d.name.startsWith(prefix)) ids.add(Number(id));
      }
    }
    return ids;
  }

  /**
   * Gather the cards due now in a deck (and its subdecks), grouped and capped
   * v3-style: every deck from a card's own deck up to the selected deck has a
   * per-day new/review budget (its config limit minus what's been studied today
   * per its newToday/revToday counters), and interday learning cards consume
   * the review budget. Study order: intraday learning + due interday learning,
   * then reviews with new cards mixed per conf.newSpread, then learn-ahead.
   * @returns {{ learning: Card[], review: Card[], new: Card[], all: Card[] }}
   */
  queue(deckId, { now } = {}) {
    const nowS = now ?? this.now;
    const learnAheadSecs = this._learnAheadSecs();
    const dids = this._deckAndDescendants(deckId);
    const learning = [], learningAhead = [], dayLearning = [], review = [], newCards = [];
    for (const card of this.col.cards.values()) {
      if (!dids.has(card.did)) continue;
      switch (card.queue) {
        case CardQueue.Learning:
          if (card.due <= nowS) learning.push(card);
          else if (card.due <= nowS + learnAheadSecs) learningAhead.push(card); // learn-ahead
          break;
        case CardQueue.DayLearning:
          if (card.due <= this.daysElapsed) dayLearning.push(card);
          break;
        case CardQueue.Review:
          if (card.due <= this.daysElapsed) review.push(card);
          break;
        case CardQueue.New:
          newCards.push(card);
          break;
        // suspended / buried / preview: not studied here
      }
    }
    const byDue = (a, b) => a.due - b.due;
    // Intraday learning: previously-answered cards first, then by due
    // (rslib queue/learning.rs sorts by (reps == 0, due)).
    const byLearningOrder = (a, b) => (a.reps === 0 ? 1 : 0) - (b.reps === 0 ? 1 : 0) || a.due - b.due;
    learning.sort(byLearningOrder);
    learningAhead.sort(byLearningOrder);
    dayLearning.sort(byDue);
    // Gather order decides which cards the daily caps admit (Anki: ORDER BY
    // at gather time), so apply it before capping, not after.
    const orderDc = this.deckConfigFor({ did: deckId });
    this._orderNewGather(newCards, orderDc);
    this._orderReviewGather(review, orderDc);

    // Gather-time sibling burying (v3, builder/burying.rs): after the first
    // gathered sibling of a note, later siblings are excluded from the build
    // when the corresponding bury flag is set. Modes OR-accumulate per note;
    // learning cards record modes but are never excluded (no such flag).
    const buryModes = new Map(); // nid -> { buryNew, buryRev }
    const keepGathered = (card, kind) => {
      const modes = buryModes.get(card.nid);
      if (modes && ((kind === "new" && modes.buryNew) || (kind === "review" && modes.buryRev))) {
        return false;
      }
      const dc = this.deckConfigFor(card);
      buryModes.set(card.nid, {
        buryNew: (modes?.buryNew ?? false) || (dc.new?.bury ?? false),
        buryRev: (modes?.buryRev ?? false) || (dc.rev?.bury ?? false),
      });
      return true;
    };
    // Only new/review siblings are excludable by default; day-learning only
    // when the modern bury_interday_learning flag is set.
    const keep = (card) => keepGathered(card,
      card.queue === CardQueue.New ? "new"
        : card.queue === CardQueue.Review ? "review"
        : card.queue === CardQueue.DayLearning && this.deckConfigFor(card).buryInterday ? "review" : null);
    const gatheredLearning = learning.filter(keep);
    const gatheredDayLearning = dayLearning.filter(keep);
    const gatheredReview = review.filter(keep);
    const gatheredNew = newCards.filter(keep);

    // Filtered decks ignore per-day limits and "studied today" counters.
    let cappedDayLearn = gatheredDayLearning, cappedReview = gatheredReview, cappedNew = gatheredNew;
    if (!this.col.decks[String(deckId)]?.dyn) {
      const budget = this._limitBudget(deckId);
      cappedDayLearn = gatheredDayLearning.filter((c) => budget.take(c.did, "rev"));
      cappedReview = gatheredReview.filter((c) => budget.take(c.did, "rev"));
      cappedNew = gatheredNew.filter((c) => budget.take(c.did, "new"));
    }
    this._sortNewDisplay(cappedNew, orderDc);

    // Interday-learning vs reviews: 0 = interspersed (v3 default), 1 = after,
    // 2 = before. New-card mix: dc.newMix overrides legacy conf.newSpread.
    const interdayMix = orderDc.interdayMix ?? 0;
    const dayAndReview = interdayMix === 2 ? [...cappedDayLearn, ...cappedReview]
      : interdayMix === 1 ? [...cappedReview, ...cappedDayLearn]
      : this._interleave(cappedReview, cappedDayLearn);
    const newMix = orderDc.newMix ?? this.col.conf?.newSpread ?? 0;
    const main = this._mixNewAndReview(dayAndReview, cappedNew, newMix);
    return {
      // Counts group day-learning with learning (Anki: learn_count includes
      // interday learning); `all` applies the configured mix ordering.
      learning: [...gatheredLearning, ...cappedDayLearn], review: cappedReview, new: cappedNew,
      // Learn-ahead cards are studied early only once everything else is done.
      all: [...gatheredLearning, ...main, ...learningAhead],
    };
  }

  /**
   * Per-deck daily budgets for the v3 limit rule: a card is admitted only if
   * its deck and every ancestor up to (and including) the selected deck still
   * have new/review budget, and admitting it spends one from each.
   */
  _limitBudget(rootId) {
    const root = this.col.decks[String(rootId)];
    const nameToDid = new Map(Object.entries(this.col.decks).map(([id, d]) => [d.name, Number(id)]));
    const remaining = new Map();
    const budgetOf = (did) => {
      if (!remaining.has(did)) {
        const deck = this.col.decks[String(did)];
        // Gather budgets are the same remaining daily limits the deck list
        // displays; a missing deck is unlimited.
        remaining.set(did, deck ? this._remainingLimits(deck)
          : { review: Infinity, new: Infinity, capNewToReview: false });
      }
      return remaining.get(did);
    };
    const chains = new Map(); // card deck id -> deck ids from selected root down to it
    const chainFor = (did) => {
      if (chains.has(did)) return chains.get(did);
      const chain = [];
      const deckName = this.col.decks[String(did)]?.name;
      if (deckName && root?.name) {
        const parts = deckName.split("::");
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join("::");
          if (prefix.length < root.name.length || !prefix.startsWith(root.name)) continue;
          const pid = nameToDid.get(prefix);
          if (pid != null) chain.push(pid);
        }
      }
      chains.set(did, chain.length ? chain : [did]);
      return chains.get(did);
    };
    return {
      // Taking a card requires (and spends) budget along the whole chain.
      // v3: new cards also consume the review budget unless the collection
      // sets "new cards ignore review limit".
      take: (did, kind) => {
        const needRev = kind === "rev" || !this._newCardsIgnoreReviewLimit();
        const entries = chainFor(did).map((d) => budgetOf(d));
        for (const b of entries) {
          if (kind === "new" && b.new <= 0) return false;
          if (needRev && b.review <= 0) return false;
        }
        for (const b of entries) {
          if (kind === "new") b.new -= 1;
          if (needRev) b.review -= 1;
        }
        return true;
      },
    };
  }

  /** Order reviews and new cards per mix mode (0 mix, 1 after, 2 before). */
  _mixNewAndReview(review, newCards, spread) {
    if (spread === 2) return [...newCards, ...review];
    if (spread === 1 || !newCards.length || !review.length) return [...review, ...newCards];
    return this._interleave(review, newCards);
  }

  /** Proportional interleave (Anki's intersperser). */
  _interleave(a, b) {
    const out = [];
    let ai = 0, bi = 0;
    while (ai < a.length || bi < b.length) {
      const af = ai < a.length ? ai / a.length : Infinity;
      const bf = bi < b.length ? bi / b.length : Infinity;
      out.push(af <= bf ? a[ai++] : b[bi++]);
    }
    return out;
  }

  /** New-card gather order (v3 gather priority; legacy new.order=0 → random notes). */
  _orderNewGather(newCards, dc) {
    const prio = dc.newGatherPriority ?? (dc.new?.order === 0 ? 3 : 1);
    if (prio === 1) { newCards.sort((a, b) => a.due - b.due); return; } // lowest position
    const deckName = (c) => this.col.decks[String(c.did)]?.name ?? "";
    const h = (x) => orderHash(x, this.daysElapsed);
    if (prio === 2) newCards.sort((a, b) => b.due - a.due); // highest position
    else if (prio === 3) newCards.sort((a, b) => h(a.nid) - h(b.nid) || a.due - b.due || a.ord - b.ord); // random notes (siblings consecutive)
    else if (prio === 4) newCards.sort((a, b) => h(a.id) - h(b.id)); // random cards
    else if (prio === 5) newCards.sort((a, b) => deckName(a).localeCompare(deckName(b)) || h(a.nid) - h(b.nid) || a.ord - b.ord);
    else newCards.sort((a, b) => deckName(a).localeCompare(deckName(b)) || a.due - b.due || a.ord - b.ord); // 0: deck, then position
  }

  /** New-card display sort (applied after capping). */
  _sortNewDisplay(cappedNew, dc) {
    const order = dc.newSortOrder ?? 0;
    if (order === 1) return; // no sort — keep gather order
    const h = (x) => orderHash(x, this.daysElapsed);
    if (order === 2) cappedNew.sort((a, b) => a.ord - b.ord || h(a.id) - h(b.id)); // template then random
    else if (order === 3) cappedNew.sort((a, b) => h(a.nid) - h(b.nid) || a.ord - b.ord); // random note then template
    else if (order === 4) cappedNew.sort((a, b) => h(a.id) - h(b.id)); // random card
    else cappedNew.sort((a, b) => a.ord - b.ord); // 0: template (stable — gather order within an ordinal)
  }

  /** Review gather order (v3 review_order enum). */
  _orderReviewGather(review, dc) {
    const ro = dc.reviewOrder ?? 0;
    if (ro === 0) { review.sort((a, b) => a.due - b.due); return; } // due day
    const deckName = (c) => this.col.decks[String(c.did)]?.name ?? "";
    const h = (x) => orderHash(x, this.daysElapsed);
    const retr = (c) => this._retrievabilityForOrder(c);
    const key = {
      1: (a, b) => a.due - b.due || deckName(a).localeCompare(deckName(b)),        // day then deck
      2: (a, b) => deckName(a).localeCompare(deckName(b)) || a.due - b.due,        // deck then day
      3: (a, b) => a.ivl - b.ivl,                                                  // intervals ascending
      4: (a, b) => b.ivl - a.ivl,                                                  // intervals descending
      5: (a, b) => a.factor - b.factor,                                            // ease ascending
      6: (a, b) => b.factor - a.factor,                                            // ease descending
      7: (a, b) => retr(a) - retr(b),                                              // retrievability ascending
      11: (a, b) => retr(b) - retr(a),                                             // retrievability descending
      // relative overdueness: -(1 + (today−due+0.001)/ivl) asc → ratio desc
      12: (a, b) => (this.daysElapsed - b.due + 0.001) / Math.max(b.ivl, 1) - (this.daysElapsed - a.due + 0.001) / Math.max(a.ivl, 1),
      8: (a, b) => h(a.id) - h(b.id),                                              // random
      9: (a, b) => a.id - b.id,                                                    // added
      10: (a, b) => b.id - a.id,                                                   // reverse added
    }[ro];
    review.sort(key ?? ((a, b) => a.due - b.due));
  }

  /** Retrievability estimate for review ordering (FSRS curve, else SM-2 approx). */
  _retrievabilityForOrder(card) {
    const elapsed = Math.max(this.daysElapsed - card.due, 0) + Math.max(card.ivl, 0);
    const s = card.memoryState?.stability;
    if (s) {
      const decay = -0.1542; // FSRS-6 default decay — an ordering key, not scheduling
      const factor = Math.exp(Math.log(0.9) / decay) - 1;
      return Math.pow((elapsed / s) * factor + 1, decay);
    }
    return Math.pow(0.9, elapsed / Math.max(card.ivl, 1));
  }

  /**
   * Un-bury scheduler/user-buried cards once per day (restoring queue from type).
   * Call this on collection load and persist if it returns > 0. Returns the
   * number of cards unburied. Idempotent within a day.
   */
  unburyForNewDay() {
    if (this.col.conf._lastUnburyDay === this.daysElapsed) return 0;
    let changed = 0;
    for (const card of this.col.cards.values()) {
      if (card.queue === CardQueue.SchedBuried || card.queue === CardQueue.UserBuried) {
        card.queue = card.type === CardType.Review ? CardQueue.Review
          : card.type === CardType.New ? CardQueue.New
          : CardQueue.Learning;
        changed++;
      }
    }
    this.col.conf._lastUnburyDay = this.daysElapsed;
    return changed;
  }

  /**
   * Bury a card's siblings (same note) per the deck's bury settings. v3
   * carve-out (rslib bury_and_suspend.rs): only siblings whose queue is
   * gathered at or after the answered card's queue are buried — answering a
   * review buries new siblings but never day-learning ones, etc.
   * Rank order: intraday learning 0 < day-learning 1 < review 2 < new 3.
   */
  _burySiblings(card, answeredQueue) {
    const dc = this.deckConfigFor(card);
    const buryNew = dc.new?.bury ?? false;
    const buryRev = dc.rev?.bury ?? false;
    if (!buryNew && !buryRev) return;
    const RANK = {
      [CardQueue.Learning]: 0, [CardQueue.Preview]: 0,
      [CardQueue.DayLearning]: 1, [CardQueue.Review]: 2, [CardQueue.New]: 3,
    };
    const answeredRank = RANK[answeredQueue] ?? 0;
    for (const sib of this.col.cards.values()) {
      if (sib.nid !== card.nid || sib.id === card.id) continue;
      if ((RANK[sib.queue] ?? 99) < answeredRank) continue;
      if ((sib.queue === CardQueue.New && buryNew) || (sib.queue === CardQueue.Review && buryRev)) {
        sib.queue = CardQueue.SchedBuried;
      }
    }
  }

  // --- card operations (manual) ---

  _queueForType(card) {
    return card.type === CardType.Review ? CardQueue.Review
      : card.type === CardType.New ? CardQueue.New : CardQueue.Learning;
  }
  _touch(card) { card.mod = this.now; card.usn = -1; }

  suspend(card) { card.queue = CardQueue.Suspended; this._touch(card); }
  unsuspend(card) {
    if (card.queue === CardQueue.Suspended) card.queue = this._queueForType(card);
    this._touch(card);
  }
  buryCard(card) { card.queue = CardQueue.UserBuried; this._touch(card); }
  setFlag(card, n) { card.flags = (card.flags & ~7) | (n & 7); this._touch(card); }
  /** Toggle flag n (1–7) on a card, exclusively (Anki-style): at most one
   * flag; toggling the active one clears it. (Legacy multi-flag cards still
   * read correctly; any toggle collapses them to the exclusive form.) */
  toggleFlag(card, n) {
    const s = cardFlagSet(card);
    writeCardFlags(card, s.size === 1 && s.has(n) ? new Set() : new Set([n]));
    this._touch(card);
  }

  /** Reset a card to "new" (forget), giving it a fresh position. */
  forget(card) {
    card.type = CardType.New;
    card.queue = CardQueue.New;
    card.ivl = 0;
    card.factor = 0;
    card.reps = 0;
    card.lapses = 0;
    card.left = 0;
    card.odue = 0;
    card.odid = 0;
    card.memoryState = null;
    const due = this.col.conf.nextPos ?? 1;
    this.col.conf.nextPos = due + 1;
    card.due = due;
    this._touch(card);
  }

  /** Schedule a card as a review card due in `days` days. */
  setDueDate(card, days) {
    card.type = CardType.Review;
    card.queue = CardQueue.Review;
    card.ivl = Math.max(days, 1);
    card.due = this.daysElapsed + days;
    card.left = 0;
    card.odue = 0;
    card.odid = 0;
    this._touch(card);
  }

  /** Move a card to another (normal) deck. */
  moveCard(card, did) {
    card.did = did;
    card.odid = 0;
    card.odue = 0;
    this._touch(card);
  }

  // --- filtered (dynamic) decks ---

  /**
   * Gather cards matching `matchFn` into a filtered deck (reschedule mode):
   * remembers each card's home deck (odid) and, for review cards, its due
   * (odue) before making it due now. Returns the number of cards gathered.
   */
  buildFiltered(filteredDeckId, matchFn) {
    let count = 0;
    for (const card of this.col.cards.values()) {
      if (card.odid) continue;             // already in a filtered deck
      if (card.did === filteredDeckId) continue;
      if (card.queue === CardQueue.Suspended) continue;
      if (card.queue === CardQueue.UserBuried || card.queue === CardQueue.SchedBuried) continue;
      if (!matchFn(card)) continue;
      card.odid = card.did;
      card.did = filteredDeckId;
      if (card.type === CardType.Review) {
        card.odue = card.due;
        card.due = this.daysElapsed; // make it due today inside the filtered deck
      }
      count++;
    }
    return count;
  }

  /** Return a filtered deck's cards to their home decks (restoring unreviewed due). */
  emptyFiltered(filteredDeckId) {
    for (const card of this.col.cards.values()) {
      if (card.did !== filteredDeckId || !card.odid) continue;
      card.did = card.odid;
      card.odid = 0;
      if (card.odue) { card.due = card.odue; card.odue = 0; } // unreviewed: restore due
    }
  }

  /** Read a deck's [dayStamp, count] counter, treating stale stamps as 0. */
  _counterValue(deck, key) {
    const c = deck[key];
    return Array.isArray(c) && c[0] === this.daysElapsed ? c[1] : 0;
  }

  /** Increment a deck's daily counter, resetting it if the day rolled over. */
  _bumpCounter(deck, key) {
    const c = deck[key];
    if (Array.isArray(c) && c[0] === this.daysElapsed) c[1] += 1;
    else deck[key] = [this.daysElapsed, 1];
  }

  /** Count a studied card against its deck + ancestors' new/review daily totals. */
  _bumpStudyCounters(did, kind) {
    const key = kind === "new" ? "newToday" : kind === "review" ? "revToday" : null;
    if (!key) return; // learning/relearning steps don't consume the daily caps
    const deck = this.col.decks[String(did)];
    if (!deck) return;
    this._bumpCounter(deck, key);
    const parts = deck.name.split("::");
    for (let i = 1; i < parts.length; i++) {
      const anc = this.col.decks[
        Object.keys(this.col.decks).find((id) => this.col.decks[id].name === parts.slice(0, i).join("::"))
      ];
      if (anc) this._bumpCounter(anc, key);
    }
  }

  /** Learn-ahead window in seconds (Anki config `collapseTime`, default 20 min). */
  _learnAheadSecs() {
    return this.col.conf?.collapseTime ?? 1200;
  }

  /**
   * "New cards ignore review limit" (rslib BoolKey::NewCardsIgnoreReviewLimit)
   * is a collection-wide flag, default false. Older versions of this app stored
   * it per preset (dconf.new.ignoreReviewLimit); honor that as a fallback so
   * existing collections keep their behavior.
   */
  _newCardsIgnoreReviewLimit() {
    return this.col.conf?.newCardsIgnoreReviewLimit
      ?? Object.values(this.col.dconf ?? {}).some((dc) => dc.new?.ignoreReviewLimit)
      ?? false;
  }

  /**
   * Remaining daily limits for one deck today (rslib decks/limits.rs
   * RemainingLimits::new): a per-deck limit set "today" wins over a plain
   * per-deck override, which wins over the deck options preset. Studied-today
   * counters are subtracted — and new cards studied today also eat the review
   * budget unless the collection-wide ignore flag is set. Filtered decks have
   * no limits.
   */
  _remainingLimits(deck) {
    if (deck.dyn) return { review: 9999, new: 9999, capNewToReview: false };
    const dc = this.deckConfigFor({ did: deck.id });
    const today = this.daysElapsed;
    let review = (deck.revLimitToday?.today === today ? deck.revLimitToday.limit : null)
      ?? deck.revLimit ?? dc.rev?.perDay ?? 200;
    let newLimit = (deck.newLimitToday?.today === today ? deck.newLimitToday.limit : null)
      ?? deck.newLimit ?? dc.new?.perDay ?? 20;
    const newToday = this._counterValue(deck, "newToday");
    review -= this._counterValue(deck, "revToday");
    newLimit -= newToday;
    const capNewToReview = !this._newCardsIgnoreReviewLimit();
    if (capNewToReview) {
      review -= newToday;
      newLimit = Math.min(newLimit, review);
    }
    return { review: Math.max(review, 0), new: Math.max(newLimit, 0), capNewToReview };
  }

  /**
   * Raw due counts per deck (rslib storage/deck/due_counts.sql): no daily
   * limits and no sibling-burying simulation — the deck list counts every due
   * card, even ones a study session would bury. Intraday learning counts cards
   * due within the learn-ahead window; new cards have no due cutoff.
   */
  _dueCountsPerDeck() {
    const learnCutoff = this.now + this._learnAheadSecs();
    const counts = new Map(); // did -> { new, review, intraday, interday }
    const entry = (did) => {
      if (!counts.has(did)) counts.set(did, { new: 0, review: 0, intraday: 0, interday: 0 });
      return counts.get(did);
    };
    for (const card of this.col.cards.values()) {
      switch (card.queue) {
        case CardQueue.New: entry(card.did).new++; break;
        case CardQueue.Review:
          if (card.due <= this.daysElapsed) entry(card.did).review++;
          break;
        case CardQueue.DayLearning:
          if (card.due <= this.daysElapsed) entry(card.did).interday++;
          break;
        case CardQueue.Learning:
          if (card.due < learnCutoff) entry(card.did).intraday++;
          break;
        case CardQueue.Preview:
          if (card.due <= learnCutoff) entry(card.did).intraday++;
          break;
        // suspended / buried: not counted
      }
    }
    return counts;
  }

  /**
   * Displayed due counts for every deck (rslib decks/tree.rs
   * sum_counts_and_apply_limits_v3): a node's count is its own cards plus its
   * children's capped counts, capped by the node's remaining daily limits —
   * interday learning spends the review budget first, then reviews, then new
   * cards. Children are additionally capped by ancestor limits only when the
   * collection-wide "apply all parent limits" flag is set (default off).
   * @returns {Map<number, { new: number, learning: number, review: number }>}
   */
  deckCounts() {
    const due = this._dueCountsPerDeck();
    const decks = Object.values(this.col.decks);
    const limits = new Map(decks.map((d) => [d.id, this._remainingLimits(d)]));
    // Parent linkage by name; a deck whose parent is missing attaches to the
    // nearest existing ancestor (Anki drops it from the tree until a DB check).
    const byName = new Map(decks.map((d) => [d.name, d.id]));
    const children = new Map(); // parent did (0 = top level) -> [did]
    for (const d of decks) {
      const parts = d.name.split("::");
      let pid = 0;
      for (let i = parts.length - 1; i > 0 && !pid; i--) {
        const anc = byName.get(parts.slice(0, i).join("::"));
        if (anc != null && anc !== d.id) pid = anc;
      }
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(d.id);
    }
    const applyAll = this.col.conf?.applyAllParentLimits ?? false;
    const out = new Map();
    const visit = (did, parentLimits) => {
      const rem = { ...limits.get(did) };
      if (parentLimits) { // RemainingLimits::cap_to(parent)
        rem.review = Math.min(rem.review, parentLimits.review);
        rem.new = Math.min(rem.new, parentLimits.new);
      }
      const sum = due.get(did) ?? { new: 0, review: 0, intraday: 0, interday: 0 };
      const total = { ...sum };
      for (const kid of children.get(did) ?? []) {
        const c = visit(kid, applyAll ? rem : null);
        total.new += c.new; total.review += c.review;
        total.intraday += c.intraday; total.interday += c.interday;
      }
      const interday = Math.min(total.interday, rem.review);
      const left = rem.review - interday;
      const review = Math.min(total.review, left);
      let newC = Math.min(total.new, rem.new);
      if (rem.capNewToReview) newC = Math.min(newC, left - review);
      const capped = { new: newC, review, intraday: total.intraday, interday };
      out.set(did, { new: capped.new, learning: capped.intraday + capped.interday, review: capped.review });
      return capped;
    };
    for (const top of children.get(0) ?? []) visit(top, applyAll ? { review: 9999, new: 9999 } : null);
    return out;
  }

  /** Due counts for a deck (and subdecks) as shown in the deck list: { new, learning, review }. */
  counts(deckId) {
    return this.deckCounts().get(Number(deckId)) ?? { new: 0, learning: 0, review: 0 };
  }

  /** Preview the four button outcomes for a card without mutating it. */
  nextStates(card) {
    const current = this.cardToState(card);
    const ctx = this.contextFor(card, current);
    const s = nextStatesFor(current, ctx);
    const wrap = (state) => ({ state, interval: maybeAsDays(intervalKindOf(state), this.secsUntilRollover) });
    return { again: wrap(s.again), hard: wrap(s.hard), good: wrap(s.good), easy: wrap(s.easy) };
  }

  /**
   * Answer a card with a rating; mutates the card in place and returns the
   * revlog entry recorded (also appended to the collection).
   * @param {import("./model.js").Card} card
   * @param {number} rating 1=Again 2=Hard 3=Good 4=Easy
   * @param {{ nowMs?: number, takenMs?: number }} [opts]
   */
  answerCard(card, rating, opts = {}) {
    const current = this.cardToState(card);
    const ctx = this.contextFor(card, current);
    const states = nextStatesFor(current, ctx);
    const next = [null, states.again, states.hard, states.good, states.easy][rating];
    if (!next) throw new Error(`invalid rating: ${rating}`);

    const lastInterval = asRevlogInterval(intervalKindOf(current));
    const answeredQueue = card.queue; // captured pre-answer for the bury carve-out
    const wasDayLearning = card.queue === CardQueue.DayLearning;
    card.reps += 1;
    if (this.fsrsEnabled) card.desiredRetention = this.desiredRetentionFor(this.deckConfigFor(card));
    // Interday learning cards consume the review budget in v3.
    this._bumpStudyCounters(card.did, wasDayLearning ? "review" : current.kind);
    this._applyState(card, next);
    if (stateLeeched(next)) {
      // Anki always tags the note "leech"; the suspend action additionally suspends.
      const note = this.col.notes.get(card.nid);
      if (note && !note.tags.includes("leech")) {
        note.tags.push("leech");
        note.mod = this.now;
        note.usn = -1;
      }
      if ((this.deckConfigFor(card).lapse?.leechAction ?? 1) === 0) {
        card.queue = CardQueue.Suspended;
      }
    }
    card.mod = this.now;
    card.usn = -1;
    if (card.odid) card.odue = 0; // answered inside a filtered deck → rescheduled, don't restore
    this._burySiblings(card, answeredQueue); // hide other cards of the same note until tomorrow
    this._loadBalanceUpdate(card); // keep the load balancer's day cache in step

    const entry = new Revlog({
      id: opts.nowMs ?? nowMs(),
      cid: card.id,
      usn: -1,
      ease: rating,
      ivl: asRevlogInterval(intervalKindOf(next)),
      lastIvl: lastInterval,
      factor: Math.round(card.factor || 0),
      time: Math.min(opts.takenMs ?? 0, 60000),
      type: revlogKindOf(current.kind),
    });
    this.col.addRevlog(entry);
    return entry;
  }

  /** Write a target state into the card's columns (answering/*). */
  _applyState(card, state) {
    switch (state.kind) {
      case "new":
        card.type = CardType.New;
        card.queue = CardQueue.New;
        card.due = state.position;
        card.memoryState = null;
        return;
      case "learning":
        this._applyLearning(card, state, CardType.Learning, state);
        return;
      case "review":
        card.type = CardType.Review;
        card.queue = CardQueue.Review;
        card.ivl = state.scheduledDays;
        card.due = this.daysElapsed + state.scheduledDays;
        card.factor = Math.round(state.easeFactor * 1000);
        card.lapses = state.lapses;
        card.left = 0;
        card.memoryState = state.memoryState ?? null;
        return;
      case "relearning":
        card.type = CardType.Relearning;
        card.ivl = state.review.scheduledDays;
        card.factor = Math.round(state.review.easeFactor * 1000);
        card.lapses = state.review.lapses;
        this._applyLearning(card, state.learning, CardType.Relearning, state.learning);
        return;
      default:
        throw new Error(`unknown state kind: ${state.kind}`);
    }
  }

  /** Shared learning/relearning column write (queue + due from interval kind). */
  _applyLearning(card, learn, type, memSource) {
    card.type = type;
    card.left = learn.remainingSteps;
    card.memoryState = memSource.memoryState ?? null;
    // Intraday learning delays get +0..25% fuzz (max +5 min), seeded per
    // card+reps like review fuzz (rslib answering/learning.rs) — keeps cards
    // answered in a batch from re-dueing in lockstep.
    let secs = learn.scheduledSecs;
    if (this.fuzz) secs += Math.floor(fuzzFactorFor(card) * Math.min(secs * 0.25, 300));
    const kind = maybeAsDays({ secs }, this.secsUntilRollover);
    if (kind.secs !== undefined) {
      card.queue = CardQueue.Learning;
      card.due = this.now + kind.secs; // epoch seconds
      card.ivl = type === CardType.Relearning ? card.ivl : 0;
    } else {
      card.queue = CardQueue.DayLearning;
      card.due = this.daysElapsed + kind.days;
      if (type === CardType.Learning) card.ivl = 0;
    }
  }
}

function stateLeeched(state) {
  if (state.kind === "review") return state.leeched;
  if (state.kind === "relearning") return state.review.leeched;
  return false;
}

// Expose pure transition helpers for testing against rslib's unit vectors.
export const _internal = {
  LearningSteps, nextStatesFor, reviewNextStates, learnNextStates, relearnNextStates,
  leechThresholdMet, withReviewFuzz, constrainedFuzzBounds, fuzzDelta,
  INITIAL_EASE_FACTOR, MINIMUM_EASE_FACTOR,
};
