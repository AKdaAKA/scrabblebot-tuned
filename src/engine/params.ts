// Parameters picked by self-play tuning in sim/ (see sim/tune.ts, sim/rr2.ts).
// Won a 200-match round-robin against three other tuned variants, a 3×-face
// "hoarder" and a sim, finishing 1st ~49% of the time at those tables.
import { DEFAULT_PARAMS, type Params } from "./strategy.ts";

export const TUNED_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  alphaMax: 2.479,
  alphaRef: 24.242,
  alphaPow: 0.7,
  dupDecay: 0.675,
  balancePenalty: 0.609,
  cashWeight: 0.1,
  kappa0: 1.859,
  spendPerAuction: 1.745,
  surplusPow: 1.051,
  dumpAt: 3,
  minBid: 1,
};
