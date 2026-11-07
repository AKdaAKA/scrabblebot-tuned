import { IDX, lineup } from "./bench.ts";
import { Rng, runMatch, brainAgent } from "./sim.ts";
import { Brain, DEFAULT_PARAMS } from "../src/engine/strategy.ts";
const over = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const rng = new Rng(7);
const sums: Record<string, number> = {};
const N = 15;
for (let m = 0; m < N; m++) {
  const res = runMatch(IDX, lineup((process.argv[3] ?? "hoarders") as any, brainAgent(new Brain(IDX, {...DEFAULT_PARAMS, ...over}), "me"), rng), rng);
  res.forEach((p, i) => (sums[i + ":" + p.name] = (sums[i + ":" + p.name] ?? 0) + p.score / N));
}
console.log(Object.entries(sums).map(([k, v]) => `${k}=${v.toFixed(0)}`).join("  "));
