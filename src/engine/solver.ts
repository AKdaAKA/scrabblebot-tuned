// Rack evaluation: split a rack into words to play now, and value whatever
// is left over by how likely it is to become part of a long word later.
//
//   value(rack) = max over sets of disjoint words W  [ Σ reward(w) + pot(rack − W) ]
//
// `pot` is a cheap stand-in for the future: each held tile is worth about
// α × (face + glue), where α shrinks to 0 as the bag runs out. At α = 0 this
// is the exact "play everything now" optimum, which is what the endgame uses.

import { LETTER_VALUE, VOWEL, WordIndex } from "./words.ts";

export interface PotParams {
  alpha: number; // multiplier on held-tile value (≈ expected final multiplier × P(used))
  glue: number[]; // per-letter bonus for letters that make words easy
  dupDecay: number; // each extra copy of a letter is worth this fraction of the previous
  balancePenalty: number; // penalty for vowel/consonant imbalance
  cashWeight: number; // extra weight on points played now (they also become coins)
}

const GLUE_DEFAULT: Record<string, number> = {
  E: 1.2, A: 0.9, I: 0.7, O: 0.7, U: 0.2,
  S: 1.4, R: 0.9, T: 0.9, N: 0.8, L: 0.7, D: 0.5, G: 0.3, C: 0.3, M: 0.3, P: 0.3, H: 0.3,
};
export const DEFAULT_GLUE: number[] = Array.from({ length: 26 }, (_, k) =>
  GLUE_DEFAULT[String.fromCharCode(65 + k)] ?? 0,
);

const Q = 16;
const U = 20;

export function potential(r: ArrayLike<number>, p: PotParams): number {
  if (p.alpha <= 0) return 0;
  let sum = 0;
  let n = 0;
  let v = 0;
  for (let k = 0; k < 26; k++) {
    const c = r[k]!;
    if (c === 0) continue;
    n += c;
    if (VOWEL[k]) v += c;
    let face = LETTER_VALUE[k]!;
    if (k === Q && r[U]! === 0) face = 2; // Q without U is close to dead
    const unit = face + p.glue[k]!;
    // Geometric decay for duplicates: unit × (1 + d + d² + …)
    let w = unit;
    let s = 0;
    for (let j = 0; j < c; j++) {
      s += w;
      w *= k === 4 && j === 0 ? 0.95 : p.dupDecay; // a second E is nearly as good
    }
    sum += s;
  }
  const off = Math.abs(v - 0.4 * n) - 1;
  const pen = off > 0 ? p.balancePenalty * off * off : 0;
  return p.alpha * Math.max(0, sum - pen);
}

export interface Plan {
  value: number; // played reward (cash-weighted) + potential of leftover
  played: number; // raw reward of the words
  words: number[]; // word indices into the WordIndex
  leftover: Uint8Array;
}

interface State {
  rack: Uint8Array;
  played: number;
  words: number[];
  from: number; // position in candidate list (words are chosen in list order)
  value: number;
}

export interface SearchParams {
  beam: number;
  branch: number;
  maxDepth: number;
}

export const DEFAULT_SEARCH: SearchParams = { beam: 12, branch: 10, maxDepth: 8 };

function key(r: Uint8Array): string {
  return String.fromCharCode(...r);
}

/**
 * Best plan for `rack`. `cands` (optional) are the spellable word indices for
 * this rack or a superset of it, in reward-descending order.
 */
export function bestPlan(
  idx: WordIndex,
  rack: Uint8Array,
  pot: PotParams,
  search: SearchParams = DEFAULT_SEARCH,
  cands?: number[],
): Plan {
  const list = cands ?? idx.spellable(rack);
  const cw = 1 + pot.cashWeight;
  const root: State = {
    rack: rack.slice(),
    played: 0,
    words: [],
    from: 0,
    value: potential(rack, pot),
  };
  let best = root;
  let beam: State[] = [root];
  for (let depth = 0; depth < search.maxDepth && beam.length > 0; depth++) {
    const next = new Map<string, State>();
    for (const s of beam) {
      let taken = 0;
      for (let ci = s.from; ci < list.length && taken < search.branch; ci++) {
        const wi = list[ci]!;
        if (!idx.fits(wi, s.rack)) continue;
        taken++;
        const r2 = s.rack.slice();
        idx.subtract(wi, r2);
        const played = s.played + idx.reward[wi]!;
        const value = played * cw + potential(r2, pot);
        const k = key(r2);
        const prev = next.get(k);
        if (prev && prev.value >= value) continue;
        next.set(k, { rack: r2, played, words: [...s.words, wi], from: ci, value });
      }
    }
    beam = [...next.values()].sort((a, b) => b.value - a.value).slice(0, search.beam);
    if (beam.length > 0 && beam[0]!.value > best.value) best = beam[0]!;
  }
  return { value: best.value, played: best.played, words: best.words, leftover: best.rack };
}
