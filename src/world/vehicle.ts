import * as THREE from 'three';
import { rng } from '../core/rng';
import { compose, Spring } from '../core/math';
import { PAL } from '../render/palette';
import { beam, box, cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { toonUnique, vcToon } from '../render/materials';
import { StaticCollider, type HitReceiver } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { sfx } from '../audio/sfx';

/**
 * A chunky pastel pickup truck. Static collider, but it rocks on its suspension when hit and
 * the alarm goes off (blinking lights + beeps). Shoot it enough (the fuel cap counts five
 * times) and the engine starts smoking, catches fire and the whole thing blows up.
 */
export class Pickup implements HitReceiver, Updatable {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  readonly collider: StaticCollider;
  private roll = new Spring(0, 90, 5);
  private pitch = new Spring(0, 90, 5);
  private bounce = new Spring(0, 140, 7);
  private alarmT = 0;
  private lights: THREE.MeshBasicMaterial[] = [];
  private tail: THREE.MeshBasicMaterial[] = [];
  private mesh: THREE.Mesh;
  private readonly maxHp = 26;
  private hp = 26;
  private burnT = -1;
  private wreckT = -1;
  private readonly capLocal = new THREE.Vector3(1.0, 1.12, -0.55);

  constructor(
    private ctx: GameCtx,
    x: number,
    z: number,
    rot: number,
  ) {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = rot;
    const g = new GeoBuilder();
    const W = 1.9;
    // chassis / lower body (length along z, front = +z)
    g.add(rbox(W, 0.62, 4.3, 0.22, 3), PAL.carBody, compose(0, 0.78, 0));
    g.add(rbox(W + 0.04, 0.12, 4.36, 0.06), PAL.carCream, compose(0, 0.9, 0));
    // hood
    g.add(rbox(W - 0.08, 0.3, 1.35, 0.2, 3), PAL.carBody, compose(0, 1.18, 1.35));
    // cabin
    g.add(rbox(W - 0.12, 0.85, 1.6, 0.28, 3), PAL.carCream, compose(0, 1.52, 0.02));
    // windows (inset, glassy)
    const glass = 0x9fd0de;
    g.add(rbox(W - 0.3, 0.5, 0.06, 0.05), glass, compose(0, 1.62, 0.83, -0.18, 0, 0));
    g.add(rbox(W - 0.3, 0.46, 0.06, 0.05), glass, compose(0, 1.6, -0.79));
    for (const s of [-1, 1]) g.add(rbox(0.06, 0.46, 1.2, 0.05), glass, compose(s * (W / 2 - 0.05), 1.6, 0.02));
    // glass highlights
    g.add(box(0.12, 0.42, 0.02), 0xf3fbff, compose(-0.35, 1.63, 0.87, -0.18, 0, 0.3));
    g.add(box(0.06, 0.42, 0.02), 0xf3fbff, compose(-0.15, 1.63, 0.87, -0.18, 0, 0.3));
    // bed walls
    for (const s of [-1, 1]) g.add(rbox(0.1, 0.36, 2.0, 0.04), PAL.carBody, compose(s * (W / 2 - 0.05), 1.22, -1.1));
    g.add(rbox(W, 0.36, 0.1, 0.04), PAL.carBody, compose(0, 1.22, -2.1));
    g.add(box(W - 0.2, 0.05, 1.9), 0x6f9f96, compose(0, 1.08, -1.1));
    // bumpers
    g.add(rbox(W + 0.1, 0.2, 0.22, 0.08), PAL.chrome, compose(0, 0.55, 2.18));
    g.add(rbox(W + 0.1, 0.2, 0.22, 0.08), PAL.chrome, compose(0, 0.55, -2.18));
    // grille
    g.add(rbox(1.0, 0.28, 0.06, 0.04), 0x6e7680, compose(0, 0.9, 2.16));
    for (let i = -2; i <= 2; i++) g.add(box(0.04, 0.22, 0.03), PAL.chrome, compose(i * 0.18, 0.9, 2.19));
    // wheels
    for (const sx of [-1, 1]) {
      for (const sz of [-1.35, 1.35]) {
        g.add(cyl(0.42, 0.42, 0.3, 16), PAL.tire, compose(sx * (W / 2 - 0.05), 0.42, sz, 0, 0, Math.PI / 2));
        g.add(cyl(0.2, 0.2, 0.32, 12), PAL.chrome, compose(sx * (W / 2 - 0.03), 0.42, sz, 0, 0, Math.PI / 2));
        g.add(cyl(0.08, 0.08, 0.34, 8), 0x8d939c, compose(sx * (W / 2 - 0.02), 0.42, sz, 0, 0, Math.PI / 2));
        // arches
        g.add(rbox(0.12, 0.2, 1.05, 0.05), 0x6fa89d, compose(sx * (W / 2 + 0.01), 0.95, sz));
      }
    }
    // mirrors
    for (const s of [-1, 1]) {
      g.add(beam(new THREE.Vector3(s * 0.85, 1.4, 0.72), new THREE.Vector3(s * 1.08, 1.45, 0.78), 0.05, 0.05), PAL.carCream);
      g.add(rbox(0.08, 0.18, 0.14, 0.03), PAL.carCream, compose(s * 1.1, 1.48, 0.78));
    }
    // fuel cap (the weak spot)
    g.add(cyl(0.11, 0.11, 0.04, 14), PAL.chrome, compose(W / 2 + 0.005, 1.12, -0.55, 0, 0, Math.PI / 2));
    g.add(cyl(0.05, 0.05, 0.05, 8), 0x8d939c, compose(W / 2 + 0.02, 1.12, -0.55, 0, 0, Math.PI / 2));
    // cargo: a crate and a pumpkin in the bed
    g.add(rbox(0.6, 0.5, 0.6, 0.05), PAL.crate, compose(0.35, 1.36, -1.5, 0, 0.3, 0));
    g.add(sphere(0.26, 12, 8), PAL.pumpkin, compose(-0.45, 1.33, -0.8, 0, 0, 0, 1.2, 0.85, 1.2));
    g.add(cyl(0.03, 0.04, 0.12, 5), PAL.pumpkinStem, compose(-0.45, 1.58, -0.8));

    const m = new THREE.Mesh(g.build(), vcToon());
    m.castShadow = true;
    m.receiveShadow = true;
    this.body.add(m);
    this.mesh = m;

    // lights (separate so they can blink)
    for (const s of [-1, 1]) {
      const hl = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.headlight).multiplyScalar(0.9) });
      const hm = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 14), hl);
      hm.rotation.x = Math.PI / 2;
      hm.position.set(s * 0.68, 0.98, 2.16);
      this.body.add(hm);
      this.lights.push(hl);
      const tl = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd8584a) });
      const tm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.05), tl);
      tm.position.set(s * 0.75, 1.1, -2.16);
      this.body.add(tm);
      this.tail.push(tl);
    }
    this.group.add(this.body);

    this.collider = StaticCollider.box(x, z, W / 2 + 0.05, 2.25, 1.9, rot, 'metal', this);
  }

  onBulletHit(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, damage: number, force: number): void {
    this.ctx.fx.sparks(point, normal, 6, 7);
    this.ctx.fx.decals.bulletHole(point, normal, 0.08);
    sfx.metalHit(point);
    this.push(dir, force * 0.08);
    if (this.wreckT >= 0) return;
    this.triggerAlarm();
    const cap = this.group.localToWorld(this.capLocal.clone());
    const onCap = point.distanceTo(cap) < 0.45;
    if (onCap) this.ctx.fx.particles.soft.spawn(cap, { vel: normal.clone().multiplyScalar(2), life: 0.5, size: 0.15, sizeEnd: 0.6, color: 0xe8dcc8, alpha: 0.6, drag: 3 });
    this.hurt(damage * (onCap ? 5 : 1));
  }

  private hurt(amount: number): void {
    if (this.wreckT >= 0 || this.burnT >= 0) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      // it's going to blow: fire under the hood, a few seconds to run
      this.burnT = 2.6;
      sfx.roar(this.group.position);
      this.ctx.feat('CORRE!', this.group.position.clone().setY(2.4));
      this.triggerAlarm();
    }
  }

  onImpact(speed: number, _p: THREE.Vector3, dir: THREE.Vector3, mass: number): boolean {
    this.push(dir, speed * Math.min(mass, 30) * 0.004);
    sfx.metalHit(this.group.position);
    if (speed > 6) this.triggerAlarm();
    return false;
  }

  onBlast(center: THREE.Vector3, strength: number): void {
    const d = this.group.position.clone().sub(center).setY(0).normalize();
    this.push(d, strength * 2.5);
    this.bounce.kick(strength * 4);
    if (this.wreckT >= 0) return;
    this.triggerAlarm();
    this.hurt(strength * 22);
  }

  private blowUp(): void {
    this.burnT = -1;
    this.wreckT = 0;
    const p = this.group.localToWorld(new THREE.Vector3(0, 1.0, 0.6));
    this.ctx.explode(p, 1.5, 'truck');
    // the truck jumps, lands charred
    this.bounce.kick(-26);
    this.pitch.kick(rng.spread(8));
    this.roll.kick(rng.spread(8));
    this.mesh.material = toonUnique(0x6a5e5a, { vertexColors: true });
    for (const l of this.lights) l.color.set(0x2a2426);
    for (const l of this.tail) l.color.set(0x2a2426);
    this.alarmT = 0;
    this.ctx.fx.gibs(p, new THREE.Vector3(0, 1, 0), 8, 0x6a5e5a);
  }

  private push(dir: THREE.Vector3, amount: number): void {
    const inv = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.group.rotation.y, 0)).invert();
    const local = dir.clone().applyQuaternion(inv);
    this.roll.kick(-local.x * amount * 2);
    this.pitch.kick(local.z * amount * 2);
    this.bounce.kick(-amount * 0.5);
  }

  triggerAlarm(): void {
    if (this.wreckT >= 0) return;
    if (this.alarmT <= 0) sfx.alarm(this.group.position, 3.5);
    this.alarmT = Math.max(this.alarmT, 3.5);
  }

  update(dt: number, t: number): void {
    this.roll.update(dt);
    this.pitch.update(dt);
    this.bounce.update(dt);
    this.body.rotation.z = this.roll.value * 0.05;
    this.body.rotation.x = this.pitch.value * 0.05;
    this.body.position.y = this.bounce.value * 0.03;
    this.updateDamage(dt);
    if (this.alarmT > 0) {
      this.alarmT -= dt;
      const on = Math.sin(t * 25) > 0;
      const k = on ? 2.6 : 0.5;
      for (const l of this.lights) l.color.setRGB(k, k * 0.95, k * 0.75);
      for (const l of this.tail) l.color.setRGB(on ? 2.5 : 0.6, on ? 0.6 : 0.2, on ? 0.4 : 0.15);
      if (this.alarmT <= 0) {
        for (const l of this.lights) l.color.set(PAL.headlight).multiplyScalar(0.9);
        for (const l of this.tail) l.color.set(0xd8584a);
      }
      if (rng.chance(dt * 2)) this.bounce.kick(0.4);
    }
  }

  /** Engine smoke when hurt, flames when burning, a smoke column once wrecked. */
  private updateDamage(dt: number): void {
    const fx = this.ctx.fx.particles;
    const hood = this.group.localToWorld(new THREE.Vector3(rng.spread(0.5), 1.35, 1.3 + rng.spread(0.4)));
    const hurt = 1 - this.hp / this.maxHp;
    if (this.wreckT < 0 && this.burnT < 0 && hurt > 0.45 && rng.chance(dt * 10 * hurt)) {
      fx.soft.spawn(hood, { vel: new THREE.Vector3(rng.spread(0.3), 1.2, rng.spread(0.3)), life: 1.4, size: 0.2, sizeEnd: 0.8, color: 0x8f8783, colorEnd: 0xd9d2cc, alpha: 0.5, drag: 0.8, gravity: 0.3, fadeIn: 0.15 });
    }
    if (this.burnT >= 0) {
      this.burnT -= dt;
      for (let i = 0; i < 2; i++) {
        fx.fire.spawn(hood, new THREE.Vector3(rng.spread(0.6), rng.range(1.5, 3), rng.spread(0.6)), rng.range(0.3, 0.5), 0.25, rng.range(0.5, 0.8), new THREE.Color(0xffd36b).multiplyScalar(2), new THREE.Color(0xe0553a));
      }
      if (rng.chance(dt * 8)) fx.smoke.spawn(hood, new THREE.Vector3(rng.spread(0.4), 2, rng.spread(0.4)), rng.range(1, 1.6), 0.3, 1.1, new THREE.Color(0x4f4644), new THREE.Color(0xa59c97));
      if (rng.chance(dt * 6)) this.bounce.kick(0.6);
      sfx.roar(this.group.position);
      if (this.burnT <= 0) this.blowUp();
    } else if (this.wreckT >= 0) {
      this.wreckT += dt;
      const k = Math.max(0, 1 - this.wreckT / 30);
      if (k > 0 && rng.chance(dt * 9 * k)) {
        fx.smoke.spawn(hood, new THREE.Vector3(rng.spread(0.3), 1.6, rng.spread(0.3)), rng.range(1.6, 2.6), 0.3, 1.3, new THREE.Color(0x5a5250), new THREE.Color(0xb3aba6));
      }
      if (this.wreckT < 8 && rng.chance(dt * 12)) {
        fx.fire.spawn(hood, new THREE.Vector3(rng.spread(0.4), rng.range(1, 2), rng.spread(0.4)), rng.range(0.25, 0.45), 0.2, 0.5, new THREE.Color(0xffc15a).multiplyScalar(2), new THREE.Color(0xd14a33));
      }
    }
  }
}
