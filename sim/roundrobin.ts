import { IDX } from "./bench.ts";
import { Rng, runMatch, simAgent, hoarderAgent, brainAgent } from "./sim.ts";
import { Brain, DEFAULT_PARAMS } from "../src/engine/strategy.ts";
const C: Record<string, any> = {
  t3: {"alphaMax":2.29,"alphaRef":30,"alphaPow":0.7,"dupDecay":0.6,"balancePenalty":0.716,"cashWeight":0.1,"kappa0":2.085,"spendPerAuction":2.528,"surplusPow":1.051,"dumpAt":3,"minBid":1},
  b11: {"alphaMax":2.29,"alphaRef":26.418,"alphaPow":0.701,"dupDecay":0.6,"balancePenalty":0.716,"cashWeight":0.1,"kappa0":2.085,"spendPerAuction":2.528,"surplusPow":0.804,"dumpAt":3,"minBid":1},
  b12: {"alphaMax":2.29,"alphaRef":23.624,"alphaPow":0.7,"dupDecay":0.6,"balancePenalty":0.802,"cashWeight":0.1,"kappa0":2.085,"spendPerAuction":2.175,"surplusPow":1.051,"dumpAt":3,"minBid":1},
  b13: {"alphaMax":2.479,"alphaRef":24.242,"alphaPow":0.7,"dupDecay":0.675,"balancePenalty":0.609,"cashWeight":0.1,"kappa0":1.859,"spendPerAuction":1.745,"surplusPow":1.051,"dumpAt":3,"minBid":1},
};
const names = Object.keys(C);
const N = Number(process.argv[2] ?? 60);
const rng = new Rng(Number(process.argv[3] ?? 99));
const place: Record<string, number> = {}, score: Record<string, number> = {}, wins: Record<string, number> = {};
for (let m = 0; m < N; m++) {
  const order = [...names];
  for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const agents = order.map((nm) => brainAgent(new Brain(IDX, { ...DEFAULT_PARAMS, ...C[nm] }), nm));
  agents.push(hoarderAgent(IDX, "hoarder", 2.5 + rng.next()));
  agents.push(simAgent(IDX, "sim", "Aggressive", rng));
  const res = runMatch(IDX, agents, rng);
  for (const p of res) {
    const pl = res.filter((x) => x.score > p.score).length + 1;
    place[p.name] = (place[p.name] ?? 0) + pl / N;
    score[p.name] = (score[p.name] ?? 0) + p.score / N;
    if (pl === 1) wins[p.name] = (wins[p.name] ?? 0) + 1 / N;
  }
}
for (const k of Object.keys(place).sort((a, b) => place[a]! - place[b]!))
  console.log(k.padEnd(8), `place ${place[k]!.toFixed(2)}  score ${score[k]!.toFixed(1)}  win ${((wins[k] ?? 0) * 100).toFixed(0)}%`);
