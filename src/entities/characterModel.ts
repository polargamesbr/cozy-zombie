import * as THREE from 'three';
import { PAL } from '../render/palette';
import { blob, capsule, cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { outlineMaterial, toonUnique } from '../render/materials';
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
};

const tmpX = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();

/**
 * Chibi character rig built from primitives: big head, bean torso, stubby limbs. Parts are
 * pivoted at their joints so the same objects can be driven by procedural animation or by the
 * ragdoll (in world space).
 */
export class CharacterModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly armL = new THREE.Group();
  readonly armR = new THREE.Group();
  readonly legL = new THREE.Group();
  readonly legR = new THREE.Group();
  readonly handR = new THREE.Group();
  readonly handL = new THREE.Group();
  readonly shadow: THREE.Mesh;
  readonly s: number;
  private mats: THREE.MeshToonMaterial[] = [];
  private headMat: THREE.MeshToonMaterial;
  private xrayMats: THREE.MeshBasicMaterial[] = [];
  private xrayMeshes: THREE.Mesh[] = [];
  private flashT = 0;
  private faceKind: FaceKind;

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
    this.xrayMats.push(xray);
    const stencil = (m: THREE.Material) => {
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
      return m;
    };
    // one vertex-colored material per character (so hit flashes are per character)
    const bodyMat = stencil(toonUnique(0xffffff, { vertexColors: true })) as THREE.MeshToonMaterial;
    this.mats.push(bodyMat);
    // parts are accumulated per joint and merged into one mesh each: 3 draw calls per joint
    const builders = new Map<THREE.Object3D, { plain: GeoBuilder; outlined: GeoBuilder }>();
    const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, withOutline = true) => {
      let b = builders.get(parent);
      if (!b) {
        b = { plain: new GeoBuilder(), outlined: new GeoBuilder() };
        builders.set(parent, b);
      }
      (withOutline ? b.outlined : b.plain).add(geo, color);
    };
    const finish = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, withOutline: boolean) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      if (withOutline) parent.add(new THREE.Mesh(geo, outline));
      const x = new THREE.Mesh(geo, xray);
      x.renderOrder = 50;
      parent.add(x);
      this.xrayMeshes.push(x);
    };

    // ---- legs
    for (const [leg, sx] of [
      [this.legL, 1],
      [this.legR, -1],
    ] as [THREE.Group, number][]) {
      leg.position.set(sx * DIMS.hipX * s, DIMS.hipY * s, 0);
      const lg = capsule(0.075 * s * bulk, DIMS.legLen * s * 0.7, 3, 8);
      lg.translate(0, -DIMS.legLen * s * 0.45, 0);
      part(leg, lg, style.pants);
      const boot = rbox(0.14 * s * bulk, 0.1 * s, 0.2 * s, 0.045 * s);
      boot.translate(0, -DIMS.legLen * s + 0.02 * s, 0.03 * s);
      part(leg, boot, style.shoes);
      this.body.add(leg);
    }

    // ---- torso
    this.torso.position.set(0, DIMS.torsoY * s, 0);
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
      const bp = rbox(0.24 * s, 0.26 * s, 0.13 * s, 0.05 * s);
      bp.translate(0, 0.02 * s, -0.17 * s);
      part(this.torso, bp, 0x7f9a5a);
      const roll = cyl(0.05 * s, 0.05 * s, 0.26 * s, 8);
      roll.rotateZ(Math.PI / 2);
      roll.translate(0, 0.16 * s, -0.17 * s);
      part(this.torso, roll, 0xc98b5a, false);
    }
    if (style.hat === 'hood') {
      const hood = sphere(0.2 * s, 12, 8);
      hood.scale(1.1, 0.7, 0.8);
      hood.translate(0, 0.16 * s, -0.15 * s);
      part(this.torso, hood, style.shirt);
    }
    this.body.add(this.torso);

    // ---- head (face texture on its own material, hat/hair merged)
    this.head.position.set(0, DIMS.headY * s, 0);
    this.faceKind = style.face;
    this.headMat = stencil(toonUnique(0xffffff, { map: faceTexture(style.face, style.skin, style.faceVariant) })) as THREE.MeshToonMaterial;
    this.mats.push(this.headMat);
    const hg = new THREE.SphereGeometry(DIMS.headR * s, 32, 22);
    hg.scale(1.02, 0.94, 0.96);
    finish(this.head, hg, this.headMat, true);
    this.buildHat(style, part);
    this.body.add(this.head);

    // ---- arms
    for (const [arm, hand, sx] of [
      [this.armL, this.handL, 1],
      [this.armR, this.handR, -1],
    ] as [THREE.Group, THREE.Group, number][]) {
      arm.position.set(sx * DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
      const ag = capsule(0.062 * s * bulk, DIMS.armLen * s * 0.62, 3, 8);
      ag.translate(0, -DIMS.armLen * s * 0.42, 0);
      part(arm, ag, style.shirt);
      const hgeo = sphere(0.068 * s * bulk, 10, 8);
      hgeo.translate(0, -DIMS.armLen * s, 0);
      part(arm, hgeo, style.skin);
      hand.position.set(0, -DIMS.armLen * s, 0);
      arm.add(hand);
      this.body.add(arm);
    }

    for (const [parent, b] of builders) {
      if (!b.outlined.empty) finish(parent, b.outlined.build(), bodyMat, true);
      if (!b.plain.empty) finish(parent, b.plain.build(), bodyMat, false);
    }

    // ---- blob shadow for contact grounding
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0x2a3320, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    sh.rotation.x = -Math.PI / 2;
    sh.scale.setScalar(0.85 * s * (style.belly ?? 1));
    sh.position.y = 0.02;
    sh.renderOrder = 2;
    this.shadow = sh;
  }

  private buildHat(style: CharacterStyle, part: (parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, outline?: boolean) => void): void {
    const s = style.scale;
    const r = DIMS.headR * s;
    if (style.hat === 'cap') {
      const dome = new THREE.SphereGeometry(r * 1.04, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
      dome.scale(1.02, 0.78, 1.0);
      dome.translate(0, r * 0.12, 0);
      part(this.head, dome, PAL.capRed);
      const visor = cyl(r * 0.7, r * 0.72, 0.03 * s, 16);
      visor.scale(1, 1, 0.75);
      visor.translate(0, r * 0.17, r * 0.72);
      part(this.head, visor, 0xc24d40);
      const button = sphere(0.03 * s, 6, 4);
      button.translate(0, r * 0.93, 0);
      part(this.head, button, PAL.capRed, false);
      for (const [x, y, z, rr] of [
        [0.8, -0.05, -0.2, 0.2],
        [-0.8, -0.05, -0.2, 0.2],
        [0.5, -0.1, -0.75, 0.22],
        [-0.45, -0.12, -0.78, 0.22],
        [0, -0.15, -0.9, 0.24],
      ]) {
        const g = blob(rr * r, 1, 0.2, x * 10, 0.9);
        g.translate(x * r, y * r + r * 0.12, z * r);
        part(this.head, g, style.hair, false);
      }
    } else if (style.hat === 'straw') {
      const brim = cyl(r * 1.55, r * 1.6, 0.04 * s, 20);
      brim.translate(0, r * 0.55, 0);
      part(this.head, brim, PAL.strawHat);
      const top = cyl(r * 0.78, r * 0.9, r * 0.55, 16);
      top.translate(0, r * 0.82, 0);
      part(this.head, top, PAL.strawHat);
      const band = cyl(r * 0.91, r * 0.91, r * 0.12, 16);
      band.translate(0, r * 0.62, 0);
      part(this.head, band, 0xc9584a, false);
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
        part(this.head, g, style.hair, false);
      }
    }
  }

  get meshesForFlash(): THREE.MeshToonMaterial[] {
    return this.mats;
  }

  setFace(kind: FaceKind): void {
    if (kind === this.faceKind) return;
    this.faceKind = kind;
    this.headMat.map = faceTexture(kind, this.style.skin, this.style.faceVariant);
    this.headMat.needsUpdate = true;
  }

  /** Brief white hit flash. */
  flash(t = 0.09): void {
    this.flashT = t;
  }

  setXray(on: boolean): void {
    for (const m of this.xrayMeshes) m.visible = on;
  }

  updateFlash(dt: number): void {
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = this.flashT > 0 ? 1 : 0;
      for (const m of this.mats) {
        m.emissive.setRGB(k, k * 0.95, k * 0.9);
        m.emissiveIntensity = k * 0.85;
      }
    }
  }

  /** World positions of the ragdoll joints in the current pose. */
  jointPositions(): THREE.Vector3[] {
    this.root.updateMatrixWorld(true);
    const s = this.s;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < JOINT_COUNT; i++) out.push(new THREE.Vector3());
    this.head.getWorldPosition(out[J.head]);
    this.armL.getWorldPosition(out[J.shoulderL]);
    this.armR.getWorldPosition(out[J.shoulderR]);
    this.legL.getWorldPosition(out[J.hipL]);
    this.legR.getWorldPosition(out[J.hipR]);
    out[J.handL].set(0, -DIMS.armLen * s, 0).applyMatrix4(this.armL.matrixWorld);
    out[J.handR].set(0, -DIMS.armLen * s, 0).applyMatrix4(this.armR.matrixWorld);
    out[J.footL].set(0, -DIMS.legLen * s, 0).applyMatrix4(this.legL.matrixWorld);
    out[J.footR].set(0, -DIMS.legLen * s, 0).applyMatrix4(this.legR.matrixWorld);
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
    // limbs
    rd.link(J.handL, J.shoulderL, rest);
    rd.link(J.handR, J.shoulderR, rest);
    rd.link(J.footL, J.hipL, rest);
    rd.link(J.footR, J.hipR, rest);
    // keep legs from folding through the chest, arms from crossing the head
    rd.link(J.footL, J.shoulderL, rest, 0.62, 1.3, 0.5);
    rd.link(J.footR, J.shoulderR, rest, 0.62, 1.3, 0.5);
    rd.link(J.handL, J.head, rest, 0.55, 3, 0.4);
    rd.link(J.handR, J.head, rest, 0.55, 3, 0.4);
    rd.link(J.footL, J.footR, rest, 0.6, 4, 0.3);
    rd.setPositions(this.jointPositions(), vel);
    return rd;
  }

  /** Pose the parts in world space from ragdoll particles. Root/body must be identity. */
  applyRagdoll(rd: Ragdoll, headSpin?: THREE.Quaternion): void {
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
    const torsoZ = tmpZ.clone();
    const neck = new THREE.Vector3().addVectors(shL, shR).multiplyScalar(0.5);
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
    // limbs: -Y from joint to end
    const limb = (obj: THREE.Object3D, a: number, b: number) => {
      const pa = rd.get(a, new THREE.Vector3());
      const pb = rd.get(b, new THREE.Vector3());
      obj.position.copy(pa);
      const y = pa.clone().sub(pb).normalize();
      let x = torsoX.clone().addScaledVector(y, -torsoX.dot(y));
      if (x.lengthSq() < 1e-4) x = torsoZ.clone().cross(y);
      x.normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      tmpM.makeBasis(x, y, z);
      obj.quaternion.setFromRotationMatrix(tmpM);
    };
    limb(this.armL, J.shoulderL, J.handL);
    limb(this.armR, J.shoulderR, J.handR);
    limb(this.legL, J.hipL, J.footL);
    limb(this.legR, J.hipR, J.footR);
    // blob shadow follows the pelvis
    this.shadow.position.set(this.torso.position.x, 0.02, this.torso.position.z);
  }

  private blendFrom: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];

  private get parts(): THREE.Object3D[] {
    return [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
  }

  /**
   * Capture the current world-space part transforms (ragdoll pose) expressed relative to the
   * root placed at `pos`/`yaw`, so we can blend back to an animated pose (getting up).
   */
  beginBlendFromWorld(pos: THREE.Vector3, yaw: number): void {
    const rootM = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
    const inv = rootM.clone().invert();
    this.blendFrom = this.parts.map((p) => {
      const m = new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(inv);
      const pp = new THREE.Vector3();
      const q = new THREE.Quaternion();
      m.decompose(pp, q, new THREE.Vector3());
      return { pos: pp, quat: q };
    });
    this.root.position.copy(pos);
    this.root.rotation.set(0, yaw, 0);
  }

  /** After the animation pose was applied this frame, blend toward it from the captured pose. */
  applyBlend(t: number): void {
    if (!this.blendFrom.length) return;
    const k = Math.min(1, Math.max(0, t));
    const e = k * k * (3 - 2 * k);
    this.parts.forEach((p, i) => {
      const from = this.blendFrom[i];
      p.position.lerpVectors(from.pos, p.position, e);
      p.quaternion.slerpQuaternions(from.quat, p.quaternion, e);
    });
    if (k >= 1) this.blendFrom = [];
  }

  /** Reset part transforms to the standing rest pose (local to body). */
  resetPose(): void {
    const s = this.s;
    this.torso.position.set(0, DIMS.torsoY * s, 0);
    this.torso.quaternion.identity();
    this.head.position.set(0, DIMS.headY * s, 0);
    this.head.quaternion.identity();
    this.armL.position.set(DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    this.armR.position.set(-DIMS.shoulderX * s, DIMS.shoulderY * s, 0);
    this.legL.position.set(DIMS.hipX * s, DIMS.hipY * s, 0);
    this.legR.position.set(-DIMS.hipX * s, DIMS.hipY * s, 0);
    for (const o of [this.armL, this.armR, this.legL, this.legR]) o.quaternion.identity();
  }

  dispose(): void {
    this.root.removeFromParent();
    this.shadow.removeFromParent();
  }
}
