import * as THREE from 'three';
import { rng } from '../core/rng';
import { flashTexture, puffTexture, ringTexture, softCircleTexture } from '../render/textures';
import { GLOBAL_UNIFORMS, toonUnique } from '../render/materials';

/** Atlas cells used by billboard particles. */
export const TEX = { puff: 0, soft: 1, star: 2, ring: 3 } as const;

function buildAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const cells = [puffTexture(), softCircleTexture(), flashTexture(), ringTexture()];
  cells.forEach((t, i) => {
    const img = t.image as HTMLCanvasElement;
    ctx.drawImage(img, (i % 2) * 128, Math.floor(i / 2) * 128, 128, 128);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const vert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iColor;   // rgb + alpha
  attribute vec4 iParams;  // size, rotation, texIndex, stretch
  attribute vec3 iVel;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vWorldY;
  varying float vSize;
  varying float vCell;
  varying vec2 vQ;
  #include <fog_pars_vertex>
  void main() {
    vColor = iColor;
    float size = iParams.x;
    float rot = iParams.y;
    float cell = iParams.z;
    float stretch = iParams.w;
    vec2 corner = position.xy;
    vec2 cellOff = vec2(mod(cell, 2.0), 1.0 - floor(cell / 2.0)) * 0.5;
    vUv = uv * 0.5 + cellOff;
    vec4 mvPosition = viewMatrix * vec4(iPos, 1.0);
    vec2 offset;
    if (stretch > 0.0) {
      vec2 v = (viewMatrix * vec4(iVel, 0.0)).xy;
      float l = length(v);
      vec2 dir = l > 1e-4 ? v / l : vec2(1.0, 0.0);
      vec2 perp = vec2(-dir.y, dir.x);
      offset = dir * corner.x * size * (1.0 + l * stretch) + perp * corner.y * size;
    } else {
      float c = cos(rot);
      float s = sin(rot);
      offset = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    }
    mvPosition.xy += offset;
    vQ = offset / max(size * 0.5, 1e-4);
    vSize = size;
    vCell = cell;
    vWorldY = (transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz)).y;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunView;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vWorldY;
  varying float vSize;
  varying float vCell;
  varying vec2 vQ;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(uMap, vUv);
    // soft particles: fade out where the billboard slices into the ground (rings lie on it)
    float soft = vCell > 2.5 ? 1.0 : smoothstep(0.0, max(vSize * 0.35, 0.04), vWorldY);
    float a = t.a * vColor.a * soft;
    if (a < 0.01) discard;
    vec3 col = t.rgb * vColor.rgb;
    #ifdef LIT
      // treat each puff as a little sphere lit by the low sun
      vec2 q = clamp(vQ, -1.0, 1.0);
      vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))) + 0.25));
      float l = dot(n, uSunView) * 0.5 + 0.5;
      col *= mix(vec3(0.76, 0.79, 0.95), vec3(1.12, 1.0, 0.86), l);
    #endif
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;

interface BParticle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  s0: number;
  s1: number;
  c0: THREE.Color;
  c1: THREE.Color;
  a0: number;
  a1: number;
  rot: number;
  rotV: number;
  grav: number;
  drag: number;
  cell: number;
  stretch: number;
  /** fade-in fraction of life */
  fadeIn: number;
  floor: boolean;
}

export interface BillboardOpts {
  vel?: THREE.Vector3 | [number, number, number];
  life?: number;
  size?: number;
  sizeEnd?: number;
  color?: number | THREE.Color;
  colorEnd?: number | THREE.Color;
  alpha?: number;
  alphaEnd?: number;
  rot?: number;
  rotVel?: number;
  gravity?: number;
  drag?: number;
  cell?: number;
  stretch?: number;
  fadeIn?: number;
  /** HDR multiplier on color (for bloom). */
  intensity?: number;
  floor?: boolean;
}

export class BillboardSystem {
  readonly mesh: THREE.Mesh;
  private ps: BParticle[] = [];
  private iPos: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iParams: THREE.InstancedBufferAttribute;
  private iVel: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private cursor = 0;

