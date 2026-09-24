import * as THREE from 'three';
import { Rng, rng } from '../core/rng';
import { noise } from '../core/noise';
import { compose, Spring } from '../core/math';
import { PAL } from '../render/palette';
import { blob, cone, cyl, GeoBuilder, gradientY, grassTuftGeometry, rock, sphere } from '../render/geometry';
import { GLOBAL_UNIFORMS, toon, vcToon } from '../render/materials';
import { canvasTexture } from '../render/textures';
import { StaticCollider } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { LAYOUT, inPond, isOpenGround } from './layout';
import { sfx } from '../audio/sfx';

export type TreeKind = 'oak' | 'autumn' | 'birch' | 'pine';

const LEAF_COLORS: Record<TreeKind, number[]> = {
  oak: [PAL.leafA, PAL.leafB, PAL.leafC],
  autumn: [PAL.leafAutumn, PAL.leafGold, PAL.leafRust],
  birch: [PAL.leafB, PAL.leafGold, PAL.leafA],
  pine: [PAL.pine, PAL.pineDark],
};

function birchTexture(): THREE.CanvasTexture {
  return canvasTexture('birch', 64, 256, (ctx, w, h) => {
    const r = new Rng(9);
    ctx.fillStyle = '#f3eee4';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = `rgba(60,55,55,${0.55 + r.next() * 0.35})`;
      const y = r.next() * h;
      const x = r.next() * w;
      ctx.beginPath();
      ctx.ellipse(x, y, 4 + r.next() * 12, 1.2 + r.next() * 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

export interface TreeParts {
  trunk: THREE.BufferGeometry | null;
  birchTrunk: THREE.BufferGeometry | null;
  leaves: THREE.BufferGeometry;
  canopyBase: number;
  canopyRadius: number;
  canopyHeight: number;
}

/** Build tree geometry in local space (trunk base at origin). Canopy is relative to canopyBase. */
export function treeParts(kind: TreeKind, s: number, seed: number): TreeParts {
  const r = new Rng(seed);
  const trunk = new GeoBuilder();
  const leaves = new GeoBuilder();
  let birchTrunk: THREE.BufferGeometry | null = null;
  let canopyBase = 2.2 * s;
  let canopyRadius: number;
  let canopyHeight: number;

  if (kind === 'pine') {
    canopyBase = 0.9 * s;
    trunk.add(cyl(0.16 * s, 0.24 * s, 1.4 * s, 8), PAL.trunkDark, compose(0, 0.7 * s, 0));
    const tiers = [
      [1.55, 1.7, 0.0],
      [1.25, 1.5, 0.85],
      [0.95, 1.3, 1.6],
      [0.6, 1.1, 2.3],
    ];
    tiers.forEach(([rad, hgt, y], i) => {
      const g = cone(rad * s, hgt * s, 9);
      g.translate(0, (y + hgt / 2) * s, 0);
      gradientY(g, i % 2 ? PAL.pineDark : 0x557f60, i % 2 ? PAL.pine : 0x77a07a);
      leaves.addColored(g);
    });
    canopyRadius = 1.6 * s;
    canopyHeight = 1.8 * s;
  } else if (kind === 'birch') {
    birchTrunk = cyl(0.11 * s, 0.16 * s, 3.2 * s, 10);
    birchTrunk.translate(0, 1.6 * s, 0);
    canopyBase = 2.4 * s;
    const blobs = [
      [0, 1.2, 0, 1.0],
      [0.55, 0.7, 0.2, 0.7],
      [-0.5, 0.8, -0.2, 0.72],
      [0.1, 1.9, 0.05, 0.62],
    ];
    blobs.forEach(([bx, by, bz, br], i) => {
      const g = blob(br * s, 2, 0.14, seed + i, 1.15);
      g.translate(bx * s, by * s, bz * s);
      gradientY(g, i === 1 ? PAL.leafGold : PAL.leafA, PAL.leafB, 0, 2.6 * s);
      leaves.addColored(g);
    });
    canopyRadius = 1.3 * s;
    canopyHeight = 1.1 * s;
  } else {
    trunk.add(cyl(0.2 * s, 0.32 * s, 2.6 * s, 10), PAL.trunk, compose(0, 1.3 * s, 0, 0.03, 0, -0.04));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + r.spread(0.4);
      trunk.add(blob(0.2 * s, 1, 0.2, seed + i, 0.5), PAL.trunkDark, compose(Math.cos(a) * 0.27 * s, 0.06, Math.sin(a) * 0.27 * s));
    }
    trunk.add(cyl(0.06 * s, 0.1 * s, 1.1 * s, 6), PAL.trunk, compose(0.35 * s, 2.3 * s, 0, 0, 0, -0.8));
    trunk.add(cyl(0.05 * s, 0.09 * s, 1.0 * s, 6), PAL.trunk, compose(-0.3 * s, 2.4 * s, 0.1 * s, 0.2, 0, 0.9));
    const blobs = [
      [0, 1.25, 0, 1.55],
      [1.15, 0.85, 0.35, 1.08],
      [-1.1, 0.95, -0.25, 1.12],
      [0.25, 1.0, -1.05, 1.0],
      [-0.3, 1.1, 1.0, 0.98],
      [0.2, 2.05, 0.15, 1.02],
    ];
    blobs.forEach(([bx, by, bz, br], i) => {
      const g = blob(br * s, 2, 0.13, seed * 3 + i, 0.92);
      g.translate(bx * s, by * s, bz * s);
      const low = kind === 'autumn' ? (i % 3 === 0 ? PAL.leafRust : PAL.leafAutumn) : PAL.leafC;
      const high = kind === 'autumn' ? (i % 2 ? PAL.leafGold : 0xf0bd6a) : i % 2 ? PAL.leafB : 0xa9cf83;
      gradientY(g, low, high, -0.3 * s, 3.2 * s);
      leaves.addColored(g);
    });
    canopyRadius = 2.2 * s;
    canopyHeight = 1.3 * s;
  }
  return { trunk: trunk.empty ? null : trunk.build(), birchTrunk, leaves: leaves.build(), canopyBase, canopyRadius, canopyHeight };
}

/** A swaying, shootable tree. The canopy is a separate pivoted mesh with spring physics. */
export class Tree implements Updatable {
  readonly group = new THREE.Group();
  readonly canopy = new THREE.Group();
  readonly collider: StaticCollider;
  private swayX = new Spring(0, 30, 3.2);
  private swayZ = new Spring(0, 30, 3.2);
  private leafTimer: number;
  readonly canopyCenter = new THREE.Vector3();
  readonly canopyRadius: number;

  constructor(
    private ctx: GameCtx,
    x: number,
    z: number,
    readonly kind: TreeKind,
    readonly s: number,
    seed: number,
  ) {
    const r = new Rng(seed);
    this.group.position.set(x, 0, z);
    this.group.rotation.y = r.angle();
    const parts = treeParts(kind, s, seed);
    if (parts.trunk) {
      const tm = new THREE.Mesh(parts.trunk, vcToon());
      tm.castShadow = true;
      tm.receiveShadow = true;
      this.group.add(tm);
    }
    if (parts.birchTrunk) {
      const tmesh = new THREE.Mesh(parts.birchTrunk, toon(0xffffff, { map: birchTexture() }));
      tmesh.castShadow = true;
      this.group.add(tmesh);
    }
    const lm = new THREE.Mesh(parts.leaves, vcToon({ wind: 0.035, windHeight: 0.35 }));
    lm.castShadow = true;
    lm.receiveShadow = true;
    this.canopy.position.y = parts.canopyBase;
    this.canopy.add(lm);
    this.group.add(this.canopy);
    this.canopyRadius = parts.canopyRadius;
    this.canopyCenter.set(x, parts.canopyBase + parts.canopyHeight, z);

    const trunkR = kind === 'birch' ? 0.16 * s : kind === 'pine' ? 0.25 * s : 0.32 * s;
    this.collider = StaticCollider.cyl(x, z, trunkR, kind === 'pine' ? 3 * s : 3 * s, 'wood', {
      onBulletHit: (p, n) => {
        this.shake(0.35, n);
        ctx.fx.splinters(p, n, 3, PAL.trunk);
        ctx.fx.decals.bulletHole(p, n, 0.11);
        sfx.woodHit(p);
        this.dropLeaves(2);
      },
      onImpact: (speed, p, dir) => {
        this.shake(Math.min(1.2, speed * 0.08), dir.clone().negate());
        this.dropLeaves(Math.min(8, Math.round(speed * 0.5)));
        sfx.thud(p, speed / 8);
        return false;
      },
      onBlast: (c, strength) => {
        const d = new THREE.Vector3(this.group.position.x - c.x, 0, this.group.position.z - c.z).normalize();
        this.shake(Math.min(1.5, strength), d.negate());
        this.dropLeaves(Math.round(10 * strength));
      },
    });
    this.leafTimer = r.range(1, 6);
  }

  shake(amount: number, from: THREE.Vector3): void {
    // lean away from the hit direction
    this.swayX.kick(-from.z * amount * 1.2);
    this.swayZ.kick(from.x * amount * 1.2);
  }

  dropLeaves(n: number): void {
    const colors = LEAF_COLORS[this.kind];
    for (let i = 0; i < n; i++) {
      const p = this.canopyCenter.clone().add(new THREE.Vector3(rng.spread(this.canopyRadius * 0.8), rng.spread(0.6) - 0.4, rng.spread(this.canopyRadius * 0.8)));
      this.ctx.fx.leafBurst(p, 1, colors);
    }
  }

  update(dt: number): void {
    this.swayX.update(dt);
    this.swayZ.update(dt);
    this.canopy.rotation.x = this.swayX.value * 0.25;
    this.canopy.rotation.z = this.swayZ.value * 0.25;
    this.leafTimer -= dt;
    if (this.leafTimer <= 0 && this.kind !== 'pine') {
      this.leafTimer = rng.range(3, 9);
      this.ctx.fx.leafBurst(
        this.canopyCenter.clone().add(new THREE.Vector3(rng.spread(this.canopyRadius * 0.7), -0.6, rng.spread(this.canopyRadius * 0.7))),
        1,
        LEAF_COLORS[this.kind],
      );
    }
  }
}

export function createBush(x: number, z: number, s: number, seed: number, flowers: boolean): THREE.Mesh {
  const r = new Rng(seed);
  const b = new GeoBuilder();
  const n = 3 + r.int(0, 1);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.spread(0.3);
    const rad = (0.45 + r.next() * 0.25) * s;
    const g = blob(rad, 2, 0.14, seed + i, 0.85);
    g.translate(Math.cos(a) * 0.35 * s, rad * 0.75, Math.sin(a) * 0.35 * s);
    gradientY(g, PAL.leafC, PAL.bush, 0, 1.1 * s);
    b.addColored(g);
  }
  const top = blob(0.5 * s, 2, 0.12, seed + 9, 0.85);
  top.translate(0, 0.72 * s, 0);
  gradientY(top, PAL.bush, PAL.leafB, 0.2, 1.3 * s);
  b.addColored(top);
  if (flowers) {
    const col = r.pick([PAL.flowerPink, PAL.flowerWhite, PAL.flowerYellow]);
    for (let i = 0; i < 9; i++) {
      const a = r.angle();
      const el = r.range(0.2, 1.1);
      b.add(sphere(0.06 * s, 6, 5), col, compose(Math.cos(a) * 0.62 * s * Math.cos(el * 0.5), 0.45 * s + Math.sin(el) * 0.55 * s, Math.sin(a) * 0.62 * s * Math.cos(el * 0.5)));
    }
  }
  const m = new THREE.Mesh(b.build(), vcToon({ wind: 0.015, windHeight: 0.8 }));
  m.position.set(x, 0, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function createRock(x: number, z: number, s: number, seed: number): THREE.Mesh {
  const g = rock(s, seed);
  g.translate(0, s * 0.35, 0);
  const b = new GeoBuilder();
  gradientY(g, PAL.stoneDark, PAL.stone);
  b.addColored(g);
  const m = new THREE.Mesh(b.build(), vcToon());
  m.position.set(x, 0, z);
  m.rotation.y = seed;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Grass & flowers
// ---------------------------------------------------------------------------------------------

export const PUSHERS = { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, 0, 0)) };

function grassMaterial(): THREE.MeshToonMaterial {
  const m = vcToon().clone();
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uGust = GLOBAL_UNIFORMS.uGust;
    shader.uniforms.uGustStrength = GLOBAL_UNIFORMS.uGustStrength;
    shader.uniforms.uPush = PUSHERS;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec4 uGust;
         uniform float uGustStrength;
         uniform vec4 uPush[10];`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 gw = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
           float h = clamp(position.y / 0.45, 0.0, 1.0);
           h = h * h;
           vec2 sway = vec2(
             sin(uTime * 1.6 + gw.x * 0.55 + gw.z * 0.35) * 0.6 + sin(uTime * 3.1 + gw.z * 1.7) * 0.25,
             cos(uTime * 1.3 + gw.x * 0.4 - gw.z * 0.5) * 0.4);
           vec2 off = sway * 0.07;
           float flatten = 0.0;
           for (int i = 0; i < 10; i++) {
             vec4 p = uPush[i];
             if (p.z <= 0.0) continue;
             vec2 d = gw.xz - p.xy;
             float dist = length(d) + 1e-3;
             float f = (1.0 - smoothstep(p.z * 0.35, p.z, dist)) * p.w;
             off += d / dist * f * 0.32;
             flatten = max(flatten, f);
           }
           vec2 gd = gw.xz - uGust.xz;
           float gdist = length(gd) + 0.001;
           float age = uTime - uGust.w;
           float ring = exp(-pow((gdist - age * 14.0) * 0.6, 2.0)) * exp(-age * 1.5) * uGustStrength;
           off += gd / gdist * ring * 0.5;
           flatten = max(flatten, ring * 0.8);
           // offsets are in world space, the instance may be rotated: rotate back
           vec3 wOff = vec3(off.x, 0.0, off.y);
           // instances are only yawed and scaled (same x/z scale): inverse = transpose / s²
           mat3 im = mat3(instanceMatrix);
           vec3 lOff = transpose(im) * wOff / dot(im[0], im[0]);
           transformed += lOff * h;
           transformed.y *= 1.0 - flatten * 0.45;
         }`,
      );
  };
  const prevCompile = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prevCompile.call(m, shader, r);
    // blades are lit like the ground they grow from, whichever side faces the camera
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
       normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`,
    );
  };
  m.customProgramCacheKey = () => 'grass';
  return m;
}

export function createGrass(): THREE.Group {
  const group = new THREE.Group();
  group.userData.noAO = true;
  const r = new Rng(4242);
  const mat = grassMaterial();
  const variants = [
    grassTuftGeometry(5, 0.36, 0.1, 11, new THREE.Color(0x93b366), new THREE.Color(PAL.grassTip)),
    grassTuftGeometry(7, 0.3, 0.15, 23, new THREE.Color(0x8fb063), new THREE.Color(0xd3e294)),
  ];
  const b = LAYOUT.bounds;
  const pts: [number, number, number][][] = [[], []];
  const tries = 26000;
  for (let i = 0; i < tries; i++) {
    const x = r.range(b.minX - 12, b.maxX + 12);
    const z = r.range(b.minZ - 12, b.maxZ + 12);
    if (!isOpenGround(x, z, 0.2)) continue;
    // clumpy distribution: dense patches, lots of breathing room between
    const n = noise.fbm2(x * 0.08, z * 0.08, 2) * 0.5 + 0.5;
    const n2 = noise.noise2(x * 0.5 + 9, z * 0.5) * 0.5 + 0.5;
    if (n < 0.56 || n2 * n < 0.34) continue;
    pts[r.chance(0.55) ? 0 : 1].push([x, z, n]);
  }
  const m4 = new THREE.Matrix4();
  const c = new THREE.Color();
  // square chunks, each its own instanced mesh, so whatever is off screen isn't drawn at all
  const CHUNK = 16;
  variants.forEach((geo, vi) => {
    const chunks = new Map<string, [number, number, number][]>();
    for (const p of pts[vi]) {
      const key = `${Math.floor(p[0] / CHUNK)},${Math.floor(p[1] / CHUNK)}`;
      let list = chunks.get(key);
      if (!list) chunks.set(key, (list = []));
      list.push(p);
    }
    for (const list of chunks.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, z, n], i) => {
        const s = 0.75 + n * 0.6 + r.next() * 0.25;
        m4.copy(compose(x, 0, z, 0, r.angle(), 0, s, s * (0.85 + r.next() * 0.35), s));
        mesh.setMatrixAt(i, m4);
        c.setHSL(0.22 + r.spread(0.03), 0.4 + r.spread(0.08), 0.66 + r.spread(0.06));
        c.lerp(new THREE.Color(1, 1, 1), 0.62);
        mesh.setColorAt(i, c);
      });
      mesh.receiveShadow = true;
      // bounds from the instances, padded for wind sway and people brushing through
      mesh.computeBoundingSphere();
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.8;
      // instances are in random order, so drawing fewer thins the grass evenly (quality LOD)
      mesh.userData.lodCount = list.length;
      group.add(mesh);
    }
  });
  return group;
}

/** Garden flowers + meadow flower clumps (stems and heads as two instanced meshes). */
export function createFlowers(): THREE.Group {
  const group = new THREE.Group();
  group.userData.noAO = true;
  const r = new Rng(99);
  const spots: { x: number; z: number; col: number; h: number }[] = [];
  // garden beds
  for (const bed of LAYOUT.beds) {
    if (bed.kind !== 'flowers') continue;
    const n = Math.round(bed.w * bed.d * 16);
    const palette = [PAL.flowerPink, PAL.flowerYellow, PAL.flowerWhite, PAL.flowerLavender, PAL.flowerRed];
    for (let i = 0; i < n; i++) {
      spots.push({ x: bed.x + r.spread(bed.w / 2 - 0.1), z: bed.z + r.spread(bed.d / 2 - 0.08), col: r.pick(palette), h: r.range(0.28, 0.5) });
    }
  }
  // meadow clumps
  for (let i = 0; i < 70; i++) {
    const x = r.range(-34, 34);
    const z = r.range(-26, 24);
    if (!isOpenGround(x, z, 0.6)) continue;
    const col = r.pick([PAL.flowerWhite, PAL.flowerYellow, PAL.flowerLavender, PAL.flowerPink, PAL.flowerOrange]);
    const k = 3 + r.int(0, 5);
    for (let j = 0; j < k; j++) spots.push({ x: x + r.spread(0.5), z: z + r.spread(0.5), col, h: r.range(0.22, 0.42) });
  }
  const stemGeo = new THREE.CylinderGeometry(0.012, 0.016, 1, 4);
  stemGeo.translate(0, 0.5, 0);
  const headGeo = new THREE.IcosahedronGeometry(0.075, 0);
  headGeo.scale(1, 0.55, 1);
  const leafMat = toon(0x6f9f58, { wind: 0.05, windHeight: 2.0 });
  const headMat = toon(0xffffff, { wind: 0.05, windHeight: 2.0 });
  const stems = new THREE.InstancedMesh(stemGeo, leafMat, spots.length);
  const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length);
  const c = new THREE.Color();
  spots.forEach((s, i) => {
    const tilt = r.spread(0.15);
    stems.setMatrixAt(i, compose(s.x, 0, s.z, tilt, 0, 0, 1, s.h, 1));
    heads.setMatrixAt(i, compose(s.x, s.h, s.z + Math.sin(tilt) * s.h, 0, r.angle(), 0));
    heads.setColorAt(i, c.set(s.col));
  });
  stems.receiveShadow = true;
  heads.castShadow = false;
  heads.receiveShadow = true;
  group.add(stems, heads);
  return group;
}

/** Reeds and cattails around the pond. */
export function createReeds(): THREE.Group {
  const group = new THREE.Group();
  group.userData.noAO = true;
  const r = new Rng(31337);
  const p = LAYOUT.pond;
  const reedGeo = grassTuftGeometry(5, 0.9, 0.08, 5, new THREE.Color(0x7f9a55), new THREE.Color(0xc3cf86));
  const reeds: THREE.Matrix4[] = [];
  const tails: THREE.Matrix4[] = [];
  for (let i = 0; i < 120; i++) {
    const a = r.angle();
    const k = r.range(0.88, 1.12);
    const x = p.x + Math.cos(a) * p.rx * k;
    const z = p.z + Math.sin(a) * p.rz * k;
    if (Math.cos(a) > 0.6 && Math.sin(a) > -0.2) continue; // leave an opening
    const s = r.range(0.7, 1.3);
    reeds.push(compose(x, 0, z, 0, r.angle(), 0, s, s, s));
    if (r.chance(0.35)) tails.push(compose(x + r.spread(0.1), 0, z + r.spread(0.1), r.spread(0.1), 0, r.spread(0.1), s));
  }
  const reedMesh = new THREE.InstancedMesh(reedGeo, grassMaterial(), reeds.length);
  reedMesh.castShadow = true;
  reeds.forEach((m, i) => reedMesh.setMatrixAt(i, m));
  reedMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  for (let i = 0; i < reeds.length; i++) reedMesh.setColorAt(i, new THREE.Color(1, 1, 1));
  reedMesh.receiveShadow = true;
  group.add(reedMesh);
  const tb = new GeoBuilder();
  tb.add(new THREE.CylinderGeometry(0.012, 0.015, 1.15, 4), 0x7d9152, compose(0, 0.575, 0));
  tb.add(new THREE.CapsuleGeometry(0.04, 0.16, 2, 6), PAL.cattail, compose(0, 1.08, 0));
  const tailMesh = new THREE.InstancedMesh(tb.build(), vcToon({ wind: 0.06, windHeight: 1.0 }), tails.length);
  tails.forEach((m, i) => tailMesh.setMatrixAt(i, m));
  tailMesh.castShadow = true;
  group.add(tailMesh);
  return group;
}

export function inWater(x: number, z: number): boolean {
  return inPond(x, z, -0.2);
}

/** Decorative ring of trees outside the playable area (one merged mesh per material). */
export function createForestRing(): THREE.Group {
  const group = new THREE.Group();
  const r = new Rng(8080);
  const trunks = new GeoBuilder();
  const leaves = new GeoBuilder();
  const b = LAYOUT.bounds;
  let placed = 0;
  for (let i = 0; i < 900 && placed < 95; i++) {
    const x = r.range(-72, 72);
    const z = r.range(-62, 58);
    const inside = x > b.minX - 3 && x < b.maxX + 3 && z > b.minZ - 3 && z < b.maxZ + 3;
    if (inside) continue;
    if (Math.abs(z - LAYOUT.road.z) < LAYOUT.road.width / 2 + 2) continue;
    // thinner near the play area so the edge stays readable
    const edge = Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ);
    if (edge < 8 && r.chance(0.55)) continue;
    const kind: TreeKind = r.chance(0.45) ? 'pine' : r.chance(0.35) ? 'autumn' : 'oak';
    const s = r.range(0.9, 1.35);
    const parts = treeParts(kind, s, 500 + i);
    const m = compose(x, 0, z, 0, r.angle(), 0);
    if (parts.trunk) trunks.addColored(parts.trunk, m);
    const lm = m.clone().multiply(compose(0, parts.canopyBase, 0));
    leaves.addColored(parts.leaves, lm);
    placed++;
  }
  const tm = new THREE.Mesh(trunks.build(), vcToon());
  tm.castShadow = true;
  const lm = new THREE.Mesh(leaves.build(), vcToon({ wind: 0.03, windHeight: 0.2 }));
  lm.castShadow = true;
  lm.receiveShadow = true;
  group.add(tm, lm);
  // soft rolling hills on the horizon
  const hills = new GeoBuilder();
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + r.spread(0.1);
    const d = r.range(95, 125);
    const rad = r.range(22, 38);
    const g = blob(rad, 2, 0.05, i, r.range(0.22, 0.34));
    hills.add(g, r.chance(0.5) ? PAL.grassDark : PAL.grassDeep, compose(Math.cos(a) * d, -2, Math.sin(a) * d));
  }
  group.add(new THREE.Mesh(hills.build(), vcToon()));
  return group;
}
