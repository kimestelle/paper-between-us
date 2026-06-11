// Determinism check for StrokeWalker: feeding points in arbitrary batch
// sizes (live drawing) must emit the exact same stamps as feeding the whole
// path at once (replay/rebuild). Run: npx tsx scripts/walker-test.ts

import { StrokeWalker } from "../engine/paint";
import type { Brush, Pt } from "../lib/protocol";

function collect(brush: Brush, pts: Pt[], batches: number[]) {
  const out: number[] = [];
  const w = new StrokeWalker(brush, 0.03, 800, 1000, (x, y, r, a, d) =>
    out.push(x, y, r, a, d),
  );
  let i = 0;
  for (const b of batches) {
    for (let k = 0; k < b && i < pts.length; k++, i++) w.feed(pts[i]);
  }
  while (i < pts.length) w.feed(pts[i++]);
  w.finish();
  return out;
}

// deterministic pseudo-random path
let s = 42;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31), s / 2 ** 31);
const pts: Pt[] = [];
let x = 0.2,
  y = 0.3;
for (let i = 0; i < 400; i++) {
  x = Math.min(1, Math.max(0, x + (rnd() - 0.5) * 0.02));
  y = Math.min(1, Math.max(0, y + (rnd() - 0.48) * 0.02));
  pts.push({ x, y, p: 0.3 + 0.7 * rnd() });
}

let failures = 0;
for (const brush of ["pen", "water", "erase"] as const) {
  const whole = collect(brush, pts, [pts.length]);
  for (const batching of [
    [1],
    [3, 7, 1, 12],
    [50, 2, 2, 2, 100],
  ]) {
    // cycle the batch pattern over the path
    const seq: number[] = [];
    let n = 0;
    while (n < pts.length) {
      const b = batching[seq.length % batching.length];
      seq.push(b);
      n += b;
    }
    const batched = collect(brush, pts, seq);
    const same =
      batched.length === whole.length &&
      batched.every((v, j) => Math.abs(v - whole[j]) < 1e-9);
    if (!same) {
      failures++;
      console.error(
        `MISMATCH brush=${brush} batching=${batching} stamps ${batched.length / 5} vs ${whole.length / 5}`,
      );
    } else {
      console.log(
        `ok brush=${brush} batching=[${batching}] — ${whole.length / 5} stamps identical`,
      );
    }
  }
}

// tap (single point) and two-point line edge cases
for (const brush of ["pen", "water", "erase"] as const) {
  const tap = collect(brush, [{ x: 0.5, y: 0.5, p: 0.5 }], [1]);
  if (tap.length / 5 < 1) {
    failures++;
    console.error(`MISMATCH: ${brush} tap emitted no stamp`);
  } else console.log(`ok ${brush} tap → ${tap.length / 5} stamp(s)`);
  const line = collect(
    brush,
    [
      { x: 0.2, y: 0.2, p: 0.5 },
      { x: 0.8, y: 0.8, p: 0.5 },
    ],
    [1, 1],
  );
  console.log(`ok ${brush} 2-pt line → ${line.length / 5} stamps`);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all walker determinism checks passed");