  constructor(
    private max: number,
    additive: boolean,
    atlas: THREE.Texture,
  ) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.iParams = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.iVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.iPos, this.iColor, this.iParams, this.iVel]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iColor', this.iColor);
    geo.setAttribute('iParams', this.iParams);
    geo.setAttribute('iVel', this.iVel);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: atlas }, uSunView: { value: new THREE.Vector3(0, 1, 0) } }]),
      defines: additive ? {} : { LIT: 1 },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    mat.uniforms.uMap.value = atlas;
    mat.uniforms.uSunView = GLOBAL_UNIFORMS.uSunView;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 10;
    for (let i = 0; i < max; i++) {
      this.ps.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        max: 1,
        s0: 1,
        s1: 1,
        c0: new THREE.Color(),
        c1: new THREE.Color(),
        a0: 1,
        a1: 0,
        rot: 0,
        rotV: 0,
        grav: 0,
        drag: 0,
        cell: 0,
        stretch: 0,
        fadeIn: 0,
        floor: false,
      });
    }
  }

  spawn(pos: THREE.Vector3 | [number, number, number], o: BillboardOpts): void {
    // find a free slot (ring buffer; overwrite oldest if full)
    let p: BParticle | null = null;
    for (let k = 0; k < this.max; k++) {
      const c = this.ps[(this.cursor + k) % this.max];
      if (!c.alive) {
        p = c;
        this.cursor = (this.cursor + k + 1) % this.max;
        break;
      }
    }
    if (!p) {
      p = this.ps[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
    }
    const [x, y, z] = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const v = o.vel ? (Array.isArray(o.vel) ? o.vel : [o.vel.x, o.vel.y, o.vel.z]) : [0, 0, 0];
    p.alive = true;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = v[0];
    p.vy = v[1];
    p.vz = v[2];
    p.life = 0;
    p.max = o.life ?? 1;
    p.s0 = o.size ?? 0.5;
    p.s1 = o.sizeEnd ?? p.s0;
    const k = o.intensity ?? 1;
    p.c0.set(o.color ?? 0xffffff).multiplyScalar(k);
    p.c1.set(o.colorEnd ?? o.color ?? 0xffffff).multiplyScalar(k);
    p.a0 = o.alpha ?? 1;
    p.a1 = o.alphaEnd ?? 0;
    p.rot = o.rot ?? rng.angle();
    p.rotV = o.rotVel ?? 0;
    p.grav = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.cell = o.cell ?? TEX.puff;
    p.stretch = o.stretch ?? 0;
    p.fadeIn = o.fadeIn ?? 0;
    p.floor = o.floor ?? false;
  }

  update(dt: number): void {
    let n = 0;
    const pos = this.iPos.array as Float32Array;
    const col = this.iColor.array as Float32Array;
    const par = this.iParams.array as Float32Array;
    const vel = this.iVel.array as Float32Array;
    const c = new THREE.Color();
    for (const p of this.ps) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.alive = false;
        continue;
      }
      const t = p.life / p.max;
      const drag = 1 / (1 + p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag + p.grav * dt;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.floor && p.y < 0.02) {
        p.y = 0.02;
        p.vy = 0;
      }
      p.rot += p.rotV * dt;
      const size = p.s0 + (p.s1 - p.s0) * (1 - (1 - t) * (1 - t));
      let a = p.a0 + (p.a1 - p.a0) * t;
      if (p.fadeIn > 0 && t < p.fadeIn) a *= t / p.fadeIn;
      c.copy(p.c0).lerp(p.c1, t);
      pos[n * 3] = p.x;
      pos[n * 3 + 1] = p.y;
      pos[n * 3 + 2] = p.z;
      col[n * 4] = c.r;
      col[n * 4 + 1] = c.g;
      col[n * 4 + 2] = c.b;
      col[n * 4 + 3] = a;
      par[n * 4] = size;
      par[n * 4 + 1] = p.rot;
      par[n * 4 + 2] = p.cell;
      par[n * 4 + 3] = p.stretch;
      vel[n * 3] = p.vx;
      vel[n * 3 + 1] = p.vy;
      vel[n * 3 + 2] = p.vz;
      n++;
    }
    this.geo.instanceCount = n;
    this.iPos.needsUpdate = true;
    this.iColor.needsUpdate = true;
    this.iParams.needsUpdate = true;
    this.iVel.needsUpdate = true;
  }

  clear(): void {
    for (const p of this.ps) p.alive = false;
  }
}

interface Drop {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
  kind: number;
  bounces: number;
}

/**
 * Small solid droplets/chunks (blood, dirt clods, pumpkin bits) as an instanced mesh,
 * stretched along their velocity. Calls `onLand` so gameplay can paint a splat.
 */
export class DropSystem {
  readonly mesh: THREE.InstancedMesh;
  private drops: Drop[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  onLand: ((pos: THREE.Vector3, vel: THREE.Vector3, kind: number, size: number) => void) | null = null;

  constructor(private max: number) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = toonUnique(0xffffff);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < max; i++) {
      this.drops.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 1, size: 0.05, color: new THREE.Color(), kind: 0, bounces: 0 });
    }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, size: number, color: number, kind = 0, life = 1.4): void {
    let d = this.drops.find((x) => !x.alive);
    if (!d) d = this.drops[Math.floor(rng.next() * this.max)];
    d.alive = true;
    d.pos.copy(pos);
    d.vel.copy(vel);
    d.life = 0;
    d.max = life;
    d.size = size;
    d.color.set(color);
    d.kind = kind;
    d.bounces = 0;
  }

  update(dt: number, gravity: number): void {
    let n = 0;
    for (const d of this.drops) {
      if (!d.alive) continue;
      d.life += dt;
      if (d.life > d.max) {
        d.alive = false;
        continue;
      }
      d.vel.y += gravity * dt;
      d.vel.multiplyScalar(1 / (1 + dt * 0.4));
      d.pos.addScaledVector(d.vel, dt);
      if (d.pos.y < d.size * 0.5) {
        d.pos.y = d.size * 0.5;
        if (d.kind === 0) {
          this.onLand?.(d.pos, d.vel, d.kind, d.size);
          d.alive = false;
          continue;
        }
        // chunks bounce a couple of times then settle and shrink
        if (d.bounces < 2 && d.vel.y < -1.5) {
          d.vel.y *= -0.3;
          d.vel.x *= 0.6;
          d.vel.z *= 0.6;
          d.bounces++;
          if (d.bounces === 1) this.onLand?.(d.pos, d.vel, d.kind, d.size);
        } else {
          d.vel.set(0, 0, 0);
        }
      }
      const sp = d.vel.length();
      const t = d.life / d.max;
      const shrink = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
      const stretch = 1 + Math.min(sp * 0.06, 1.6);
      if (sp > 0.01) this.q.setFromUnitVectors(this.up, this.s.copy(d.vel).divideScalar(sp));
      else this.q.identity();
      const sz = d.size * shrink;
      this.s.set(sz / Math.sqrt(stretch), sz * stretch, sz / Math.sqrt(stretch));
      this.m.compose(d.pos, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, d.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const d of this.drops) d.alive = false;
  }
}

