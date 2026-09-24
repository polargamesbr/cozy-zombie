/** Small seeded PRNG (mulberry32) with game-friendly helpers. */
export class Rng {
  private s: number;

  constructor(seed = 1234567) {
    this.s = seed >>> 0;
  }

  seed(seed: number): void {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Symmetric range [-a, a]. */
  spread(a: number): number {
    return (this.next() * 2 - 1) * a;
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }

  /** Roughly gaussian in [-1, 1]. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 1.5;
  }
}

/** Global RNG for gameplay/FX. Re-seeded in deterministic test mode. */
export const rng = new Rng((Math.random() * 2 ** 31) | 0);

/** Separate deterministic RNG used while building the level, so the farm always looks the same. */
export const buildRng = new Rng(20240611);

/** Stable hash → [0,1) for procedural variation. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
