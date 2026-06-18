// Scheduler tests. The pure-transition cases replicate the golden vectors
// embedded in anki/rslib/src/scheduler/states/{review,learning,relearning}.rs
// (using their `defaults_for_testing` context). The end-to-end cases drive a
// real card through the lifecycle in both SM-2 and FSRS modes.

import test from "node:test";
import assert from "node:assert/strict";

import { Scheduler, _internal } from "../src/scheduler.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { Rating } from "../src/fsrs.js";

const { LearningSteps, reviewNextStates, learnNextStates, relearnNextStates, leechThresholdMet } = _internal;

// Mirror rslib StateContext::defaults_for_testing().
function testCtx(over = {}) {
  return {
    steps: new LearningSteps([1, 10]),
    relearnSteps: new LearningSteps([10]),
    graduatingIntervalGood: 1,
    graduatingIntervalEasy: 4,
    initialEaseFactor: 2.5,
    hardMultiplier: 1.2,
    easyMultiplier: 1.3,
    intervalMultiplier: 1.0,
    maximumReviewInterval: 36500,
    leechThreshold: 8,
    lapseMultiplier: 0.0,
    minimumLapseInterval: 1,
    fsrs: null,
    fsrsShortTermWithSteps: false,
    ...over,
  };
}

const reviewState = (o) => ({ scheduledDays: 0, elapsedDays: 0, easeFactor: 2.5, lapses: 0, leeched: false, memoryState: null, ...o });
const learnState = (remainingSteps) => ({ remainingSteps, scheduledSecs: 60, elapsedSecs: 0, memoryState: null });

// --- review.rs vectors ---

test("review passing intervals (2,3,4) with ease 1.3 [review.rs]", () => {
  const s = reviewNextStates(reviewState({ scheduledDays: 1, elapsedDays: 1, easeFactor: 1.3 }), testCtx());
  assert.deepEqual([s.hard.scheduledDays, s.good.scheduledDays, s.easy.scheduledDays], [2, 3, 4]);
});

test("low hard multiplier doesn't pull good down → (1,3,4) [review.rs]", () => {
  const s = reviewNextStates(reviewState({ scheduledDays: 2, elapsedDays: 2, easeFactor: 1.3 }), testCtx({ hardMultiplier: 0.1 }));
  assert.deepEqual([s.hard.scheduledDays, s.good.scheduledDays, s.easy.scheduledDays], [1, 3, 4]);
});

test("maximum interval respected → (5,5,5) [review.rs]", () => {
  const s = reviewNextStates(reviewState({ scheduledDays: 1, elapsedDays: 1, easeFactor: 1.3 }), testCtx({ intervalMultiplier: 10, maximumReviewInterval: 5 }));
  assert.deepEqual([s.hard.scheduledDays, s.good.scheduledDays, s.easy.scheduledDays], [5, 5, 5]);
});

test("ease deltas: again -0.2 (floored 1.3), hard -0.15, easy +0.15", () => {
  const s = reviewNextStates(reviewState({ scheduledDays: 10, elapsedDays: 10, easeFactor: 2.5, lapses: 0 }), testCtx());
  // With default relearn steps, Again stays in relearning; ease lives on .review.
  assert.equal(s.again.kind, "relearning");
  assert.equal(s.again.review.easeFactor, 2.3);
  assert.equal(s.again.review.lapses, 1);
  assert.ok(Math.abs(s.hard.easeFactor - 2.35) < 1e-6);
  assert.equal(s.good.easeFactor, 2.5);
  assert.ok(Math.abs(s.easy.easeFactor - 2.65) < 1e-6);
});

test("leech threshold [review.rs]", () => {
  assert.equal(leechThresholdMet(3, 3), true);
  assert.equal(leechThresholdMet(4, 3), false);
  assert.equal(leechThresholdMet(5, 3), true);
  assert.equal(leechThresholdMet(8, 8), true);
  assert.equal(leechThresholdMet(0, 0), false);
});

// --- learning.rs vectors ---

test("learn: again resets to first step (remaining 2, 60s) [learning.rs]", () => {
  for (const remaining of [1, 2]) {
    const s = learnNextStates(learnState(remaining), testCtx());
    assert.equal(s.again.kind, "learning");
    assert.equal(s.again.remainingSteps, 2);
    assert.equal(s.again.scheduledSecs, 60);
  }
});

test("learn: hard on first step = avg → 330s, stays; last step = 600s [learning.rs]", () => {
  const first = learnNextStates(learnState(2), testCtx()).hard;
  assert.deepEqual([first.kind, first.remainingSteps, first.scheduledSecs], ["learning", 2, 330]);
  const last = learnNextStates(learnState(1), testCtx()).hard;
  assert.deepEqual([last.kind, last.remainingSteps, last.scheduledSecs], ["learning", 1, 600]);
});

test("learn: good advances step (2→1, 600s); from last graduates to review 1d [learning.rs]", () => {
  const adv = learnNextStates(learnState(2), testCtx()).good;
  assert.deepEqual([adv.kind, adv.remainingSteps, adv.scheduledSecs], ["learning", 1, 600]);
  const grad = learnNextStates(learnState(1), testCtx()).good;
  assert.deepEqual([grad.kind, grad.scheduledDays], ["review", 1]);
});

