// Scheduling day boundaries — a faithful port of rslib scheduler/timing.rs
// (the v2/v3 path).
//
// Anki's "day" is a *local* calendar day that starts at the rollover hour
// (default 4 AM), so studying at 11 PM and again at 1 AM counts as one day,
// and the queue flips over early in the morning rather than at midnight (or,
// worse, at UTC midnight). Two offsets matter:
//   - the local UTC offset at `now` (handles DST changes naturally), and
//   - the offset at collection creation (col.conf.creationOffset, minutes,
//     same sign convention as Date.getTimezoneOffset) so day counts stay
//     stable across timezone moves.

const DAY = 86400;

/** Local UTC offset in minutes at an epoch-seconds moment (DST-aware). */
export function tzOffsetMinutes(sec) {
  return new Date(sec * 1000).getTimezoneOffset();
}

/**
 * Compute scheduler timing.
 * @param {number} nowSec epoch seconds
 * @param {number} crtSec collection creation time (epoch seconds)
 * @param {{ rolloverHour?: number, nowOffsetMin?: number, crtOffsetMin?: number }} [opts]
 * @returns {{ daysElapsed: number, nextDayAt: number, secsUntilRollover: number }}
 */
export function schedTiming(nowSec, crtSec, opts = {}) {
  const rollover = clampHour(opts.rolloverHour ?? 4);
  const offNow = opts.nowOffsetMin ?? tzOffsetMinutes(nowSec);
  const offCrt = opts.crtOffsetMin ?? offNow;
  // rslib semantics: days_elapsed = calendar days between the creation *date*
  // and today's date, minus one if today's rollover hour hasn't passed yet.
  // Equivalently: shift `now` back by the rollover hour before taking its
  // local calendar day; the creation day is its plain local calendar day.
  const nowDay = Math.floor((nowSec - offNow * 60 - rollover * 3600) / DAY);
  const crtDay = Math.floor((crtSec - offCrt * 60) / DAY);
  const daysElapsed = Math.max(nowDay - crtDay, 0);
  const nextDayAt = (nowDay + 1) * DAY + rollover * 3600 + offNow * 60;
  return { daysElapsed, nextDayAt, secsUntilRollover: nextDayAt - nowSec };
}

function clampHour(h) {
  return Number.isFinite(h) ? Math.min(Math.max(Math.trunc(h), 0), 23) : 4;
}

/** Timing for a collection, reading rollover/creationOffset from its conf. */
export function collectionTiming(col, nowSec) {
  return schedTiming(nowSec, col.crt ?? 0, {
    rolloverHour: col.conf?.rollover,
    crtOffsetMin: col.conf?.creationOffset,
  });
}

/** Epoch seconds of the start of the local day containing `sec` (midnight). */
export function localDayStart(sec, offMin = tzOffsetMinutes(sec)) {
  return Math.floor((sec - offMin * 60) / DAY) * DAY + offMin * 60;
}
