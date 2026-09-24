import * as THREE from 'three';
import { rng } from '../core/rng';
import { compose, damp, Spring } from '../core/math';
import { PAL } from '../render/palette';
import { box, cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { GLOBAL_UNIFORMS, toon, toonUnique, vcToon } from '../render/materials';
import { canvasTexture } from '../render/textures';
import { StaticCollider, type HitReceiver } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { sfx } from '../audio/sfx';

function m(geo: THREE.BufferGeometry, shadow = true): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, vcToon());
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** Red mailbox: the flag flips and letters fly when shot. */
export class Mailbox implements HitReceiver, Updatable {
  readonly group = new THREE.Group();
  readonly collider: StaticCollider;
  private flag = new THREE.Group();
  private lid = new THREE.Group();
  private flagS = new Spring(0, 60, 4);
  private lidS = new Spring(0, 80, 6);
  private letters = 3;

  constructor(
    private ctx: GameCtx,
    x: number,
    z: number,
  ) {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = Math.PI;
    const g = new GeoBuilder();
    g.add(rbox(0.12, 1.05, 0.12, 0.03), PAL.fenceWoodDark, compose(0, 0.52, 0));
    g.add(rbox(0.3, 0.06, 0.52, 0.02), PAL.fenceWoodDark, compose(0, 1.05, 0));
    g.add(rbox(0.3, 0.24, 0.5, 0.04), PAL.mailbox, compose(0, 1.2, 0));
    g.add(cyl(0.15, 0.15, 0.5, 14, false), PAL.mailbox, compose(0, 1.32, 0, Math.PI / 2, 0, 0));
    this.group.add(m(g.build()));
    const fg = new GeoBuilder();
    fg.add(box(0.025, 0.32, 0.03), 0xd8b04a, compose(0, 0.16, 0));
    fg.add(box(0.02, 0.1, 0.14), PAL.flowerYellow, compose(0, 0.27, 0.07));
    this.flag.add(m(fg.build()));
    this.flag.position.set(0.16, 1.2, 0.05);
    this.flag.rotation.x = Math.PI / 2;
    this.group.add(this.flag);
    const lg = new GeoBuilder();
    lg.add(cyl(0.155, 0.155, 0.02, 14), 0xc94c41, compose(0, 0, 0, Math.PI / 2, 0, 0));
    lg.add(box(0.3, 0.12, 0.02), 0xc94c41, compose(0, -0.08, 0));
    this.lid.add(m(lg.build()));
    this.lid.position.set(0, 1.12, 0.26);
    this.group.add(this.lid);
    this.collider = StaticCollider.cyl(x, z, 0.2, 1.5, 'metal', this);
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.flagS.kick(9);
    this.lidS.kick(8);
    this.ctx.fx.sparks(point, normal, 4, 5);
    sfx.metalHit(point);
    if (this.letters > 0) {
      this.letters--;
      const p = new THREE.Vector3(0, 1.25, -0.3).applyMatrix4(this.group.matrixWorld);
      for (let i = 0; i < 2; i++) {
        this.ctx.fx.debris.spawn('flat', p, new THREE.Vector3(rng.spread(2), rng.range(2, 4), rng.spread(2)), new THREE.Vector3(0.22, 0.01, 0.12), i ? 0xfdf6e8 : 0xf3d7c4, { life: 9, spin: 6 });
      }
    }
  }

  onBlast(): void {
    this.flagS.kick(12);
    this.lidS.kick(12);
  }

  update(dt: number): void {
    this.flagS.update(dt);
    this.lidS.update(dt);
    this.flag.rotation.x = Math.PI / 2 - Math.min(Math.PI / 2, Math.abs(this.flagS.value) * 0.5);
    this.lid.rotation.x = Math.min(1.8, Math.abs(this.lidS.value) * 0.25);
  }
}

/** Old street lamp with a warm point light; it flickers now and then and can be shot out. */
export class LampPost implements HitReceiver, Updatable {
  readonly group = new THREE.Group();
  readonly collider: StaticCollider;
  private light: THREE.PointLight;
  private glass: THREE.MeshBasicMaterial;
  private broken = false;
  private flicker = 0;
  private swing = new Spring(0, 30, 2);
  private head = new THREE.Group();

