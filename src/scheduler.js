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
// decks, preview, load balancing, sibling burying, the a*1000 "reps left today"
// component of `left`, and leech actions beyond suspend are not yet implemented.

import { CardType, CardQueue, RevlogType, Revlog } from "./model.js";
import { FSRS, DEFAULT_PARAMETERS } from "./fsrs.js";
import { nowMs, nowSec } from "./ids.js";

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
  const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
  return Math.floor(lower + ctx.fuzzFactor * (1 + upper - lower));
}

/** Deterministic fuzz factor in [0,1) from a card's id + reps. */
function fuzzFactorFor(card) {
  let x = ((Number(card.id) >>> 0) ^ ((card.reps * 2654435761) >>> 0)) >>> 0;
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
  const daysLate = Math.max(r.elapsedDays - r.scheduledDays, 0);
  const hardFactor = ctx.hardMultiplier;
  const hardMin = hardFactor <= 1 ? 0 : r.scheduledDays + 1;
  const hard = constrainPassing(ctx, current * hardFactor, hardMin);
  const goodMin = hardFactor <= 1 ? r.scheduledDays + 1 : hard + 1;
  const good = constrainPassing(ctx, (current + daysLate / 2) * r.easeFactor, goodMin);
  const easy = constrainPassing(ctx, (current + daysLate) * r.easeFactor * ctx.easyMultiplier, good + 1);
  return [hard, good, easy];
}

function failingReviewInterval(r, ctx) {
  if (ctx.fsrs) return [ctx.fsrs.again.interval, fsrsMem(ctx.fsrs.again)];
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
    // timing: crt is the rollover anchor (Anki aligns it).
    const delta = this.now - (collection.crt ?? 0);
    this.daysElapsed = Math.floor(delta / DAY);
    this.secsUntilRollover = DAY - (((delta % DAY) + DAY) % DAY);
  }

  /** Resolve the deck options group (dconf) for a card's deck. */
  deckConfigFor(card) {
    let deck = this.col.decks[String(card.did)];
    // Filtered decks use the card's original (home) deck options.
    if (deck?.dyn && card.odid) deck = this.col.decks[String(card.odid)] ?? deck;
    const dcId = deck && deck.conf != null ? String(deck.conf) : "1";
    return this.col.dconf[dcId] ?? this.col.dconf["1"] ?? {};
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
    };

    if (this.fsrsEnabled) {
      const fsrs = new FSRS(this.fsrsParameters, this.desiredRetentionFor(dc));
      const elapsed = current.kind === "review" ? current.elapsedDays
        : current.kind === "relearning" ? current.review.elapsedDays : 0;
      const mem = current.kind === "review" ? current.memoryState
        : current.kind === "relearning" ? current.review.memoryState
        : current.kind === "learning" ? current.memoryState : null;
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
        const due = Math.min(card.due, this.daysElapsed);
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
   * Gather the cards due now in a deck (and its subdecks), grouped and capped at
   * the deck's per-day new/review limits minus what's already been studied today
   * (tracked in the deck's newToday/revToday counters). Uses a fixed study order
   * (due learning, then reviews, then new).
   * @returns {{ learning: Card[], review: Card[], new: Card[], all: Card[] }}
   */
  queue(deckId, { now } = {}) {
    const nowS = now ?? this.now;
    const learnAheadSecs = this.col.conf?.collapseTime ?? 1200;
    const dids = this._deckAndDescendants(deckId);
    const learning = [], learningAhead = [], review = [], newCards = [];
    for (const card of this.col.cards.values()) {
      if (!dids.has(card.did)) continue;
      switch (card.queue) {
        case CardQueue.Learning:
          if (card.due <= nowS) learning.push(card);
          else if (card.due <= nowS + learnAheadSecs) learningAhead.push(card); // learn-ahead
          break;
        case CardQueue.DayLearning:
          if (card.due <= this.daysElapsed) learning.push(card);
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
    learning.sort(byDue);
    learningAhead.sort(byDue);
    review.sort(byDue);
    newCards.sort(byDue);

    const deck = this.col.decks[String(deckId)];
    const isDyn = !!deck?.dyn;
    // Filtered decks ignore per-day limits and "studied today" counters.
    const dc = this.deckConfigFor({ did: deckId });
    const newPerDay = isDyn ? Infinity : (dc.new?.perDay ?? 20);
    const revPerDay = isDyn ? Infinity : (dc.rev?.perDay ?? 200);
    const newDone = isDyn || !deck ? 0 : this._counterValue(deck, "newToday");
    const revDone = isDyn || !deck ? 0 : this._counterValue(deck, "revToday");
    const cappedNew = newCards.slice(0, Math.max(0, newPerDay - newDone));
    const cappedReview = review.slice(0, Math.max(0, revPerDay - revDone));
    return {
      learning, review: cappedReview, new: cappedNew,
      // Learn-ahead cards are studied early only once everything else is done.
      all: [...learning, ...cappedReview, ...cappedNew, ...learningAhead],
    };
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

  /** Bury a card's siblings (same note) per the deck's bury settings. */
  _burySiblings(card) {
    const dc = this.deckConfigFor(card);
    const buryNew = dc.new?.bury ?? true;
    const buryRev = dc.rev?.bury ?? true;
    for (const sib of this.col.cards.values()) {
      if (sib.nid !== card.nid || sib.id === card.id) continue;
      if ((sib.queue === CardQueue.New && buryNew) || (sib.queue === CardQueue.Review && buryRev)) {
        sib.queue = CardQueue.SchedBuried;
      }
    }
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

  /** Due counts for a deck (and subdecks): { new, learning, review }. */
  counts(deckId, opts) {
    const q = this.queue(deckId, opts);
    return { new: q.new.length, learning: q.learning.length, review: q.review.length };
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
    card.reps += 1;
    if (this.fsrsEnabled) card.desiredRetention = this.desiredRetentionFor(this.deckConfigFor(card));
    this._bumpStudyCounters(card.did, current.kind); // count against daily new/review caps
    this._applyState(card, next);
    if (stateLeeched(next) && (this.deckConfigFor(card).lapse?.leechAction ?? 0) === 0) {
      card.queue = CardQueue.Suspended;
    }
    card.mod = this.now;
    card.usn = -1;
    if (card.odid) card.odue = 0; // answered inside a filtered deck → rescheduled, don't restore
    this._burySiblings(card); // hide other cards of the same note until tomorrow

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
    const kind = maybeAsDays({ secs: learn.scheduledSecs }, this.secsUntilRollover);
    if (kind.secs !== undefined) {
      card.queue = CardQueue.Learning;
      card.due = this.now + kind.secs; // epoch seconds (fuzz disabled)
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
