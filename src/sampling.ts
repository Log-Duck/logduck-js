/**
 * The sampling arithmetic, copied from the server (`functions/src/shared/hitSampling.ts` in
 * the LogDuck repo) and pinned to the same FNV-1a reference vectors in the tests, so the two
 * cannot drift: a hit is kept at rate N when `fnv1a32(id) % N === 0`. Rates are powers of two,
 * which is what lets a client rate and a server rate compose — every stricter rate keeps a
 * subset of a looser one.
 *
 * FNV-1a over the id's UTF-16 code units. Ids are ASCII, so this is the same as hashing bytes.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

/** True when a hit with this id survives sampling at `rate` (1 keeps everything). */
export function sampleKeeps(id: string, rate: number): boolean {
  return rate <= 1 || fnv1a32(id) % rate === 0;
}
