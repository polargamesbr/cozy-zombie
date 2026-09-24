import * as THREE from 'three';
import { compose } from '../core/math';
import { rng } from '../core/rng';
import { PAL } from '../render/palette';
import { cyl, GeoBuilder, rbox, sphere } from '../render/geometry';
import { outlineMaterial, vcToon } from '../render/materials';
import type { GameCtx } from '../game/context';
import type { Player } from './player';
import { sfx } from '../audio/sfx';
import { TEX } from '../fx/particles';

export type PickupKind = 'ammoPistol' | 'ammoShotgun' | 'pie';

function buildPickup(kind: PickupKind): THREE.Group {
  const g = new GeoBuilder();
  if (kind === 'pie') {
    g.add(cyl(0.26, 0.22, 0.1, 18), 0xd9a066, compose(0, 0.05, 0));
    g.add(cyl(0.23, 0.23, 0.04, 18), 0xb8323f, compose(0, 0.1, 0));
    for (let i = 0; i < 4; i++) {
      g.add(rbox(0.46, 0.02, 0.05, 0.01), 0xf0c585, compose(0, 0.125, -0.15 + i * 0.1));
      g.add(rbox(0.05, 0.02, 0.46, 0.01), 0xf0c585, compose(-0.15 + i * 0.1, 0.13, 0));
    }
    g.add(cyl(0.27, 0.27, 0.035, 18), 0xe8b374, compose(0, 0.11, 0));
  } else if (kind === 'ammoShotgun') {
    g.add(rbox(0.36, 0.2, 0.26, 0.04), 0xd8584a, compose(0, 0.1, 0));
    g.add(rbox(0.37, 0.05, 0.27, 0.02), 0xf2ede4, compose(0, 0.1, 0));
    for (let i = 0; i < 3; i++) {
      g.add(cyl(0.035, 0.035, 0.12, 8), PAL.shellRed, compose(-0.09 + i * 0.09, 0.26, 0));
      g.add(cyl(0.037, 0.037, 0.03, 8), PAL.brass, compose(-0.09 + i * 0.09, 0.21, 0));
    }
  } else {
    g.add(rbox(0.3, 0.18, 0.22, 0.04), 0x7f9a5a, compose(0, 0.09, 0));
    g.add(rbox(0.31, 0.04, 0.23, 0.02), 0xf2d37a, compose(0, 0.1, 0));
    for (let i = 0; i < 4; i++) g.add(cyl(0.02, 0.02, 0.08, 6), PAL.brass, compose(-0.09 + i * 0.06, 0.22, 0));
    for (let i = 0; i < 4; i++) g.add(sphere(0.02, 6, 4), 0xd8a54a, compose(-0.09 + i * 0.06, 0.265, 0));
  }
  const geo = g.build();
  const grp = new THREE.Group();
  const m = new THREE.Mesh(geo, vcToon());
  m.castShadow = true;
  grp.add(m);
  const ol = new THREE.Mesh(geo, outlineMaterial(0x3b2a2e, 0.015));
  ol.userData.noAO = true;
  grp.add(ol);
  return grp;
}

export class Pickup {
  readonly group: THREE.Group;
  dead = false;
  private t = rng.angle();
  private age = 0;
  private vel: THREE.Vector3;

  constructor(
    private ctx: GameCtx,
    readonly kind: PickupKind,
    readonly pos: THREE.Vector3,
  ) {
    this.group = buildPickup(kind);
    this.group.position.copy(pos);
    ctx.root.add(this.group);
    // pop out
    this.vel = new THREE.Vector3(rng.spread(1.5), 4, rng.spread(1.5));
  }

  update(dt: number, player: Player): string | null {
    this.age += dt;
    this.t += dt;
    if (this.vel.lengthSq() > 0) {
      this.vel.y -= 20 * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y < 0.15) {
        this.pos.y = 0.15;
        this.vel.set(0, 0, 0);
      }
    }
    const bob = this.vel.lengthSq() === 0 ? Math.sin(this.t * 3) * 0.06 : 0;
    this.group.position.set(this.pos.x, this.pos.y + bob + 0.1, this.pos.z);
    this.group.rotation.y += dt * 1.6;
    if (Math.random() < dt * 2.5) {
      this.ctx.fx.particles.glow.spawn(this.group.position.clone().add(new THREE.Vector3(rng.spread(0.25), 0.25 + rng.next() * 0.2, rng.spread(0.25))), {
        life: 0.5,
        size: 0.12,
        sizeEnd: 0,
        color: 0xfff1b0,
        intensity: 1.6,
        alpha: 1,
        cell: TEX.star,
      });
    }
    if (this.age > 45) {
      const k = Math.max(0, 1 - (this.age - 45) / 2);
      this.group.scale.setScalar(k);
      if (k <= 0) this.remove();
    }
    if (!player.alive) return null;
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    if (d < 0.9 && this.age > 0.4) {
      let msg: string | null = null;
      if (this.kind === 'pie') {
        if (player.hp >= player.maxHp) return null;
        player.heal(2);
        msg = 'Torta quentinha! +2 ❤';
      } else if (this.kind === 'ammoShotgun') {
        player.addAmmo('shotgun', 6);
        msg = '+6 cartuchos';
      } else {
        player.addAmmo('pistol', 12);
        msg = '+12 balas';
      }
      sfx.pickup(this.pos);
      this.remove();
      return msg;
    }
    return null;
  }

  remove(): void {
    this.dead = true;
    this.group.removeFromParent();
  }
}