  constructor(
    private ctx: GameCtx,
    x: number,
    z: number,
  ) {
    this.group.position.set(x, 0, z);
    const g = new GeoBuilder();
    const dark = 0x4d5a57;
    g.add(cyl(0.16, 0.2, 0.3, 10), dark, compose(0, 0.15, 0));
    g.add(cyl(0.06, 0.08, 3.1, 8), dark, compose(0, 1.7, 0));
    g.add(sphere(0.09, 8, 6), dark, compose(0, 3.28, 0));
    g.add(cyl(0.03, 0.03, 0.75, 6), dark, compose(0.35, 3.2, 0, 0, 0, Math.PI / 2));
    this.group.add(m(g.build()));
    this.head.position.set(0.7, 3.2, 0);
    const hg = new GeoBuilder();
    hg.add(cyl(0.02, 0.02, 0.2, 5), dark, compose(0, -0.1, 0));
    hg.add(cyl(0.02, 0.26, 0.16, 10), dark, compose(0, -0.24, 0));
    hg.add(cyl(0.12, 0.08, 0.06, 10), dark, compose(0, -0.56, 0));
    this.head.add(m(hg.build(), false));
    this.glass = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe1a0).multiplyScalar(2.4) });
    const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.11, 0.26, 10), this.glass);
    gl.position.y = -0.42;
    this.head.add(gl);
    this.light = new THREE.PointLight(0xffc27a, 7, 9, 1.5);
    this.light.position.y = -0.5;
    this.head.add(this.light);
    this.group.add(this.head);
    this.collider = StaticCollider.cyl(x, z, 0.12, 3.4, 'metal', this);
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.ctx.fx.sparks(point, normal, 5, 6);
    sfx.metalHit(point);
    this.swing.kick(2.5);
  }

  onBlast(): void {
    this.swing.kick(5);
    if (!this.broken && rng.chance(0.5)) this.flicker = 1.2;
  }

  update(dt: number, t: number): void {
    this.swing.update(dt);
    this.swing.target = Math.sin(t * 0.8) * 0.02;
    this.head.rotation.z = this.swing.value * 0.12;
    if (this.broken) return;
    let k = 1;
    if (this.flicker > 0) {
      this.flicker -= dt;
      k = rng.chance(0.45) ? 0.15 : 1;
    } else if (rng.chance(dt * 0.12)) this.flicker = rng.range(0.2, 0.7);
    this.light.intensity = damp(this.light.intensity, 7 * k, 40, dt);
    this.glass.color.setRGB(2.4 * k, 2.1 * k, 1.5 * k);
  }
}

