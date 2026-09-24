import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp } from '../core/math';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { blob, capsule, cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { addRim, outlineMaterial, toonUnique } from '../render/materials';
import { faceTexture, softCircleTexture, type FaceKind } from '../render/textures';
import { J, JOINT_COUNT, Ragdoll } from '../physics/ragdoll';

export interface CharacterStyle {
  scale: number;
  skin: number;
  shirt: number;
  pants: number;
  shoes: number;
  face: 'player' | 'zombie';
  faceVariant: number;
  hat: 'cap' | 'straw' | 'none' | 'hood';
  hair: number;
  overalls?: number;
  belly?: number;
  backpack?: boolean;
  outline: number;
  xray: number;
  /** thicker arms/legs */
  bulk?: number;
}

export const DIMS = {
  hipY: 0.34,
  hipX: 0.1,
  shoulderY: 0.64,
  shoulderX: 0.2,
  torsoY: 0.49,
  headY: 0.98,
  headR: 0.3,
  armLen: 0.28,
  legLen: 0.26,
  /** elbow / knee position along the limb */
  upperArm: 0.14,
  thigh: 0.13,
};

export type Side = 0 | 1;

const tmpX = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const ikD = new THREE.Vector3();
const ikP = new THREE.Vector3();
const ikE = new THREE.Vector3();
const ikY2 = new THREE.Vector3();
const ikZ2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

/** Damped spring that makes a dangling part (hat, hair, backpack) lag behind its anchor. */
class Wobble {
  x = 0;
  z = 0;
  private vx = 0;
  private vz = 0;
  private prev = new THREE.Vector3();
  private prevVel = new THREE.Vector3();
  private primed = 0;

  constructor(
    readonly bone: THREE.Object3D,
    private anchor: THREE.Object3D,
    private freq: number,
    private zeta: number,
    private gain: number,
    private max: number,
    private gravity = 0,
  ) {}

  update(dt: number): void {
    if (dt <= 0) return;
    const p = this.anchor.getWorldPosition(tmpA);
    const vel = tmpB.copy(p).sub(this.prev).divideScalar(dt);
    // teleports / spawns: restart the tracking instead of flinging the part
    if (this.primed < 2 || vel.lengthSq() > 30 * 30) {
      this.prev.copy(p);
      this.prevVel.set(0, 0, 0);
      this.primed++;
      return;
    }
    const acc = tmpC.copy(vel).sub(this.prevVel).divideScalar(dt);
    this.prev.copy(p);
    this.prevVel.copy(vel);
    if (acc.lengthSq() > 70 * 70) acc.setLength(70);
    // inertial force felt by the dangling part, in the anchor's frame
    acc.negate();
    acc.y -= 9.8 * this.gravity;
    this.anchor.getWorldQuaternion(tmpQ).invert();
    acc.applyQuaternion(tmpQ);
    const w2 = this.freq * this.freq;
    const c = 2 * this.zeta * this.freq;
    const n = dt > 1 / 50 ? 2 : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.vx += (-w2 * this.x - c * this.vx + acc.z * this.gain) * h;
      this.vz += (-w2 * this.z - c * this.vz - acc.x * this.gain) * h;
      this.x += this.vx * h;
      this.z += this.vz * h;
    }
    if (Math.abs(this.x) > this.max) {
      this.x = Math.sign(this.x) * this.max;
      this.vx *= -0.3;
    }
    if (Math.abs(this.z) > this.max) {
      this.z = Math.sign(this.z) * this.max;
      this.vz *= -0.3;
    }
  }

  kick(vx: number, vz: number): void {
    this.vx += vx;
    this.vz += vz;
  }
}

/** A part knocked off the body (hat, arm) tumbling on its own until it fades away. */
interface Loose {
  obj: THREE.Object3D;
  kind: 'hat' | 'arm';
  local: THREE.Vector3;
  c: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  radius: number;
  life: number;
  bounces: number;
  /** descendants frozen in the pose they had when the part came off */
  frozen: { obj: THREE.Object3D; q: THREE.Quaternion }[];
}

/**
 * Chibi character built from primitives: big head, bean torso, stubby two-segment limbs.
 * Everything except the head is one vertex-colored skinned mesh with rigid (single-bone)
 * weights, so a whole character costs a handful of draw calls while every part still pivots
 * at its joint: procedural animation, the ragdoll (in world space) and knocked-off parts all
 * just move bones.
 */
