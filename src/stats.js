// Collection statistics — pure functions over a Collection, so they're testable
// in Node and reusable by any UI.
//
// "Mature" follows Anki's convention: a review card with interval >= 21 days.

import { CardType, CardQueue, RevlogType } from "./model.js";

const MATURE_IVL = 21;

/** Card counts by state. */
export function cardCounts(col) {
  const c = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0, buried: 0, total: 0 };
  for (const card of col.cards.values()) {
    c.total++;
    if (card.queue === CardQueue.Suspended) { c.suspended++; continue; }
    if (card.queue === CardQueue.UserBuried || card.queue === CardQueue.SchedBuried) { c.buried++; continue; }
    switch (card.type) {
      case CardType.New: c.new++; break;
      case CardType.Learning: case CardType.Relearning: c.learning++; break;
      case CardType.Review: (card.ivl >= MATURE_IVL ? c.mature++ : c.young++); break;
    }
  }
  return c;
}

/** The day-number (days since crt) for a revlog entry's millisecond id. */
function revlogDay(col, entryId) {
  return Math.floor((entryId / 1000 - col.crt) / 86400);
}

/**
 * Reviews performed per day for the last `days` days (index 0 = today).
 * @returns {number[]} length `days`
 */
export function reviewsPerDay(col, today, days = 30) {
  const out = new Array(days).fill(0);
  for (const r of col.revlog) {
    const daysAgo = today - revlogDay(col, r.id);
    if (daysAgo >= 0 && daysAgo < days) out[daysAgo]++;
  }
  return out;
}

/**
 * Count of review cards becoming due in each of the next `days` days
 * (index 0 = today / overdue).
 * @returns {number[]} length `days`
 */
export function dueForecast(col, today, days = 30) {
  const out = new Array(days).fill(0);
  for (const card of col.cards.values()) {
    if (card.type !== CardType.Review || card.queue !== CardQueue.Review) continue;
    const inDays = Math.max(card.due - today, 0);
    if (inDays < days) out[inDays]++;
  }
  return out;
}

/**
 * True retention: fraction of review-type answers that weren't "Again".
 * Returns null if there are no review answers yet.
 */
export function retention(col) {
  let total = 0;
  let passed = 0;
  for (const r of col.revlog) {
    if (r.type === RevlogType.Review) {
      total++;
      if (r.ease > 1) passed++;
    }
  }
  return total ? passed / total : null;
}

/** Answer-button counts (Again/Hard/Good/Easy) over all real reviews. */
export function answerButtons(col) {
  const out = [0, 0, 0, 0]; // index = ease - 1
  for (const r of col.revlog) {
    if (r.ease >= 1 && r.ease <= 4 && r.type !== RevlogType.Manual && r.type !== RevlogType.Rescheduled) {
      out[r.ease - 1]++;
    }
  }
  return { again: out[0], hard: out[1], good: out[2], easy: out[3] };
}

/**
 * Review-interval distribution in week-wide buckets (index 0 = under a week).
 * The final bucket collects everything >= `weeks` weeks.
 * @returns {number[]} length `weeks`
 */
export function intervalHistogram(col, weeks = 26) {
  const out = new Array(weeks).fill(0);
  for (const card of col.cards.values()) {
    if (card.type !== CardType.Review) continue;
    out[Math.min(Math.floor(card.ivl / 7), weeks - 1)]++;
  }
  return out;
}

/** Everything the stats view needs, in one call. */
export function collectionStats(col, today, days = 30) {
  return {
    counts: cardCounts(col),
    totalReviews: col.revlog.length,
    retention: retention(col),
    reviewsPerDay: reviewsPerDay(col, today, days),
    dueForecast: dueForecast(col, today, days),
    answerButtons: answerButtons(col),
    intervalHistogram: intervalHistogram(col),
  };
}
