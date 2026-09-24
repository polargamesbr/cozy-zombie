import * as THREE from 'three';
import { smoothstep } from '../core/math';
import { rng } from '../core/rng';
import { GLOBAL_UNIFORMS } from '../render/materials';
import type { GameCtx } from '../game/context';
import type { CharacterBody } from '../physics/world';
import type { WeaponDef } from './weapons';
import { Zombie, type HitParts } from './zombie';
import { inPond, LAYOUT } from '../world/layout';
import type { Pond } from '../world/pond';
import { sfx } from '../audio/sfx';
import { PAL } from '../render/palette';

interface Accum {
  damage: number;
  impulse: THREE.Vector3;
  point: THREE.Vector3;
  head: boolean;
  dist: number;
  parts: HitParts;
}

const _d = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);

/** Hitscan shooting: spreads pellets, resolves every hit and triggers all the juice. */
export class Combat {
  constructor(
    private ctx: GameCtx,
    private pond: Pond,
  ) {}

  fire(w: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, shooter: CharacterBody, muzzleVis: THREE.Vector3): { hits: number; kills: number } {
    const ctx = this.ctx;
    const perZombie = new Map<Zombie, Accum>();
    let hits = 0;
    let kills = 0;
    for (let i = 0; i < w.pellets; i++) {
      // pellets cluster toward the middle of the cone
      const a = w.pellets > 1 ? rng.gauss() * w.spread : rng.spread(w.spread);
      _d.copy(dir).applyAxisAngle(_axis, a);
      _d.y += rng.spread(w.pellets > 1 ? 0.05 : 0.01);
      _d.normalize();
      const hit = ctx.physics.raycast(origin, _d, w.range, shooter);
      const end = hit ? hit.point : origin.clone().addScaledVector(_d, w.range);
      ctx.fx.tracers.add(muzzleVis, end, w.pellets > 1 ? 0.035 : 0.05, w.pellets > 1 ? 0.06 : 0.07);
      if (!hit) continue;
      const fall = 1 - smoothstep(w.falloffStart, w.falloffEnd, hit.distance) * 0.8;
      const dmg = w.damage * fall;
      const force = w.force * fall;
      const d = _d.clone();
      switch (hit.kind) {
        case 'character': {
          const owner = hit.character!.owner;
          if (owner instanceof Zombie) {
            let acc = perZombie.get(owner);
            if (!acc) {
              acc = { damage: 0, impulse: new THREE.Vector3(), point: hit.point.clone(), head: false, dist: hit.distance, parts: {} };
              perZombie.set(owner, acc);
            }
            // legs maim more than they kill
            const part = owner.classify(hit.point, !!hit.headshot);
            const pd = dmg * (part === 'head' ? 1.8 : part === 'legL' || part === 'legR' ? 0.75 : 1);
            acc.damage += pd;
            acc.parts[part] = (acc.parts[part] ?? 0) + pd;
            acc.impulse.addScaledVector(d, force);
            acc.head ||= !!hit.headshot;
            acc.dist = Math.min(acc.dist, hit.distance);
            ctx.fx.bloodMist(hit.point, d);
          }
          break;
        }
        case 'ragdoll': {
          const owner = hit.ragdoll!.owner;
          if (owner instanceof Zombie) owner.shotCorpse(hit.particle!, d, force, hit.point, w.id, hit.distance);
          else {
            hit.ragdoll!.applyImpulse(hit.particle!, d.x * force * 3, force, d.z * force * 3);
            ctx.fx.bloodBurst(hit.point, d, 3, 0.6);
          }
          hits++;
          break;
        }
        case 'body': {
          const owner = hit.body!.owner;
          if (owner?.onBulletHit) owner.onBulletHit(hit.point, hit.normal, d, dmg, force);
          else hit.body!.applyImpulse(d.clone().multiplyScalar(force * 2), hit.point);
          break;
        }
        case 'static': {
          const owner = hit.collider!.owner;
          if (owner?.onBulletHit) owner.onBulletHit(hit.point, hit.normal, d, dmg, force);
          else {
            ctx.fx.impact(hit.surface, hit.point, hit.normal, d, w.pellets > 1);
            if (hit.surface !== 'plant' && hit.surface !== 'hay') ctx.fx.decals.bulletHole(hit.point, hit.normal);
          }
          break;
        }
        case 'ground': {
          if (inPond(hit.point.x, hit.point.z, -0.25)) {
            ctx.fx.splash(hit.point.clone().setY(0.08), w.pellets > 1 ? 0.5 : 0.8);
            this.pond.ripple(hit.point.x, hit.point.z, ctx.time, 1);
          } else {
            const onRoad = Math.abs(hit.point.z - LAYOUT.road.z) < LAYOUT.road.width / 2;
            ctx.fx.impact(onRoad ? 'road' : 'grass', hit.point, hit.normal, d, w.pellets > 1);
          }
          break;
        }
      }
    }
    for (const [z, acc] of perZombie) {
      hits++;
      if (z.takeHit(acc.damage, acc.impulse, acc.point, acc.head, w.id, acc.dist, acc.parts)) kills++;
    }

    // ---- feel
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    ctx.fx.muzzleFlash(muzzleVis, flat, w.id === 'shotgun');
    if (w.id === 'shotgun') sfx.shotgun(origin);
    else sfx.pistol(origin);
    if (hits > 0) ctx.hitstop(w.hitstop * (kills > 0 ? 1.6 : 1));
    if (kills > 0) ctx.shake(w.id === 'shotgun' ? 0.25 : 0.1);
    ctx.noise(origin, w.noise);
    if (w.id === 'shotgun') {
      const p = muzzleVis.clone().addScaledVector(flat, 0.6);
      GLOBAL_UNIFORMS.uGust.value.set(p.x, 0, p.z, ctx.time);
      GLOBAL_UNIFORMS.uGustStrength.value = 0.4;
    }
    return { hits, kills };
  }

