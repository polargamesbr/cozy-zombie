import * as THREE from 'three';
import { rng } from '../core/rng';
import { noise } from '../core/noise';
import { compose, damp, dampAngle } from '../core/math';
import { box, cone, GeoBuilder, sphere } from '../render/geometry';
import { toon, toonUnique, vcToon } from '../render/materials';
import { canvasTexture } from '../render/textures';
import type { GameCtx, NoiseListener, Updatable } from '../game/context';
import { isOpenGround, LAYOUT } from './layout';
import { sfx } from '../audio/sfx';

const BIRD_COLORS = [
  { body: 0x8d6b57, belly: 0xe89a5e, wing: 0x6f5646 },
  { body: 0x6f8fcb, belly: 0xf3cda6, wing: 0x5673a9 },
  { body: 0xa98a6c, belly: 0xefe1c8, wing: 0x86684f },
];

type BirdState = 'ground' | 'flee' | 'away' | 'return';

class Bird {
  readonly group = new THREE.Group();
  private wingL = new THREE.Group();
  private wingR = new THREE.Group();
  private head = new THREE.Group();
  state: BirdState = 'ground';
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  target = new THREE.Vector3();
  yaw = rng.angle();
  timer = rng.range(0.5, 2);
  private hop = 0;
  private peck = 0;
  private flap = 0;