function signTexture(): THREE.CanvasTexture {
  return canvasTexture('signboard', 512, 192, (ctx, w, h) => {
    ctx.fillStyle = '#c9965f';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(90,55,30,${0.08 + i * 0.02})`;
      ctx.fillRect(0, (i * h) / 4 + h / 4 - 3, w, 3);
    }
    ctx.strokeStyle = '#7a5334';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#fff4df';
    ctx.font = 'bold 76px "Trebuchet MS", "Nunito", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FAZENDA', w / 2, h / 2 - 12);
    ctx.font = 'bold 34px "Trebuchet MS", system-ui, sans-serif';
    ctx.fillStyle = '#ffe2a3';
    ctx.fillText('~ Recanto Feliz ~', w / 2, h / 2 + 48);
    // little flowers
    for (const [x, y, c] of [
      [48, 44, '#f5a7ba'],
      [w - 48, 44, '#f8d877'],
      [48, h - 44, '#bca8e0'],
      [w - 48, h - 44, '#f5a7ba'],
    ] as [number, number, string][]) {
      ctx.fillStyle = c;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * 9, y + Math.sin(a) * 9, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#fff4df';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Hanging farm sign on two chains: swings when shot or blasted. */
export class HangingSign implements HitReceiver, Updatable {
  readonly group = new THREE.Group();
  readonly colliders: StaticCollider[] = [];
  private board = new THREE.Group();
  private swing = new Spring(0, 9, 0.6);
  private twist = new Spring(0, 14, 1);

  constructor(
    private ctx: GameCtx,
    x: number,
    z: number,
  ) {
    this.group.position.set(x, 0, z);
    const g = new GeoBuilder();
    const wood = PAL.fenceWoodDark;
    for (const s of [-1, 1]) g.add(cyl(0.08, 0.1, 2.8, 8), wood, compose(s * 1.05, 1.4, 0));
    g.add(rbox(2.4, 0.14, 0.14, 0.04), wood, compose(0, 2.75, 0));
    this.group.add(m(g.build()));
    this.board.position.set(0, 2.68, 0);
    const bg = new GeoBuilder();
    for (const s of [-1, 1]) bg.add(cyl(0.012, 0.012, 0.42, 4), 0x5a5655, compose(s * 0.7, -0.21, 0));
    this.board.add(m(bg.build(), false));
    const face = new THREE.Mesh(rbox(1.7, 0.64, 0.07, 0.03), [
      toon(0xb98552),
      toon(0xb98552),
      toon(0xb98552),
      toon(0xb98552),
      toon(0xffffff, { map: signTexture() }),
      toon(0xffffff, { map: signTexture() }),
    ]);
    // RoundedBox has groups per face in +x,-x,+y,-y,+z,-z order
    face.position.y = -0.74;
    face.castShadow = true;
    this.board.add(face);
    this.group.add(this.board);
    for (const s of [-1, 1]) this.colliders.push(StaticCollider.cyl(x + s * 1.05, z, 0.1, 2.8, 'wood'));
    const bc = StaticCollider.box(x, z, 0.85, 0.05, 2.35, 0, 'wood', this, 1.6);
    this.colliders.push(bc);
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3): void {
    this.swing.kick(dir.z * 5 + rng.spread(1));
    this.twist.kick((point.x - this.group.position.x) * 3);
    this.ctx.fx.splinters(point, normal, 2, 0xb98552);
    sfx.woodHit(point);
  }

  onBlast(center: THREE.Vector3, strength: number): void {
    this.swing.kick((this.group.position.z - center.z > 0 ? 1 : -1) * strength * 6);
    this.twist.kick(rng.spread(strength * 3));
  }

  update(dt: number, t: number): void {
    this.swing.target = Math.sin(t * 0.9) * 0.05;
    this.swing.update(dt);
    this.twist.update(dt);
    this.board.rotation.x = this.swing.value * 0.35;
    this.board.rotation.y = this.twist.value * 0.1;
  }
}

function clothMaterial(color: number): THREE.MeshToonMaterial {
  const mat = toonUnique(color, { side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uGust = GLOBAL_UNIFORMS.uGust;
    shader.uniforms.uGustStrength = GLOBAL_UNIFORMS.uGustStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec4 uGust; uniform float uGustStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float hang = clamp(-position.y / 0.6, 0.0, 1.0);
         float gust = exp(-(uTime - uGust.w) * 1.2) * uGustStrength;
         float amp = 0.07 + gust * 0.35;
         transformed.z += sin(uTime * 2.3 + position.x * 5.0 + position.y * 2.0) * amp * hang;
         transformed.x += sin(uTime * 1.7 + position.y * 3.0) * 0.02 * hang;`,
      );
  };
  mat.customProgramCacheKey = () => 'cloth';
  return mat;
}

