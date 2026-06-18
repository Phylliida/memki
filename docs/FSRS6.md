# FSRS-6 — precise formula reference

This is the algorithm `src/fsrs.js` implements. It is a faithful port of the Rust
crate Anki links against — **open-spaced-repetition/fsrs-rs** — specifically
`src/model.rs` (the inference/scheduling path) and `src/inference.rs`. FSRS-6 has
been Anki's default scheduler since **25.07**.

> Where `model.rs` and the optimizer's `simulation.rs` disagree, the scheduling
> path in `model.rs` wins, because that is what Anki actually schedules with.
> The one place this matters is the short-term branch gate (`rating >= 2` in
> `model.rs` vs `>= 3` in `simulation.rs`).

## Parameters

21 weights `w[0..20]`. Default array (fsrs-rs `DEFAULT_PARAMETERS`):

```
[0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
 0.1542]
```

`w[20]` is **DECAY** (FSRS-6 made it learnable; default `0.1542`, range ~0.1–0.8).
Earlier models used a fixed decay of `0.5`.

Clamps: `S ∈ [0.001, 36500]`, `D ∈ [1, 10]`.

### Migrating older parameter sets (`fillParameters`)

| length | model | migration to 21 weights |
|---|---|---|
| 0 | — | use defaults |
| 17 | FSRS-4.5 | `w4 = 2·w5 + w4; w5 = ln(3·w5 + 1)/3; w6 += 0.5;` then append `[0,0,0, 0.5]` |
| 19 | FSRS-5 | append `[0, 0.5]` |
| 21 | FSRS-6 | unchanged |

## Forgetting curve & interval

Internally `decay = -w[20]` (negative) and `factor = 0.9^(1/decay) − 1`.

- **Retrievability** after `t` days at stability `S`:  `R(t,S) = (1 + factor·t/S)^decay`
- **Next interval** for desired retention `r`:  `I(r,S) = (S/factor)·(r^(1/decay) − 1)`

By construction `R(S, S) = 0.9`, and `I(0.9, S) = S`.

## Initial state (first review of a new card), rating `g ∈ {1,2,3,4}`

- `S₀(g) = w[g−1]`
- `D₀(g) = w[4] − exp(w[5]·(g−1)) + 1`   ← FSRS-6 exponential form (FSRS-5 was linear)

## Difficulty update

```
ΔD              = −w[6]·(g − 3)
linear_damping  = (10 − D)·ΔD / 9
D'              = D + linear_damping
D_next          = w[7]·D₀(4) + (1 − w[7])·D'     (mean reversion toward "Easy" D₀)
D_next          = clamp(D_next, 1, 10)
```

## Stability update

Let `r` = retrievability at review time (`R(t, S)`).

**After a successful review** (`g ≥ 2`):
```
hard_penalty = (g == 2) ? w[15] : 1
easy_bonus   = (g == 4) ? w[16] : 1
S' = S · ( exp(w[8])·(11 − D)·S^(−w[9])·(exp((1−r)·w[10]) − 1)·hard_penalty·easy_bonus + 1 )
```

**After a lapse** (`g == 1`):
```
S' = min(
       w[11]·D^(−w[12])·((S+1)^w[13] − 1)·exp((1−r)·w[14]),
       S / exp(w[17]·w[18])                                   ← post-lapse stability cap
     )
```

**Same-day review** (`t == 0`, overrides the above for any rating):
```
sinc = exp(w[17]·(g − 3 + w[18]))·S^(−w[19])
S'   = S · ( (g ≥ 2) ? max(sinc, 1) : sinc )
```

All stability outputs are clamped to `[0.001, 36500]`.

## What lives elsewhere

This module is the pure memory model. The **scheduler layer** (not yet written)
adds: learning/relearning steps, queues, due dates, interval rounding, fuzz, the
`maximum_review_interval` cap, and the `memory_state_from_sm2` bootstrap used when
importing a collection that has review history but no FSRS state. Those are
properties of Anki's deck config, kept separate so this core stays exactly testable.
