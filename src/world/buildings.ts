import * as THREE from 'three';
import { Rng, rng } from '../core/rng';
import { compose, damp, Spring } from '../core/math';
import { PAL } from '../render/palette';
import { beam, blob, box, cyl, gableGeometry, GeoBuilder, rbox, slabBetween, sphere, worldUV } from '../render/geometry';
import { GLOBAL_UNIFORMS, toon, toonUnique, vcToon, WINDOW_GLOWS } from '../render/materials';
import { barnBoardTexture, brickTexture, shingleTexture, strawTexture, woodSidingTexture } from '../render/textures';
import { StaticCollider } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { LAYOUT } from './layout';
import { TEX } from '../fx/particles';
import { sfx } from '../audio/sfx';

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** Curtain material: a soft cloth wave in the vertex shader. */
/** Vertex-colored curtains that sway toward/away from the glass (along their own normal). */
function curtainMaterial(): THREE.MeshToonMaterial {
  const m = toonUnique(0xffffff, { side: THREE.DoubleSide, vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float hang = clamp((0.5 - uv.y), 0.0, 1.0);
           vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), normal) + vec3(1e-4, 0.0, 0.0));
           float ph = position.x * 9.0 + position.z * 9.0 + position.y * 3.0;
           transformed += normal * sin(uTime * 1.7 + ph) * 0.025 * (0.4 + hang);
           transformed += side * sin(uTime * 1.1 + position.y * 4.0) * 0.012 * hang;
         }`,
      );
  };
  m.customProgramCacheKey = () => 'curtain-vc';
  return m;
}

/**
 * Collects every window's interior glow and curtains of one building so they draw as two
 * meshes (instead of three per window).
 */
class WindowBatch {
  readonly glow = new GeoBuilder();
  readonly curtains = new GeoBuilder();

  build(group: THREE.Group): void {
    if (!this.glow.empty) {
      // vertex colors carry each glow's own warmth; the material color is the day/night multiplier
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: true });
      WINDOW_GLOWS.push({ mat, base: new THREE.Color(1, 1, 1) });
      group.add(new THREE.Mesh(this.glow.build(), mat));
    }
    if (!this.curtains.empty) group.add(new THREE.Mesh(this.curtains.build(), curtainMaterial()));
  }
}

function glowMaterial(color: number, k: number): THREE.MeshBasicMaterial {
  const c = new THREE.Color(color).multiplyScalar(k);
  const mat = new THREE.MeshBasicMaterial({ color: c, toneMapped: true });
  WINDOW_GLOWS.push({ mat, base: c.clone() });
  return mat;
}

/** A framed window with glow, curtains, shutters and an optional flower box (local +Z facing). */
function addWindow(b: GeoBuilder, wb: WindowBatch, x: number, y: number, z: number, w: number, h: number, rotY: number, opts: { shutters?: boolean; flowers?: boolean; curtain?: number } = {}): void {
  const m = compose(x, y, z, 0, rotY, 0);
  const local = (geo: THREE.BufferGeometry, color: number, lm: THREE.Matrix4) => b.add(geo, color, m.clone().multiply(lm));
  const t = 0.09;
  // frame
  local(rbox(w + t * 2, t, 0.12, 0.03), PAL.houseTrim, compose(0, h / 2 + t / 2, 0.04));
  local(rbox(w + t * 2 + 0.1, t * 1.2, 0.22, 0.03), PAL.houseTrim, compose(0, -h / 2 - t / 2, 0.08));
  local(rbox(t, h, 0.12, 0.03), PAL.houseTrim, compose(-w / 2 - t / 2, 0, 0.04));
  local(rbox(t, h, 0.12, 0.03), PAL.houseTrim, compose(w / 2 + t / 2, 0, 0.04));
  // mullions
  local(box(0.05, h, 0.04), PAL.houseTrim, compose(0, 0, 0.05));
  local(box(w, 0.05, 0.04), PAL.houseTrim, compose(0, h * 0.08, 0.05));
  // inner glow (interior light) sits just inside the wall
  wb.glow.add(new THREE.PlaneGeometry(w, h), new THREE.Color(PAL.windowGlow).multiplyScalar(1.05), m.clone().multiply(compose(0, 0, -0.02)));
  // curtains
  const curtain = opts.curtain ?? PAL.curtain;
  for (const s of [-1, 1]) {
    const cg = new THREE.PlaneGeometry(w * 0.32, h * 0.96, 4, 6);
    const pos = cg.getAttribute('position');
    // gathered tie-back shape: narrower in the middle
    for (let i = 0; i < pos.count; i++) {
      const yy = pos.getY(i) / (h * 0.48);
      const pinch = 1 - 0.45 * Math.exp(-((yy + 0.1) ** 2) * 6);
      const xx = pos.getX(i);
      pos.setX(i, (xx + w * 0.16) * pinch - w * 0.16);
    }
    cg.computeVertexNormals();
    wb.curtains.add(cg, curtain, m.clone().multiply(compose(s * (w / 2 - w * 0.16), 0, 0.005, 0, 0, 0, s, 1, 1)));
  }
  if (opts.shutters) {
    for (const s of [-1, 1]) {
      local(rbox(w * 0.36, h + 0.08, 0.05, 0.02), PAL.houseDoor, compose(s * (w / 2 + t + w * 0.19), 0, 0.06));
      local(box(w * 0.26, 0.03, 0.02), 0x4e8784, compose(s * (w / 2 + t + w * 0.19), h * 0.2, 0.09));
      local(box(w * 0.26, 0.03, 0.02), 0x4e8784, compose(s * (w / 2 + t + w * 0.19), -h * 0.2, 0.09));
    }
  }
  if (opts.flowers) {
    local(rbox(w + 0.15, 0.22, 0.26, 0.04), PAL.terracotta, compose(0, -h / 2 - 0.26, 0.2));
    const r = new Rng(Math.round(x * 13 + z * 7));
    for (let i = 0; i < 9; i++) {
      const fx = -w / 2 + (i + 0.5) * (w / 9);
      local(sphere(0.08, 6, 5), r.chance(0.5) ? PAL.leafA : PAL.leafC, compose(fx, -h / 2 - 0.1, 0.2 + r.spread(0.05)));
      local(sphere(0.06, 6, 5), r.pick([PAL.flowerPink, PAL.flowerRed, PAL.flowerWhite, PAL.flowerYellow]), compose(fx + r.spread(0.04), -h / 2 - 0.02 + r.next() * 0.06, 0.24 + r.spread(0.05)));
    }
  }
}

// =============================================================================================
// House
// =============================================================================================

export class House implements Updatable {
  readonly group = new THREE.Group();
  readonly colliders: StaticCollider[] = [];
  readonly chimneyTop = new THREE.Vector3();
  private door = new THREE.Group();
  private doorAngle = new Spring(0, 40, 7);
  private lamp = new THREE.Group();
  private lampSwingX = new Spring(0, 18, 1.2);
  private lampSwingZ = new Spring(0, 18, 1.2);
  private lampLight: THREE.PointLight;
  private lampGlass: THREE.MeshBasicMaterial;
  private smokeTimer = 0;
  private flicker = 0;
  readonly doorWorld = new THREE.Vector3();

  constructor(private ctx: GameCtx) {
    const H = LAYOUT.house;
    const { w, d, h } = H;
    this.group.position.set(H.x, 0, H.z);
    const base = 0.38;
    const b = new GeoBuilder();

    // foundation
    b.add(rbox(w + 0.3, base, d + 0.3, 0.06), PAL.stone, compose(0, base / 2, 0));
    // walls (textured)
    const wallGeo = rbox(w, h, d, 0.08, 2);
    wallGeo.translate(0, base + h / 2, 0);
    worldUV(wallGeo, 0.5);
    const walls = mesh(wallGeo, toon(PAL.houseWall, { map: woodSidingTexture() }));
    this.group.add(walls);
    // corner trims + fascia
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(rbox(0.16, h + 0.02, 0.16, 0.04), PAL.houseTrim, compose(sx * (w / 2), base + h / 2, sz * (d / 2)));
    b.add(rbox(w + 0.12, 0.14, 0.12, 0.03), PAL.houseTrim, compose(0, base + h - 0.07, d / 2 + 0.02));
    b.add(rbox(w + 0.12, 0.14, 0.12, 0.03), PAL.houseTrim, compose(0, base + h - 0.07, -d / 2 - 0.02));

    // roof
    const yWall = base + h;
    const tan = 0.66;
    const over = 0.5;
    const rise = (d / 2) * tan;
    const yRidge = yWall + rise;
    const ze = d / 2 + over;
    const ye = yRidge - ze * tan;
    const th = 0.2;
    const lift = th / 2 / Math.cos(Math.atan(tan));
    const gable = gableGeometry(w - 0.02, rise, d - 0.02);
    gable.translate(0, yWall, 0);
    worldUV(gable, 0.5);
    this.group.add(mesh(gable, toon(PAL.houseWall, { map: woodSidingTexture() })));
    const roofMat = toon(PAL.houseRoof, { map: shingleTexture() });
    for (const s of [-1, 1]) {
      const { geo, matrix } = slabBetween(s * ze, ye + lift, 0, yRidge + lift, w + over * 2, th);
      geo.applyMatrix4(matrix);
      // UV: along x and along slope
      const pos = geo.getAttribute('position');
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = pos.getX(i) * 0.55;
        uv[i * 2 + 1] = (Math.abs(pos.getZ(i)) * 1.2 + pos.getY(i) * 0.4) * 0.55;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      this.group.add(mesh(geo, roofMat));
    }
    // ridge cap + barge boards
    b.add(cyl(0.13, 0.13, w + over * 2 + 0.04, 8), PAL.houseRoofDark, compose(0, yRidge + th * 0.9, 0, 0, 0, Math.PI / 2));
    for (const sx of [-1, 1]) {
      for (const s of [-1, 1]) {
        b.add(beam(new THREE.Vector3(sx * (w / 2 + over + 0.02), ye + lift * 0.4, s * ze), new THREE.Vector3(sx * (w / 2 + over + 0.02), yRidge + lift * 0.4, 0), 0.16, 0.06, new THREE.Vector3(1, 0, 0)), PAL.houseTrim);
      }
    }

    // chimney on the back slope
    const cx = -w / 2 + 1.3;
    const cz = -d / 4;
    const chimTop = yRidge + 1.0;
    const chim = rbox(0.72, chimTop - yWall + 0.2, 0.72, 0.04);
    chim.translate(cx, (chimTop + yWall - 0.2) / 2, cz);
    worldUV(chim, 0.9);
    this.group.add(mesh(chim, toon(0xffffff, { map: brickTexture() })));
    b.add(rbox(0.9, 0.16, 0.9, 0.04), 0x7d6a64, compose(cx, chimTop + 0.06, cz));
    b.add(rbox(0.5, 0.12, 0.5, 0.03), 0x4e433f, compose(cx, chimTop + 0.16, cz));
    this.chimneyTop.set(H.x + cx, chimTop + 0.35, H.z + cz);

    // ---- front: door, windows
    const fz = d / 2 + 0.02;
    b.add(rbox(1.3, 0.12, 0.14, 0.03), PAL.houseTrim, compose(0, base + 2.15, fz));
    b.add(rbox(0.12, 2.15, 0.14, 0.03), PAL.houseTrim, compose(-0.6, base + 1.07, fz));
    b.add(rbox(0.12, 2.15, 0.14, 0.03), PAL.houseTrim, compose(0.6, base + 1.07, fz));
    // interior darkness behind the door
    const interior = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.1), new THREE.MeshBasicMaterial({ color: 0x4a332b }));
    interior.position.set(0, base + 1.05, d / 2 - 0.06);
    this.group.add(interior);
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.4), glowMaterial(PAL.windowGlow, 0.55));
    warm.position.set(0.1, base + 1.2, d / 2 - 0.08);
    this.group.add(warm);
    // door leaf (hinged on the left)
    this.door.position.set(-0.54, base + 1.03, d / 2 + 0.01);
    const leaf = new GeoBuilder();
    leaf.add(rbox(1.08, 2.06, 0.08, 0.03), PAL.houseDoor, compose(0.54, 0, 0));
    leaf.add(rbox(0.8, 0.7, 0.03, 0.02), 0x6fb0ad, compose(0.54, -0.45, 0.045));
    leaf.add(box(0.5, 0.42, 0.02), 0xbfe0e8, compose(0.54, 0.45, 0.045));
    leaf.add(box(0.04, 0.42, 0.03), PAL.houseTrim, compose(0.54, 0.45, 0.05));
    leaf.add(sphere(0.05, 8, 6), PAL.brass, compose(0.95, 0, 0.08));
    this.door.add(mesh(leaf.build(), vcToon()));
    this.group.add(this.door);
    this.doorWorld.set(H.x, 0, H.z + d / 2 + 0.2);

    const wb = new WindowBatch();
    addWindow(b, wb, -2.35, base + 1.5, fz, 1.1, 1.0, 0, { shutters: true, flowers: true });
    addWindow(b, wb, 2.35, base + 1.5, fz, 1.1, 1.0, 0, { shutters: true, flowers: true });
    addWindow(b, wb, w / 2 + 0.02, base + 1.5, 0.2, 1.0, 1.0, Math.PI / 2, { curtain: 0xf6d38a });
    addWindow(b, wb, -w / 2 - 0.02, base + 1.5, 0.2, 1.0, 1.0, -Math.PI / 2, { curtain: 0xb9d6e8 });
    addWindow(b, wb, 1.6, base + 1.5, -d / 2 - 0.02, 1.0, 0.9, Math.PI, {});
    // round attic windows in both gable ends
    for (const sx of [-1, 1]) {
      b.add(cyl(0.3, 0.3, 0.1, 16), PAL.houseTrim, compose(sx * (w / 2 + 0.02), yWall + 0.62, 0, 0, 0, Math.PI / 2));
      wb.glow.add(new THREE.CircleGeometry(0.22, 16), new THREE.Color(PAL.windowGlow).multiplyScalar(0.85), compose(sx * (w / 2 + 0.075), yWall + 0.62, 0, 0, sx * Math.PI / 2, 0));
    }
    wb.build(this.group);

    // ---- porch
    const pz = d / 2 + 0.95;
    const deckH = 0.34;
    const deckGeo = rbox(4.6, deckH, 1.9, 0.04);
    deckGeo.translate(0, deckH / 2, pz);
    worldUV(deckGeo, 0.75);
    this.group.add(mesh(deckGeo, toon(PAL.porchWood, { map: woodSidingTexture() })));
    b.add(rbox(1.6, 0.12, 0.4, 0.03), PAL.porchWood, compose(0, 0.06 + 0.12, pz + 1.12));
    b.add(rbox(1.6, 0.12, 0.35, 0.03), 0xb98d63, compose(0, 0.06, pz + 1.45));
    for (const sx of [-1, 1]) {
      b.add(rbox(0.16, 2.35, 0.16, 0.05), PAL.houseTrim, compose(sx * 2.1, deckH + 1.17, pz + 0.75));
      b.add(rbox(0.26, 0.12, 0.26, 0.04), PAL.houseTrim, compose(sx * 2.1, deckH + 0.06, pz + 0.75));
    }
    // porch roof
    {
      const { geo, matrix } = slabBetween(d / 2 - 0.05, base + 2.78, d / 2 + 2.15, base + 2.38, 5.0, 0.14);
      geo.applyMatrix4(matrix);
      const pos = geo.getAttribute('position');
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = pos.getX(i) * 0.55;
        uv[i * 2 + 1] = pos.getZ(i) * 0.7;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      this.group.add(mesh(geo, roofMat));
      b.add(rbox(5.02, 0.16, 0.08, 0.03), PAL.houseTrim, compose(0, base + 2.32, d / 2 + 2.12));
    }
    // hanging lamp
    this.lamp.position.set(1.0, base + 2.6, pz + 0.3);
    const lampGeo = new GeoBuilder();
    lampGeo.add(cyl(0.012, 0.012, 0.35, 4), 0x3d3a3d, compose(0, -0.175, 0));
    lampGeo.add(cyl(0.13, 0.1, 0.07, 8), 0x3d3a3d, compose(0, -0.38, 0));
    lampGeo.add(cyl(0.07, 0.07, 0.04, 8), 0x3d3a3d, compose(0, -0.62, 0));
    this.lamp.add(mesh(lampGeo.build(), vcToon(), false));
    this.lampGlass = glowMaterial(0xffe2a6, 2.2);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.2, 8), this.lampGlass);
    glass.position.y = -0.51;
    this.lamp.add(glass);
    this.lampLight = new THREE.PointLight(0xffc27a, 5, 7, 1.6);
    this.lampLight.position.y = -0.5;
    this.lamp.add(this.lampLight);
    this.group.add(this.lamp);

    const built = mesh(b.build(), vcToon());
    this.group.add(built);

    // ---- colliders
    const hx = H.x;
    const hz = H.z;
    this.colliders.push(
      StaticCollider.box(hx, hz, w / 2 + 0.12, d / 2 + 0.12, yRidge + 0.3, 0, 'wood', {
        onBulletHit: (p, n, dir) => this.onWallHit(p, n, dir),
      }),
    );
    const deck = StaticCollider.box(hx, hz + pz, 2.3, 0.95, deckH, 0, 'wood');
    deck.walkable = true;
    const step1 = StaticCollider.box(hx, hz + pz + 1.12, 0.8, 0.2, 0.24, 0, 'wood');
    step1.walkable = true;
    const step2 = StaticCollider.box(hx, hz + pz + 1.45, 0.8, 0.18, 0.12, 0, 'wood');
    step2.walkable = true;
    this.colliders.push(deck, step1, step2);
    for (const sx of [-1, 1]) this.colliders.push(StaticCollider.cyl(hx + sx * 2.1, hz + pz + 0.75, 0.12, 2.8, 'wood'));
  }

  private onWallHit(p: THREE.Vector3, n: THREE.Vector3, dir: THREE.Vector3): void {
    const local = p.clone().sub(this.group.position);
    const H = LAYOUT.house;
    // door?
    if (Math.abs(local.x) < 0.6 && local.z > H.d / 2 - 0.1 && local.y < 2.4) {
      this.doorAngle.kick(3 + Math.random() * 2);
      this.ctx.fx.splinters(p, n, 2, PAL.houseDoor);
      sfx.woodHit(p);
      return;
    }
    this.ctx.fx.splinters(p, n, 3, PAL.houseWall);
    this.ctx.fx.decals.bulletHole(p, n);
    sfx.woodHit(p);
    void dir;
  }

  /** Shake the lamp (shots nearby, explosions). */
  jolt(strength: number): void {
    this.lampSwingX.kick(rng.spread(strength));
    this.lampSwingZ.kick(rng.spread(strength));
  }

  update(dt: number, t: number): void {
    // door opens when the player is near the porch
    const pl = this.ctx.playerPos;
    const dx = pl.x - this.doorWorld.x;
    const dz = pl.z - this.doorWorld.z;
    const open = Math.abs(dx) < 1.3 && dz > -0.3 && dz < 2.2;
    this.doorAngle.target = open ? 1.35 : 0;
    const prev = this.doorAngle.value;
    this.doorAngle.update(dt);
    if (this.doorAngle.value < 0) {
      this.doorAngle.value = 0;
      this.doorAngle.velocity = Math.abs(this.doorAngle.velocity) * 0.3;
    }
    this.door.rotation.y = this.doorAngle.value;
    if (prev < 0.05 && this.doorAngle.value >= 0.05 && open) sfx.woodHit(this.doorWorld);

    // lamp swing + gentle idle breeze
    this.lampSwingX.target = Math.sin(t * 0.7) * 0.03;
    this.lampSwingX.update(dt);
    this.lampSwingZ.update(dt);
    this.lamp.rotation.x = this.lampSwingX.value;
    this.lamp.rotation.z = this.lampSwingZ.value;
    // occasional flicker
    this.flicker -= dt;
    let k = 1;
    if (this.flicker < 0) {
      if (rng.chance(dt * 0.25)) this.flicker = rng.range(0.15, 0.5);
    } else k = rng.chance(0.5) ? 0.35 : 1;
    this.lampLight.intensity = damp(this.lampLight.intensity, 5 * k, 30, dt);
    this.lampGlass.color.setRGB(2.2 * k, 1.9 * k, 1.4 * k);

    // chimney smoke
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.32 + rng.next() * 0.2;
      this.ctx.fx.particles.soft.spawn(this.chimneyTop.clone().add(new THREE.Vector3(rng.spread(0.1), 0, rng.spread(0.1))), {
        vel: [0.45 + rng.spread(0.1), 0.9 + rng.next() * 0.3, 0.12 + rng.spread(0.1)],
        life: 4.2,
        size: 0.35,
        sizeEnd: 1.5,
        color: 0xf4efe9,
        colorEnd: 0xe4dde2,
        alpha: 0.6,
        alphaEnd: 0,
        drag: 0.25,
        rotVel: rng.spread(0.4),
        fadeIn: 0.12,
        cell: TEX.puff,
      });
    }
  }
}

// =============================================================================================
// Barn
// =============================================================================================

export class Barn implements Updatable {
  readonly group = new THREE.Group();
  readonly colliders: StaticCollider[] = [];
  private doorL = new THREE.Group();
  private doorR = new THREE.Group();
  private dl = new Spring(0.55, 20, 3);
  private dr = new Spring(-0.12, 20, 3);
  private vane = new THREE.Group();
  private vaneAngle = 0;
  /** Doors blown off by a horde (until the farm is rebuilt). */
  doorsGone = false;
  private rattleT = 0;

  constructor(private ctx: GameCtx) {
    const B = LAYOUT.barn;
    const { w, d } = B;
    this.group.position.set(B.x, 0, B.z);
    const b = new GeoBuilder();
    const hw = w / 2;
    const eave = 3.5;
    const kneeX = 2.75;
    const kneeY = 5.25;
    const ridge = 6.2;
    const base = 0.3;

    b.add(rbox(w + 0.3, base, d + 0.3, 0.05), PAL.stone, compose(0, base / 2, 0));
    // walls from the gambrel profile
    const shape = new THREE.Shape();
    shape.moveTo(-hw, 0);
    shape.lineTo(hw, 0);
    shape.lineTo(hw, eave);
    shape.lineTo(kneeX, kneeY);
    shape.lineTo(0, ridge);
    shape.lineTo(-kneeX, kneeY);
    shape.lineTo(-hw, eave);
    shape.closePath();
    const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    wallGeo.translate(0, base, -d / 2);
    wallGeo.computeVertexNormals();
    worldUV(wallGeo, 0.33);
    this.group.add(mesh(wallGeo, toon(PAL.barnRed, { map: barnBoardTexture() })));

    // roof slabs
    const roofMat = toon(PAL.barnRoof, { map: shingleTexture() });
    const prof: [number, number][] = [
      [-hw - 0.35, eave + base - 0.25],
      [-kneeX, kneeY + base],
      [0, ridge + base],
      [kneeX, kneeY + base],
      [hw + 0.35, eave + base - 0.25],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = prof[i];
      const [bx, by] = prof[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const g = rbox(len + 0.12, 0.2, d + 0.7, 0.05);
      const ang = Math.atan2(by - ay, bx - ax);
      const nx = -Math.sin(ang);
      const ny = Math.cos(ang);
      g.applyMatrix4(compose((ax + bx) / 2 + nx * 0.1, (ay + by) / 2 + ny * 0.1, 0, 0, 0, ang));
      const pos = g.getAttribute('position');
      const uv = new Float32Array(pos.count * 2);
      for (let k = 0; k < pos.count; k++) {
        uv[k * 2] = pos.getZ(k) * 0.5;
        uv[k * 2 + 1] = (pos.getX(k) * Math.cos(ang) + pos.getY(k) * Math.sin(ang)) * 0.55;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      this.group.add(mesh(g, roofMat));
    }

    // white trims along the gambrel outline, front and back
    for (const z of [d / 2 + 0.03, -d / 2 - 0.03]) {
      const pts: [number, number][] = [
        [-hw, base],
        [-hw, eave + base],
        [-kneeX, kneeY + base],
        [0, ridge + base],
        [kneeX, kneeY + base],
        [hw, eave + base],
        [hw, base],
      ];
      for (let i = 0; i < pts.length - 1; i++) {
        b.add(beam(new THREE.Vector3(pts[i][0], pts[i][1], z), new THREE.Vector3(pts[i + 1][0], pts[i + 1][1], z), 0.2, 0.08), PAL.barnTrim);
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(rbox(0.18, eave, 0.18, 0.04), PAL.barnTrim, compose(sx * hw, base + eave / 2, sz * (d / 2)));

    // big door opening
    const doorW = 3.4;
    const doorH = 3.1;
    const fz = d / 2 + 0.02;
    const interior = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), new THREE.MeshBasicMaterial({ color: 0x3b2a26 }));
    interior.position.set(0, base + doorH / 2, d / 2 - 0.05);
    this.group.add(interior);
    // hay inside
    const hay = new THREE.Mesh(rbox(1.3, 0.7, 0.8, 0.08), toon(0xb99a58, { map: strawTexture() }));
    hay.position.set(0.9, base + 0.35, d / 2 - 0.6);
    this.group.add(hay);
    b.add(rbox(doorW + 0.3, 0.22, 0.12, 0.04), PAL.barnTrim, compose(0, base + doorH + 0.08, fz));
    for (const [grp, sx] of [
      [this.doorL, -1],
      [this.doorR, 1],
    ] as [THREE.Group, number][]) {
      grp.position.set(sx * (doorW / 2), base + doorH / 2, fz + 0.04);
      const dg = new GeoBuilder();
      const lw = doorW / 2;
      const cxl = -sx * lw / 2;
      const panel = rbox(lw - 0.04, doorH - 0.04, 0.08, 0.02);
      panel.translate(cxl, 0, 0);
      worldUV(panel, 0.33);
      const pm = mesh(panel, toon(PAL.barnRedDark, { map: barnBoardTexture() }));
      grp.add(pm);
      // frame + X brace
      dg.add(rbox(lw, 0.16, 0.06, 0.02), PAL.barnTrim, compose(cxl, doorH / 2 - 0.08, 0.06));
      dg.add(rbox(lw, 0.16, 0.06, 0.02), PAL.barnTrim, compose(cxl, -doorH / 2 + 0.08, 0.06));
      dg.add(rbox(0.16, doorH, 0.06, 0.02), PAL.barnTrim, compose(cxl - lw / 2 + 0.08, 0, 0.06));
      dg.add(rbox(0.16, doorH, 0.06, 0.02), PAL.barnTrim, compose(cxl + lw / 2 - 0.08, 0, 0.06));
      dg.add(beam(new THREE.Vector3(cxl - lw / 2 + 0.1, -doorH / 2 + 0.12, 0.07), new THREE.Vector3(cxl + lw / 2 - 0.1, doorH / 2 - 0.12, 0.07), 0.14, 0.05), PAL.barnTrim);
      dg.add(beam(new THREE.Vector3(cxl - lw / 2 + 0.1, doorH / 2 - 0.12, 0.07), new THREE.Vector3(cxl + lw / 2 - 0.1, -doorH / 2 + 0.12, 0.07), 0.14, 0.05), PAL.barnTrim);
      grp.add(mesh(dg.build(), vcToon()));
      this.group.add(grp);
    }
    // hay loft door
    const ly = base + 4.35;
    b.add(rbox(1.5, 1.35, 0.1, 0.03), PAL.barnTrim, compose(0, ly, fz));
    const loft = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.05), new THREE.MeshBasicMaterial({ color: 0x3b2a26 }));
    loft.position.set(0, ly, fz + 0.06);
    this.group.add(loft);
    const loftHay = new THREE.Mesh(rbox(1.0, 0.5, 0.5, 0.08), toon(0xffffff, { map: strawTexture() }));
    loftHay.position.set(0.05, ly - 0.27, fz + 0.05);
    this.group.add(loftHay);
    b.add(beam(new THREE.Vector3(-0.62, ly - 0.55, fz + 0.1), new THREE.Vector3(0.62, ly + 0.55, fz + 0.1), 0.1, 0.05), PAL.barnTrim);
    // side windows
    const wb = new WindowBatch();
    for (const sx of [-1, 1]) addWindow(b, wb, sx * (hw + 0.03), base + 2.1, 0, 0.9, 0.8, sx * Math.PI / 2, { curtain: 0xe8d7a8 });
    wb.build(this.group);
    // weather vane
    this.vane.position.set(0, base + ridge + 0.1, d / 2 - 1.2);
    const vb = new GeoBuilder();
    vb.add(cyl(0.03, 0.03, 1.2, 5), 0x3d3a3d, compose(0, 0.6, 0));
    vb.add(box(0.9, 0.035, 0.035), 0x3d3a3d, compose(0, 0.95, 0));
    vb.add(box(0.035, 0.035, 0.9), 0x3d3a3d, compose(0, 0.95, 0));
    // rooster
    vb.add(sphere(0.16, 8, 6), 0x3d3a3d, compose(0.05, 1.35, 0, 0, 0, 0, 1.4, 1, 0.3));
    vb.add(sphere(0.08, 8, 6), 0x3d3a3d, compose(0.26, 1.52, 0, 0, 0, 0, 1, 1, 0.4));
    vb.add(box(0.18, 0.28, 0.03), 0x3d3a3d, compose(-0.22, 1.47, 0, 0, 0, 0.5));
    vb.add(box(0.04, 0.08, 0.03), PAL.capRed, compose(0.27, 1.62, 0));
    vb.add(box(0.5, 0.05, 0.03), 0x3d3a3d, compose(0, 1.18, 0));
    this.vane.add(mesh(vb.build(), vcToon()));
    this.group.add(this.vane);

    this.group.add(mesh(b.build(), vcToon()));

    this.colliders.push(
      StaticCollider.box(B.x, B.z, hw + 0.1, d / 2 + 0.1, ridge, 0, 'wood', {
        onBulletHit: (p, n) => this.onHit(p, n),
      }),
    );
  }

  private onHit(p: THREE.Vector3, n: THREE.Vector3): void {
    const local = p.clone().sub(this.group.position);
    if (local.z > LAYOUT.barn.d / 2 - 0.1 && Math.abs(local.x) < 1.7 && local.y < 3.4) {
      if (local.x < 0) this.dl.kick(-2.5);
      else this.dr.kick(2.5);
    }
    this.ctx.fx.splinters(p, n, 3, PAL.barnRed);
    this.ctx.fx.decals.bulletHole(p, n);
    sfx.woodHit(p);
  }

  blast(strength: number): void {
    this.dl.kick(-strength * 3);
    this.dr.kick(strength * 3);
  }

  /** World point just outside the big doors. */
  get doorFront(): THREE.Vector3 {
    const B = LAYOUT.barn;
    return new THREE.Vector3(B.x, 0, B.z + B.d / 2 + 0.7);
  }

  /** Something is banging to get out: the doors rattle for a moment. */
  rattle(seconds: number): void {
    this.rattleT = Math.max(this.rattleT, seconds);
  }

  /** The horde bursts out: both doors fly off in a cloud of dust and splinters. */
  burstDoors(): void {
    if (this.doorsGone) return;
    this.doorsGone = true;
    const fx = this.ctx.fx;
    const front = this.doorFront.setY(1.5);
    for (const [door, sx] of [
      [this.doorL, -1],
      [this.doorR, 1],
    ] as [THREE.Group, number][]) {
      door.updateWorldMatrix(true, true);
      const q = door.getWorldQuaternion(new THREE.Quaternion());
      const c = door.localToWorld(new THREE.Vector3(-sx * 0.85, 0, 0));
      door.visible = false;
      fx.debris.spawn('plank', c, new THREE.Vector3(sx * rng.range(2, 3.5), rng.range(3.5, 5), rng.range(6, 8.5)), new THREE.Vector3(1.6, 3.0, 0.1), PAL.barnRedDark, { quat: q, spin: 5, life: 14 });
      for (let i = 0; i < 3; i++) {
        fx.debris.spawn('plank', c.clone().add(new THREE.Vector3(rng.spread(0.5), rng.spread(1.2), 0)), new THREE.Vector3(sx * rng.range(1, 4), rng.range(3, 7), rng.range(4, 9)), new THREE.Vector3(rng.range(0.6, 1.5), 0.16, 0.06), PAL.barnTrim, { spin: 14, life: 10 });
      }
    }
    fx.dust(front.clone().setY(0.4), 16, 2.4, 0xe9dcc6, 0.8);
    fx.smokePuff(front, new THREE.Vector3(0, 0.3, 1), 6, 0.8);
    fx.splinters(front, new THREE.Vector3(0, 0, 1), 12, PAL.barnRed);
    sfx.woodBreak(front);
    sfx.thud(front, 2);
    this.ctx.shake(0.55);
    this.ctx.noise(front, 40);
  }

  update(dt: number, t: number): void {
    this.dl.update(dt);
    this.dr.update(dt);
    this.dl.target = 0.55 + Math.sin(t * 0.6) * 0.03;
    this.dr.target = -0.12 + Math.sin(t * 0.5 + 1) * 0.02;
    if (this.rattleT > 0) {
      this.rattleT -= dt;
      if (rng.chance(dt * 9)) {
        this.dl.kick(rng.range(-3, -1));
        this.dr.kick(rng.range(1, 3));
        sfx.woodHit(this.doorFront.setY(1.5));
      }
    }
    // doors open outward: left door swings to -z... rotate around hinge
    this.doorL.rotation.y = -this.dl.value;
    this.doorR.rotation.y = -this.dr.value;
    this.vaneAngle += Math.sin(t * 0.21) * dt * 0.4;
    this.vane.rotation.y = this.vaneAngle + Math.sin(t * 1.3) * 0.08;
  }
}

/** Hay bale visual (used as heavy physics body). */
export function hayBaleGeometry(): THREE.BufferGeometry {
  return rbox(1.2, 0.62, 0.8, 0.14, 3);
}

export function haystackBlob(): THREE.BufferGeometry {
  return blob(0.8, 2, 0.1, 5, 0.7);
}
