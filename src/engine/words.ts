// Fast dictionary index for "which words can I spell from this rack?".
//
// Every word is stored as a 26-letter count vector plus a bitmask of the
// letters it uses. A rack query first rejects words by mask (one AND), then
// checks counts only for the survivors. Scanning all ~173k words this way
// takes a millisecond or two.

export const LETTER_VALUE: number[] = [
  // A  B  C  D  E  F  G  H  I  J  K  L  M  N  O  P  Q   R  S  T  U  V  W  X  Y  Z
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

// Standard bag (no blanks), 98 tiles — same as the module's DEFAULT_BAG.
export const BAG_COUNTS: number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];

export const VOWEL = new Uint8Array(26);
for (const c of "AEIOU") VOWEL[c.charCodeAt(0) - 65] = 1;

/** Reward for playing a word: base × length multiplier, integer-floored like the module. */
export function rewardFor(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function letterIndex(c: string): number {
  return c.charCodeAt(0) - 65;
}

export class WordIndex {
  readonly words: string[];
  readonly len: Uint8Array;
  readonly mask: Uint32Array;
  readonly counts: Uint8Array; // 26 per word
  readonly reward: Uint16Array;
  readonly base: Uint16Array;
  private readonly lookup: Set<string>;

  constructor(raw: string[]) {
    // Sort by reward descending so callers scanning in order see the best
    // words first.
    const list = raw
      .map((w) => w.trim().toUpperCase())
      .filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
    const scored = list.map((w) => {
      let b = 0;
      for (let i = 0; i < w.length; i++) b += LETTER_VALUE[w.charCodeAt(i) - 65]!;
      return { w, b, r: rewardFor(b, w.length) };
    });
    scored.sort((x, y) => y.r - x.r || x.w.length - y.w.length);
    const n = scored.length;
    this.words = new Array(n);
    this.len = new Uint8Array(n);
    this.mask = new Uint32Array(n);
    this.counts = new Uint8Array(n * 26);
    this.reward = new Uint16Array(n);
    this.base = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const { w, b, r } = scored[i]!;
      this.words[i] = w;
      this.len[i] = Math.min(w.length, 255);
      this.reward[i] = r;
      this.base[i] = b;
      let m = 0;
      for (let j = 0; j < w.length; j++) {
        const k = w.charCodeAt(j) - 65;
        this.counts[i * 26 + k]!++;
        m |= 1 << k;
      }
      this.mask[i] = m >>> 0;
    }
    this.lookup = new Set(list);
  }

  has(word: string): boolean {
    return this.lookup.has(word);
  }

  /**
   * Indices of every word spellable from `rack` (26 counts), in
   * reward-descending order. `minLen` drops short words.
   */
  spellable(rack: ArrayLike<number>, minLen = 2): number[] {
    let total = 0;
    let rmask = 0;
    for (let k = 0; k < 26; k++) {
      const c = rack[k]!;
      total += c;
      if (c > 0) rmask |= 1 << k;
    }
    const out: number[] = [];
    const notMask = ~rmask >>> 0;
    const { len, mask, counts } = this;
    const n = this.words.length;
    for (let i = 0; i < n; i++) {
      const L = len[i]!;
      if (L > total || L < minLen) continue;
      if ((mask[i]! & notMask) !== 0) continue;
      const off = i * 26;
      let ok = true;
      // Only letters in the word's mask can be non-zero.
      let m = mask[i]!;
      while (m !== 0) {
        const k = 31 - Math.clz32(m & -m);
        if (counts[off + k]! > rack[k]!) {
          ok = false;
          break;
        }
        m &= m - 1;
      }
      if (ok) out.push(i);
    }
    return out;
  }

  /** Whether word i fits in rack. */
  fits(i: number, rack: ArrayLike<number>): boolean {
    const off = i * 26;
    let m = this.mask[i]!;
    while (m !== 0) {
      const k = 31 - Math.clz32(m & -m);
      if (this.counts[off + k]! > rack[k]!) return false;
      m &= m - 1;
    }
    return true;
  }

  subtract(i: number, rack: Uint8Array): void {
    const off = i * 26;
    let m = this.mask[i]!;
    while (m !== 0) {
      const k = 31 - Math.clz32(m & -m);
      rack[k]! -= this.counts[off + k]!;
      m &= m - 1;
    }
  }
}

export function rackFromMap(map: Map<string, number>): Uint8Array {
  const r = new Uint8Array(26);
  for (const [c, n] of map) {
    const k = letterIndex(c);
    if (k >= 0 && k < 26) r[k] = Math.min(255, r[k]! + n);
  }
  return r;
}

export function rackToString(r: ArrayLike<number>): string {
  let s = "";
  for (let k = 0; k < 26; k++) s += String.fromCharCode(65 + k).repeat(r[k]!);
  return s;
}