test("learn: easy always graduates, easy(4) > good(1) [learning.rs]", () => {
  const s = learnNextStates(learnState(1), testCtx());
  assert.equal(s.easy.kind, "review");
  assert.ok(s.easy.scheduledDays > s.good.scheduledDays);
  assert.equal(s.easy.scheduledDays, 4);
});

test("learn: with no steps, again/hard graduate to review 1d [learning.rs]", () => {
  const s = learnNextStates(learnState(0), testCtx({ steps: new LearningSteps([]) }));
  assert.equal(s.again.kind, "review");
  assert.equal(s.again.scheduledDays, 1);
  assert.equal(s.hard.kind, "review");
});

// --- relearning.rs vectors ---

const relearnState = () => ({
  learning: { remainingSteps: 1, scheduledSecs: 600, elapsedSecs: 0, memoryState: null },
  review: reviewState({ scheduledDays: 3, elapsedDays: 3, ease_factor: 2.5, lapses: 1 }),
});

test("relearn: again stays relearning, applies lapse penalty 3→1 [relearning.rs]", () => {
  const s = relearnNextStates(relearnState(), testCtx());
  assert.equal(s.again.kind, "relearning");
  assert.equal(s.again.review.scheduledDays, 1);
});

test("relearn: good from last step graduates to review (3d); easy = +1 (4d) [relearning.rs]", () => {
  const s = relearnNextStates(relearnState(), testCtx());
  assert.equal(s.good.kind, "review");
  assert.equal(s.good.scheduledDays, 3);
  assert.equal(s.easy.kind, "review");
  assert.equal(s.easy.scheduledDays, 4);
});

test("relearn: again with two steps resets to first (remaining 2) [relearning.rs]", () => {
  const ctx = testCtx({ relearnSteps: new LearningSteps([5, 10]) });
  const s = relearnNextStates(relearnState(), ctx);
  assert.equal(s.again.kind, "relearning");
  assert.equal(s.again.learning.remainingSteps, 2);
});

test("relearn FSRS: no steps → review uses algorithm intervals (2,3,5,7) [relearning.rs]", () => {
  const fsrs = (a, h, g, e) => ({
    again: { state: { stability: 4, difficulty: 5 }, interval: a },
    hard: { state: { stability: 4, difficulty: 5 }, interval: h },
    good: { state: { stability: 4, difficulty: 5 }, interval: g },
    easy: { state: { stability: 4, difficulty: 5 }, interval: e },
  });
  const ctx = testCtx({ relearnSteps: new LearningSteps([]), fsrs: fsrs(2, 3, 5, 7) });
  const s = relearnNextStates(relearnState(), ctx);
  assert.equal(s.again.scheduledDays, 2);
  assert.equal(s.hard.scheduledDays, 3);
  assert.equal(s.good.scheduledDays, 5);
  assert.equal(s.easy.scheduledDays, 7);
});

// --- end-to-end SM-2 lifecycle ---

test("SM-2 lifecycle: new → learning → graduates to review", () => {
  const col = Collection.createDefault();
  col.crt = Math.floor(Date.now() / 1000) - 100 * 86400;
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const card = col.addCard(new Card({ nid: note.id, did: 1 }));
  const sched = new Scheduler(col);

  assert.equal(card.type, CardType.New);
  // Good on a new card → enters learning at step 2 (10 min).
  sched.answerCard(card, Rating.Good);
  assert.equal(card.type, CardType.Learning);
  assert.equal(card.queue, CardQueue.Learning);
  assert.equal(card.left, 1);
  assert.equal(card.reps, 1);

  // Good again → graduates to review with the good graduating interval (1 day).
  sched.answerCard(card, Rating.Good);
  assert.equal(card.type, CardType.Review);
  assert.equal(card.queue, CardQueue.Review);
  assert.equal(card.ivl, 1);
  assert.equal(card.factor, 2500);
  assert.equal(col.revlog.length, 2);
});

test("SM-2: Again on a review card lapses it into relearning", () => {
  const col = Collection.createDefault();
  col.crt = Math.floor(Date.now() / 1000) - 100 * 86400;
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const card = col.addCard(new Card({
    nid: note.id, did: 1, type: CardType.Review, queue: CardQueue.Review,
    ivl: 30, factor: 2500, reps: 5, due: 0,
  }));
  const sched = new Scheduler(col);

  sched.answerCard(card, Rating.Again);
  assert.equal(card.type, CardType.Relearning);
  assert.equal(card.lapses, 1);
  assert.equal(card.factor, 2300); // ease dropped 0.2
  assert.equal(card.queue, CardQueue.Learning);
});

test("FSRS lifecycle: new card gets memory state and FSRS-derived interval", () => {
  const col = Collection.createDefault();
  col.crt = Math.floor(Date.now() / 1000) - 100 * 86400;
  col.conf.fsrs = true;
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const card = col.addCard(new Card({ nid: note.id, did: 1 }));
  const sched = new Scheduler(col);

  // Preview: Easy on a brand-new FSRS card should give a positive day interval.
  const preview = sched.nextStates(card);
  assert.ok(preview.easy.interval.days >= 1);

  sched.answerCard(card, Rating.Easy);
  assert.equal(card.type, CardType.Review);
  const mem = card.memoryState;
  assert.ok(mem && mem.stability > 0 && mem.difficulty >= 1 && mem.difficulty <= 10);
  // Review interval should match FSRS nextInterval(stability) at 0.9 retention, ~= stability.
  assert.ok(card.ivl >= 1);
  assert.equal(col.revlog.length, 1);
});