  constructor(pos: THREE.Vector3) {
    const c = rng.pick(BIRD_COLORS);
    const g = new GeoBuilder();
    g.add(sphere(0.1, 10, 8), c.body, compose(0, 0.13, 0, 0, 0, 0, 0.9, 0.85, 1.25));
    g.add(sphere(0.075, 8, 6), c.belly, compose(0, 0.1, 0.04, 0, 0, 0, 0.8, 0.75, 1));
    g.add(box(0.07, 0.02, 0.14), c.wing, compose(0, 0.16, -0.14, -0.35, 0, 0));
    g.add(box(0.012, 0.08, 0.012), 0xd08a4a, compose(0.03, 0.04, 0));
    g.add(box(0.012, 0.08, 0.012), 0xd08a4a, compose(-0.03, 0.04, 0));
    this.group.add(new THREE.Mesh(g.build(), vcToon()));
    const hg = new GeoBuilder();
    hg.add(sphere(0.068, 8, 6), c.body, compose(0, 0, 0));
    hg.add(cone(0.022, 0.07, 5), 0xe9a54a, compose(0, -0.005, 0.08, Math.PI / 2, 0, 0));
    hg.add(sphere(0.013, 5, 4), 0x2b2226, compose(0.045, 0.02, 0.04));
    hg.add(sphere(0.013, 5, 4), 0x2b2226, compose(-0.045, 0.02, 0.04));
    this.head.add(new THREE.Mesh(hg.build(), vcToon()));
    this.head.position.set(0, 0.23, 0.1);
    this.group.add(this.head);
    for (const [w, s] of [
      [this.wingL, 1],
      [this.wingR, -1],
    ] as [THREE.Group, number][]) {
      const wm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.015, 0.12), toon(c.wing));
      wm.position.x = s * 0.1;
      w.add(wm);
      w.position.set(s * 0.06, 0.17, 0);
      this.group.add(w);
    }
    this.group.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o.castShadow = true), undefined) : undefined));
    this.pos.copy(pos);
    this.group.position.copy(pos);
  }

  scare(from: THREE.Vector3): void {
    if (this.state !== 'ground' && this.state !== 'return') return;
    this.state = 'flee';
    const away = this.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 0.01) away.set(rng.spread(1), 0, rng.spread(1));
    away.normalize();
    away.x += rng.spread(0.5);
    away.z += rng.spread(0.5);
    away.normalize();
    this.vel.copy(away).multiplyScalar(rng.range(4, 6)).setY(rng.range(4, 6));
    this.timer = rng.range(2.5, 3.5);
  }

  update(dt: number, t: number, player: THREE.Vector3, onFlap: (p: THREE.Vector3) => void): void {
    switch (this.state) {
      case 'ground': {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.timer = rng.range(0.4, 1.6);
          if (rng.chance(0.55)) {
            this.hop = 1;
            const a = this.yaw + rng.spread(1.2);
            this.vel.set(Math.sin(a) * rng.range(0.4, 0.9), 0, Math.cos(a) * rng.range(0.4, 0.9));
            this.yaw = a;
          } else this.peck = 1;
        }
        if (this.hop > 0) {
          this.hop -= dt * 4;
          this.pos.addScaledVector(this.vel, dt);
          this.pos.y = Math.sin(Math.max(0, this.hop) * Math.PI) * 0.08;
        } else this.pos.y = 0;
        if (this.peck > 0) this.peck -= dt * 3;
        this.head.rotation.x = Math.sin(Math.max(0, this.peck) * Math.PI) * 1.1;
        this.wingL.visible = false;
        this.wingR.visible = false;
        if (player.distanceTo(this.pos) < 3.2) {
          this.scare(player);
          onFlap(this.pos);
        }
        break;
      }
      case 'flee': {
        this.timer -= dt;
        this.vel.y += dt * 3;
        this.pos.addScaledVector(this.vel, dt);
        this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 10, dt);
        this.flap += dt * 26;
        if (this.timer <= 0) {
          this.state = 'away';
          this.timer = rng.range(18, 35);
          this.group.visible = false;
        }
        break;
      }
      case 'away': {
        this.timer -= dt;
        if (this.timer <= 0) {
          // pick a quiet landing spot far from the player
          for (let i = 0; i < 20; i++) {
            const x = rng.range(LAYOUT.bounds.minX + 4, LAYOUT.bounds.maxX - 4);
            const z = rng.range(LAYOUT.bounds.minZ + 4, LAYOUT.bounds.maxZ - 4);
            if (!isOpenGround(x, z, 0.5) || Math.hypot(x - player.x, z - player.z) < 12) continue;
            this.target.set(x, 0, z);
            const a = rng.angle();
            this.pos.set(x + Math.cos(a) * 18, 10, z + Math.sin(a) * 18);
            this.state = 'return';
            this.group.visible = true;
            break;
          }
          if (this.state !== 'return') this.timer = 5;
        }
        break;
      }
      case 'return': {
        const to = this.target.clone().sub(this.pos);
        const d = to.length();
        const sp = Math.min(6, 1 + d * 0.6);
        this.vel.copy(to).divideScalar(Math.max(d, 1e-3)).multiplyScalar(sp);
        this.pos.addScaledVector(this.vel, dt);
        this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 6, dt);
        this.flap += dt * (d > 3 ? 22 : 10);
        if (d < 0.08) {
          this.pos.copy(this.target);
          this.state = 'ground';
          this.timer = 1;
        }
        break;
      }
    }
    if (this.state === 'flee' || this.state === 'return') {
      this.wingL.visible = true;
      this.wingR.visible = true;
      const f = Math.sin(this.flap) * 1.1;
      this.wingL.rotation.z = f;
      this.wingR.rotation.z = -f;
      this.head.rotation.x = 0;
    }
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const tilt = this.state === 'flee' ? -0.4 : 0;
    this.group.rotation.x = damp(this.group.rotation.x, tilt, 8, dt);
    void t;
  }
}

class Butterfly {
  readonly group = new THREE.Group();
  private wl: THREE.Mesh;
  private wr: THREE.Mesh;
  private phase = rng.angle();
  private seed = rng.range(0, 100);
  private scatter = 0;

