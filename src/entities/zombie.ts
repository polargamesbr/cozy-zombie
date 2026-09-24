import * as THREE from 'three';
import { clamp, dampAngle, Spring } from '../core/math';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { CharacterModel, DIMS, type CharacterStyle } from './characterModel';
import { J, type Ragdoll } from '../physics/ragdoll';
import type { CharacterBody } from '../physics/world';
import type { GameCtx, GrassPusher, NoiseListener } from '../game/context';
import type { NavGrid } from '../world/navgrid';
import { LAYOUT } from '../world/layout';
import { pondPush } from '../world/pond';
import { sfx } from '../audio/sfx';
import type { Player } from './player';

export type ZombieType = 'shambler' | 'runner' | 'brute';

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
  if (type === 'brute') {
    return { ...base, scale: 1.34, skin: PAL.zombieSkinDark, shirt: PAL.zombieShirtWhite, pants: PAL.zombieOveralls, shoes: 0x5a4a44, hat: 'straw', hair: 0x5b6b52, overalls: PAL.zombieOveralls, belly: 1.3, bulk: 1.3 };
  }
  return { ...base, scale: 1, skin: PAL.zombieSkin, shirt: SHIRTS[variant % SHIRTS.length], pants: PAL.zombiePants, shoes: 0x5a4a44, hat: 'none', hair: 0x5b6b52 };
}

