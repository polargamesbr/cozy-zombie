import * as THREE from 'three';
import { clamp, damp, dampAngle, Spring, wrapAngle } from '../core/math';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { CharacterModel, DIMS } from './characterModel';
import { buildGun, WEAPONS, type WeaponDef, type WeaponId } from './weapons';
import type { GameCtx, GrassPusher } from '../game/context';
import type { CharacterBody } from '../physics/world';
import type { Ragdoll } from '../physics/ragdoll';
import { J } from '../physics/ragdoll';
import { LAYOUT } from '../world/layout';
import { pondPush } from '../world/pond';
import { sfx } from '../audio/sfx';
import type { Combat } from './combat';

export interface PlayerInput {
  moveX: number;
  moveZ: number;
  aim: THREE.Vector3;
  fire: boolean;
  firePressed: boolean;
  reload: boolean;
  dodge: boolean;
  switchTo: WeaponId | null;
}

interface Ammo {
  mag: number;
  reserve: number;
}

export class Player implements GrassPusher {
  readonly model: CharacterModel;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly pushPos = new THREE.Vector3();
  readonly pushRadius = 0.9;
  readonly body: CharacterBody;
  yaw = 0;
  maxHp = 5;
  hp = 5;
  alive = true;
  weapon: WeaponDef = WEAPONS.shotgun;
  ammo: Record<WeaponId, Ammo> = {
    pistol: { mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.startReserve },
    shotgun: { mag: WEAPONS.shotgun.mag, reserve: WEAPONS.shotgun.startReserve },
  };
  cooldown = 0;
  reloading = false;
  reloadT = 0;
  private swapT = 0;
  private pendingWeapon: WeaponId | null = null;
  private guns: Record<WeaponId, THREE.Group>;
  private gunKick = new Spring(0, 320, 16);
  private armKick = new Spring(0, 200, 13);
  private squash = new Spring(0, 260, 12);
  private headNod = new Spring(0, 150, 9);
  private pumpT = -1;
  private walkPhase = 0;
  private stepSide = 0;
  private dodgeT = 0;
  private dodgeCd = 0;
  private dodgeDir = new THREE.Vector3();
  invulnT = 0;
  private hurtFaceT = 0;
  ragdoll: Ragdoll | null = null;
  /** For the HUD: time since last successful hit (hit marker). */
  lastHitT = 10;
  lastKillT = 10;
  spreadKick = 0;
  onDeath: (() => void) | null = null;
  private groundY = 0;
  /** Debug/test: ignore damage. */
  invincible = false;

  constructor(
    private ctx: GameCtx,
    private combat: Combat,
    x: number,
    z: number,
  ) {
    this.model = new CharacterModel({
      scale: 1,
      skin: PAL.skin,
      shirt: PAL.jacket,
      pants: PAL.denim,
      shoes: PAL.boots,
      face: 'player',
      faceVariant: 0,
      hat: 'cap',
      hair: PAL.hair,
      backpack: true,
      outline: 0x3b2a2e,
      xray: 0xfff1d6,
    });
    this.guns = { pistol: buildGun('pistol'), shotgun: buildGun('shotgun') };
    for (const id of ['pistol', 'shotgun'] as WeaponId[]) {
      this.model.handR.add(this.guns[id]);
      this.guns[id].visible = id === this.weapon.id;
    }
    ctx.root.add(this.model.root);
    ctx.root.add(this.model.shadow);
    this.pos.set(x, 0, z);
    this.body = {
      x,
      z,
      radius: 0.36,
      height: 1.3,
      vx: 0,
      vz: 0,
      mass: 70,
      alive: true,
      headY: DIMS.headY,
      headR: DIMS.headR,
      owner: this,
      team: 'player',
      onRagdollHit: (speed, dir) => {
        if (speed > 7) this.damage(0, dir, speed * 0.25);
      },
    };
    ctx.physics.characters.push(this.body);
    ctx.addPusher(this);
    this.syncModel();
  }

  get dodging(): boolean {
    return this.dodgeT > 0;
  }

  get currentAmmo(): Ammo {
    return this.ammo[this.weapon.id];
  }

