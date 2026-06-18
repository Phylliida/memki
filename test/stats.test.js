// Stats tests.

import test from "node:test";
import assert from "node:assert/strict";

import { cardCounts, reviewsPerDay, dueForecast, retention, collectionStats } from "../src/stats.js";
import { Collection, Note, Card, Revlog, CardType, CardQueue, RevlogType } from "../src/model.js";

function build() {
  const col = Collection.createDefault();
  col.crt = 0; // day 0 = epoch, so day-number math is simple
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const mk = (props) => {
    const n = new Note({ mid, fields: ["Q", "A"] }).normalize();
    col.addNote(n);
    return col.addCard(new Card({ nid: n.id, did: 1, ...props }));
  };
  mk({ type: CardType.New, queue: CardQueue.New });
  mk({ type: CardType.Learning, queue: CardQueue.Learning });
  mk({ type: CardType.Review, queue: CardQueue.Review, ivl: 5, due: 10 });   // young, due day 10
  mk({ type: CardType.Review, queue: CardQueue.Review, ivl: 40, due: 12 });  // mature, due day 12
  mk({ type: CardType.Review, queue: CardQueue.Suspended, ivl: 40 });        // suspended
  return col;
}

test("cardCounts classifies states", () => {
  const c = cardCounts(build());
  assert.equal(c.new, 1);
  assert.equal(c.learning, 1);
  assert.equal(c.young, 1);
  assert.equal(c.mature, 1);
  assert.equal(c.suspended, 1);
  assert.equal(c.total, 5);
});

test("dueForecast buckets review cards by day offset", () => {
  const col = build();
  const f = dueForecast(col, 10, 30); // today = day 10
  assert.equal(f[0], 1); // the card due day 10 → today
  assert.equal(f[2], 1); // the card due day 12 → in 2 days
});

test("reviewsPerDay buckets revlog by day", () => {
  const col = build();
  col.crt = 0;
  // two reviews "today" (day 10), one "yesterday" (day 9)
  col.addRevlog(new Revlog({ id: (10 * 86400 + 5) * 1000, ease: 3, type: RevlogType.Review }));
  col.addRevlog(new Revlog({ id: (10 * 86400 + 9) * 1000, ease: 1, type: RevlogType.Review }));
  col.addRevlog(new Revlog({ id: (9 * 86400 + 1) * 1000, ease: 3, type: RevlogType.Review }));
  const r = reviewsPerDay(col, 10, 30);
  assert.equal(r[0], 2); // today
  assert.equal(r[1], 1); // yesterday
});

test("retention = fraction of review answers that passed", () => {
  const col = build();
  col.addRevlog(new Revlog({ ease: 3, type: RevlogType.Review })); // pass
  col.addRevlog(new Revlog({ ease: 1, type: RevlogType.Review })); // again
  col.addRevlog(new Revlog({ ease: 2, type: RevlogType.Learn }));  // not counted
  assert.ok(Math.abs(retention(col) - 0.5) < 1e-9);
});

test("collectionStats bundles everything", () => {
  const s = collectionStats(build(), 10, 30);
  assert.equal(s.counts.total, 5);
  assert.equal(s.dueForecast[0], 1);
  assert.equal(s.reviewsPerDay.length, 30);
  assert.equal(s.retention, null); // no review answers in the base build
});