type ZState = 'idle' | 'wander' | 'chase' | 'windup' | 'lunge' | 'recover' | 'stagger' | 'down' | 'getup' | 'dead';

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

  /**
   * @param impulse total bullet impulse (N·s) in world space
   * @param shotDist distance from the shooter (for point-blank bonuses)
   */
  takeHit(damage: number, impulse: THREE.Vector3, point: THREE.Vector3, headshot: boolean, weapon: 'pistol' | 'shotgun' | 'blast', shotDist: number): boolean {
    if (this.dead) return false;
    this.hp -= damage;
    this.alert();
    this.model.flash(0.08);
    this.headSnap.kick(headshot ? 14 : 6);
    this.squash.kick(3);
    const dir = impulse.clone().normalize();
    const blood = clamp(damage * 3, 3, 10);
    this.ctx.fx.bloodBurst(point, dir, blood, weapon === 'shotgun' ? 1.3 : 1);
    sfx.hitFlesh(point, weapon === 'shotgun');
    if (this.hp <= 0) {
      this.die(impulse, point, headshot, weapon, shotDist);
      return true;
    }
    const kv = impulse.clone().multiplyScalar(this.def.knock / (6 * this.def.mass));
    if (weapon === 'shotgun' && shotDist < 5 && this.type !== 'brute') {
      this.knockDown(kv.multiplyScalar(2).setY(3), 0.4);
    } else {
      this.stagger(kv, weapon === 'shotgun' ? 0.45 : 0.22);
    }
    return false;
  }

  private stagger(v: THREE.Vector3, t: number): void {
    if (this.state === 'down' || this.state === 'getup') return;
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
    this.ctx.fx.bloodBurst(point, dir, 14, 1.5);
    sfx.groan(this.pos, this.def.pitch * 1.25, true);
    sfx.splat(point);
    this.onDeath?.(this);
  }

  /** Radial blast from an explosion. */
  blast(center: THREE.Vector3, strength: number): void {
    const d = this.pos.clone().sub(center);
    d.y = 0;
    const dist = d.length();
    const dir = dist > 0.01 ? d.divideScalar(dist) : new THREE.Vector3(1, 0, 0);
    const dmg = 16 * strength * strength;
    if (this.dead) return;
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
    } else {
      this.hp -= dmg;
      this.model.flash(0.1);
      this.knockDown(dir.clone().multiplyScalar(8 * strength * this.def.knock).setY(6 * strength), 1);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number, t: number): void {
    this.model.updateFlash(dt);
    this.headSnap.update(dt);
    this.squash.update(dt);
    if (this.ragdoll) {
      this.updateRagdoll(dt);
      return;
    }
    if (!this.frozen) {
      this.think(dt, t);
      this.move(dt);
    } else {
      this.vel.set(0, 0, 0);
    }
    this.animate(dt, t);
    this.sync();
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
        if (dist < this.def.reach) {
          this.state = 'windup';
          this.stateT = this.def.windup;
          this.squash.kick(-2);
          sfx.groan(this.pos, this.def.pitch * 1.1, true);
        }
        break;
      case 'windup':
        if (this.stateT <= 0) {
          this.state = 'lunge';
          this.stateT = 0.2;
          const l = dist || 1;
          this.vel.x = (dx / l) * this.def.speed * 2.6 + this.vel.x * 0.2;
          this.vel.z = (dz / l) * this.def.speed * 2.6 + this.vel.z * 0.2;
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
      case 'getup':
        if (this.stateT <= 0) {
          this.state = 'chase';
          this.alerted = true;
        }
        break;
      default:
        break;
    }
  }

  private move(dt: number): void {
    let tx = 0;
    let tz = 0;
    let speed = 0;
    const p = this.player;
    if (this.state === 'chase') {
      speed = this.def.speed;
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
      speed = this.def.speed * 0.35;
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
    if (this.state === 'lunge' || this.state === 'recover' || this.state === 'windup') {
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
    const sf = clamp(sp / Math.max(1, this.def.speed), 0, 1.5);
    const run = this.type === 'runner';
    const brute = this.type === 'brute';
    this.phase += dt * (brute ? 3.2 : run ? 11 : 4.6) * Math.max(sf, this.state === 'idle' ? 0 : 0.15);
    const ph = this.phase;
    const s = Math.sin(ph);
    const limp = this.variant % 2 ? 1 : -1;
    let lean = run ? 0.32 * sf : 0.16 + 0.05 * sf;
    let roll = Math.sin(ph) * (brute ? 0.07 : 0.09) * sf;
    let armX = -1.35 + Math.sin(ph * 0.5 + 0.3) * 0.12;
    let armLX = armX + Math.sin(t * 2.1 + this.variant) * 0.12;
    let armRX = armX + Math.sin(t * 1.7 + 1 + this.variant) * 0.12;
    let armZ = 0.12;
    if (run) {
      armLX = -0.7 + s * 1.1;
      armRX = -0.7 - s * 1.1;
      armZ = 0.25;
    }
    if (brute) {
      armLX = -0.35 + s * 0.35;
      armRX = -0.35 - s * 0.35;
      armZ = 0.2;
    }
    let squashY = 0;
    if (this.state === 'windup') {
      const k = 1 - Math.max(0, this.stateT) / this.def.windup;
      armLX = armRX = -2.5 * k + armLX * (1 - k);
      lean = -0.18 * k;
      squashY = -0.06 * k;
    } else if (this.state === 'lunge') {
      armLX = armRX = -1.1;
      lean = 0.45;
    } else if (this.state === 'recover') {
      armLX = armRX = -0.9;
      lean = 0.25;
    }
    if (this.staggerAmt > 0) {
      const k = Math.min(1, this.staggerAmt);
      lean = lean * (1 - k) - 0.35 * k;
      armLX = armLX * (1 - k) + (-2.2 + Math.sin(t * 30) * 0.3) * k;
      armRX = armRX * (1 - k) + (-2.0 + Math.cos(t * 27) * 0.3) * k;
      roll += Math.sin(t * 20) * 0.08 * k;
    }
    const legA = (brute ? 0.5 : run ? 0.95 : 0.6) * Math.min(1, sf + 0.1);
    m.legL.rotation.set(s * legA * (limp > 0 ? 1 : 0.6), 0, 0.04);
    m.legR.rotation.set(-s * legA * (limp > 0 ? 0.6 : 1), 0, -0.04);
    m.armL.rotation.set(armLX, 0, -armZ);
    m.armR.rotation.set(armRX, 0, armZ);
    const bob = Math.abs(Math.cos(ph)) * (brute ? 0.07 : 0.05) * Math.min(1, sf + 0.2);
    m.body.position.set(0, bob, 0);
    m.body.rotation.set(lean, 0, roll);
    const sq = this.squash.value * 0.05 + squashY;
    m.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    m.head.rotation.set(-this.headSnap.value * 0.05 + Math.sin(t * 1.3 + this.variant) * 0.06, Math.sin(t * 0.7 + this.variant) * 0.25, 0.22 * limp + Math.sin(ph) * 0.05);
    if (this.state === 'getup') {
      this.model.applyBlend(1 - this.stateT / 0.7);
    }
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
