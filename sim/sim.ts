// Local match simulator — mirrors spacetimedb/src/game.ts:
//  * 98-tile bag, each bot dealt 5, one auction per remaining tile
//  * unbid tiles are consumed (not returned), so #auctions = 98 − 5·N
//  * Vickrey: winner pays runner-up's bid (or 1 if alone); ties random
//  * sims bid per strategy ± 2 jitter and play their longest ≥3-letter word on each win
//  * the final auction's letter can't be played (match ends in the same tx)

import { BAG_COUNTS, LETTER_VALUE, WordIndex, rewardFor } from "../src/engine/words.ts";
import { Brain, type Params } from "../src/engine/strategy.ts";

export class Rng {
  s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number { // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
}

export interface Player {
  name: string;
  rack: Uint8Array;
  balance: number;
  score: number;
}

export interface Agent {
  name: string;
  /** Called at each auction open (after the previous close). Return words to play. */
  play(me: Player, bagTotal: number, final: boolean): string[];
  bid(me: Player, letter: string, bagTotal: number, ctx: MatchCtx): number;
  /** Sims play right after winning a letter. */
  afterWin?(me: Player): string[];
}

export interface MatchCtx {
  players: Player[];
  firstPrice: boolean;
  paid: { letter: string; paid: number }[];
}

const L = (c: string) => c.charCodeAt(0) - 65;

function tryPlay(idx: WordIndex, p: Player, word: string): boolean {
  if (!idx.has(word)) return false;
  const need = new Uint8Array(26);
  for (const c of word) need[L(c)]!++;
  for (let k = 0; k < 26; k++) if (need[k]! > p.rack[k]!) return false;
  let base = 0;
  for (let k = 0; k < 26; k++) { p.rack[k]! -= need[k]!; base += need[k]! * LETTER_VALUE[k]!; }
  const r = rewardFor(base, word.length);
  p.balance += r;
  p.score += r;
  return true;
}

export function runMatch(idx: WordIndex, agents: Agent[], rng: Rng, firstPrice = false): Player[] {
  const bag = BAG_COUNTS.slice();
  let bagTotal = 98;
  const draw = (): number => {
    let i = rng.int(0, bagTotal - 1);
    for (let k = 0; k < 26; k++) {
      if (i < bag[k]!) { bag[k]!--; bagTotal--; return k; }
      i -= bag[k]!;
    }
    throw new Error("bag");
  };
  const players: Player[] = agents.map((a) => ({ name: a.name, rack: new Uint8Array(26), balance: 100, score: 0 }));
  for (const p of players) for (let n = 0; n < 5; n++) p.rack[draw()]!++;
  const ctx: MatchCtx = { players, firstPrice, paid: [] };

  while (bagTotal > 0) {
    const k = draw();
    const letter = String.fromCharCode(65 + k);
    const final = bagTotal === 0;
    // Bots react to the new auction: play words, then bid.
    agents.forEach((a, i) => {
      for (const w of a.play(players[i]!, bagTotal, final)) tryPlay(idx, players[i]!, w);
    });
    const bids = agents.map((a, i) => {
      const b = Math.floor(a.bid(players[i]!, letter, bagTotal, ctx));
      return Math.max(0, Math.min(b, players[i]!.balance));
    });
    const order = bids.map((b, i) => ({ b, i, r: rng.next() })).filter((x) => x.b > 0);
    order.sort((x, y) => y.b - x.b || x.r - y.r);
    if (order.length > 0) {
      const w = order[0]!;
      const price = firstPrice ? w.b : order[1] ? order[1].b : Math.min(1, w.b);
      const p = players[w.i]!;
      p.balance -= price;
      p.rack[k]!++;
      ctx.paid.push({ letter, paid: price });
      const after = agents[w.i]!.afterWin?.(p) ?? [];
      for (const word of after) tryPlay(idx, p, word);
    }
  }
  return players;
}

// ---------- Opponent models ----------

export function simAgent(idx: WordIndex, name: string, kind: "Cheapskate" | "ValueBidder" | "Aggressive", rng: Rng): Agent {
  return {
    name,
    play: () => [],
    bid: (me, letter) => {
      const v = LETTER_VALUE[L(letter)]!;
      const vowel = "AEIOU".includes(letter);
      const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
      return Math.max(Math.min(Math.max(base + rng.int(-2, 2), 1), me.balance), 0);
    },
    afterWin: (me) => {
      const c = idx.spellable(me.rack, 3);
      // longest word, as findBestPlayable does
      let best = -1;
      for (const i of c) if (best < 0 || idx.len[i]! > idx.len[best]!) best = i;
      return best >= 0 ? [idx.words[best]!] : [];
    },
  };
}

/** The repo's unmodified starter bot. */
export function starterAgent(idx: WordIndex, name = "starter"): Agent {
  return {
    name,
    play: (me) => {
      const out: string[] = [];
      const r = me.rack.slice();
      for (;;) {
        const c = idx.spellable(r, 2);
        let best = -1;
        for (const i of c) if (best < 0 || idx.len[i]! > idx.len[best]!) best = i;
        if (best < 0) break;
        out.push(idx.words[best]!);
        idx.subtract(best, r);
      }
      return out;
    },
    bid: (me, letter) => {
      const v = LETTER_VALUE[L(letter)]!;
      const want = me.rack[L(letter)]! === 0 ? v + 2 : Math.max(1, v);
      return Math.min(want, me.balance);
    },
  };
}

/** A "hoarder" rival: values tiles at 3× face, bids it all, dumps at the end. Proxy for strong real bots. */
export function hoarderAgent(idx: WordIndex, name = "hoarder", mult = 2.5): Agent {
  const fin = new Brain(idx);
  return {
    name,
    play: (me, bagTotal, final) => {
      if (!final) {
        // play only 7+ words mid-game
        const c = idx.spellable(me.rack, 7);
        return c.length ? [idx.words[c[0]!]!] : [];
      }
      return fin.choosePlays({ rack: me.rack, bagTotal, final: true });
    },
    bid: (me, letter, bagTotal) => {
      if (bagTotal === 0) return 0;
      const v = LETTER_VALUE[L(letter)]!;
      const b = bagTotal < 6 ? me.balance : Math.round(v * mult + 1);
      return Math.min(b, me.balance);
    },
  };
}

export function brainAgent(brain: Brain, name = "brain"): Agent {
  return {
    name,
    play: (me, bagTotal, final) => brain.choosePlays({ rack: me.rack, bagTotal, final }),
    bid: (me, letter, bagTotal, ctx) => {
      let maxOpp = 0;
      for (const p of ctx.players) if (p !== me) maxOpp = Math.max(maxOpp, p.balance);
      return brain.decideBid({
        letter, balance: me.balance, rack: me.rack, bagTotal,
        firstPrice: ctx.firstPrice, maxOppBalance: maxOpp, recentPaid: ctx.paid,
      });
    },
  };
}

export function paramsWith(base: Params, over: Partial<Params>): Params {
  return { ...base, ...over };
}