interface Blob {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  s0: number;
  s1: number;
  c0: THREE.Color;
  c1: THREE.Color;
}

/** Solid spheres that grow and shrink (cartoon fireballs / thick smoke). */
export class BlobSystem {
  readonly mesh: THREE.InstancedMesh;
  private blobs: Blob[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(
    private max: number,
    emissive: boolean,
  ) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    let mat: THREE.Material;
    if (emissive) {
      // unlit but with a baked "light from above" and darker rim, so fireballs read as volumes
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vFireN;\nvarying vec3 vFireV;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             vFireN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
             vFireV = normalize(cameraPosition - (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz);`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vFireN;\nvarying vec3 vFireV;')
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
             float up = clamp(vFireN.y * 0.5 + 0.5, 0.0, 1.0);
             float rim = 1.0 - clamp(dot(normalize(vFireN), normalize(vFireV)), 0.0, 1.0);
             diffuseColor.rgb *= mix(0.62, 1.12, up) * (1.0 - rim * rim * 0.35);`,
          );
      };
      m.customProgramCacheKey = () => 'fireblob';
      mat = m;
    } else mat = toonUnique(0xffffff);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = !emissive;
    for (let i = 0; i < max; i++) {
      this.blobs.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 1, s0: 0, s1: 1, c0: new THREE.Color(), c1: new THREE.Color() });
    }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, s0: number, s1: number, c0: THREE.Color | number, c1: THREE.Color | number): void {
    let b = this.blobs.find((x) => !x.alive);
    if (!b) b = this.blobs[Math.floor(rng.next() * this.max)];
    b.alive = true;
    b.pos.copy(pos);
    b.vel.copy(vel);
    b.life = 0;
    b.max = life;
    b.s0 = s0;
    b.s1 = s1;
    b.c0.set(c0 as THREE.ColorRepresentation);
    b.c1.set(c1 as THREE.ColorRepresentation);
  }

  update(dt: number): void {
    let n = 0;
    for (const b of this.blobs) {
      if (!b.alive) continue;
      b.life += dt;
      if (b.life > b.max) {
        b.alive = false;
        continue;
      }
      const t = b.life / b.max;
      b.vel.multiplyScalar(1 / (1 + dt * 3));
      b.vel.y += dt * 1.2;
      b.pos.addScaledVector(b.vel, dt);
      // pop in fast, then shrink away at the end
      const grow = t < 0.15 ? t / 0.15 : 1;
      const shrink = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      const sz = (b.s0 + (b.s1 - b.s0) * Math.sqrt(t)) * grow * (0.15 + 0.85 * shrink);
      this.c.copy(b.c0).lerp(b.c1, Math.min(1, t * 1.6));
      this.s.set(sz, sz, sz);
      this.m.compose(b.pos, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const b of this.blobs) b.alive = false;
  }
}

/** All particle systems bundled. */
export class Particles {
  readonly soft: BillboardSystem;
  readonly glow: BillboardSystem;
  readonly drops: DropSystem;
  readonly fire: BlobSystem;
  readonly smoke: BlobSystem;
  readonly group = new THREE.Group();

  constructor() {
    const atlas = buildAtlas();
    this.soft = new BillboardSystem(900, false, atlas);
    this.glow = new BillboardSystem(500, true, atlas);
    this.drops = new DropSystem(420);
    this.fire = new BlobSystem(60, true);
    this.smoke = new BlobSystem(80, false);
    this.group.add(this.soft.mesh, this.glow.mesh, this.drops.mesh, this.fire.mesh, this.smoke.mesh);
  }

  update(dt: number, gravity: number): void {
    this.soft.update(dt);
    this.glow.update(dt);
    this.drops.update(dt, gravity);
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  clear(): void {
    this.soft.clear();
    this.glow.clear();
    this.drops.clear();
    this.fire.clear();
    this.smoke.clear();
  }
}
