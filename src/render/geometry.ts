import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Simplex } from '../core/noise';

/** Normalize a geometry to have exactly position/normal/uv so it can be merged with others. */
function canonical(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = g.index ? g.toNonIndexed() : g.clone();
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

/**
 * Accumulates colored primitives and merges them into one vertex-colored geometry. This keeps
 * draw calls low while letting every little part have its own palette color.
 */
export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, color: number | THREE.Color, matrix?: THREE.Matrix4): this {
    const g = canonical(geo);
    if (matrix) g.applyMatrix4(matrix);
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    const n = g.getAttribute('position').count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.parts.push(g);
    return this;
  }

  /** Add a geometry that already carries a per-vertex `color` attribute. */
  addColored(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): this {
    const g = canonical(geo);
    if (matrix) g.applyMatrix4(matrix);
    this.parts.push(g);
    return this;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error('GeoBuilder: merge failed');
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return merged;
  }
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

export const rbox = (w: number, h: number, d: number, r = 0.05, seg = 2) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));

export const cyl = (rt: number, rb: number, h: number, seg = 12, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

export const sphere = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);

export const capsule = (r: number, len: number, cap = 4, radial = 10) =>
  new THREE.CapsuleGeometry(r, len, cap, radial);

export const cone = (r: number, h: number, seg = 12) => new THREE.ConeGeometry(r, h, seg);

const blobNoise = new Simplex(4242);

/**
 * Smooth, slightly lumpy sphere – the building block for canopies, bushes, rocks and puffs.
 * `squashY` flattens it, `amp` controls the lumpiness.
 */
export function blob(radius: number, detail = 2, amp = 0.12, seed = 0, squashY = 1): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(radius, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const f = 1.6 / radius;
    const d =
      blobNoise.noise3(n.x * 1.3 + seed * 3.1, n.y * 1.3 + seed * 1.7, n.z * 1.3) * 0.7 +
      blobNoise.noise3(v.x * f + seed, v.y * f, v.z * f) * 0.3;
    v.multiplyScalar(1 + d * amp);
    v.y *= squashY;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Flat-shaded low poly rock. */
export function rock(radius: number, seed = 0): THREE.BufferGeometry {
  const g = blob(radius, 1, 0.28, seed, 0.62);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/** A gable (triangular prism) roof body, ridge along X. */
export function gableGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(0, h);
  shape.lineTo(d / 2, 0);
  shape.lineTo(-d / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

/** A thin slab (roof plane) from a to b with thickness, used for overhanging roofs. */
export function slabBetween(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  length: number,
  thickness: number,
): { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy);
  const geo = new RoundedBoxGeometry(length, thickness, l, 2, Math.min(thickness * 0.45, 0.06));
  const m = new THREE.Matrix4();
  const ang = Math.atan2(dy, dx);
  m.compose(
    new THREE.Vector3(0, (ay + by) / 2, (ax + bx) / 2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-ang, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  return { geo, matrix: m };
}

/** A rounded board spanning a→b (length axis), with the given width (perp, in `up` plane) and depth. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number, up = new THREE.Vector3(0, 0, 1)): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new RoundedBoxGeometry(len, width, depth, 1, Math.min(width, depth) * 0.3);
  const x = dir.divideScalar(len);
  const z = up.clone().normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const zz = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, zz);
  m.setPosition(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return g;
}

/** Tapered blade strip for grass: returns a geometry with a vertical gradient in `color`. */
export function grassTuftGeometry(blades: number, height: number, spread: number, seed: number, base: THREE.Color, tip: THREE.Color): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  let s = seed;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * spread;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = height * (0.6 + rnd() * 0.5);
    const w = 0.035 + rnd() * 0.02;
    const facing = rnd() * Math.PI;
    const lean = 0.08 + rnd() * 0.12;
    const lx = Math.cos(a) * lean;
    const lz = Math.sin(a) * lean;
    const px = Math.cos(facing) * w;
    const pz = Math.sin(facing) * w;
    // two segments: base quad + tip triangle
    const midH = h * 0.55;
    const pts = [
      [x - px, 0, z - pz],
      [x + px, 0, z + pz],
      [x + px * 0.6 + lx * 0.4, midH, z + pz * 0.6 + lz * 0.4],
      [x - px * 0.6 + lx * 0.4, midH, z - pz * 0.6 + lz * 0.4],
      [x + lx, h, z + lz],
    ];
    const tris = [
      [0, 1, 2],
      [0, 2, 3],
      [3, 2, 4],
    ];
    for (const t of tris) {
      for (const idx of t) {
        const p = pts[idx];
        positions.push(p[0], p[1], p[2]);
        const k = p[1] / h;
        colors.push(base.r + (tip.r - base.r) * k, base.g + (tip.g - base.g) * k, base.b + (tip.b - base.b) * k);
        normals.push(0, 1, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

/**
 * Replace UVs with a box projection in world units (after transforms), so tiling textures
 * (siding, shingles, boards) keep a constant scale on every face.
 */
export function worldUV(geo: THREE.BufferGeometry, scale = 1, offset = new THREE.Vector2()): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x;
      v = z;
    } else if (nx >= nz) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * scale + offset.x;
    uv[i * 2 + 1] = v * scale + offset.y;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Recolor a geometry: fills a `color` attribute (useful before merging special geometries). */
export function paint(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

/** Vertical color gradient on an existing geometry (bottom→top), e.g. for trunks and canopies. */
export function gradientY(geo: THREE.BufferGeometry, bottom: number, top: number, y0?: number, y1?: number): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const a = y0 ?? bb.min.y;
  const b = y1 ?? bb.max.y;
  const cb = new THREE.Color(bottom);
  const ct = new THREE.Color(top);
  const pos = geo.getAttribute('position');
  const cols = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - a) / (b - a || 1)));
    c.copy(cb).lerp(ct, t);
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}
