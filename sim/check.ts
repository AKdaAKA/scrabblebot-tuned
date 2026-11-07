// Final checks: lineup benchmark with tuned params + worst-case decision latency.
import { IDX, bench, type Lineup } from "./bench.ts";
import { TUNED_PARAMS } from "../src/engine/params.ts";
import { Brain } from "../src/engine/strategy.ts";
import { Rng } from "./sim.ts";
for (const k of ["sims", "starter", "hoarders", "mixed"] as Lineup[]) {
  const r = bench(TUNED_PARAMS, k, 40, 4242);
  console.log(k.padEnd(9), `avg ${r.avg.toFixed(1)}  win ${(r.win * 100).toFixed(0)}%  place ${r.place.toFixed(2)}`);
}
// latency: random racks of 10..40 tiles, every bag phase
const b = new Brain(IDX, TUNED_PARAMS);
const rng = new Rng(5);
let worst = 0, sum = 0, n = 0;
for (let t = 0; t < 300; t++) {
  const rack = new Uint8Array(26);
  const size = rng.int(10, 40);
  for (let i = 0; i < size; i++) rack[rng.int(0, 25)]!++;
  const s = performance.now();
  const bagTotal = rng.int(0, 67);
  b.choosePlays({ rack, bagTotal, final: bagTotal === 0 });
  b.decideBid({ letter: String.fromCharCode(65 + rng.int(0, 25)), balance: 150, rack, bagTotal, firstPrice: false, maxOppBalance: 200, recentPaid: [] });
  const ms = performance.now() - s;
  worst = Math.max(worst, ms); sum += ms; n++;
}
console.log(`decision latency: mean ${(sum / n).toFixed(1)}ms, worst ${worst.toFixed(1)}ms (racks up to 40 tiles)`);
