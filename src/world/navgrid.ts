import type { PhysicsWorld } from '../physics/world';
import { LAYOUT, inPond } from './layout';

/**
 * Flow field over the farm: a Dijkstra distance map from the player, recomputed a few times per
 * second. Zombies roll downhill on it, which lets them walk around houses and fences.
 */
export class NavGrid {
  readonly cell = 0.5;
  readonly nx: number;
  readonly nz: number;
  readonly x0: number;
  readonly z0: number;
  private blocked: Uint8Array;
  private dist: Float32Array;
  private heap: Int32Array;
  private heapKey: Float32Array;
  private dirty = true;
  private lastBuildCount = -1;

  constructor(private physics: PhysicsWorld) {
    const b = LAYOUT.bounds;
    this.x0 = b.minX - 1;
    this.z0 = b.minZ - 1;
    this.nx = Math.ceil((b.maxX - b.minX + 2) / this.cell);
    this.nz = Math.ceil((b.maxZ - b.minZ + 2) / this.cell);
    const n = this.nx * this.nz;
    this.blocked = new Uint8Array(n);
    this.dist = new Float32Array(n).fill(Infinity);
    this.heap = new Int32Array(n * 8);
    this.heapKey = new Float32Array(n * 8);
  }

  markDirty(): void {
    this.dirty = true;
  }

  private rebuildBlocked(): void {
    const pad = 0.38;
    this.blocked.fill(0);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * this.cell;
        const z = this.z0 + (j + 0.5) * this.cell;
        if (inPond(x, z, 0.1)) this.blocked[j * this.nx + i] = 1;
      }
    }
    for (const c of this.physics.statics) {
      if (!c.enabled || c.walkable || c.y1 < 0.5) continue;
      const r = c.boundR + pad;
      const i0 = Math.max(0, Math.floor((c.x - r - this.x0) / this.cell));
      const i1 = Math.min(this.nx - 1, Math.floor((c.x + r - this.x0) / this.cell));
      const j0 = Math.max(0, Math.floor((c.z - r - this.z0) / this.cell));
      const j1 = Math.min(this.nz - 1, Math.floor((c.z + r - this.z0) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = this.x0 + (i + 0.5) * this.cell;
          const z = this.z0 + (j + 0.5) * this.cell;
          if (c.containsXZ(x, z, pad)) this.blocked[j * this.nx + i] = 1;
        }
      }
    }
  }

  /** Recompute the distance field toward (tx, tz). */
  compute(tx: number, tz: number): void {
    const enabledCount = this.physics.statics.reduce((n, c) => n + (c.enabled ? 1 : 0), 0);
    if (this.dirty || enabledCount !== this.lastBuildCount) {
      this.rebuildBlocked();
      this.dirty = false;
      this.lastBuildCount = enabledCount;
    }
    const { nx, nz } = this;
    const dist = this.dist;
    dist.fill(Infinity);
    let ti = Math.floor((tx - this.x0) / this.cell);
    let tj = Math.floor((tz - this.z0) / this.cell);
    ti = Math.max(0, Math.min(nx - 1, ti));
    tj = Math.max(0, Math.min(nz - 1, tj));
    // binary heap Dijkstra
    let size = 0;
    const push = (idx: number, key: number) => {
      let k = size++;
      this.heap[k] = idx;
      this.heapKey[k] = key;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (this.heapKey[p] <= this.heapKey[k]) break;
        const ti2 = this.heap[p];
        const tk = this.heapKey[p];
        this.heap[p] = this.heap[k];
        this.heapKey[p] = this.heapKey[k];
        this.heap[k] = ti2;
        this.heapKey[k] = tk;
        k = p;
      }
    };
    const pop = () => {
      const top = this.heap[0];
      size--;
      this.heap[0] = this.heap[size];
      this.heapKey[0] = this.heapKey[size];
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < size && this.heapKey[l] < this.heapKey[m]) m = l;
        if (r < size && this.heapKey[r] < this.heapKey[m]) m = r;
        if (m === k) break;
        const ti2 = this.heap[m];
        const tk = this.heapKey[m];
        this.heap[m] = this.heap[k];
        this.heapKey[m] = this.heapKey[k];
        this.heap[k] = ti2;
        this.heapKey[k] = tk;
        k = m;
      }
      return top;
    };
    const start = tj * nx + ti;
    dist[start] = 0;
    push(start, 0);
    const D = Math.SQRT2;
    while (size > 0) {
      const cur = pop();
      const ci = cur % nx;
      const cj = (cur / nx) | 0;
      const cd = dist[cur];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
          const nIdx = nj * nx + ni;
          if (this.blocked[nIdx]) continue;
          // no corner cutting
          if (di && dj && (this.blocked[cj * nx + ni] || this.blocked[nj * nx + ci])) continue;
          const nd = cd + (di && dj ? D : 1);
          if (nd < dist[nIdx]) {
            dist[nIdx] = nd;
            if (size < this.heap.length) push(nIdx, nd);
          }
        }
      }
    }
  }

  /** Best step direction from (x, z) following the field. Returns false if unknown. */
  direction(x: number, z: number, out: { x: number; z: number }): boolean {
    const { nx, nz } = this;
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
    let best = this.dist[j * nx + i];
    let bi = -1;
    let bj = -1;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const d = this.dist[nj * nx + ni];
        if (d < best) {
          best = d;
          bi = ni;
          bj = nj;
        }
      }
    }
    if (bi < 0) return false;
    const tx = this.x0 + (bi + 0.5) * this.cell;
    const tz = this.z0 + (bj + 0.5) * this.cell;
    const dx = tx - x;
    const dz = tz - z;
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l;
    out.z = dz / l;
    return true;
  }
}