export class CharacterModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly torso = new THREE.Bone();
  readonly head = new THREE.Bone();
  readonly hat = new THREE.Bone();
  readonly hair = new THREE.Bone();
  readonly pack = new THREE.Bone();
  readonly armL = new THREE.Bone();
  readonly armR = new THREE.Bone();
  readonly foreL = new THREE.Bone();
  readonly foreR = new THREE.Bone();
  readonly legL = new THREE.Bone();
  readonly legR = new THREE.Bone();
  readonly shinL = new THREE.Bone();
  readonly shinR = new THREE.Bone();
  private stumpL = new THREE.Bone();
  private stumpR = new THREE.Bone();
  readonly handR = new THREE.Group();
  readonly handL = new THREE.Group();
  readonly shadow: THREE.Mesh;
  readonly s: number;
  /** Ground height for loose parts. */
  ground: (x: number, z: number) => number = () => 0;
  /** Arm torn off (0 = left, 1 = right). */
  readonly armLost: [boolean, boolean] = [false, false];
  hatLost = false;
  private mats: THREE.MeshToonMaterial[] = [];
  private headMat: THREE.MeshToonMaterial;
  private xrayMeshes: THREE.Mesh[] = [];
  private disposables: { dispose(): void }[] = [];
  private skeleton: THREE.Skeleton;
  private flashT = 0;
  private baseFace: FaceKind;
  private shownFace: FaceKind;
  private exprFace: FaceKind | null = null;
  private exprT = 0;
  private blinkT = rng.range(0.5, 3);
  private wobbles: Wobble[] = [];
  private loose: Loose[] = [];

  constructor(readonly style: CharacterStyle) {
    const s = (this.s = style.scale);
    const bulk = style.bulk ?? 1;
    this.root.add(this.body);
    const outline = outlineMaterial(style.outline, 0.022);
    const xray = new THREE.MeshBasicMaterial({
      color: style.xray,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilZPass: THREE.KeepStencilOp,
    });
    const stencil = (m: THREE.Material) => {
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
      return m;
    };
    // one vertex-colored material per character (so hit flashes are per character)
    const bodyMat = stencil(toonUnique(0xffffff, { vertexColors: true })) as THREE.MeshToonMaterial;
    addRim(bodyMat, 0xffdca0, 0.55);
    this.mats.push(bodyMat);
    this.disposables.push(outline, xray, bodyMat);

    // ---- skeleton (rest pose)
    const shoulderLocal = (DIMS.shoulderY - DIMS.torsoY) * s;
    this.torso.position.set(0, DIMS.torsoY * s, 0);
    this.head.position.set(0, DIMS.headY * s, 0);
    this.pack.position.set(0, 0.15 * s, -0.14 * s);
    this.stumpL.position.set(DIMS.shoulderX * s, shoulderLocal, 0);
    this.stumpR.position.set(-DIMS.shoulderX * s, shoulderLocal, 0);
    this.torso.add(this.pack, this.stumpL, this.stumpR);
    this.head.add(this.hat, this.hair);
    for (const [arm, fore, hand, sx] of [
      [this.armL, this.foreL, this.handL, 1],
      [this.armR, this.foreR, this.handR, -1],
    ] as [THREE.Bone, THREE.Bone, THREE.Group, number][]) {
      arm.position.set(sx * DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
      fore.position.set(0, -DIMS.upperArm * s, 0);
      hand.position.set(0, -(DIMS.armLen - DIMS.upperArm) * s, 0);
      arm.add(fore);
      fore.add(hand);
    }
    for (const [leg, shin, sx] of [
      [this.legL, this.shinL, 1],
      [this.legR, this.shinR, -1],
    ] as [THREE.Bone, THREE.Bone, number][]) {
      leg.position.set(sx * DIMS.hipX * s, DIMS.hipY * s, 0);
      shin.position.set(0, -DIMS.thigh * s, 0);
      leg.add(shin);
    }
    this.body.add(this.legL, this.legR, this.torso, this.head, this.armL, this.armR);

    // parts are accumulated per bone, then everything is merged into one skinned geometry
    const builders = new Map<THREE.Object3D, { plain: GeoBuilder; outlined: GeoBuilder }>();
    const part = (bone: THREE.Object3D, geo: THREE.BufferGeometry, color: number, withOutline = true) => {
      let b = builders.get(bone);
      if (!b) {
        b = { plain: new GeoBuilder(), outlined: new GeoBuilder() };
        builders.set(bone, b);
      }
      (withOutline ? b.outlined : b.plain).add(geo, color);
    };

    // ---- legs: thigh + shin/boot
    const thigh = DIMS.thigh * s;
    const shinLen = (DIMS.legLen - DIMS.thigh) * s;
    for (const [leg, shin] of [
      [this.legL, this.shinL],
      [this.legR, this.shinR],
    ] as [THREE.Bone, THREE.Bone][]) {
      const tg = capsule(0.077 * s * bulk, thigh - 0.01 * s, 3, 8);
      tg.translate(0, -(thigh + 0.01 * s) / 2, 0);
      part(leg, tg, style.pants);
      const sg = capsule(0.072 * s * bulk, shinLen - 0.05 * s, 3, 8);
      sg.translate(0, -(shinLen - 0.05 * s) / 2, 0);
      part(shin, sg, style.pants);
      const boot = rbox(0.14 * s * bulk, 0.1 * s, 0.2 * s, 0.045 * s);
      boot.translate(0, -shinLen + 0.02 * s, 0.03 * s);
      part(shin, boot, style.shoes);
    }

    // ---- torso
    const belly = style.belly ?? 1;
    const tg = capsule(0.17 * s, 0.13 * s, 4, 12);
    tg.scale(1.06 * belly, 1, 0.82 * belly);
    part(this.torso, tg, style.shirt);
    if (style.overalls) {
      const bib = rbox(0.26 * s * belly, 0.22 * s, 0.1 * s, 0.04 * s);
      bib.translate(0, -0.02 * s, 0.11 * s * belly);
      part(this.torso, bib, style.overalls, false);
      const lower = capsule(0.172 * s, 0.02 * s, 4, 12);
      lower.scale(1.07 * belly, 1, 0.83 * belly);
      lower.translate(0, -0.09 * s, 0);
      part(this.torso, lower, style.overalls, false);
      for (const sx of [-1, 1]) {
        const strap = rbox(0.05 * s, 0.24 * s, 0.24 * s * belly, 0.015 * s);
        strap.translate(sx * 0.1 * s * belly, 0.08 * s, 0.01 * s);
        part(this.torso, strap, style.overalls, false);
        const button = sphere(0.022 * s, 6, 4);
        button.translate(sx * 0.1 * s * belly, 0.03 * s, 0.14 * s * belly);
        part(this.torso, button, PAL.brass, false);
      }
    } else {
      const hem = cyl(0.182 * s * belly, 0.182 * s * belly, 0.05 * s, 14);
      hem.scale(1.05, 1, 0.82);
      hem.translate(0, -0.1 * s, 0);
      part(this.torso, hem, style.face === 'player' ? 0x6b4a3a : style.pants, false);
    }
    if (style.backpack) {
      // hangs from its top edge so it can swing
      const bp = rbox(0.24 * s, 0.26 * s, 0.13 * s, 0.05 * s);
      bp.translate(0, -0.13 * s, -0.03 * s);
      part(this.pack, bp, 0x7f9a5a);
      const roll = cyl(0.05 * s, 0.05 * s, 0.26 * s, 8);
      roll.rotateZ(Math.PI / 2);
      roll.translate(0, 0.01 * s, -0.03 * s);
      part(this.pack, roll, 0xc98b5a, false);
    }
    if (style.hat === 'hood') {
      const hood = sphere(0.2 * s, 12, 8);
      hood.scale(1.1, 0.7, 0.8);
      hood.translate(0, 0.16 * s, -0.15 * s);
      part(this.torso, hood, style.shirt);
    }
    // stumps (hidden until an arm comes off)
    for (const [stump, sx] of [
      [this.stumpL, 1],
      [this.stumpR, -1],
    ] as [THREE.Bone, number][]) {
      const meat = sphere(0.074 * s * bulk, 10, 8);
      meat.scale(1, 0.9, 1);
      part(stump, meat, 0xa8323f, false);
      const bone = sphere(0.03 * s, 8, 6);
      bone.translate(sx * 0.05 * s, -0.02 * s, 0);
      part(stump, bone, 0xf4ecd9, false);
    }

    // ---- arms: upper arm + forearm/hand
    const fore = (DIMS.armLen - DIMS.upperArm) * s;
    for (const [arm, foreB] of [
      [this.armL, this.foreL],
      [this.armR, this.foreR],
    ] as [THREE.Bone, THREE.Bone][]) {
      const ug = capsule(0.062 * s * bulk, DIMS.upperArm * s - 0.03 * s, 3, 8);
      ug.translate(0, -(DIMS.upperArm * s + 0.03 * s) / 2, 0);
      part(arm, ug, style.shirt);
      const fg = capsule(0.058 * s * bulk, fore - 0.04 * s, 3, 8);
      fg.translate(0, -(fore - 0.04 * s) / 2, 0);
      part(foreB, fg, style.shirt);
      const hgeo = sphere(0.068 * s * bulk, 10, 8);
      hgeo.translate(0, -fore, 0);
      part(foreB, hgeo, style.skin);
    }

    // ---- hat / hair
    this.buildHat(style, part);

    // ---- merge into one skinned geometry: outlined parts first (group 0), plain after (group 1)
    const bones = [
      this.torso,
      this.head,
      this.hat,
      this.hair,
      this.pack,
      this.armL,
      this.foreL,
      this.armR,
      this.foreR,
      this.legL,
      this.shinL,
      this.legR,
      this.shinR,
      this.stumpL,
      this.stumpR,
    ];
    this.root.updateMatrixWorld(true);
    const outlinedGeos: THREE.BufferGeometry[] = [];
    const plainGeos: THREE.BufferGeometry[] = [];
    bones.forEach((bone, bi) => {
      const b = builders.get(bone);
      if (!b) return;
      for (const [builder, list] of [
        [b.outlined, outlinedGeos],
        [b.plain, plainGeos],
      ] as [GeoBuilder, THREE.BufferGeometry[]][]) {
        if (builder.empty) continue;
        const g = builder.build();
        g.applyMatrix4(bone.matrixWorld);
        const n = g.getAttribute('position').count;
        const idx = new Uint16Array(n * 4);
        const wts = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          idx[i * 4] = bi;
          wts[i * 4] = 1;
        }
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
        g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
        list.push(g);
      }
    });
    const geo = mergeGeometries([...outlinedGeos, ...plainGeos], false)!;
    let nOutlined = 0;
    for (const g of outlinedGeos) nOutlined += g.getAttribute('position').count;
    for (const g of [...outlinedGeos, ...plainGeos]) g.dispose();
    geo.addGroup(0, nOutlined, 0);
    geo.addGroup(nOutlined, geo.getAttribute('position').count - nOutlined, 1);
    this.disposables.push(geo);
    this.skeleton = new THREE.Skeleton(bones);
    this.disposables.push(this.skeleton);
    const skinned = (mat: THREE.Material | THREE.Material[]) => {
      const m = new THREE.SkinnedMesh(geo, mat);
      m.bind(this.skeleton, new THREE.Matrix4());
      // bones fly around in world space (ragdoll, loose parts): bounds are meaningless
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    };
    const main = skinned(bodyMat);
    main.castShadow = true;
    main.receiveShadow = true;
    const outl = skinned([outline, HIDDEN]);
    outl.userData.noAO = true;
    const xr = skinned(xray);
    xr.renderOrder = 50;
    xr.userData.noAO = true;
    this.xrayMeshes.push(xr);

    // ---- head: its own mesh (painted face), parented to the head bone
    this.baseFace = this.shownFace = style.face;
    this.headMat = stencil(toonUnique(0xffffff, { map: faceTexture(style.face, style.skin, style.faceVariant) })) as THREE.MeshToonMaterial;
    addRim(this.headMat, 0xffdca0, 0.55);
    this.mats.push(this.headMat);
    this.disposables.push(this.headMat);
    const hg = new THREE.SphereGeometry(DIMS.headR * s, 32, 22);
    hg.scale(1.02, 0.94, 0.96);
    this.disposables.push(hg);
    const headMesh = new THREE.Mesh(hg, this.headMat);
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    const headOutline = new THREE.Mesh(hg, outline);
    headOutline.userData.noAO = true;
    const headX = new THREE.Mesh(hg, xray);
    headX.renderOrder = 50;
    headX.userData.noAO = true;
    this.head.add(headMesh, headOutline, headX);
    this.xrayMeshes.push(headX);
    // warm the expression textures so the first blink/flinch doesn't paint a canvas mid-fight
    const kinds: FaceKind[] = style.face === 'player' ? ['playerBlink', 'playerHurt'] : ['zombieBlink', 'zombieHurt', 'zombieAttack'];
    for (const k of kinds) faceTexture(k, style.skin, style.faceVariant);

    // stumps stay collapsed until needed
    this.stumpL.scale.setScalar(1e-3);
    this.stumpR.scale.setScalar(1e-3);

    // ---- secondary motion
    if (style.hat === 'straw') this.wobbles.push(new Wobble(this.hat, this.head, 9, 0.22, 1.7, 0.4));
    else if (style.hat === 'cap') this.wobbles.push(new Wobble(this.hat, this.head, 15, 0.3, 1.1, 0.16));
    if (style.hat === 'cap' || style.hat === 'none') this.wobbles.push(new Wobble(this.hair, this.head, 13, 0.25, 1.4, 0.22));
    if (style.backpack) this.wobbles.push(new Wobble(this.pack, this.torso, 8, 0.3, 1.5, 0.55, 0.35));

    // ---- blob shadow for contact grounding
    const shGeo = new THREE.PlaneGeometry(1, 1);
    const shMat = new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0x2a3320, transparent: true, opacity: 0.32, depthWrite: false });
    this.disposables.push(shGeo, shMat);
    const sh = new THREE.Mesh(shGeo, shMat);
    sh.rotation.x = -Math.PI / 2;
    sh.scale.setScalar(0.85 * s * (style.belly ?? 1));
    sh.position.y = 0.02;
    sh.renderOrder = 2;
    sh.userData.noAO = true;
    this.shadow = sh;
  }

  private buildHat(style: CharacterStyle, part: (bone: THREE.Object3D, geo: THREE.BufferGeometry, color: number, outline?: boolean) => void): void {
    const s = style.scale;
    const r = DIMS.headR * s;
    if (style.hat === 'cap') {
      const dome = new THREE.SphereGeometry(r * 1.04, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
      dome.scale(1.02, 0.78, 1.0);
      dome.translate(0, r * 0.12, 0);
      part(this.hat, dome, PAL.capRed);
      const visor = cyl(r * 0.7, r * 0.72, 0.03 * s, 16);
      visor.scale(1, 1, 0.75);
      visor.translate(0, r * 0.17, r * 0.72);
      part(this.hat, visor, 0xc24d40);
      const button = sphere(0.03 * s, 6, 4);
      button.translate(0, r * 0.93, 0);
      part(this.hat, button, PAL.capRed, false);
      for (const [x, y, z, rr] of [
        [0.8, -0.05, -0.2, 0.2],
        [-0.8, -0.05, -0.2, 0.2],
        [0.5, -0.1, -0.75, 0.22],
        [-0.45, -0.12, -0.78, 0.22],
        [0, -0.15, -0.9, 0.24],
      ]) {
        const g = blob(rr * r, 1, 0.2, x * 10, 0.9);
        g.translate(x * r, y * r + r * 0.12, z * r);
        part(this.hair, g, style.hair, false);
      }
    } else if (style.hat === 'straw') {
      const brim = cyl(r * 1.55, r * 1.6, 0.04 * s, 20);
      brim.translate(0, r * 0.55, 0);
      part(this.hat, brim, PAL.strawHat);
      const top = cyl(r * 0.78, r * 0.9, r * 0.55, 16);
      top.translate(0, r * 0.82, 0);
      part(this.hat, top, PAL.strawHat);
      const band = cyl(r * 0.91, r * 0.91, r * 0.12, 16);
      band.translate(0, r * 0.62, 0);
      part(this.hat, band, 0xc9584a, false);
    } else if (style.hat === 'none') {
      for (const [x, y, z, rr] of [
        [0.3, 0.85, -0.2, 0.3],
        [-0.35, 0.8, -0.3, 0.28],
        [0.05, 0.75, -0.6, 0.3],
        [0.6, 0.5, -0.45, 0.22],
        [-0.6, 0.45, -0.5, 0.22],
      ]) {
        const g = blob(rr * r, 1, 0.25, x * 10 + y, 0.9);
        g.translate(x * r, y * r, z * r);
        part(this.hair, g, style.hair, false);
      }
    }
  }

  get meshesForFlash(): THREE.MeshToonMaterial[] {
    return this.mats;
  }

  // ------------------------------------------------------------------ faces

  /** Base expression (neutral / dead). Cancels any temporary expression. */
  setFace(kind: FaceKind): void {
    this.baseFace = kind;
    this.exprT = 0;
    this.applyFace(kind);
  }

  /** Temporary expression (flinch, attack) that falls back to the base face. */
  express(kind: FaceKind, seconds: number): void {
    if (this.baseFace === 'zombieDead' || this.baseFace === 'playerDead') return;
    this.exprFace = kind;
    this.exprT = seconds;
    this.applyFace(kind);
  }

  private applyFace(kind: FaceKind): void {
    if (kind === this.shownFace) return;
    this.shownFace = kind;
    this.headMat.map = faceTexture(kind, this.style.skin, this.style.faceVariant);
    this.headMat.needsUpdate = true;
  }

  private updateFace(dt: number): void {
    this.blinkT -= dt;
    let kind = this.baseFace;
    if (this.exprT > 0) {
      this.exprT -= dt;
      if (this.exprFace) kind = this.exprFace;
    } else if (kind === 'player' || kind === 'zombie') {
      const zombie = kind === 'zombie';
      if (this.blinkT <= 0) {
        kind = zombie ? 'zombieBlink' : 'playerBlink';
        // zombies blink slow and heavy, sometimes twice
        if (this.blinkT < -(zombie ? 0.2 : 0.11)) this.blinkT = rng.chance(0.2) ? 0.15 : zombie ? rng.range(2.5, 6) : rng.range(1.8, 4.5);
      }
    }
    this.applyFace(kind);
  }

  // ------------------------------------------------------------------ per-frame

  /** Brief white hit flash. */
  flash(t = 0.09): void {
    this.flashT = t;
  }

  setXray(on: boolean): void {
    for (const m of this.xrayMeshes) m.visible = on;
  }

  private updateFlash(dt: number): void {
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = this.flashT > 0 ? 1 : 0;
      for (const m of this.mats) {
        m.emissive.setRGB(k, k * 0.95, k * 0.9);
        m.emissiveIntensity = k * 0.85;
      }
    }
  }

  /**
   * Call once per frame after the pose (animation or ragdoll) and the root transform are set:
   * flash, face, secondary motion and loose parts.
   */
  update(dt: number): void {
    this.updateFlash(dt);
    this.updateFace(dt);
    if (dt <= 0) return;
    this.root.updateMatrixWorld(true);
    for (const w of this.wobbles) {
      if (w.bone === this.hat && this.hatLost) continue;
      w.update(dt);
      w.bone.rotation.set(w.x, 0, w.z);
    }
    this.updateLoose(dt);
  }

  /** Nudge the secondary motion (recoil, hits). */
  jiggle(strength: number): void {
    for (const w of this.wobbles) w.kick(rng.spread(strength), rng.spread(strength));
  }

  // ------------------------------------------------------------------ loose parts

  private detach(obj: THREE.Object3D, kind: Loose['kind'], local: THREE.Vector3, radius: number, vel: THREE.Vector3, spin: number): boolean {
    const world = this.root.parent;
    if (!world) return false;
    this.root.updateMatrixWorld(true);
    const frozen: Loose['frozen'] = [];
    obj.traverse((o) => {
      if (o !== obj) frozen.push({ obj: o, q: o.quaternion.clone() });
    });
    world.attach(obj);
    obj.scale.set(1, 1, 1);
    const q = obj.quaternion.clone();
    const c = local.clone().applyQuaternion(q).add(obj.position);
    this.loose.push({
      obj,
      kind,
      local,
      c,
      v: vel.clone(),
      q,
      w: new THREE.Vector3(rng.spread(spin), rng.spread(spin), rng.spread(spin)),
      radius,
      life: 0,
      bounces: 0,
      frozen,
    });
    return true;
  }

  /** Knock the hat off. Returns false if there is no hat (or it is already gone). */
  popHat(vel: THREE.Vector3, spin = 14): boolean {
    if (this.hatLost || (this.style.hat !== 'cap' && this.style.hat !== 'straw')) return false;
    const r = DIMS.headR * this.s;
    const straw = this.style.hat === 'straw';
    if (!this.detach(this.hat, 'hat', new THREE.Vector3(0, r * (straw ? 0.6 : 0.4), 0), straw ? 0.04 * this.s : 0.08 * this.s, vel, spin)) return false;
    this.hatLost = true;
    return true;
  }

  /** Tear an arm off at the shoulder. Returns the shoulder position, or null. */
  tearArm(side: Side, vel: THREE.Vector3, spin = 16): THREE.Vector3 | null {
    if (this.armLost[side]) return null;
    const arm = side === 0 ? this.armL : this.armR;
    this.root.updateMatrixWorld(true);
    const at = arm.getWorldPosition(new THREE.Vector3());
    if (!this.detach(arm, 'arm', new THREE.Vector3(0, -DIMS.armLen * 0.45 * this.s, 0), 0.065 * this.s * (this.style.bulk ?? 1), vel, spin)) return null;
    this.armLost[side] = true;
    (side === 0 ? this.stumpL : this.stumpR).scale.setScalar(1);
    return at;
  }

  /** World position of a shoulder (for stump blood). */
  shoulderWorld(side: Side, out = new THREE.Vector3()): THREE.Vector3 {
    return (side === 0 ? this.stumpL : this.stumpR).getWorldPosition(out);
  }

  private isLoose(o: THREE.Object3D): boolean {
    return (o === this.hat && this.hatLost) || (o === this.armL && this.armLost[0]) || (o === this.armR && this.armLost[1]);
  }

  private updateLoose(dt: number): void {
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const L = this.loose[i];
      L.life += dt;
      L.v.y -= 16 * dt;
      L.c.addScaledVector(L.v, dt);
      const w = L.w.length();
      if (w > 1e-4) L.q.premultiply(tmpQ.setFromAxisAngle(tmpA.copy(L.w).divideScalar(w), w * dt));
      const gy = this.ground(L.c.x, L.c.z) + L.radius;
      if (L.c.y < gy) {
        L.c.y = gy;
        if (L.v.y < -1.6 && L.bounces < 4) {
          L.v.y *= -0.32;
          L.v.x *= 0.6;
          L.v.z *= 0.6;
          L.w.multiplyScalar(0.55);
          L.bounces++;
        } else {
          L.v.y = 0;
          L.v.x /= 1 + dt * 8;
          L.v.z /= 1 + dt * 8;
          L.w.multiplyScalar(1 / (1 + dt * 12));
          // settle: hats land on their brim (or crown), arms lie flat
          if (L.kind === 'hat') tmpY.set(0, 1, 0);
          else {
            const ax = tmpX.set(1, 0, 0).applyQuaternion(L.q);
            const az = tmpZ.set(0, 0, 1).applyQuaternion(L.q);
            tmpY.set(Math.abs(ax.y) > Math.abs(az.y) ? 1 : 0, 0, Math.abs(ax.y) > Math.abs(az.y) ? 0 : 1);
          }
          const wa = tmpY.applyQuaternion(L.q);
          if (wa.y < 0) wa.negate();
          const target = tmpQ.setFromUnitVectors(wa, UP).multiply(L.q);
          L.q.slerp(target, Math.min(1, dt * 7));
        }
      }
      const fade = L.life > 20 ? Math.max(1e-3, 1 - (L.life - 20) / 0.8) : 1;
      L.obj.quaternion.copy(L.q);
      L.obj.position.copy(L.local).multiplyScalar(-fade).applyQuaternion(L.q).add(L.c);
      L.obj.scale.setScalar(fade);
      for (const f of L.frozen) f.obj.quaternion.copy(f.q);
      if (fade <= 1e-3) {
        L.obj.removeFromParent();
        this.loose.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ ragdoll

  /** World positions of the ragdoll joints in the current pose. */
  jointPositions(): THREE.Vector3[] {
    this.root.updateMatrixWorld(true);
    const s = this.s;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < JOINT_COUNT; i++) out.push(new THREE.Vector3());
    this.head.getWorldPosition(out[J.head]);
    this.torso.localToWorld(out[J.shoulderL].copy(this.stumpL.position));
    this.torso.localToWorld(out[J.shoulderR].copy(this.stumpR.position));
    if (!this.armLost[0]) this.armL.getWorldPosition(out[J.shoulderL]);
    if (!this.armLost[1]) this.armR.getWorldPosition(out[J.shoulderR]);
    this.legL.getWorldPosition(out[J.hipL]);
    this.legR.getWorldPosition(out[J.hipR]);
    if (this.armLost[0]) out[J.handL].copy(out[J.shoulderL]).y -= 0.12 * s;
    else this.handL.getWorldPosition(out[J.handL]);
    if (this.armLost[1]) out[J.handR].copy(out[J.shoulderR]).y -= 0.12 * s;
    else this.handR.getWorldPosition(out[J.handR]);
    const shin = (DIMS.legLen - DIMS.thigh) * s;
    out[J.footL].set(0, -shin, 0).applyMatrix4(this.shinL.matrixWorld);
    out[J.footR].set(0, -shin, 0).applyMatrix4(this.shinR.matrixWorld);
    return out;
  }

  /** Build the ragdoll for this body with the given initial joint velocities. */
  createRagdoll(vel: THREE.Vector3[]): Ragdoll {
    const s = this.s;
    const mass = s * s * s;
    const radii = [0.27, 0.11, 0.11, 0.11, 0.11, 0.07, 0.07, 0.08, 0.08].map((r) => r * s * (this.style.belly && r === 0.11 ? this.style.belly : 1));
    const masses = [3, 4, 4, 4, 4, 0.8, 0.8, 1, 1].map((m) => m * mass);
    const rd = new Ragdoll(radii, masses);
    // canonical rest pose for link lengths
    const rest: THREE.Vector3[] = [];
    for (let i = 0; i < JOINT_COUNT; i++) rest.push(new THREE.Vector3());
    rest[J.head].set(0, DIMS.headY * s, 0);
    rest[J.shoulderL].set(DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    rest[J.shoulderR].set(-DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    rest[J.hipL].set(DIMS.hipX * s, DIMS.hipY * s, 0);
    rest[J.hipR].set(-DIMS.hipX * s, DIMS.hipY * s, 0);
    rest[J.handL].set(DIMS.shoulderX * s, (DIMS.shoulderY - DIMS.armLen) * s, 0);
    rest[J.handR].set(-DIMS.shoulderX * s, (DIMS.shoulderY - DIMS.armLen) * s, 0);
    rest[J.footL].set(DIMS.hipX * s, (DIMS.hipY - DIMS.legLen) * s, 0);
    rest[J.footR].set(-DIMS.hipX * s, (DIMS.hipY - DIMS.legLen) * s, 0);
    // rigid torso
    const T = [J.shoulderL, J.shoulderR, J.hipL, J.hipR];
    for (let i = 0; i < 4; i++) for (let k = i + 1; k < 4; k++) rd.link(T[i], T[k], rest);
    // head on the shoulders, loosely held upright by the hips
    rd.link(J.head, J.shoulderL, rest);
    rd.link(J.head, J.shoulderR, rest);
    rd.link(J.head, J.hipL, rest, 0.86, 1.02, 0.6);
    rd.link(J.head, J.hipR, rest, 0.86, 1.02, 0.6);
    // limbs may fold (elbows/knees are solved with IK when posing)
    rd.link(J.handL, J.shoulderL, rest, 0.5, 1);
    rd.link(J.handR, J.shoulderR, rest, 0.5, 1);
    rd.link(J.footL, J.hipL, rest, 0.62, 1);
    rd.link(J.footR, J.hipR, rest, 0.62, 1);
    // keep legs from folding through the chest, arms from crossing the head
    rd.link(J.footL, J.shoulderL, rest, 0.62, 1.3, 0.5);
    rd.link(J.footR, J.shoulderR, rest, 0.62, 1.3, 0.5);
    rd.link(J.handL, J.head, rest, 0.55, 3, 0.4);
    rd.link(J.handR, J.head, rest, 0.55, 3, 0.4);
    rd.link(J.footL, J.footR, rest, 0.6, 4, 0.3);
    rd.setPositions(this.jointPositions(), vel);
    // a missing arm leaves a massless, tiny particle behind
    for (const [side, idx] of [
      [0, J.handL],
      [1, J.handR],
    ] as const) {
      if (!this.armLost[side]) continue;
      rd.detach(idx);
      rd.r[idx] = 0.001;
      rd.w[idx] = 1000;
    }
    return rd;
  }

  /**
   * Two-bone IK: place `upper` at S, bend toward `pole`, reach H. The hinge is the bones' local
   * X axis; `zSign` picks which way it folds (-1 elbows, +1 knees).
   */
  private ik(upper: THREE.Object3D, lower: THREE.Object3D, S: THREE.Vector3, H: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, zSign: number, fallback: THREE.Vector3): void {
    ikD.subVectors(H, S);
    let d = ikD.length();
    if (d < 1e-5) ikD.set(0, -1, 0);
    else ikD.divideScalar(d);
    d = clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    ikP.copy(pole).addScaledVector(ikD, -pole.dot(ikD));
    if (ikP.lengthSq() < 1e-6) ikP.crossVectors(fallback, ikD);
    ikP.normalize();
    ikE.copy(S).addScaledVector(ikD, a * cosA).addScaledVector(ikP, a * sinA);
    tmpY.subVectors(S, ikE).normalize();
    tmpZ.copy(ikP).multiplyScalar(zSign);
    tmpZ.addScaledVector(tmpY, -tmpZ.dot(tmpY)).normalize();
    tmpX.crossVectors(tmpY, tmpZ);
    tmpM.makeBasis(tmpX, tmpY, tmpZ);
    upper.position.copy(S);
    upper.quaternion.setFromRotationMatrix(tmpM);
    ikY2.subVectors(ikE, H);
    if (ikY2.lengthSq() < 1e-8) ikY2.copy(tmpY);
    ikY2.normalize();
    ikZ2.crossVectors(tmpX, ikY2);
    tmpM.makeBasis(tmpX, ikY2, ikZ2);
    tmpQ.setFromRotationMatrix(tmpM);
    lower.quaternion.copy(upper.quaternion).invert().multiply(tmpQ);
  }

  /** Pose the parts in world space from ragdoll particles. Root/body must be identity. */
  applyRagdoll(rd: Ragdoll, headSpin?: THREE.Quaternion): void {
    const s = this.s;
    const shL = rd.get(J.shoulderL, tmpA);
    const shR = rd.get(J.shoulderR, tmpB);
    const hpL = rd.get(J.hipL, tmpC);
    const hpR = rd.get(J.hipR, tmpD);
    // torso basis
    tmpX.set(shL.x + hpL.x - shR.x - hpR.x, shL.y + hpL.y - shR.y - hpR.y, shL.z + hpL.z - shR.z - hpR.z).normalize();
    tmpY.set(shL.x + shR.x - hpL.x - hpR.x, shL.y + shR.y - hpL.y - hpR.y, shL.z + shR.z - hpL.z - hpR.z);
    tmpY.addScaledVector(tmpX, -tmpY.dot(tmpX)).normalize();
    tmpZ.crossVectors(tmpX, tmpY);
    tmpM.makeBasis(tmpX, tmpY, tmpZ);
    this.torso.quaternion.setFromRotationMatrix(tmpM);
    this.torso.position.set((shL.x + shR.x + hpL.x + hpR.x) / 4, (shL.y + shR.y + hpL.y + hpR.y) / 4, (shL.z + shR.z + hpL.z + hpR.z) / 4);
    const torsoX = tmpX.clone();
    const torsoY = tmpY.clone();
    const torsoZ = tmpZ.clone();
    const neck = new THREE.Vector3().addVectors(shL, shR).multiplyScalar(0.5);
    const S = [shL.clone(), shR.clone(), hpL.clone(), hpR.clone()];
    // head
    const hp = rd.get(J.head, new THREE.Vector3());
    this.head.position.copy(hp);
    if (headSpin) this.head.quaternion.copy(headSpin);
    else {
      const up = hp.clone().sub(neck).normalize();
      const x = torsoX.clone().addScaledVector(up, -torsoX.dot(up)).normalize();
      const z = new THREE.Vector3().crossVectors(x, up);
      tmpM.makeBasis(x, up, z);
      this.head.quaternion.setFromRotationMatrix(tmpM);
    }
    // limbs: two-bone IK toward the hand/foot particles
    const a = DIMS.upperArm * s;
    const b = (DIMS.armLen - DIMS.upperArm) * s;
    const t = DIMS.thigh * s;
    const sh = (DIMS.legLen - DIMS.thigh) * s;
    const end = new THREE.Vector3();
    const pole = new THREE.Vector3();
    for (const side of [0, 1] as Side[]) {
      const sx = side === 0 ? 1 : -1;
      if (!this.armLost[side]) {
        pole.copy(torsoZ).multiplyScalar(-1).addScaledVector(torsoY, -0.4).addScaledVector(torsoX, 0.3 * sx);
        this.ik(side === 0 ? this.armL : this.armR, side === 0 ? this.foreL : this.foreR, S[side], rd.get(side === 0 ? J.handL : J.handR, end), a, b, pole, -1, torsoX);
      }
      pole.copy(torsoZ).addScaledVector(torsoX, 0.15 * sx);
      this.ik(side === 0 ? this.legL : this.legR, side === 0 ? this.shinL : this.shinR, S[2 + side], rd.get(side === 0 ? J.footL : J.footR, end), t, sh, pole, 1, torsoX);
    }
    // blob shadow follows the pelvis
    this.shadow.position.set(this.torso.position.x, 0.02, this.torso.position.z);
  }

  private blendFrom: { obj: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion; to: THREE.Vector3 }[] = [];

  /** Parts placed in body space by the ragdoll (upper bones), then their local children. */
  private get worldParts(): THREE.Object3D[] {
    return [this.torso, this.head, this.armL, this.armR, this.legL, this.legR].filter((p) => !this.isLoose(p));
  }

  private get localParts(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [this.shinL, this.shinR];
    if (!this.armLost[0]) out.push(this.foreL);
    if (!this.armLost[1]) out.push(this.foreR);
    return out;
  }

  /**
   * Capture the current world-space part transforms (ragdoll pose) expressed relative to the
   * root placed at `pos`/`yaw`, so we can blend back to an animated pose (getting up).
   */
  beginBlendFromWorld(pos: THREE.Vector3, yaw: number): void {
    const rootM = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
    const inv = rootM.clone().invert();
    this.blendFrom = this.worldParts.map((p) => {
      const m = new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(inv);
      const pp = new THREE.Vector3();
      const q = new THREE.Quaternion();
      m.decompose(pp, q, new THREE.Vector3());
      return { obj: p, pos: pp, quat: q, to: new THREE.Vector3() };
    });
    for (const p of this.localParts) this.blendFrom.push({ obj: p, pos: p.position.clone(), quat: p.quaternion.clone(), to: new THREE.Vector3() });
    this.root.position.copy(pos);
    this.root.rotation.set(0, yaw, 0);
    // the ragdoll left world-space positions on the parts; animation only drives rotations, so
    // the joints go back to their rest positions (the blend target) right away
    this.resetPose();
    for (const f of this.blendFrom) f.to.copy(f.obj.position);
  }

  /**
   * After the animation pose (rotations) was applied this frame, blend toward it from the
   * captured ragdoll pose. Positions blend toward the rest joints.
   */
  applyBlend(t: number): void {
    if (!this.blendFrom.length) return;
    const k = Math.min(1, Math.max(0, t));
    const e = k * k * (3 - 2 * k);
    for (const from of this.blendFrom) {
      from.obj.position.lerpVectors(from.pos, from.to, e);
      from.obj.quaternion.slerpQuaternions(from.quat, from.obj.quaternion, e);
    }
    if (k >= 1) this.blendFrom = [];
  }

  /** Finish a blend early: joints snap to their rest positions. */
  endBlend(): void {
    for (const from of this.blendFrom) from.obj.position.copy(from.to);
    this.blendFrom = [];
  }

  /** Reset part transforms to the standing rest pose (local to body). */
  resetPose(): void {
    const s = this.s;
    this.torso.position.set(0, DIMS.torsoY * s, 0);
    this.torso.quaternion.identity();
    this.head.position.set(0, DIMS.headY * s, 0);
    this.head.quaternion.identity();
    if (!this.armLost[0]) this.armL.position.set(DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    if (!this.armLost[1]) this.armR.position.set(-DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    this.legL.position.set(DIMS.hipX * s, DIMS.hipY * s, 0);
    this.legR.position.set(-DIMS.hipX * s, DIMS.hipY * s, 0);
    for (const o of [this.armL, this.armR, this.legL, this.legR, this.foreL, this.foreR, this.shinL, this.shinR]) if (!this.isLoose(o)) o.quaternion.identity();
  }

  dispose(): void {
    this.root.removeFromParent();
    this.shadow.removeFromParent();
    for (const L of this.loose) L.obj.removeFromParent();
    this.loose = [];
    for (const d of this.disposables) d.dispose();
  }
}
