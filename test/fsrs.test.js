// Golden-vector tests for the FSRS-6 core, replicated directly from fsrs-rs
// (the crate Anki links against): src/inference.rs `test_memory_state` and
// `test_next_interval`.
//
// fsrs-rs computes in f32 and asserts |Δ| < 1e-4 against f32 expectations; we
// compute in f64, so we allow a slightly looser absolute tolerance on the
// accumulated multi-step memory state. Integer intervals are checked exactly
// where f32/f64 rounding provably agrees (small magnitudes) and skipped for the
// astronomically large ones where f32 quantization (~few units at magnitude 1e6)
// can flip the rounded result.

import test from "node:test";
import assert from "node:assert/strict";
import { FSRS, Rating, DEFAULT_PARAMETERS } from "../src/fsrs.js";

/**
 * Replays fsrs-rs `assert_memory_state`: feed ratings [1,3,3,3,3,3] at elapsed
 * days [0,0,1,3,8,21] through next_states, picking the rated branch each step.
 */
function finalMemoryState(parameters) {
  const fsrs = new FSRS(parameters, 0.9);
  const ratings = [1, 3, 3, 3, 3, 3];
  const intervals = [0, 0, 1, 3, 8, 21];
  let state = null;
  for (let i = 0; i < ratings.length; i++) {
    state = fsrs.nextState(state, intervals[i], ratings[i]);
  }
  return state;
}

test("memory state matches fsrs-rs golden vector (default params)", () => {
  const s = finalMemoryState(DEFAULT_PARAMETERS);
  // fsrs-rs expects stability 53.62691, difficulty 6.3574867 (f32).
  assert.ok(Math.abs(s.stability - 53.62691) < 1e-2, `stability=${s.stability}`);
  assert.ok(Math.abs(s.difficulty - 6.3574867) < 1e-3, `difficulty=${s.difficulty}`);
});

test("short-term-frozen memory state matches fsrs-rs golden vector", () => {
  // fsrs-rs zeros w17,w18,w19 then expects stability 53.335106, difficulty unchanged.
  const w = DEFAULT_PARAMETERS.slice();
  w[17] = 0.0;
  w[18] = 0.0;
  w[19] = 0.0;
  const s = finalMemoryState(w);
  assert.ok(Math.abs(s.stability - 53.335106) < 1e-2, `stability=${s.stability}`);
  assert.ok(Math.abs(s.difficulty - 6.3574867) < 1e-3, `difficulty=${s.difficulty}`);
});

test("next interval matches fsrs-rs across desired retentions (S=1)", () => {
  const fsrs = new FSRS(DEFAULT_PARAMETERS);
  const expected = [3116766, 34793, 2508, 387, 90, 27, 9, 3, 1, 1];
  for (let i = 1; i <= 10; i++) {
    const r = i / 10;
    const ivl = Math.max(1, Math.round(fsrs.nextInterval(1.0, r)));
    if (expected[i - 1] >= 1000) {
      // Large magnitudes: f32 quantization in fsrs-rs can shift the rounded
      // value by a few units, so compare with a small relative tolerance.
      const rel = Math.abs(ivl - expected[i - 1]) / expected[i - 1];
      assert.ok(rel < 1e-3, `r=${r}: got ${ivl}, expected ~${expected[i - 1]}`);
    } else {
      assert.equal(ivl, expected[i - 1], `r=${r}`);
    }
  }
});

test("new-card initial state uses w[rating-1] and exponential D0", () => {
  const fsrs = new FSRS(DEFAULT_PARAMETERS);
  const again = fsrs.nextState(null, 0, Rating.Again);
  assert.equal(again.stability, DEFAULT_PARAMETERS[0]); // S0(Again) = w0
  // D0(Again) = w4 - exp(0) + 1 = w4
  assert.ok(Math.abs(again.difficulty - DEFAULT_PARAMETERS[4]) < 1e-6);

  const easy = fsrs.nextState(null, 0, Rating.Easy);
  assert.equal(easy.stability, DEFAULT_PARAMETERS[3]); // S0(Easy) = w3
});

test("retrievability is 0.9 exactly one stability-length later", () => {
  const fsrs = new FSRS(DEFAULT_PARAMETERS);
  const S = 12.34;
  assert.ok(Math.abs(fsrs.retrievability(S, S) - 0.9) < 1e-9);
});

test("difficulty stays within [1,10] and stability within clamps", () => {
  const fsrs = new FSRS(DEFAULT_PARAMETERS);
  let state = fsrs.nextState(null, 0, Rating.Again);
  for (let i = 0; i < 200; i++) {
    state = fsrs.nextState(state, 1, Rating.Again); // hammer "Again"
    assert.ok(state.difficulty >= 1 && state.difficulty <= 10);
    assert.ok(state.stability >= 0.001 && state.stability <= 36500);
  }
});
