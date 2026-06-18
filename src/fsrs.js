// FSRS-6 — Free Spaced Repetition Scheduler.
//
// A faithful port of the algorithm Anki ships, taken from the Rust crate Anki
// links against: open-spaced-repetition/fsrs-rs (src/model.rs, src/inference.rs).
// FSRS-6 is the default in Anki since 25.07.
//
// This module is the pure DSR memory model + interval math. It has NO knowledge
// of queues, learning steps, decks, or due dates — that integration lives in the
// scheduler layer. Keeping it pure makes it exactly testable against fsrs-rs.
//
// Provenance of every formula and constant is documented in docs/FSRS6.md.
//
// Precision note: fsrs-rs computes in f32; we compute in f64. Memory-state values
// can therefore differ in ~the 6th significant figure. This never changes the
// integer-day interval except at exact rounding boundaries (and Anki applies fuzz
// anyway). When reading a real collection we use Anki's *stored* stability/
// difficulty verbatim, so this only matters when we ourselves schedule a review.

/** Button ratings. Anki uses 1..4; 0 is a sentinel for "manual / no rating". */
export const Rating = Object.freeze({
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
});

/** FSRS-6 default weights (fsrs-rs src/inference.rs `DEFAULT_PARAMETERS`). w20 is DECAY. */
export const DEFAULT_PARAMETERS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
]);

export const FSRS5_DEFAULT_DECAY = 0.5;
export const FSRS6_DEFAULT_DECAY = 0.1542;

// Memory-state clamps (fsrs-rs src/simulation.rs).
export const S_MIN = 0.001;
export const S_MAX = 36500.0;
export const D_MIN = 1.0;
export const D_MAX = 10.0;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Normalize a parameter array to FSRS-6's 21 weights, migrating older models.
 * Mirrors fsrs-rs `check_and_fill_parameters`:
 *   - 0  → defaults
 *   - 17 → FSRS-4.5: rescale a few weights, append [0,0,0, 0.5]
 *   - 19 → FSRS-5: append [0, 0.5]
 *   - 21 → as-is
 * @param {ArrayLike<number>} [parameters]
 * @returns {number[]}
 */
export function fillParameters(parameters) {
  if (!parameters || parameters.length === 0) return DEFAULT_PARAMETERS.slice();
  const w = Array.from(parameters, Number);
  switch (w.length) {
    case 17:
      w[4] = w[5] * 2 + w[4];
      w[5] = Math.log(w[5] * 3 + 1) / 3;
      w[6] = w[6] + 0.5;
      w.push(0, 0, 0, FSRS5_DEFAULT_DECAY);
      return w;
    case 19:
      w.push(0, FSRS5_DEFAULT_DECAY);
      return w;
    case 21:
      return w;
    default:
      throw new Error(`Invalid FSRS parameter count: ${w.length} (expected 0, 17, 19, or 21)`);
  }
}

/** @typedef {{ stability: number, difficulty: number }} MemoryState */

/**
 * FSRS-6 scheduler. Construct with a parameter array (any supported length is
 * migrated to 21) and a desired retention (defaults to Anki's 0.9).
 */
export class FSRS {
  /**
   * @param {ArrayLike<number>} [parameters]
   * @param {number} [desiredRetention]
   */
  constructor(parameters = DEFAULT_PARAMETERS, desiredRetention = 0.9) {
    /** @type {number[]} */
    this.w = fillParameters(parameters);
    this.desiredRetention = desiredRetention;
  }

  /** Forgetting-curve constants (decay is stored negative internally). */
  _curve() {
    const decay = -this.w[20];
    const factor = Math.exp(Math.log(0.9) / decay) - 1.0; // == 0.9^(1/decay) - 1
    return { decay, factor };
  }

  /**
   * Probability of recall `t` days after a review, given stability `s`.
   * R(t,S) = (1 + factor·t/S)^decay.
   * @param {number} elapsedDays
   * @param {number} stability
   */
  retrievability(elapsedDays, stability) {
    const { decay, factor } = this._curve();
    return Math.pow((elapsedDays / stability) * factor + 1.0, decay);
  }

  /**
   * Days until retrievability falls to `retention` (default: this.desiredRetention).
   * Inverse of the forgetting curve. Returns a real number of days (un-rounded).
   * @param {number} stability
   * @param {number} [retention]
   */
  nextInterval(stability, retention = this.desiredRetention) {
    const { decay, factor } = this._curve();
    return (stability / factor) * (Math.pow(retention, 1.0 / decay) - 1.0);
  }

  // --- Initial state (first review of a brand-new card) ---

  /** S₀ for a first rating: w[rating-1]. @param {number} rating */
  initStability(rating) {
    return this.w[Math.min(Math.max(rating - 1, 0), 3)];
  }

