// Random-search tuning with self-play: candidates face the current champion
// (2 copies), a hoarder, the starter and a sim. Champion is replaced when beaten.
//   node sim/tune.ts <rounds> <matchesPerEval> <seed>
import { IDX } from "./bench.ts";
import { Rng, runMatch, simAgent, starterAgent, hoarderAgent, brainAgent, type Agent } from "./sim.ts";
import { Brain, DEFAULT_PARAMS, type Params } from "../src/engine/strategy.ts";

const rounds = Number(process.argv[2] ?? 20);
const n = Number(process.argv[3] ?? 16);
const seed = Number(process.argv[4] ?? 1);
const rng = new Rng(seed);

let champ: Params = process.argv[5] ? { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[5]) } : { ...DEFAULT_PARAMS, kappa0: 2.5, alphaMax: 2.6 };

const RANGES: Record<keyof Params, [number, number]> = {
  alphaMax: [1.5, 3.2], alphaRef: [10, 50], alphaPow: [0.3, 1.5], dupDecay: [0.4, 0.85],
  balancePenalty: [0.2, 1.5], cashWeight: [0, 0.6], kappa0: [0.8, 5], spendPerAuction: [1, 8],
  surplusPow: [0, 1.5], dumpAt: [1, 8], minBid: [1, 3],
};

function mutate(p: Params): Params {
  const q: any = { ...p };
  const keys = Object.keys(RANGES) as (keyof Params)[];
  const nk = rng.int(1, 3);
  for (let i = 0; i < nk; i++) {
    const k = keys[rng.int(0, keys.length - 1)]!;
    const [lo, hi] = RANGES[k];
    let v = q[k] + (rng.next() - 0.5) * (hi - lo) * 0.4;
    v = Math.min(hi, Math.max(lo, v));
    if (k === "dumpAt" || k === "minBid") v = Math.round(v);
    q[k] = Number(v.toFixed(3));
  }
  return q;
}

/** Mean finishing place of `cand` (lower is better) and mean score, same seeds for both sides. */
function evalPair(cand: Params, rival: Params, s: number): { cand: number; champ: number; cs: number; rs: number } {
  const r = new Rng(s);
  let cp = 0, rp = 0, cs = 0, rs = 0;
  for (let m = 0; m < n; m++) {
    const agents: Agent[] = [
      brainAgent(new Brain(IDX, cand), "cand"),
      brainAgent(new Brain(IDX, rival), "champ"),
      brainAgent(new Brain(IDX, rival), "champ2"),
      hoarderAgent(IDX, "h", 2.5 + r.next()),
      m % 2 ? starterAgent(IDX) : brainAgent(new Brain(IDX, cand), "cand2"),
      simAgent(IDX, "s", (["Cheapskate", "ValueBidder", "Aggressive"] as const)[r.int(0, 2)]!, r),
    ];
    // rotate seat order to avoid bias
    const res = runMatch(IDX, agents, r);
    const place = (i: number) => res.filter((x) => x.score > res[i]!.score).length + 1;
    cp += place(0); rp += place(1); cs += res[0]!.score; rs += res[1]!.score;
  }
  return { cand: cp / n, champ: rp / n, cs: cs / n, rs: rs / n };
}

console.log("start champ", JSON.stringify(champ));
for (let i = 0; i < rounds; i++) {
  const cand = mutate(champ);
  const e = evalPair(cand, champ, seed * 1000 + i);
  const better = e.cand < e.champ - 0.05;
  console.log(`r${i} cand place ${e.cand.toFixed(2)} (${e.cs.toFixed(0)}) vs champ ${e.champ.toFixed(2)} (${e.rs.toFixed(0)}) ${better ? "<< NEW CHAMP" : ""}`);
  if (better) {
    // confirm on fresh seeds to avoid noise
    const c2 = evalPair(cand, champ, seed * 7777 + i);
    if (c2.cand < c2.champ) { champ = cand; console.log("  confirmed", JSON.stringify(champ)); }
    else console.log("  not confirmed");
  }
}
console.log("FINAL", JSON.stringify(champ));
