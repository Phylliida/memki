// Day-boundary timing tests (rslib scheduler/timing.rs semantics).

import test from "node:test";
import assert from "node:assert/strict";

import { schedTiming } from "../src/timing.js";

const DAY = 86400;
// A fixed "collection created at local midnight" anchor for UTC-5 (offset 300).
const OFF = 300;
const CRT = 1000 * DAY + OFF * 60; // local midnight, some arbitrary day

const t = (nowSec, opts = {}) =>
  schedTiming(nowSec, CRT, { rolloverHour: 4, nowOffsetMin: OFF, crtOffsetMin: OFF, ...opts });

test("before the rollover hour it is still 'yesterday'", () => {
  // 3:59 AM local on day 10 → still day 9.
  const now = CRT + 10 * DAY + 3 * 3600 + 59 * 60;
  assert.equal(t(now).daysElapsed, 9);
  // 4:00 AM local → day 10 begins.
  assert.equal(t(CRT + 10 * DAY + 4 * 3600).daysElapsed, 10);
});

test("secsUntilRollover counts down to the next 4 AM local", () => {
  // 10 PM local on day 5 → 6 hours until 4 AM.
  const now = CRT + 5 * DAY + 22 * 3600;
  assert.equal(t(now).secsUntilRollover, 6 * 3600);
});

test("rollover hour is configurable", () => {
  // At 1 AM local with rollover 0 (midnight), the new day has already begun.
  const now = CRT + 3 * DAY + 3600;
  assert.equal(t(now, { rolloverHour: 0 }).daysElapsed, 3);
  // With rollover 2 it has not.
  assert.equal(t(now, { rolloverHour: 2 }).daysElapsed, 2);
});

test("creation offset keeps day counts stable across a timezone move", () => {
  // Collection created at UTC-5; user now in UTC+1 (offset -60). Noon local on
  // what is day 7 for the creation zone's calendar should not drift by more
  // than the real calendar difference.
  const now = CRT + 7 * DAY + 12 * 3600;
  const home = t(now).daysElapsed;
  const abroad = t(now, { nowOffsetMin: -60 }).daysElapsed;
  assert.ok(Math.abs(home - abroad) <= 1);
});

test("daysElapsed never goes negative", () => {
  assert.equal(t(CRT - 5 * DAY).daysElapsed, 0);
});

test("N days later at noon reads as N days elapsed, regardless of offset", () => {
  for (const off of [-720, -60, 0, 300, 720]) {
    const crt = 1000 * DAY + off * 60; // local midnight in that zone
    const r = schedTiming(crt + 42 * DAY + 12 * 3600, crt, { nowOffsetMin: off, crtOffsetMin: off });
    assert.equal(r.daysElapsed, 42, `offset ${off}`);
  }
});

test("midnight belongs to the previous scheduling day (rollover 4 not passed)", () => {
  assert.equal(t(CRT + 42 * DAY).daysElapsed, 41);
});
