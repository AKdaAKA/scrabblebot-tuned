// Benchmark a parameter set across several lineups.
//   node sim/bench.ts [matches] [json-params-override]
import * as fs from "node:fs";
import { WordIndex } from "../src/engine/words.ts";
import { Brain, DEFAULT_PARAMS, type Params } from "../src/engine/strategy.ts";
import { Rng, runMatch, simAgent, starterAgent, hoarderAgent, brainAgent, type Agent } from "./sim.ts";

const here = new URL("..", import.meta.url).pathname;
const dict = [here + "wordlist.txt", here + "../spacetimedb/wordlist.txt"].find((f) => fs.existsSync(f))!;
export const IDX = new WordIndex(fs.readFileSync(dict, "utf8").split("\n"));

const KINDS = ["Cheapskate", "ValueBidder", "Aggressive"] as const;

export type Lineup = "sims" | "starter" | "hoarders" | "mixed";

export function lineup(kind: Lineup, me: Agent, rng: Rng, rival?: () => Agent): Agent[] {
  const sim = (i: number) => simAgent(IDX, `sim${i}`, KINDS[rng.int(0, 2)]!, rng);
  switch (kind) {
    case "sims": return [me, sim(1), sim(2), sim(3), sim(4), sim(5)];
    case "starter": return [me, starterAgent(IDX), sim(1), sim(2), sim(3), sim(4)];
    case "hoarders": return [me, hoarderAgent(IDX, "h1", 2.5), hoarderAgent(IDX, "h2", 3), starterAgent(IDX), sim(1), sim(2)];
    case "mixed": return [me, rival ? rival() : hoarderAgent(IDX), rival ? rival() : hoarderAgent(IDX, "h2", 3), hoarderAgent(IDX, "h3", 2), starterAgent(IDX), sim(1)];
  }
}

export interface Result { avg: number; win: number; place: number }

export function bench(p: Params, kind: Lineup, n: number, seed: number, rival?: () => Agent): Result {
  const rng = new Rng(seed);
  let tot = 0, wins = 0, place = 0;
  for (let m = 0; m < n; m++) {
    const me = brainAgent(new Brain(IDX, p), "me");
    const agents = lineup(kind, me, rng, rival);
    const res = runMatch(IDX, agents, rng);
    const my = res[0]!.score;
    tot += my;
    const better = res.filter((r) => r.score > my).length;
    if (better === 0) wins++;
    place += better + 1;
  }
  return { avg: tot / n, win: wins / n, place: place / n };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2] ?? 40);
  const over = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const p = { ...DEFAULT_PARAMS, ...over };
  const t = performance.now();
  for (const k of ["sims", "starter", "hoarders", "mixed"] as Lineup[]) {
    const r = bench(p, k, n, 12345);
    console.log(k.padEnd(9), `avg ${r.avg.toFixed(1)}  win ${(r.win * 100).toFixed(0)}%  place ${r.place.toFixed(2)}`);
  }
  console.log(`${((performance.now() - t) / 1000).toFixed(1)}s`);
}
