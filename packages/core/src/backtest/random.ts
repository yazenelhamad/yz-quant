/**
 * Deterministic pseudo-random primitives for the backtester.
 *
 * Everything in the backtest package must be reproducible from a seed: Monte Carlo
 * resampling, synthetic data generation and any tie-breaking use these helpers and
 * never `Math.random`.
 */

/** A deterministic uniform generator on [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 - a small, fast, well-distributed 32-bit PRNG.
 * Same seed => same sequence on every platform (uses Math.imul and >>> 0 wraparound).
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randomInt(rng: Rng, n: number): number {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Standard normal deviate via Box-Muller (deterministic given the rng). */
export function randomNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  // Avoid log(0).
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Bootstrap sample (with replacement) of the same length as the input. */
export function bootstrapSample<T>(items: readonly T[], rng: Rng, length = items.length): T[] {
  const out: T[] = [];
  if (items.length === 0) return out;
  for (let i = 0; i < length; i++) out.push(items[randomInt(rng, items.length)] as T);
  return out;
}

/** FNV-1a 32-bit hash of a string, returned as 8 hex characters. */
export function fnv1a32(input: string, seed = 0x811c9dc5): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Two independent FNV-1a passes concatenated for a 64-bit-wide, stable fingerprint. */
export function fnv1a64(input: string): string {
  return fnv1a32(input) + fnv1a32(input, 0x9747b28c);
}