  constructor(
    private home: THREE.Vector3,
    color: number,
  ) {
    const tex = canvasTexture('butterfly-wing', 64, 64, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(70,50,60,0.9)';
      ctx.lineWidth = 3;
      // upper lobe
      ctx.beginPath();
      ctx.ellipse(34, 22, 26, 18, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // lower lobe
      ctx.beginPath();
      ctx.ellipse(26, 46, 16, 13, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(70,50,60,0.55)';
      ctx.beginPath();
      ctx.arc(44, 18, 5, 0, Math.PI * 2);
      ctx.fill();
    });
    const geo = new THREE.PlaneGeometry(0.16, 0.16);
    geo.translate(0.08, 0, 0);
    geo.rotateX(-Math.PI / 2);
    const mat = toonUnique(color, { map: tex, side: THREE.DoubleSide });
    mat.alphaTest = 0.5;
    this.wl = new THREE.Mesh(geo, mat);
    this.wr = new THREE.Mesh(geo, mat);
    this.wr.scale.x = -1;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.07, 2, 4), toon(0x4a3a3a));
    body.rotation.x = Math.PI / 2;
    this.group.add(this.wl, this.wr, body);
  }

  scare(): void {
    this.scatter = 2.5;
  }

  update(dt: number, t: number): void {
    this.scatter = Math.max(0, this.scatter - dt);
    const r = 1.4 + this.scatter * 2;
    const x = this.home.x + noise.noise2(t * 0.25, this.seed) * r;
    const z = this.home.z + noise.noise2(this.seed, t * 0.25) * r;
    const y = 0.7 + noise.noise2(t * 0.6, this.seed + 7) * 0.35 + this.scatter * 0.8;
    const prev = this.group.position.clone();
    this.group.position.set(x, y, z);
    const d = this.group.position.clone().sub(prev);
    if (d.lengthSq() > 1e-8) this.group.rotation.y = Math.atan2(d.x, d.z);
    const f = Math.sin(t * 22 + this.phase) * 1.1;
    this.wl.rotation.z = f;
    this.wr.rotation.z = -f;
  }
}

/** Birds, butterflies and ambient chirps – the little life that makes the farm feel cozy. */
export class Ambient implements Updatable, NoiseListener {
  readonly group = new THREE.Group();
  private birds: Bird[] = [];
  private butterflies: Butterfly[] = [];
  private chirpTimer = 3;

  constructor(private ctx: GameCtx) {
    const spots: [number, number][] = [
      [-6.5, -0.5],
      [-5.6, 0.4],
      [3.2, -5.5],
      [4, -4.8],
      [-18, 3.5],
      [7.5, 5],
      [-2, -16],
      [22, -8],
    ];
    for (const [x, z] of spots) {
      const b = new Bird(new THREE.Vector3(x + rng.spread(0.5), 0, z + rng.spread(0.5)));
      this.birds.push(b);
      this.group.add(b.group);
    }
    const flowers: [number, number, number][] = [
      [-12.9, -2.6, 0xf6d36b],
      [-7.1, -2.4, 0xf2f2f2],
      [-14.2, 1.5, 0xf3a3c0],
      [18, 3.5, 0xa9c8f0],
    ];
    for (const [x, z, c] of flowers) {
      const bf = new Butterfly(new THREE.Vector3(x, 0, z), c);
      this.butterflies.push(bf);
      this.group.add(bf.group);
    }
  }

  hear(pos: THREE.Vector3, radius: number): void {
    let flapped = false;
    for (const b of this.birds) {
      if (b.pos.distanceTo(pos) < radius) {
        const before = b.state;
        b.scare(pos);
        if (!flapped && before === 'ground') {
          sfx.birdsFlap(b.pos);
          flapped = true;
        }
      }
    }
    for (const bf of this.butterflies) if (bf.group.position.distanceTo(pos) < radius * 0.6) bf.scare();
  }

  update(dt: number, t: number): void {
    const player = this.ctx.playerPos;
    for (const b of this.birds) b.update(dt, t, player, (p) => sfx.birdsFlap(p));
    for (const bf of this.butterflies) bf.update(dt, t);
    this.chirpTimer -= dt;
    if (this.chirpTimer <= 0) {
      this.chirpTimer = rng.range(2.5, 7);
      const grounded = this.birds.filter((b) => b.state === 'ground');
      if (grounded.length) sfx.chirp(rng.pick(grounded).pos, 0.1);
    }
  }
}