  /**
   * Front kick: a cone in front of `from`. Standing zombies get knocked flying (into fences, the
   * pond, each other), bodies get punted, props get booted.
   */
  kick(from: THREE.Vector3, fwd: THREE.Vector3, self: CharacterBody): { hits: number; kills: number } {
    const ctx = this.ctx;
    const reach = 1.45;
    let hits = 0;
    let kills = 0;
    let flesh = false;
    const to = new THREE.Vector3();
    // bodies already on the floor (not the ones this kick is about to knock down)
    const corpses = [...ctx.physics.ragdolls];
    for (const ch of [...ctx.physics.characters]) {
      if (ch === self || !ch.alive) continue;
      to.set(ch.x - from.x, 0, ch.z - from.z);
      const d = to.length();
      if (d - ch.radius > reach || d < 1e-4) continue;
      to.divideScalar(d);
      if (to.dot(fwd) < 0.3) continue;
      const owner = ch.owner;
      if (!(owner instanceof Zombie)) continue;
      const dir = fwd.clone().multiplyScalar(0.65).addScaledVector(to, 0.35).normalize();
      const point = new THREE.Vector3(ch.x - to.x * ch.radius, from.y + 0.5 * owner.model.s, ch.z - to.z * ch.radius);
      if (owner.kicked(dir, point)) kills++;
      hits++;
      flesh = true;
    }
    for (const rd of corpses) {
      if (rd.owner === self.owner) continue;
      let bd = Infinity;
      for (let i = 0; i < rd.n; i++) {
        to.set(rd.p[i * 3] - from.x, 0, rd.p[i * 3 + 2] - from.z);
        const d = to.length();
        if (d < 1e-4 || to.dot(fwd) / d < 0.2) continue;
        bd = Math.min(bd, d);
      }
      if (bd > reach + 0.2) continue;
      for (let i = 0; i < rd.n; i++) rd.addVelocity(i, fwd.x * 6.5, 3 + (i === 0 ? 1.5 : 0), fwd.z * 6.5);
      const c = rd.center(new THREE.Vector3());
      ctx.fx.bloodBurst(c, fwd, 3, 0.6);
      hits++;
      flesh = true;
    }
    for (const b of ctx.physics.bodies) {
      to.set(b.pos.x - from.x, 0, b.pos.z - from.z);
      const d = to.length();
      if (d - b.radius > reach || d < 1e-4 || to.dot(fwd) / d < 0.3) continue;
      const m = Math.min(b.mass, 40);
      b.applyImpulse(new THREE.Vector3(fwd.x * m * 7, m * 2.6, fwd.z * m * 7), b.pos.clone().addScaledVector(fwd, -b.radius * 0.5).setY(b.pos.y + 0.05));
      hits++;
    }
    if (hits > 0) {
      ctx.hitstop(kills > 0 ? 0.09 : 0.065);
      ctx.shake(0.32);
      ctx.cam.kick(fwd, 0.25);
      sfx.kick(from.clone().addScaledVector(fwd, 0.9), flesh);
      ctx.fx.dust(from.clone().addScaledVector(fwd, 0.9).setY(0.1), 4, 0.6, PAL.dust, 0.35);
    }
    return { hits, kills };
  }
}
