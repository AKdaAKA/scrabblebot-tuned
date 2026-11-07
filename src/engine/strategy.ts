// Bidding and word-play policy. Pure functions over plain data so the same
// code runs in the live bot and in the local simulator.

import { bestPlan, DEFAULT_GLUE, DEFAULT_SEARCH, type PotParams, type SearchParams } from "./solver.ts";
import { LETTER_VALUE, WordIndex, letterIndex } from "./words.ts";

export interface Params {
  alphaMax: number; // held-tile multiplier with the whole match ahead
  alphaRef: number; // useful auctions left at which alpha starts shrinking
  alphaPow: number; // shape of the shrink
  dupDecay: number;
  balancePenalty: number;
  cashWeight: number; // early-game bonus for points that also become coins
  kappa0: number; // coins bid per point of value, baseline
  spendPerAuction: number; // expected coins we need per remaining auction
  surplusPow: number; // how fast surplus coins raise our bids
  dumpAt: number; // with this many useful auctions left, bid everything we value
  minBid: number; // always bid at least this on a positive-value letter (cheap Vickrey wins)
}

export const DEFAULT_PARAMS: Params = {
  alphaMax: 2.0,
  alphaRef: 30,
  alphaPow: 0.7,
  dupDecay: 0.6,
  balancePenalty: 0.6,
  cashWeight: 0.1,
  kappa0: 1.0,
  spendPerAuction: 3,
  surplusPow: 1.0,
  dumpAt: 3,
  minBid: 1,
};

export interface BidView {
  letter: string;
  balance: number;
  rack: Uint8Array;
  /** Tiles left in the bag after this auction's letter was drawn (matchState.bagTotal). */
  bagTotal: number;
  firstPrice: boolean;
  /** Highest opponent balance — nobody can bid more than this. */
  maxOppBalance: number;
  /** Prices other bots paid this match, for first-price shading. */
  recentPaid: { letter: string; paid: number }[];
}

export interface PlayView {
  rack: Uint8Array;
  bagTotal: number;
  /** True when this is the last chance to play (final auction is open). */
  final: boolean;
}

/** Auctions after the current one whose letters can still be used. The very last letter can't. */
function usefulAhead(bagTotal: number): number {
  return Math.max(0, bagTotal - 1);
}

export function alphaFor(p: Params, useful: number): number {
  if (useful <= 0) return 0;
  const x = Math.min(1, useful / p.alphaRef);
  return p.alphaMax * Math.pow(x, p.alphaPow);
}

function potParams(p: Params, useful: number, final: boolean): PotParams {
  const a = final ? 0 : alphaFor(p, useful);
  return {
    alpha: a,
    glue: DEFAULT_GLUE,
    dupDecay: p.dupDecay,
    balancePenalty: p.balancePenalty,
    // Cash only matters while there's bidding left to fund.
    cashWeight: final ? 0 : p.cashWeight * Math.min(1, useful / 40),
  };
}

export class Brain {
  readonly idx: WordIndex;
  readonly p: Params;
  readonly search: SearchParams;
  constructor(idx: WordIndex, p: Params = DEFAULT_PARAMS, search: SearchParams = DEFAULT_SEARCH) {
    this.idx = idx;
    this.p = p;
    this.search = search;
  }

  /** Points of value the letter adds to our rack, under the current horizon. */
  letterValue(rack: Uint8Array, letter: string, bagTotal: number): number {
    // Winning this letter happens at close; by then the bag has bagTotal tiles
    // left and the final auction's letter is useless to everyone.
    if (bagTotal <= 0) return 0;
    const useful = usefulAhead(bagTotal);
    const pot = potParams(this.p, useful, false);
    const k = letterIndex(letter);
    const withL = rack.slice();
    withL[k]!++;
    const cands = this.idx.spellable(withL);
    const a = bestPlan(this.idx, withL, pot, this.search, cands);
    const b = bestPlan(this.idx, rack, pot, this.search, cands);
    if (useful === 0) {
      // Letter arrives as the last auction opens: only the exact final split matters.
      const fin = { ...pot, alpha: 0, cashWeight: 0 };
      return (
        bestPlan(this.idx, withL, fin, this.search, cands).value -
        bestPlan(this.idx, rack, fin, this.search, cands).value
      );
    }
    return a.value - b.value;
  }

  decideBid(v: BidView): number {
    if (v.bagTotal <= 0 || v.balance <= 0) return 0; // last letter: worthless
    const value = this.letterValue(v.rack, v.letter, v.bagTotal);
    if (value <= 0) return 0;
    const useful = usefulAhead(v.bagTotal);
    let bid: number;
    if (useful < this.p.dumpAt) {
      // Coins are about to be worthless: bid all of it on anything useful.
      bid = v.balance;
    } else {
      const need = Math.max(1, useful * this.p.spendPerAuction);
      const surplus = Math.max(1, v.balance / need);
      const kappa = this.p.kappa0 * Math.pow(surplus, this.p.surplusPow);
      bid = Math.max(this.p.minBid, Math.floor(value * kappa));
    }
    // Nobody can outbid their balance, so one more than the richest rival wins outright.
    bid = Math.min(bid, v.balance, v.maxOppBalance + 1);
    if (v.firstPrice) bid = this.shade(v, bid);
    return Math.max(0, Math.floor(bid));
  }

  /** First-price: pay about what it takes to win, not our full value. */
  private shade(v: BidView, cap: number): number {
    const face = LETTER_VALUE[letterIndex(v.letter)]!;
    const similar = v.recentPaid
      .filter((r) => Math.abs(LETTER_VALUE[letterIndex(r.letter)]! - face) <= 1)
      .map((r) => r.paid)
      .sort((a, b) => a - b);
    let est: number;
    if (similar.length >= 3) est = similar[Math.floor(similar.length * 0.75)]!;
    else est = face + 3;
    return Math.min(cap, est + 1);
  }

  /** Words to play right now. */
  choosePlays(v: PlayView): string[] {
    const useful = usefulAhead(v.bagTotal);
    const pot = potParams(this.p, useful, v.final);
    const plan = bestPlan(this.idx, v.rack, pot, this.search);
    return plan.words.map((i) => this.idx.words[i]!);
  }
}
