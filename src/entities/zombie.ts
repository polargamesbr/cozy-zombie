import * as THREE from 'three';
import { clamp, dampAngle, lerp, Spring } from '../core/math';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { CharacterModel, DIMS, type CharacterStyle, type Side } from './characterModel';
import { J, type Ragdoll } from '../physics/ragdoll';
import type { CharacterBody } from '../physics/world';
import type { GameCtx, GrassPusher, NoiseListener } from '../game/context';
import type { NavGrid } from '../world/navgrid';
import { inPond, LAYOUT } from '../world/layout';
import { FenceSegment } from '../world/fences';
import { pondPush } from '../world/pond';
import { sfx } from '../audio/sfx';
import type { Player } from './player';

export type ZombieType = 'shambler' | 'runner' | 'brute' | 'crawler';

/** Where a bullet landed on a standing zombie. */
export type HitPart = 'head' | 'torso' | 'legL' | 'legR' | 'armL' | 'armR';
export type HitParts = Partial<Record<HitPart, number>>;

interface ZDef {
  hp: number;
  speed: number;
  accel: number;
  radius: number;
  mass: number;
  damage: number;
  windup: number;
  reach: number;
  /** how much knockback they take (0..1+) */
  knock: number;
  launch: number;
  pitch: number;
}

const ZDEFS: Record<ZombieType, ZDef> = {
  shambler: { hp: 4, speed: 1.6, accel: 6, radius: 0.34, mass: 1, damage: 1, windup: 0.45, reach: 1.05, knock: 1, launch: 1, pitch: 1 },
  runner: { hp: 2.6, speed: 3.7, accel: 10, radius: 0.3, mass: 0.75, damage: 1, windup: 0.3, reach: 1.0, knock: 1.25, launch: 1.25, pitch: 1.3 },
  brute: { hp: 13, speed: 1.3, accel: 3.5, radius: 0.46, mass: 2.4, damage: 2, windup: 0.7, reach: 1.35, knock: 0.35, launch: 0.55, pitch: 0.7 },
  // born without working legs: low, slow-ish, hard to hit, easy to miss in the grass
  crawler: { hp: 2.2, speed: 2.2, accel: 5, radius: 0.3, mass: 0.8, damage: 1, windup: 0.45, reach: 1.0, knock: 1.2, launch: 1.2, pitch: 1.15 },
};

const SHIRTS = [PAL.zombieShirt, 0x8fb0c9, 0xd4c49a, 0xb8a0c8];

function styleFor(type: ZombieType, variant: number): CharacterStyle {
  const base = {
    face: 'zombie' as const,
    faceVariant: variant,
    outline: 0x2e3b35,
    xray: 0xff9f9a,
  };
  if (type === 'runner') {
    return { ...base, scale: 0.88, skin: 0xaecfb4, shirt: PAL.zombieHoodie, pants: 0x5f5d6b, shoes: 0xe9e3d8, hat: 'hood', hair: 0x4d5a48 };
  }
  if (type === 'crawler') {
    return { ...base, scale: 0.94, skin: 0xb9cc9c, shirt: 0x9aa7b8, pants: 0x6b6660, shoes: 0x5a4a44, hat: 'none', hair: 0x6a735c };
  }
  if (type === 'brute') {
    return { ...base, scale: 1.34, skin: PAL.zombieSkinDark, shirt: PAL.zombieShirtWhite, pants: PAL.zombieOveralls, shoes: 0x5a4a44, hat: 'straw', hair: 0x5b6b52, overalls: PAL.zombieOveralls, belly: 1.3, bulk: 1.3 };
  }
  return { ...base, scale: 1, skin: PAL.zombieSkin, shirt: SHIRTS[variant % SHIRTS.length], pants: PAL.zombiePants, shoes: 0x5a4a44, hat: 'none', hair: 0x5b6b52 };
}

type ZState = 'idle' | 'wander' | 'chase' | 'windup' | 'lunge' | 'recover' | 'stagger' | 'down' | 'getup' | 'dead' | 'vault' | 'bash';

const _dir = { x: 0, z: 0 };

export class Zombie implements NoiseListener, GrassPusher {
  readonly model: CharacterModel;
  readonly def: ZDef;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly body: CharacterBody;
  readonly pushPos = new THREE.Vector3();
  readonly pushRadius: number;
  yaw = rng.angle();
  hp: number;
  state: ZState = 'wander';
  alerted = false;
  dead = false;
  removed = false;
  ragdoll: Ragdoll | null = null;
  private home: THREE.Vector3;
  private target = new THREE.Vector3();
  private stateT = 0;
  private phase = rng.angle();
  private groanT = rng.range(2, 6);
  private knockV = new THREE.Vector3();
  private staggerAmt = 0;
  private headSnap = new Spring(0, 160, 9);
  private squash = new Spring(0, 220, 11);
  private deadT = 0;
  private trailT = 0;
  private sinkT = 0;
  private settleT = 0;
  private headSpin: THREE.Quaternion | null = null;
  private headSpinV = new THREE.Vector3();
  private neckBleedT = 0;
  private lastImpactSfx = 0;
  private variant: number;
  /** Damage taken in the legs: enough of it makes them limp, then crawl. */
  private legDmg = 0;
  /** Limping on this leg (0 = left, 1 = right), or -1. */
  limpSide: -1 | Side = -1;
  /** Legs are gone for good: drags itself with its arms. */
  crawl = false;
  private armBleed: [number, number] = [0, 0];
  /** Seconds spent (as a body) in the pond. */
  private wetT = -1;
  // fences: climb over (vault) or smash through (bash)
  private fence: FenceSegment | null = null;
  private fenceCd = 0;
  private fenceDir = new THREE.Vector3();
  private vaultFrom = new THREE.Vector3();
  private vaultTo = new THREE.Vector3();
  private vaultT = 0;
  private vaultDur = 0.7;
  private vaultMid = false;
  onDeath: ((z: Zombie) => void) | null = null;
  /** Debug: stand still (used to stage screenshots). */
  frozen = false;

  constructor(
    private ctx: GameCtx,
    private nav: NavGrid,
    private player: Player,
    readonly type: ZombieType,
    x: number,
    z: number,
    variant = 0,
  ) {
    this.def = ZDEFS[type];
    this.variant = variant;
    this.hp = this.def.hp;
    this.model = new CharacterModel(styleFor(type, variant));
    ctx.root.add(this.model.root);
    ctx.root.add(this.model.shadow);
    this.model.ground = (gx, gz) => ctx.groundAt(gx, gz);
    this.pos.set(x, 0, z);
    this.home = this.pos.clone();
    this.target.copy(this.home);
    this.pushRadius = 0.8 * this.model.s;
    const s = this.model.s;
    this.body = {
      x,
      z,
      radius: this.def.radius,
      height: 1.3 * s,
      vx: 0,
      vz: 0,
      mass: 60 * this.def.mass,
      alive: true,
      headY: DIMS.headY * s,
      headR: DIMS.headR * s * 1.05,
      owner: this,
      team: 'zombie',
      onRagdollHit: (speed, dir, mass) => this.bumped(speed, dir, mass),
    };
    if (type === 'crawler') {
      this.crawl = true;
      this.body.height = 0.62 * s;
      this.body.headY = 0.36 * s;
    }
    ctx.physics.characters.push(this.body);
    ctx.physics.resolveCharacter(this.body, 1.3);
    this.pos.set(this.body.x, 0, this.body.z);
    ctx.addPusher(this);
    ctx.addNoiseListener(this);
    this.stateT = rng.range(0.5, 2);
    this.sync();
  }