  /** D₀ for a first rating (FSRS-6 exponential form): w4 - exp(w5·(rating-1)) + 1. */
  initDifficulty(rating) {
    return this.w[4] - Math.exp(this.w[5] * (rating - 1)) + 1.0;
  }

  // --- Difficulty update ---

  _linearDamping(deltaD, oldD) {
    return ((10.0 - oldD) * deltaD) / 9.0;
  }

  _meanReversion(newD) {
    // w7·(D₀(Easy) − newD) + newD  ==  w7·D₀(4) + (1−w7)·newD
    return this.w[7] * (this.initDifficulty(Rating.Easy) - newD) + newD;
  }

  /** Next difficulty (with linear damping; clamp/mean-reversion applied in step). */
  nextDifficulty(difficulty, rating) {
    const deltaD = -this.w[6] * (rating - 3.0);
    return difficulty + this._linearDamping(deltaD, difficulty);
  }

  // --- Stability update ---

  _stabilityAfterSuccess(lastS, lastD, r, rating) {
    const hardPenalty = rating === Rating.Hard ? this.w[15] : 1.0;
    const easyBonus = rating === Rating.Easy ? this.w[16] : 1.0;
    return (
      lastS *
      (Math.exp(this.w[8]) *
        (11.0 - lastD) *
        Math.pow(lastS, -this.w[9]) *
        (Math.exp((1.0 - r) * this.w[10]) - 1.0) *
        hardPenalty *
        easyBonus +
        1.0)
    );
  }

  _stabilityAfterFailure(lastS, lastD, r) {
    const newS =
      this.w[11] *
      Math.pow(lastD, -this.w[12]) *
      (Math.pow(lastS + 1.0, this.w[13]) - 1.0) *
      Math.exp((1.0 - r) * this.w[14]);
    const newSMin = lastS / Math.exp(this.w[17] * this.w[18]);
    return Math.min(newS, newSMin);
  }

  _stabilityShortTerm(lastS, rating) {
    // NOTE: model.rs (the scheduling/inference path Anki uses) gates on rating >= 2.
    // The optimizer's simulation.rs uses rating >= 3 — we match the scheduling path.
    const sinc =
      Math.exp(this.w[17] * (rating - 3.0 + this.w[18])) * Math.pow(lastS, -this.w[19]);
    return lastS * (rating >= Rating.Hard ? Math.max(sinc, 1.0) : sinc);
  }

  /**
   * Advance a memory state by one review. Direct port of fsrs-rs `step`.
   * @param {MemoryState|null} state  Current state, or null for a brand-new card.
   * @param {number} elapsedDays      Days since last review (0 = same-day).
   * @param {number} rating           1=Again, 2=Hard, 3=Good, 4=Easy (0 = no-op).
   * @returns {MemoryState}
   */
  nextState(state, elapsedDays, rating) {
    const isNew = state === null || state.stability === 0;
    const lastS = clamp(isNew ? S_MIN : state.stability, S_MIN, S_MAX);
    const lastD = clamp(isNew ? D_MIN : state.difficulty, D_MIN, D_MAX);

    if (rating === 0) return { stability: lastS, difficulty: lastD };

    if (isNew) {
      const r = Math.min(Math.max(rating, 1), 4);
      return {
        stability: clamp(this.initStability(r), S_MIN, S_MAX),
        difficulty: clamp(this.initDifficulty(r), D_MIN, D_MAX),
      };
    }

    const r = this.retrievability(elapsedDays, lastS);
    let newS =
      rating === Rating.Again
        ? this._stabilityAfterFailure(lastS, lastD, r)
        : this._stabilityAfterSuccess(lastS, lastD, r, rating);
    if (elapsedDays === 0) newS = this._stabilityShortTerm(lastS, rating);

    const newD = clamp(this._meanReversion(this.nextDifficulty(lastD, rating)), D_MIN, D_MAX);

    return { stability: clamp(newS, S_MIN, S_MAX), difficulty: newD };
  }

  /**
   * Outcomes for all four buttons from the current state — the raw memory-model
   * view (new state + un-rounded interval in days at the desired retention).
   * The queue/learning-step state machine sits above this in the scheduler.
   * @param {MemoryState|null} state
   * @param {number} elapsedDays
   * @returns {{again:{state:MemoryState,interval:number}, hard:..., good:..., easy:...}}
   */
  nextStates(state, elapsedDays) {
    const make = (rating) => {
      const s = this.nextState(state, elapsedDays, rating);
      return { state: s, interval: this.nextInterval(s.stability) };
    };
    return {
      again: make(Rating.Again),
      hard: make(Rating.Hard),
      good: make(Rating.Good),
      easy: make(Rating.Easy),
    };
  }
}