/** Clothesline with gently flapping laundry. */
export function createClothesline(a: [number, number], b: [number, number]): THREE.Group {
  const group = new THREE.Group();
  const g = new GeoBuilder();
  const wood = PAL.fenceWood;
  for (const [x, z] of [a, b]) {
    g.add(cyl(0.05, 0.06, 2.1, 7), wood, compose(x, 1.05, z));
    g.add(rbox(0.06, 0.06, 0.7, 0.02), wood, compose(x, 2.0, z));
  }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (const off of [-0.3, 0.3]) g.add(cyl(0.008, 0.008, len, 4), 0xeeeeee, compose((a[0] + b[0]) / 2, 1.98, a[1] + off, 0, 0, Math.PI / 2));
  const posts = new THREE.Mesh(g.build(), vcToon());
  posts.castShadow = true;
  group.add(posts);
  const items: [number, number, number, number, number][] = [
    // t along line, width, height, color, row
    [0.14, 0.55, 0.62, PAL.curtain, -0.3],
    [0.36, 0.7, 0.5, 0xfdf6ea, -0.3],
    [0.62, 0.45, 0.7, 0x8fb9d6, -0.3],
    [0.85, 0.3, 0.35, PAL.flowerYellow, -0.3],
    [0.25, 0.6, 0.8, 0xa7c98a, 0.3],
    [0.7, 0.8, 0.55, 0xe9b6d2, 0.3],
  ];
  for (const [t, w, h, col, row] of items) {
    const geo = new THREE.PlaneGeometry(w, h, 6, 6);
    geo.translate(0, -h / 2, 0);
    const cloth = new THREE.Mesh(geo, clothMaterial(col));
    cloth.position.set(a[0] + (b[0] - a[0]) * t, 1.96, a[1] + row);
    cloth.castShadow = true;
    group.add(cloth);
    // pins
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.03), toon(0xc49a6c));
    pin.position.set(cloth.position.x - w * 0.35, 1.97, cloth.position.z);
    const pin2 = pin.clone();
    pin2.position.x = cloth.position.x + w * 0.35;
    group.add(pin, pin2);
  }
  return group;
}

/** Striped roadblock marking the edge of the playable area. */
export function createBarricade(x: number, z: number, rot: number): THREE.Mesh {
  const g = new GeoBuilder();
  for (const s of [-1, 1]) {
    g.add(rbox(0.08, 1.0, 0.08, 0.02), 0xe9e2d6, compose(s * 1.1, 0.5, 0.25, -0.25, 0, 0));
    g.add(rbox(0.08, 1.0, 0.08, 0.02), 0xe9e2d6, compose(s * 1.1, 0.5, -0.25, 0.25, 0, 0));
  }
  for (let i = 0; i < 6; i++) {
    g.add(box(0.4, 0.26, 0.06), i % 2 ? 0xf2ede4 : 0xd8584a, compose(-1.0 + i * 0.4 + 0.2, 0.82, 0));
  }
  const mesh = new THREE.Mesh(g.build(), vcToon());
  mesh.position.set(x, 0, z);
  mesh.rotation.y = rot;
  mesh.castShadow = true;
  return mesh;
}

/** Wheelbarrow full of pumpkins (static decoration). */
export function createWheelbarrow(x: number, z: number, rot: number): THREE.Mesh {
  const g = new GeoBuilder();
  g.add(rbox(0.7, 0.3, 1.0, 0.06), 0x7fa0b5, compose(0, 0.55, 0, -0.08, 0, 0));
  g.add(cyl(0.2, 0.2, 0.08, 14), PAL.tire, compose(0, 0.2, 0.62, 0, 0, Math.PI / 2));
  for (const s of [-1, 1]) {
    g.add(cyl(0.025, 0.025, 1.2, 5), PAL.fenceWoodDark, compose(s * 0.28, 0.5, -0.35, Math.PI / 2 - 0.2, 0, 0));
    g.add(cyl(0.025, 0.025, 0.4, 5), PAL.fenceWoodDark, compose(s * 0.25, 0.22, -0.2));
  }
  for (const [px, pz, s] of [
    [-0.12, 0.1, 1],
    [0.15, -0.15, 0.8],
    [0.05, 0.3, 0.7],
  ]) {
    g.add(sphere(0.18 * s, 10, 8), PAL.pumpkin, compose(px, 0.78, pz, 0, 0, 0, 1.15, 0.85, 1.15));
  }
  const mesh = new THREE.Mesh(g.build(), vcToon());
  mesh.position.set(x, 0, z);
  mesh.rotation.y = rot;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