  get alive(): boolean {
    return !this.dead;
  }

  hear(pos: THREE.Vector3, radius: number): void {
    if (this.dead) return;
    if (pos.distanceTo(this.pos) < radius) this.alert();
  }

  alert(): void {
    if (this.alerted || this.dead) return;
    this.alerted = true;
    if (this.state === 'idle' || this.state === 'wander') {
      this.state = 'chase';
      this.headSnap.kick(8);
      sfx.groan(this.pos, this.def.pitch, true);
    }
  }

  /** Hit by a ragdoll/prop flying into it: bowling! */
  private bumped(speed: number, dir: THREE.Vector3, mass: number): void {
    if (this.dead || this.state === 'down' || this.state === 'getup') return;
    const k = (speed * Math.min(mass, 20)) / (20 * this.def.mass);
    if (k > 3.2) {
      this.knockDown(dir.clone().multiplyScalar(speed * 0.55).setY(2.5), 0.35);
    } else {
      this.stagger(dir.clone().multiplyScalar(k * 1.2), 0.25);
    }
    this.alert();
  }

  // ------------------------------------------------------------------ damage

  /** Which part of the standing body a world-space point is on. */
  classify(p: THREE.Vector3, headshot: boolean): HitPart {
    if (headshot) return 'head';
    const s = this.model.s;
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    // model +X ("left" parts) in world space is (cos yaw, 0, -sin yaw)
    const lx = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    if (this.crawl) {
      const lz = dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw);
      return lz < -0.2 * s ? (lx > 0 ? 'legL' : 'legR') : 'torso';
    }
    const y = p.y - this.pos.y;
    if (y < (DIMS.hipY + 0.05) * s) return lx > 0 ? 'legL' : 'legR';
    if (y > (DIMS.shoulderY - 0.2) * s && y < (DIMS.shoulderY + 0.12) * s && Math.abs(lx) > DIMS.shoulderX * s * 0.6) return lx > 0 ? 'armL' : 'armR';
    return 'torso';
  }

  /**
   * @param impulse total bullet impulse (N·s) in world space
   * @param shotDist distance from the shooter (for point-blank bonuses)
   * @param parts damage per body part (localized reactions)
   */
  takeHit(
    damage: number,
    impulse: THREE.Vector3,
    point: THREE.Vector3,
    headshot: boolean,
    weapon: 'pistol' | 'shotgun' | 'blast',
    shotDist: number,
    parts: HitParts = {},
  ): boolean {
    if (this.dead) return false;
    this.hp -= damage;
    this.alert();
    this.model.flash(0.08);
    this.model.jiggle(headshot ? 6 : 3);
    this.headSnap.kick(headshot ? 14 : 6);
    this.squash.kick(3);
    const dir = impulse.clone().normalize();
    const blood = clamp(damage * 3, 3, 10);
    this.ctx.fx.bloodBurst(point, dir, blood, weapon === 'shotgun' ? 1.3 : 1);
    sfx.hitFlesh(point, weapon === 'shotgun');
    // shotgun at close range can take an arm clean off
    if (weapon === 'shotgun' && shotDist < 6) {
      for (const side of [0, 1] as Side[]) {
        const d = parts[side === 0 ? 'armL' : 'armR'] ?? 0;
        if (d >= 1.4 && rng.chance(this.hp <= 0 ? 0.85 : 0.7)) this.tearArm(side, dir);
      }
    }
    if (headshot && this.model.style.hat === 'straw' && rng.chance(this.hp <= 0 ? 0.9 : 0.5)) {
      this.model.popHat(new THREE.Vector3(dir.x * 3, 4.5, dir.z * 3));
    }
    if (this.hp <= 0) {
      this.die(impulse, point, headshot, weapon, shotDist);
      return true;
    }
    this.model.express('zombieHurt', 0.35);
    const kv = impulse.clone().multiplyScalar(this.def.knock / (6 * this.def.mass));
    // legs: limp, then crawl
    const legL = parts.legL ?? 0;
    const legR = parts.legR ?? 0;
    if (legL + legR > 0 && !this.crawl) {
      this.legDmg += legL + legR;
      const maxHp = this.def.hp;
      if (this.legDmg >= maxHp * 0.5 || (weapon === 'shotgun' && legL + legR >= maxHp * 0.35)) {
        this.becomeCrawler(kv);
        return false;
      }
      if (this.legDmg >= maxHp * 0.22 && this.limpSide < 0) {
        this.limpSide = legL >= legR ? 0 : 1;
        sfx.groan(this.pos, this.def.pitch * 0.9, true);
      }
    }
    if (weapon === 'shotgun' && shotDist < 5 && this.type !== 'brute') {
      this.knockDown(kv.multiplyScalar(2).setY(3), 0.4);
    } else {
      this.stagger(kv, weapon === 'shotgun' ? 0.45 : 0.22);
    }
    return false;
  }

  /** Legs shot out: fall on the face and keep coming on the elbows. */
  private becomeCrawler(kv: THREE.Vector3): void {
    this.crawl = true;
    this.limpSide = -1;
    const s = this.model.s;
    this.body.height = 0.62 * s;
    this.body.headY = 0.36 * s;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // legs go out from under it: the body pitches forward
    const v = kv.clone().setY(0).addScaledVector(fwd, 1.2).setY(1.2);
    this.enterRagdoll(v, 0.2);
    const rd = this.ragdoll!;
    for (const f of [J.footL, J.footR]) rd.addVelocity(f, -fwd.x * 3.5, 2.5, -fwd.z * 3.5);
    rd.addVelocity(J.head, fwd.x * 2, 0, fwd.z * 2);
    this.state = 'down';
    this.settleT = 0;
    this.stateT = 0;
    sfx.groan(this.pos, this.def.pitch * 0.85, true);
  }

  /** Tear an arm off (alive or as a ragdoll). */
  tearArm(side: Side, dir: THREE.Vector3): void {
    const vel = new THREE.Vector3(dir.x * rng.range(4, 6.5), rng.range(3, 5), dir.z * rng.range(4, 6.5));
    const at = this.model.tearArm(side, vel, 18);
    if (!at) return;
    if (this.ragdoll) {
      const idx = side === 0 ? J.handL : J.handR;
      this.ragdoll.detach(idx);
      this.ragdoll.r[idx] = 0.001;
      this.ragdoll.w[idx] = 1000;
    }
    this.armBleed[side] = 1.4;
    this.ctx.fx.bloodBurst(at, dir, 10, 1.3);
    this.ctx.fx.gibs(at, dir, 3);
    sfx.splat(at);
  }

  private stagger(v: THREE.Vector3, t: number): void {
    if (this.state === 'down' || this.state === 'getup' || this.state === 'vault') return;
    this.knockV.add(new THREE.Vector3(v.x, 0, v.z));
    this.staggerAmt = Math.min(1.5, this.staggerAmt + t * 2);
    if (this.state !== 'stagger') this.state = 'stagger';
    this.stateT = Math.max(this.stateT, t);
  }

  /** Explosion / big knock while still alive: ragdoll now, get up later. */
  knockDown(vel: THREE.Vector3, spin: number): void {
    if (this.dead || this.ragdoll) return;
    this.enterRagdoll(vel, spin);
    this.state = 'down';
    this.settleT = 0;
    this.stateT = 0;
  }

  private enterRagdoll(launch: THREE.Vector3, spin: number): void {
    const joints = this.model.jointPositions();
    const base = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const flat = new THREE.Vector3(launch.x, 0, launch.z);
    const fl = flat.length();
    const fdir = fl > 1e-3 ? flat.clone().divideScalar(fl) : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).negate();
    const side = new THREE.Vector3(-fdir.z, 0, fdir.x);
    const vel = joints.map(() => base.clone().add(launch));
    // body folds: head whips back, legs lag behind, arms flail
    vel[J.head].addScaledVector(fdir, fl * 0.25 + spin * 3).y += spin * 2;
    vel[J.shoulderL].addScaledVector(fdir, fl * 0.15);
    vel[J.shoulderR].addScaledVector(fdir, fl * 0.15);
    for (const f of [J.footL, J.footR]) {
      vel[f].addScaledVector(fdir, -fl * 0.45 - spin * 2.5);
      vel[f].y += spin * 2.5;
    }
    for (const h of [J.handL, J.handR]) vel[h].add(new THREE.Vector3(rng.spread(3), rng.range(1, 4), rng.spread(3)));
    // a bit of twist
    const tw = rng.spread(spin * 3);
    vel[J.shoulderL].addScaledVector(side, tw);
    vel[J.hipR].addScaledVector(side, -tw);
    const rd = this.model.createRagdoll(vel);
    rd.owner = this;
    this.ragdoll = rd;
    this.ctx.physics.addRagdoll(rd);
    this.body.alive = false;
    this.model.setXray(false);
  }

  /** A bullet hit the (dead or knocked down) body: shove it around, maybe pop the head. */
  shotCorpse(particle: number, dir: THREE.Vector3, force: number, point: THREE.Vector3, weapon: 'pistol' | 'shotgun', dist: number): void {
    const rd = this.ragdoll;
    if (!rd) return;
    const k = force * 3.2;
    rd.applyImpulse(particle, dir.x * k, Math.max(0.3, dir.y) * k + k * 0.35, dir.z * k);
    this.ctx.fx.bloodBurst(point, dir, 3, 0.7);
    sfx.hitFlesh(point);
    if (!this.dead) {
      this.hp -= force * 0.2;
      if (this.hp <= 0) {
        this.dead = true;
        this.state = 'dead';
        this.model.setFace('zombieDead');
        this.onDeath?.(this);
      }
    }
    if ((particle === J.handL || particle === J.handR || particle === J.shoulderL || particle === J.shoulderR) && weapon === 'shotgun' && dist < 5 && rng.chance(0.45)) {
      this.tearArm(particle === J.handL || particle === J.shoulderL ? 0 : 1, dir);
    }
    if (particle === J.head && !rd.headDetached && weapon === 'shotgun' && dist < 4 && rng.chance(0.5)) {
      rd.detach(J.head);
      rd.addVelocity(J.head, dir.x * 6, 5, dir.z * 6);
      this.headSpin = new THREE.Quaternion();
      this.headSpinV.set(rng.spread(18), rng.spread(18), rng.spread(18));
      this.neckBleedT = 1;
      this.ctx.fx.gibs(point, dir, 5);
    }
  }

  private die(impulse: THREE.Vector3, point: THREE.Vector3, headshot: boolean, weapon: 'pistol' | 'shotgun' | 'blast', shotDist: number): void {
    this.dead = true;
    this.state = 'dead';
    this.body.alive = false;
    this.model.setFace('zombieDead');
    const dir = impulse.clone().normalize();
    // exaggerated launch: shotgun point blank sends them flying
    const pointBlank = weapon === 'shotgun' ? clamp(1.45 - shotDist / 7, 0.45, 1.3) : 0.6;
    const speed = Math.min(9.5, (impulse.length() / (6 * this.def.mass)) * 1.45 * this.def.launch * (weapon === 'shotgun' ? pointBlank : 1));
    const launch = dir.clone().setY(0).normalize().multiplyScalar(speed);
    // flat and fast: bodies slam into fences instead of sailing over them
    launch.y = weapon === 'pistol' ? 1.2 : 2.2 + speed * 0.2;
    if (this.ragdoll) {
      // already down: just kick it
      for (let i = 0; i < this.ragdoll.n; i++) this.ragdoll.addVelocity(i, launch.x * 0.6, launch.y * 0.6, launch.z * 0.6);
    } else this.enterRagdoll(launch, weapon === 'shotgun' ? 1 : 0.4);
    const rd = this.ragdoll!;
    // pop the head on a close shotgun headshot or a direct blast
    if ((headshot && weapon === 'shotgun' && shotDist < 4.5) || (weapon === 'blast' && rng.chance(0.35))) {
      rd.detach(J.head);
      rd.addVelocity(J.head, launch.x * 0.8 + rng.spread(2), 6 + rng.next() * 3, launch.z * 0.8 + rng.spread(2));
      this.headSpin = new THREE.Quaternion();
      this.headSpinV.set(rng.spread(18), rng.spread(18), rng.spread(18));
      this.neckBleedT = 1.2;
      this.ctx.fx.gibs(point, dir, 6);
    }
    if (weapon === 'shotgun' && shotDist < 6) this.ctx.fx.gibs(point, dir, 5);
    if (weapon === 'blast') this.ctx.fx.gibs(point, dir, 7);
    if (rng.chance(this.model.style.hat === 'straw' ? 0.85 : 0.6)) this.model.popHat(new THREE.Vector3(launch.x * 0.6 + rng.spread(1.5), 4 + rng.next() * 2.5, launch.z * 0.6 + rng.spread(1.5)));
    this.ctx.fx.bloodBurst(point, dir, 14, 1.5);
    sfx.groan(this.pos, this.def.pitch * 1.25, true);
    sfx.splat(point);
    this.onDeath?.(this);
  }

  /** Booted by the player. Returns true if the kick killed it. */
  kicked(dir: THREE.Vector3, point: THREE.Vector3): boolean {
    if (this.dead) return false;
    const brute = this.type === 'brute';
    this.hp -= 0.6;
    this.alert();
    this.model.flash(0.08);
    this.model.jiggle(6);
    this.headSnap.kick(10);
    this.ctx.fx.bloodBurst(point, dir, 3, 0.8);
    const k = this.def.knock * (brute ? 0.55 : 1);
    const v = dir.clone().multiplyScalar(8.5 * k).setY(2.6 + 1.2 * k);
    if (this.hp <= 0) {
      this.dead = true;
      this.state = 'dead';
      this.body.alive = false;
      this.model.setFace('zombieDead');
      if (this.ragdoll) for (let i = 0; i < this.ragdoll.n; i++) this.ragdoll.addVelocity(i, v.x, v.y, v.z);
      else this.enterRagdoll(v, 0.9);
      this.model.popHat(new THREE.Vector3(v.x * 0.5, 4, v.z * 0.5));
      sfx.groan(this.pos, this.def.pitch * 1.25, true);
      this.ctx.feat('CHUTE!', point);
      this.onDeath?.(this);
      return true;
    }
    if (this.ragdoll) return false;
    this.model.express('zombieHurt', 0.5);
    if (brute && this.hp > this.def.hp * 0.4) {
      // big boys just stumble back
      this.stagger(dir.clone().multiplyScalar(4), 0.6);
      return false;
    }
    this.knockDown(v, 0.9);
    return false;
  }

  /** Radial blast from an explosion. Returns true if it killed this zombie. */
  blast(center: THREE.Vector3, strength: number): boolean {
    const d = this.pos.clone().sub(center);
    d.y = 0;
    const dist = d.length();
    const dir = dist > 0.01 ? d.divideScalar(dist) : new THREE.Vector3(1, 0, 0);
    const dmg = 16 * strength * strength;
    if (this.dead) return false;
    if (this.hp - dmg <= 0) {
      this.hp = 0;
      this.dead = true;
      // custom launch: straight up and away, lots of spin
      this.state = 'dead';
      this.body.alive = false;
      this.model.setFace('zombieDead');
      const k = 0.55 + strength * 0.45;
      const launch = dir.clone().multiplyScalar(rng.range(3.2, 5.5) * k * this.def.launch).setY(rng.range(7.5, 9.5) * k);
      if (!this.ragdoll) this.enterRagdoll(launch, 1.4);
      this.model.popHat(new THREE.Vector3(launch.x * 0.8 + rng.spread(2), launch.y * 0.9, launch.z * 0.8 + rng.spread(2)), 20);
      if (rng.chance(0.35 * strength)) this.tearArm(rng.chance(0.5) ? 0 : 1, dir.clone().setY(0.6).normalize());
      if (rng.chance(0.3)) {
        this.ragdoll!.detach(J.head);
        this.ragdoll!.addVelocity(J.head, rng.spread(4), 9, rng.spread(4));
        this.headSpin = new THREE.Quaternion();
        this.headSpinV.set(rng.spread(20), rng.spread(20), rng.spread(20));
        this.neckBleedT = 1.2;
      }
      this.ctx.fx.bloodBurst(this.pos.clone().setY(0.8), dir, 12, 1.3);
      this.ctx.fx.gibs(this.pos.clone().setY(0.8), dir, 4);
      sfx.groan(this.pos, this.def.pitch * 1.3, true);
      this.onDeath?.(this);
      return true;
    }
    this.hp -= dmg;
    this.model.flash(0.1);
    this.model.popHat(dir.clone().multiplyScalar(4).setY(6), 20);
    this.knockDown(dir.clone().multiplyScalar(8 * strength * this.def.knock).setY(6 * strength), 1);
    return false;
  }

  // ------------------------------------------------------------------ update

  update(dt: number, t: number): void {
    this.headSnap.update(dt);
    this.squash.update(dt);
    if (this.ragdoll) {
      this.updateRagdoll(dt);
      if (this.removed) return;
    } else {
      if (!this.frozen) {
        this.think(dt, t);
        this.move(dt);
      } else {
        this.vel.set(0, 0, 0);
      }
      this.animate(dt, t);
      this.sync();
    }
    this.model.update(dt);
    this.bleedStumps(dt);
  }

  private bleedStumps(dt: number): void {
    for (const side of [0, 1] as Side[]) {
      if (this.armBleed[side] <= 0) continue;
      this.armBleed[side] -= dt;
      if (Math.random() > 0.55) continue;
      const at = this.model.shoulderWorld(side);
      const out = at.clone().sub(this.model.torso.getWorldPosition(new THREE.Vector3())).normalize();
      const v = out.multiplyScalar(2.2).add(new THREE.Vector3(rng.spread(0.8), 1.6, rng.spread(0.8)));
      this.ctx.fx.particles.drops.spawn(at, v, rng.range(0.03, 0.055), PAL.blood, 0, 1.2);
    }
  }

  private think(dt: number, _t: number): void {
    const p = this.player;
    const dx = p.pos.x - this.pos.x;
    const dz = p.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.stateT -= dt;
    if (!this.alerted && p.alive && dist < 10.5) this.alert();
    if (this.alerted && p.alive) {
      this.groanT -= dt;
      if (this.groanT <= 0) {
        this.groanT = rng.range(3, 7);
        sfx.groan(this.pos, this.def.pitch);
      }
    }
    switch (this.state) {
      case 'idle':
      case 'wander': {
        if (this.stateT <= 0) {
          if (this.state === 'idle') {
            this.state = 'wander';
            const a = rng.angle();
            const r = rng.range(1, 4);
            this.target.set(this.home.x + Math.cos(a) * r, 0, this.home.z + Math.sin(a) * r);
            this.stateT = rng.range(3, 6);
          } else {
            this.state = 'idle';
            this.stateT = rng.range(1.5, 4);
          }
        }
        break;
      }
      case 'chase':
        if (!p.alive) {
          this.state = 'wander';
          this.alerted = false;
          this.home.copy(this.pos);
          break;
        }
        if (dist < this.def.reach * (this.crawl ? 0.85 : 1)) {
          this.state = 'windup';
          this.stateT = this.def.windup;
          this.squash.kick(-2);
          this.model.express('zombieAttack', this.def.windup + 0.35);
          sfx.groan(this.pos, this.def.pitch * 1.1, true);
        }
        break;
      case 'windup':
        if (this.stateT <= 0) {
          this.state = 'lunge';
          this.stateT = 0.2;
          const l = dist || 1;
          const sp = this.speed * (this.crawl ? 2.2 : 2.6);
          this.vel.x = (dx / l) * sp + this.vel.x * 0.2;
          this.vel.z = (dz / l) * sp + this.vel.z * 0.2;
          if (this.type === 'runner') {
            this.vel.x *= 1.3;
            this.vel.z *= 1.3;
          }
        }
        break;
      case 'lunge':
        if (p.alive && dist < this.def.reach + 0.25 && this.stateT > 0.02) {
          const dir = new THREE.Vector3(dx, 0, dz).normalize();
          p.damage(this.def.damage, dir, this.type === 'brute' ? 9 : 6);
          this.stateT = 0;
        }
        if (this.stateT <= 0) {
          this.state = 'recover';
          this.stateT = this.type === 'runner' ? 0.45 : 0.7;
        }
        break;
      case 'recover':
        if (this.stateT <= 0) this.state = this.alerted ? 'chase' : 'wander';
        break;
      case 'stagger':
        if (this.stateT <= 0) this.state = this.alerted ? 'chase' : 'wander';
        break;
      case 'bash': {
        const f = this.fence;
        if (!f || f.broken) {
          this.state = 'chase';
          this.fence = null;
          break;
        }
        if (this.stateT <= 0) {
          const brute = this.type === 'brute';
          if (f.bash(this.fenceDir, brute ? 1.3 : 0.55)) {
            this.state = 'chase';
            this.fence = null;
            this.fenceCd = 0.3;
            sfx.groan(this.pos, this.def.pitch * 1.1, true);
          } else {
            this.stateT = brute ? 0.85 : 1.1;
          }
          this.squash.kick(2.5);
          if (brute) this.ctx.shake(0.06);
        }
        break;
      }
      case 'getup':
        if (this.stateT <= 0) {
          this.model.endBlend();
          this.state = 'chase';
          this.alerted = true;
        }
        break;
      default:
        break;
    }
  }

  private move(dt: number): void {
    this.fenceCd = Math.max(0, this.fenceCd - dt);
    if (this.state === 'vault') {
      this.updateVault(dt);
      return;
    }
    let tx = 0;
    let tz = 0;
    let speed = 0;
    const p = this.player;
    if (this.state === 'chase') {
      speed = this.speed;
      const clear = this.ctx.physics.segmentClear(this.pos.x, this.pos.z, p.pos.x, p.pos.z, 0.6, this.def.radius * 0.9);
      if (clear) {
        tx = p.pos.x - this.pos.x;
        tz = p.pos.z - this.pos.z;
      } else if (this.nav.direction(this.pos.x, this.pos.z, _dir)) {
        tx = _dir.x;
        tz = _dir.z;
      } else {
        tx = p.pos.x - this.pos.x;
        tz = p.pos.z - this.pos.z;
      }
    } else if (this.state === 'wander') {
      speed = this.speed * 0.35;
      tx = this.target.x - this.pos.x;
      tz = this.target.z - this.pos.z;
      if (Math.hypot(tx, tz) < 0.3) speed = 0;
    }
    const tl = Math.hypot(tx, tz);
    let wantX = 0;
    let wantZ = 0;
    if (tl > 1e-3 && speed > 0) {
      wantX = (tx / tl) * speed;
      wantZ = (tz / tl) * speed;
    }
    // walking into a fence: climb it or smash it
    if (this.state === 'chase' && tl > 1e-3 && this.fenceCd <= 0) {
      const dx = tx / tl;
      const dz = tz / tl;
      const pr = this.def.radius + 0.12;
      const c = this.ctx.physics.climbableAt(this.pos.x + dx * pr, this.pos.z + dz * pr);
      if (c && c.owner instanceof FenceSegment) {
        const n = c.owner.normal;
        const d = (this.pos.x - c.x) * n.x + (this.pos.z - c.z) * n.z;
        const side = d >= 0 ? 1 : -1;
        if (-(dx * n.x + dz * n.z) * side > 0.3) {
          this.startFence(c.owner, n, d);
          if ((this.state as ZState) === 'vault') return;
        }
      }
    }
    if (this.state === 'lunge' || this.state === 'recover' || this.state === 'windup' || this.state === 'bash') {
      // keep momentum, bleed it off
      const k = 1 / (1 + dt * (this.state === 'lunge' ? 2 : 7));
      this.vel.x *= k;
      this.vel.z *= k;
    } else if (this.state !== 'stagger') {
      const a = this.def.accel * dt;
      const dvx = wantX - this.vel.x;
      const dvz = wantZ - this.vel.z;
      const dl = Math.hypot(dvx, dvz);
      if (dl <= a) {
        this.vel.x = wantX;
        this.vel.z = wantZ;
      } else {
        this.vel.x += (dvx / dl) * a;
        this.vel.z += (dvz / dl) * a;
      }
    } else {
      this.vel.multiplyScalar(1 / (1 + dt * 6));
    }
    // knockback impulse decays separately so hits read clearly
    this.pos.x += (this.vel.x + this.knockV.x) * dt;
    this.pos.z += (this.vel.z + this.knockV.z) * dt;
    this.knockV.multiplyScalar(1 / (1 + dt * 7));
    this.staggerAmt = Math.max(0, this.staggerAmt - dt * 2.5);
    this.body.x = this.pos.x;
    this.body.z = this.pos.z;
    this.ctx.physics.resolveCharacter(this.body, 1.3);
    pondPush(this.body, this.body.radius);
    const b = LAYOUT.bounds;
    this.body.x = clamp(this.body.x, b.minX, b.maxX);
    this.body.z = clamp(this.body.z, b.minZ, b.maxZ);
    this.pos.x = this.body.x;
    this.pos.z = this.body.z;
    this.body.vx = this.vel.x;
    this.body.vz = this.vel.z;
    // face movement or the player when attacking
    let face = this.yaw;
    if (this.state === 'windup' || this.state === 'lunge' || this.state === 'chase') face = Math.atan2(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
    else if (Math.hypot(this.vel.x, this.vel.z) > 0.2) face = Math.atan2(this.vel.x, this.vel.z);
    if (this.state !== 'stagger') this.yaw = dampAngle(this.yaw, face, this.type === 'runner' ? 10 : 5, dt);
    this.pos.y = this.ctx.physics.heightAt(this.pos.x, this.pos.z);
    this.pushPos.copy(this.pos);
  }

  private startFence(seg: FenceSegment, n: THREE.Vector3, d: number): void {
    const side = d >= 0 ? 1 : -1;
    this.fence = seg;
    this.fenceDir.copy(n).multiplyScalar(-side);
    this.yaw = Math.atan2(this.fenceDir.x, this.fenceDir.z);
    if (this.type === 'brute' || this.crawl) {
      // too heavy / no legs: smash through
      this.state = 'bash';
      this.stateT = this.type === 'brute' ? 0.55 : 0.8;
      this.model.express('zombieAttack', 1.4);
      this.squash.kick(-1.5);
      return;
    }
    this.state = 'vault';
    this.vaultT = 0;
    this.vaultDur = this.type === 'runner' ? 0.5 : 0.78;
    this.vaultMid = false;
    this.vaultFrom.copy(this.pos);
    this.vaultTo.copy(this.pos).addScaledVector(this.fenceDir, Math.abs(d) + this.def.radius + 0.35);
    this.vel.set(0, 0, 0);
    this.knockV.set(0, 0, 0);
    this.squash.kick(-2);
    seg.shake(side * 3);
  }

  /** Clumsy hop over a fence: a little arc, sometimes the fence gives way under it. */
  private updateVault(dt: number): void {
    this.vaultT += dt;
    const k = Math.min(1, this.vaultT / this.vaultDur);
    const e = k * k * (3 - 2 * k);
    this.pos.x = lerp(this.vaultFrom.x, this.vaultTo.x, e);
    this.pos.z = lerp(this.vaultFrom.z, this.vaultTo.z, e);
    const ground = this.ctx.physics.heightAt(this.pos.x, this.pos.z);
    this.pos.y = ground + 4 * 0.95 * this.model.s * k * (1 - k);
    this.body.x = this.pos.x;
    this.body.z = this.pos.z;
    this.pushPos.copy(this.pos);
    if (!this.vaultMid && k > 0.45) {
      this.vaultMid = true;
      const f = this.fence;
      if (f) {
        f.shake(4);
        sfx.woodHit(this.pos.clone().setY(0.9));
        if (rng.chance(0.2)) {
          // crash through it
          f.break(this.fenceDir.clone(), 3.5);
          this.fence = null;
          this.pos.y = ground;
          this.knockDown(this.fenceDir.clone().multiplyScalar(3.2).setY(1.6), 0.6);
          return;
        }
      }
    }
    if (k >= 1) {
      this.pos.y = ground;
      this.state = 'chase';
      this.fence = null;
      this.fenceCd = 0.8;
      this.squash.kick(3);
      this.ctx.fx.dust(this.pos.clone().setY(0.05), 3, 0.5);
      sfx.thud(this.pos, 0.4);
    }
  }

  /** Spawned bursting out of somewhere (the barn): shoved forward, already hunting. */
  burstOut(v: THREE.Vector3): void {
    this.alert();
    this.state = 'chase';
    this.knockV.set(v.x, 0, v.z);
    this.yaw = Math.atan2(v.x, v.z);
    this.headSnap.kick(8);
  }

  /** Current top speed (legs shot → slower). */
  get speed(): number {
    if (this.crawl) return Math.max(0.55, this.def.speed * 0.42);
    return this.def.speed * (this.limpSide >= 0 ? 0.62 : 1);
  }

  /** Separate from another zombie / the player. */
  separate(ox: number, oz: number, r: number, push = 0.5): void {
    if (this.ragdoll) return;
    const dx = this.pos.x - ox;
    const dz = this.pos.z - oz;
    const d = Math.hypot(dx, dz);
    const rr = this.def.radius + r;
    if (d >= rr || d < 1e-4) return;
    const k = (rr - d) * push;
    this.pos.x += (dx / d) * k;
    this.pos.z += (dz / d) * k;
    this.body.x = this.pos.x;
    this.body.z = this.pos.z;
  }

  private animate(dt: number, t: number): void {
    const m = this.model;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    const sf = clamp(sp / Math.max(0.5, this.speed), 0, 1.5);
    const run = this.type === 'runner';
    const brute = this.type === 'brute';
    const limping = this.limpSide >= 0;
    const rate = this.crawl ? 5.5 : brute ? 3.2 : run ? 11 : limping ? 3.8 : 4.6;
    this.phase += dt * rate * Math.max(sf, this.state === 'idle' ? 0 : 0.15);
    if (this.crawl) {
      this.animateCrawl(t, sf);
    } else {
      const ph = this.phase;
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      const tilt = this.variant % 2 ? 1 : -1;
      let lean = run ? 0.32 * sf : 0.16 + 0.05 * sf;
      let roll = Math.sin(ph) * (brute ? 0.07 : 0.09) * sf;
      let armX = -1.35 + Math.sin(ph * 0.5 + 0.3) * 0.12;
      let armLX = armX + Math.sin(t * 2.1 + this.variant) * 0.12;
      let armRX = armX + Math.sin(t * 1.7 + 1 + this.variant) * 0.12;
      let armZ = 0.12;
      // elbows: shamblers reach almost straight, runners pump, brutes swing heavy
      let elL = -0.12 + Math.sin(t * 1.9 + this.variant) * 0.1;
      let elR = -0.12 + Math.sin(t * 2.3 + this.variant * 2) * 0.1;
      if (run) {
        armLX = -0.7 + s * 1.1;
        armRX = -0.7 - s * 1.1;
        armZ = 0.25;
        elL = -1.25 + s * 0.25;
        elR = -1.25 - s * 0.25;
      }
      if (brute) {
        armLX = -0.35 + s * 0.35;
        armRX = -0.35 - s * 0.35;
        armZ = 0.2;
        elL = -0.3 - Math.max(0, s) * 0.4;
        elR = -0.3 - Math.max(0, -s) * 0.4;
      }
      let squashY = 0;
      if (this.state === 'windup') {
        const k = 1 - Math.max(0, this.stateT) / this.def.windup;
        armLX = armRX = -2.5 * k + armLX * (1 - k);
        elL = elR = -1.2 * k + elL * (1 - k);
        lean = -0.18 * k;
        squashY = -0.06 * k;
      } else if (this.state === 'lunge') {
        armLX = armRX = -1.1;
        elL = elR = 0;
        lean = 0.45;
      } else if (this.state === 'recover') {
        armLX = armRX = -0.9;
        elL = elR = -0.35;
        lean = 0.25;
      } else if (this.state === 'bash') {
        // raise both fists, slam them down on the fence
        const period = brute ? 0.85 : 1.1;
        const k = 1 - Math.max(0, this.stateT) / period;
        const up = k < 0.7 ? k / 0.7 : 1 - (k - 0.7) / 0.3;
        armLX = armRX = -0.9 - 1.8 * up;
        elL = elR = -1.1 * up;
        lean = 0.35 - 0.45 * up;
        squashY = -0.04 * up;
      } else if (this.state === 'vault') {
        armLX = -1.9;
        armRX = -1.5;
        elL = elR = -0.2;
        lean = 0.55;
      }
      if (this.staggerAmt > 0) {
        const k = Math.min(1, this.staggerAmt);
        lean = lean * (1 - k) - 0.35 * k;
        armLX = armLX * (1 - k) + (-2.2 + Math.sin(t * 30) * 0.3) * k;
        armRX = armRX * (1 - k) + (-2.0 + Math.cos(t * 27) * 0.3) * k;
        elL = elL * (1 - k) + (-0.7 + Math.sin(t * 23) * 0.5) * k;
        elR = elR * (1 - k) + (-0.6 + Math.cos(t * 25) * 0.5) * k;
        roll += Math.sin(t * 20) * 0.08 * k;
      }
      const legA = (brute ? 0.5 : run ? 0.95 : 0.6) * Math.min(1, sf + 0.1);
      // the bad leg swings less and never bends; the body dips when it takes the weight
      const stiffL = this.limpSide === 0 ? 0.45 : tilt > 0 ? 1 : 0.6;
      const stiffR = this.limpSide === 1 ? 0.45 : tilt > 0 ? 0.6 : 1;
      m.legL.rotation.set(s * legA * stiffL, 0, 0.04);
      m.legR.rotation.set(-s * legA * stiffR, 0, -0.04);
      const knee = (run ? 1.3 : brute ? 0.6 : 0.8) * Math.min(1, sf + 0.1);
      m.shinL.rotation.set(this.limpSide === 0 ? 0.02 : 0.1 + Math.max(0, -c) * knee, 0, 0);
      m.shinR.rotation.set(this.limpSide === 1 ? 0.02 : 0.1 + Math.max(0, c) * knee, 0, 0);
      if (this.state === 'vault') {
        // knees tucked over the pickets
        m.legL.rotation.set(-1.25, 0, 0.12);
        m.legR.rotation.set(-0.8, 0, -0.12);
        m.shinL.rotation.set(1.7, 0, 0);
        m.shinR.rotation.set(1.3, 0, 0);
      }
      m.armL.rotation.set(armLX, 0, -armZ);
      m.armR.rotation.set(armRX, 0, armZ);
      m.foreL.rotation.set(elL, 0, 0);
      m.foreR.rotation.set(elR, 0, 0);
      let bob = Math.abs(Math.cos(ph)) * (brute ? 0.07 : 0.05) * Math.min(1, sf + 0.2);
      if (limping) {
        // weight on the bad leg (its half of the cycle): drop and lurch toward it
        const bad = this.limpSide === 0 ? Math.max(0, -s) : Math.max(0, s);
        bob -= bad * 0.07 * Math.min(1, sf + 0.3);
        roll += (this.limpSide === 0 ? -1 : 1) * (0.06 + bad * 0.16);
        lean += 0.08;
      }
      m.body.position.set(0, bob, 0);
      m.body.rotation.set(lean, 0, roll);
      const sq = this.squash.value * 0.05 + squashY;
      m.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
      m.head.rotation.set(-this.headSnap.value * 0.05 + Math.sin(t * 1.3 + this.variant) * 0.06, Math.sin(t * 0.7 + this.variant) * 0.25, 0.22 * tilt + Math.sin(ph) * 0.05);
      m.torso.rotation.set(0, 0, 0);
    }
    if (this.state === 'getup') {
      this.model.applyBlend(1 - this.stateT / 0.7);
    }
  }

  /** Face down, pulling itself along with alternating arms, legs dragging behind. */
  private animateCrawl(t: number, sf: number): void {
    const m = this.model;
    const s = m.s;
    const ph = this.phase;
    let theta = 1.32;
    let reachL = -1.84 - 0.5 * Math.cos(ph);
    let reachR = -1.84 + 0.5 * Math.cos(ph);
    // lift the hand while it travels forward again
    let elL = -0.25 - 0.8 * Math.max(0, Math.sin(ph));
    let elR = -0.25 - 0.8 * Math.max(0, -Math.sin(ph));
    let headX = -1.15 + Math.sin(t * 1.4 + this.variant) * 0.08;
    if (this.state === 'windup' || this.state === 'bash') {
      const period = this.state === 'bash' ? 1.1 : this.def.windup;
      const k = 1 - Math.max(0, this.stateT) / period;
      theta = 1.32 - 0.5 * k;
      reachL = reachR = reachL * (1 - k) - 2.9 * k;
      elL = elR = elL * (1 - k) - 0.9 * k;
      headX = -1.15 + 0.35 * k;
    } else if (this.state === 'lunge') {
      theta = 1.2;
      reachL = reachR = -2.5;
      elL = elR = 0;
    } else if (this.staggerAmt > 0) {
      const k = Math.min(1, this.staggerAmt);
      reachL += Math.sin(t * 30) * 0.4 * k;
      reachR += Math.cos(t * 27) * 0.4 * k;
      theta += 0.1 * k;
    }
    const roll = Math.sin(ph) * 0.12 * Math.min(1, sf + 0.2);
    const ty = DIMS.torsoY * s;
    // keep the chest above the root (so hits and shadows line up) and just off the ground
    m.body.rotation.set(theta, 0, roll);
    m.body.position.set(0, 0.2 * s - ty * Math.cos(theta), -ty * Math.sin(theta));
    const sq = this.squash.value * 0.04;
    m.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    m.armL.rotation.set(reachL, 0, -0.18);
    m.armR.rotation.set(reachR, 0, 0.18);
    m.foreL.rotation.set(elL, 0, 0);
    m.foreR.rotation.set(elR, 0, 0);
    // legs drag, a little twitch in the knees
    m.legL.rotation.set(0.08 + Math.sin(ph + 1) * 0.06, 0, 0.14);
    m.legR.rotation.set(0.08 - Math.sin(ph + 1) * 0.06, 0, -0.14);
    m.shinL.rotation.set(0.25 + Math.max(0, Math.sin(ph * 0.5 + t)) * 0.3, 0, 0);
    m.shinR.rotation.set(0.25 + Math.max(0, Math.cos(ph * 0.5 + t)) * 0.3, 0, 0);
    m.head.rotation.set(headX - this.headSnap.value * 0.04, Math.sin(t * 0.8 + this.variant) * 0.2, Math.sin(ph) * 0.08);
    m.torso.rotation.set(0, Math.sin(ph) * 0.12, 0);
  }

  private sync(): void {
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.shadow.position.set(this.pos.x, this.pos.y + 0.02, this.pos.z);
  }

  private updateRagdoll(dt: number): void {
    const rd = this.ragdoll!;
    const m = this.model;
    // detached head spins freely
    if (this.headSpin) {
      const w = this.headSpinV.length();
      if (w > 1e-3) this.headSpin.premultiply(new THREE.Quaternion().setFromAxisAngle(this.headSpinV.clone().divideScalar(w), w * dt));
      if (rd.contact[J.head]) {
        // roll on the ground
        const v = rd.velocity(J.head, new THREE.Vector3());
        this.headSpinV.set(v.z, 0, -v.x).multiplyScalar(1 / (DIMS.headR * m.s));
      }
      this.headSpinV.multiplyScalar(1 / (1 + dt * 0.8));
    }
    if (this.dead) {
      this.deadT += dt;
      if (this.deadT > 28) {
        // sink into the ground and vanish so the farm cleans itself up
        if (this.sinkT === 0) this.ctx.physics.removeRagdoll(rd);
        this.sinkT += dt;
        for (let i = 0; i < rd.n; i++) rd.p[i * 3 + 1] -= dt * 0.32;
        m.shadow.visible = false;
        if (this.sinkT > 2.6) {
          this.remove();
          return;
        }
      }
    }
    if (this.state !== 'getup') {
      m.root.position.set(0, 0, 0);
      m.root.quaternion.identity();
      m.body.position.set(0, 0, 0);
      m.body.quaternion.identity();
      m.body.scale.set(1, 1, 1);
      m.applyRagdoll(rd, this.headSpin ?? undefined);
    }
    rd.center(this.pos);
    this.body.x = this.pos.x;
    this.body.z = this.pos.z;
    this.pushPos.copy(this.pos);
    if (this.updateWater(dt, rd)) return;

    // neck fountain
    if (this.neckBleedT > 0) {
      this.neckBleedT -= dt;
      if (Math.random() < 0.6) {
        const neck = new THREE.Vector3().addVectors(rd.get(J.shoulderL, new THREE.Vector3()), rd.get(J.shoulderR, new THREE.Vector3())).multiplyScalar(0.5);
        const up = neck.clone().sub(this.pos).normalize();
        this.ctx.fx.particles.drops.spawn(neck, up.multiplyScalar(3).add(new THREE.Vector3(rng.spread(1), 1.5, rng.spread(1))), rng.range(0.03, 0.06), PAL.blood, 0, 1.2);
      }
    }

    // impacts → dust, thuds, splats, breaking stuff
    for (const im of rd.impacts) {
      if (im.speed < 3.5) continue;
      const p = new THREE.Vector3(im.x, im.y, im.z);
      const n = new THREE.Vector3(im.nx, im.ny, im.nz);
      if (im.kind === 'ground' && inPond(im.x, im.z)) continue;
      if (im.kind === 'ground') {
        if (im.speed > 5) this.ctx.fx.dust(p, Math.min(6, Math.round(im.speed * 0.5)), 1, PAL.dust, 0.4);
        if (im.index !== J.handL && im.index !== J.handR && im.speed > 4.5) this.ctx.fx.decals.blood(p.setY(0), n, 0.35 + Math.min(0.5, im.speed * 0.04));
      } else if (im.kind === 'static') {
        this.ctx.fx.decals.blood(p, n, 0.4 + Math.min(0.4, im.speed * 0.03), { streakDir: new THREE.Vector3(0, -1, 0) });
        this.ctx.fx.dust(p, 3, 0.8, 0xe9dcc6, 0.35);
      }
      if (this.ctx.time - this.lastImpactSfx > 0.12) {
        this.lastImpactSfx = this.ctx.time;
        sfx.thud(p, im.speed / 7);
        if (im.speed > 11) this.ctx.shake(0.12);
      }
    }
    // blood trail while sliding
    const torsoContact = rd.contact[J.hipL] || rd.contact[J.hipR] || rd.contact[J.shoulderL];
    const v = rd.velocity(J.hipL, new THREE.Vector3());
    const hs = Math.hypot(v.x, v.z);
    if (this.dead && torsoContact && hs > 1.1) {
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.06;
        this.ctx.fx.decals.blood(this.pos.clone().setY(0), new THREE.Vector3(0, 1, 0), 0.32, { streakDir: v, dark: rng.chance(0.3), life: 30 });
      }
    }

    if (this.dead) return;

    // knocked down but alive: wait to settle, then get up
    if (this.state === 'down') {
      this.stateT += dt;
      const moving = !rd.sleeping && hs > 0.4;
      this.settleT = moving ? 0 : this.settleT + dt;
      if ((this.settleT > 0.5 && this.stateT > 0.9) || this.stateT > 3.5) {
        const shL = rd.get(J.shoulderL, new THREE.Vector3());
        const shR = rd.get(J.shoulderR, new THREE.Vector3());
        const hpL = rd.get(J.hipL, new THREE.Vector3());
        const hpR = rd.get(J.hipR, new THREE.Vector3());
        const up = new THREE.Vector3().addVectors(shL, shR).sub(hpL).sub(hpR);
        const yaw = Math.atan2(up.x, up.z);
        const standPos = new THREE.Vector3((hpL.x + hpR.x) / 2, 0, (hpL.z + hpR.z) / 2);
        this.ctx.physics.removeRagdoll(rd);
        this.ragdoll = null;
        this.headSpin = null;
        this.pos.copy(standPos);
        this.body.x = standPos.x;
        this.body.z = standPos.z;
        this.ctx.physics.resolveCharacter(this.body, 1.3);
        this.pos.x = this.body.x;
        this.pos.z = this.body.z;
        this.yaw = yaw;
        this.vel.set(0, 0, 0);
        this.knockV.set(0, 0, 0);
        this.model.beginBlendFromWorld(this.pos, this.yaw);
        this.state = 'getup';
        this.stateT = 0.7;
        this.body.alive = true;
        this.model.setXray(true);
        sfx.groan(this.pos, this.def.pitch, true);
      }
    }
  }

  /**
   * The pond: a splash on the way in, bodies float for a while and then sink, and a zombie that
   * lands in the water while knocked down drowns. Returns true if the zombie was removed.
   */
  private updateWater(dt: number, rd: Ragdoll): boolean {
    const wet = rd.submerged >= 3 && inPond(this.pos.x, this.pos.z, -0.2);
    if (!wet) {
      if (this.wetT >= 0 && !inPond(this.pos.x, this.pos.z)) this.wetT = -1;
      return false;
    }
    if (this.wetT < 0) {
      this.wetT = 0;
      const v = rd.velocity(J.hipL, new THREE.Vector3());
      this.ctx.fx.splash(this.pos.clone().setY(0.06), Math.min(2.2, 0.8 + v.length() * 0.18));
      this.ctx.shake(0.15);
      if (!this.dead) {
        // no getting up from this one
        this.dead = true;
        this.state = 'dead';
        this.hp = 0;
        this.model.setFace('zombieDead');
        sfx.groan(this.pos, this.def.pitch * 1.4, true);
        this.ctx.feat('AFOGADO!', this.pos.clone().setY(0.6));
        this.onDeath?.(this);
      }
    }
    this.wetT += dt;
    // bubbles and a few thrashing ripples, then it goes under
    if (Math.random() < dt * (this.wetT < 1.5 ? 14 : 4)) {
      const b = this.pos.clone().add(new THREE.Vector3(rng.spread(0.5), 0, rng.spread(0.5))).setY(0.07);
      this.ctx.fx.particles.drops.spawn(b, new THREE.Vector3(rng.spread(0.4), rng.range(0.6, 1.6), rng.spread(0.4)), rng.range(0.025, 0.045), 0xeaf8f8, 1, 0.35);
    }
    if (this.wetT < 1.2 && Math.random() < dt * 6) {
      for (const i of [J.handL, J.handR, J.footL]) rd.addVelocity(i, rng.spread(1.5), rng.range(0.5, 2), rng.spread(1.5));
    }
    rd.buoyancy = this.wetT < 4 ? 1 : Math.max(0, 1 - (this.wetT - 4) / 3);
    rd.wake();
    this.model.shadow.visible = false;
    if (this.wetT > 11) {
      this.remove();
      return true;
    }
    return false;
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.ragdoll) this.ctx.physics.removeRagdoll(this.ragdoll);
    this.model.dispose();
    const i = this.ctx.physics.characters.indexOf(this.body);
    if (i >= 0) this.ctx.physics.characters.splice(i, 1);
    this.ctx.removePusher(this);
  }
}