  /** World position of the current weapon's muzzle. */
  muzzleWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const gun = this.guns[this.weapon.id];
    gun.updateWorldMatrix(true, false);
    return out.copy(this.weapon.muzzle).applyMatrix4(gun.matrixWorld);
  }

  addAmmo(id: WeaponId, n: number): void {
    const a = this.ammo[id];
    a.reserve = Math.min(WEAPONS[id].reserveMax, a.reserve + n);
  }

  heal(n: number): void {
    this.hp = Math.min(this.maxHp, this.hp + n);
  }

  damage(amount: number, dir: THREE.Vector3, knock = 5): void {
    if (!this.alive || this.invulnT > 0 || this.dodgeT > 0.08 || this.invincible) return;
    this.hp -= amount;
    this.invulnT = amount > 0 ? 0.9 : 0.3;
    this.vel.x += dir.x * knock;
    this.vel.z += dir.z * knock;
    this.model.flash(0.12);
    this.headNod.kick(12);
    this.squash.kick(4);
    if (amount > 0) {
      this.hurtFaceT = 0.5;
      this.model.setFace('playerHurt');
      sfx.hurt(this.pos);
      this.ctx.shake(0.45);
      this.ctx.hitstop(0.06);
      this.ctx.fx.bloodBurst(this.pos.clone().setY(0.8), dir, 6, 0.6);
    }
    if (this.hp <= 0) this.die(dir.clone().multiplyScalar(Math.min(6, knock * 0.45 + 2)));
  }

  private die(impulse: THREE.Vector3): void {
    this.alive = false;
    this.body.alive = false;
    this.model.setFace('playerDead');
    this.model.setXray(false);
    const vel = this.model.jointPositions().map(() => new THREE.Vector3(this.vel.x * 0.3 + impulse.x, 2.2 + impulse.y, this.vel.z * 0.3 + impulse.z));
    vel[J.head].addScaledVector(impulse, 0.4);
    const rd = this.model.createRagdoll(vel);
    this.ragdoll = rd;
    this.ctx.physics.addRagdoll(rd);
    this.guns.pistol.visible = false;
    this.guns.shotgun.visible = false;
    this.ctx.slowmo(0.35, 1.2);
    this.onDeath?.();
  }

  update(dt: number, input: PlayerInput): void {
    this.lastHitT += dt;
    this.lastKillT += dt;
    this.spreadKick = Math.max(0, this.spreadKick - dt * 3);
    if (!this.alive) {
      if (this.ragdoll) {
        this.model.root.position.set(0, 0, 0);
        this.model.root.quaternion.identity();
        this.model.body.position.set(0, 0, 0);
        this.model.body.quaternion.identity();
        this.model.body.scale.set(1, 1, 1);
        this.model.applyRagdoll(this.ragdoll);
        this.ragdoll.center(this.pos);
      }
      this.model.updateFlash(dt);
      return;
    }
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    if (this.hurtFaceT > 0) {
      this.hurtFaceT -= dt;
      if (this.hurtFaceT <= 0) this.model.setFace('player');
    }

    // ---------------- movement
    const maxSpeed = 4.7;
    let mx = input.moveX;
    let mz = input.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    if (input.dodge && this.dodgeCd <= 0 && this.dodgeT <= 0) {
      this.dodgeT = 0.38;
      this.dodgeCd = 0.62;
      if (ml > 0.1) this.dodgeDir.set(mx, 0, mz).normalize();
      else this.dodgeDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      sfx.whoosh(this.pos);
      this.ctx.fx.dust(this.pos, 4, 1, PAL.dust, 0.35);
      this.cancelReload();
    }
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      const k = this.dodgeT / 0.38;
      const sp = 4.5 + 7.5 * k;
      this.vel.x = this.dodgeDir.x * sp;
      this.vel.z = this.dodgeDir.z * sp;
    } else {
      const tx = mx * maxSpeed;
      const tz = mz * maxSpeed;
      const accel = ml > 0.1 ? 34 : 22;
      const dvx = tx - this.vel.x;
      const dvz = tz - this.vel.z;
      const dl = Math.hypot(dvx, dvz);
      const step = accel * dt;
      if (dl <= step) {
        this.vel.x = tx;
        this.vel.z = tz;
      } else {
        this.vel.x += (dvx / dl) * step;
        this.vel.z += (dvz / dl) * step;
      }
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // collisions
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
    const gh = this.ctx.physics.heightAt(this.pos.x, this.pos.z);
    this.groundY = damp(this.groundY, gh, 18, dt);
    this.pos.y = this.groundY;
    this.pushPos.copy(this.pos);

    // ---------------- aim
    const ax = input.aim.x - this.pos.x;
    const az = input.aim.z - this.pos.z;
    if (Math.hypot(ax, az) > 0.25) {
      const target = Math.atan2(ax, az);
      this.yaw = dampAngle(this.yaw, target, this.dodgeT > 0 ? 6 : 26, dt);
    }

    // ---------------- weapons
    if (input.switchTo && input.switchTo !== this.weapon.id && this.swapT <= 0) {
      this.pendingWeapon = input.switchTo;
      this.swapT = 0.28;
      this.cancelReload();
      sfx.reload(this.pos, true);
    }
    if (this.swapT > 0) {
      this.swapT -= dt;
      if (this.pendingWeapon && this.swapT < 0.14) {
        this.guns[this.weapon.id].visible = false;
        this.weapon = WEAPONS[this.pendingWeapon];
        this.guns[this.weapon.id].visible = true;
        this.pendingWeapon = null;
      }
    }
    const a = this.currentAmmo;
    if (input.reload && !this.reloading && a.mag < this.weapon.mag && a.reserve > 0) this.startReload();
    if (this.reloading) this.updateReload(dt);
    const wantFire = this.weapon.id === 'pistol' ? input.fire : input.fire;
    if (wantFire && this.dodgeT <= 0 && this.swapT <= 0) {
      if (this.reloading && this.weapon.perShell && a.mag > 0) this.cancelReload();
      if (!this.reloading && this.cooldown <= 0) {
        if (a.mag > 0) this.fire(input.aim);
        else if (input.firePressed) {
          sfx.empty(this.pos);
          this.cooldown = 0.25;
          if (a.reserve > 0) this.startReload();
        }
      }
    }
    if (this.pumpT >= 0) {
      this.pumpT += dt;
      if (this.pumpT > 0.22) {
        this.pumpT = -1;
        sfx.pump(this.pos);
        this.gunKick.kick(-2.2);
        this.ejectShell(true);
      }
    }

    this.animate(dt);
    this.syncModel();
  }

  private startReload(): void {
    this.reloading = true;
    this.reloadT = this.weapon.reloadTime;
    if (!this.weapon.perShell) sfx.reload(this.pos);
  }

  private cancelReload(): void {
    this.reloading = false;
  }

  private updateReload(dt: number): void {
    const a = this.currentAmmo;
    this.reloadT -= dt;
    if (this.reloadT > 0) return;
    if (this.weapon.perShell) {
      if (a.reserve > 0 && a.mag < this.weapon.mag) {
        a.mag++;
        a.reserve--;
        sfx.reload(this.pos, true);
        this.armKick.kick(1.2);
      }
      if (a.mag >= this.weapon.mag || a.reserve <= 0) {
        this.reloading = false;
        sfx.pump(this.pos);
      } else this.reloadT = this.weapon.reloadTime;
    } else {
      const need = this.weapon.mag - a.mag;
      const n = Math.min(need, a.reserve);
      a.mag += n;
      a.reserve -= n;
      this.reloading = false;
      this.armKick.kick(2);
    }
  }

  /** 0..1 progress for the HUD reload ring. */
  get reloadProgress(): number {
    if (!this.reloading) return 0;
    if (this.weapon.perShell) {
      const a = this.currentAmmo;
      return a.mag / this.weapon.mag;
    }
    return 1 - this.reloadT / this.weapon.reloadTime;
  }

  private fire(aim: THREE.Vector3): void {
    const w = this.weapon;
    const a = this.currentAmmo;
    a.mag--;
    this.cooldown = w.fireInterval;
    const muzzle = this.muzzleWorld();
    // aim direction: horizontal toward the cursor unless the cursor picked a low/high target
    const dir = new THREE.Vector3().subVectors(aim, muzzle);
    const flatLen = Math.hypot(dir.x, dir.z);
    if (flatLen < 1.2) {
      dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    } else {
      dir.y = clamp(dir.y / flatLen, -0.5, 0.35) * flatLen;
    }
    dir.normalize();
    // make sure the muzzle is not inside a wall: pull the origin back to the body if needed
    const origin = muzzle.clone();
    const back = new THREE.Vector3(this.pos.x, muzzle.y, this.pos.z);
    const check = new THREE.Vector3().subVectors(origin, back);
    const clen = check.length();
    if (clen > 0.01 && !this.ctx.physics.segmentClear(back.x, back.z, origin.x, origin.z, muzzle.y)) origin.copy(back);
    const res = this.combat.fire(w, origin, dir, this.body, muzzle);
    if (res.hits > 0) this.lastHitT = 0;
    if (res.kills > 0) this.lastKillT = 0;
    // feel
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    this.vel.x -= flat.x * w.recoil;
    this.vel.z -= flat.z * w.recoil;
    this.gunKick.kick(w.id === 'shotgun' ? 9 : 5);
    this.armKick.kick(w.id === 'shotgun' ? 9 : 4.5);
    this.squash.kick(w.id === 'shotgun' ? 2.6 : 0.9);
    this.headNod.kick(w.id === 'shotgun' ? 3 : 1);
    this.spreadKick = Math.min(1, this.spreadKick + (w.id === 'shotgun' ? 1 : 0.35));
    this.ctx.shake(w.shake);
    this.ctx.cam.kick(flat.clone().negate(), w.camKick);
    if (w.id === 'shotgun') {
      this.ctx.cam.punchFov(0.5);
      this.pumpT = 0;
      this.ctx.fx.dustRing(this.pos, 0.35, 8);
    } else this.ejectShell(false);
    if (a.mag === 0 && a.reserve > 0) {
      // auto reload after the last shot
      this.reloadT = 0;
      setTimeout(() => {
        if (this.alive && !this.reloading && this.currentAmmo.mag === 0 && this.currentAmmo.reserve > 0) this.startReload();
      }, 280);
    }
  }

  private ejectShell(shotgun: boolean): void {
    const gun = this.guns[this.weapon.id];
    gun.updateWorldMatrix(true, false);
    const port = new THREE.Vector3(0, 0.07, shotgun ? 0.05 : 0.12).applyMatrix4(gun.matrixWorld);
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const back = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const v = right.multiplyScalar(rng.range(1.8, 2.8)).add(new THREE.Vector3(0, rng.range(2.8, 3.8), 0)).addScaledVector(back, rng.range(0.3, 1));
    v.x += this.vel.x * 0.5;
    v.z += this.vel.z * 0.5;
    const scale = shotgun ? new THREE.Vector3(0.042, 0.12, 0.042) : new THREE.Vector3(0.024, 0.05, 0.024);
    this.ctx.fx.debris.spawn(shotgun ? 'shell' : 'casing', port, v, scale, shotgun ? 0xffffff : PAL.brass, {
      life: 7,
      spin: 22,
      onBounce: (sp, p) => sfx.shellTink(p, sp < 2.5),
    });
  }

  private animate(dt: number): void {
    const m = this.model;
    this.gunKick.update(dt);
    this.armKick.update(dt);
    this.squash.update(dt);
    this.headNod.update(dt);
    m.updateFlash(dt);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const sf = clamp(speed / 4.7, 0, 1.4);
    // movement relative to facing
    const fwd = (this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw)) / 4.7;
    const side = (this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) / 4.7;
    const prevPhase = this.walkPhase;
    this.walkPhase += dt * (4 + 8 * sf) * (sf > 0.05 ? 1 : 0);
    if (sf > 0.2 && Math.floor(prevPhase / Math.PI) !== Math.floor(this.walkPhase / Math.PI)) {
      this.stepSide ^= 1;
      sfx.footstep(this.pos);
      if (sf > 0.8 && rng.chance(0.5)) this.ctx.fx.dust(this.pos.clone().setY(0.05), 1, 0.3, PAL.dust, 0.22);
    }
    const sw = Math.sin(this.walkPhase);
    const amp = Math.min(1, sf);
    const legSwing = 0.85 * amp;
    const dirSign = fwd >= -0.2 ? 1 : -1;
    m.legL.rotation.set(sw * legSwing * dirSign * Math.min(1, Math.abs(fwd) + 0.3), 0, sw * side * 0.4);
    m.legR.rotation.set(-sw * legSwing * dirSign * Math.min(1, Math.abs(fwd) + 0.3), 0, -sw * side * 0.4);
    const bob = Math.abs(Math.cos(this.walkPhase)) * 0.055 * amp;
    const t = this.ctx.time;
    const breathe = Math.sin(t * 2.4) * 0.012;

    // squash & stretch
    const sq = this.squash.value * 0.06;
    m.body.scale.set(1 + sq * 0.6, 1 - sq + breathe, 1 + sq * 0.6);
    m.body.position.y = bob;
    let lean = fwd * 0.14 - this.armKick.value * 0.012;
    let roll = -side * 0.1;
    m.body.position.z = 0;
    if (this.dodgeT > 0) {
      // forward roll pivoting around the belly
      const k = 1 - this.dodgeT / 0.38;
      const a = k * Math.PI * 2;
      const h = 0.5;
      m.body.rotation.set(a, 0, 0);
      m.body.position.y = h - h * Math.cos(a) + Math.sin(k * Math.PI) * 0.12;
      m.body.position.z = -h * Math.sin(a);
      lean = 0;
      roll = 0;
    } else m.body.rotation.set(lean, 0, roll);

    // arms / weapon pose
    const up = -this.armKick.value * 0.045;
    const swapDown = this.swapT > 0 ? Math.sin((this.swapT / 0.28) * Math.PI) * 0.9 : 0;
    const reloadDip = this.reloading ? 0.35 + Math.sin(t * 14) * 0.08 : 0;
    const armBob = Math.sin(this.walkPhase * 2) * 0.04 * amp;
    const gun = this.guns[this.weapon.id];
    if (this.dodgeT > 0) {
      m.armR.rotation.set(-2.4, 0, 0.3);
      m.armL.rotation.set(-2.4, 0, -0.3);
      gun.rotation.set(2.4, 0, 0);
    } else if (this.weapon.id === 'pistol') {
      const ar = -1.46 + up + swapDown + reloadDip + armBob;
      m.armR.rotation.set(ar, 0, 0.14);
      m.armL.rotation.set(-1.32 + up * 0.8 + swapDown + reloadDip * 1.4 + armBob, 0, -0.5);
      gun.rotation.set(-ar - 0.02, -0.12, 0);
      gun.position.set(0, 0, 0.02 - this.gunKick.value * 0.012);
    } else {
      const ar = -0.92 + up + swapDown + reloadDip * 0.5 + armBob;
      m.armR.rotation.set(ar, 0, 0.16);
      const pumpPull = this.pumpT >= 0 ? Math.sin(Math.min(1, this.pumpT / 0.22) * Math.PI) * 0.25 : 0;
      m.armL.rotation.set(-1.42 + up * 0.8 + swapDown + reloadDip + pumpPull + armBob, 0, -0.62);
      gun.rotation.set(-ar - 0.04 + up * 0.3, -0.16, 0);
      gun.position.set(0.02, 0.0, 0.02 - this.gunKick.value * 0.018);
    }
    m.head.rotation.set(-this.headNod.value * 0.04 + Math.sin(t * 1.3) * 0.03, 0, Math.sin(t * 0.9) * 0.03);
    m.torso.rotation.y = side * 0.1;
    m.setXray(true);
    void wrapAngle;
  }

  private syncModel(): void {
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.shadow.position.set(this.pos.x, this.pos.y + 0.02, this.pos.z);
  }

  dispose(): void {
    this.model.dispose();
    const i = this.ctx.physics.characters.indexOf(this.body);
    if (i >= 0) this.ctx.physics.characters.splice(i, 1);
    if (this.ragdoll) this.ctx.physics.removeRagdoll(this.ragdoll);
    this.ctx.removePusher(this);
  }
}
