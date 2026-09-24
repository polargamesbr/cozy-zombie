import * as THREE from 'three';
import { Rng } from '../core/rng';
import { compose } from '../core/math';
import { PAL } from '../render/palette';
import { blob, GeoBuilder, sphere } from '../render/geometry';
import { vcToon } from '../render/materials';
import type { StaticCollider, HitReceiver } from '../physics/colliders';
import type { GameCtx, Updatable } from '../game/context';
import { LAYOUT } from './layout';
import { createGround } from './ground';
import { createBush, createFlowers, createForestRing, createGrass, createReeds, createRock, Tree } from './nature';
import { Barn, House } from './buildings';
import { FenceRun, type FenceSegment } from './fences';
import { Pickup } from './vehicle';
import { Pond } from './pond';
import { Barrel, Can, Chair, Crate, FlowerPot, HayBale, Prop, PropaneTank, Pumpkin } from './props';
import { createBarricade, createClothesline, createWheelbarrow, HangingSign, LampPost, Mailbox } from './decor';
import { Ambient } from './ambient';

/** Things explosions should poke (fences, trees, car, lamps...). */
export interface Blastable {
  pos: THREE.Vector3;
  receiver: HitReceiver;
}

/** Builds and owns the whole farm scene. */
export class Farm {
  readonly group = new THREE.Group();
  readonly updatables: Updatable[] = [];
  readonly blastables: Blastable[] = [];
  readonly props: Prop[] = [];
  readonly trees: Tree[] = [];
  readonly house: House;
  readonly barn: Barn;
  readonly fenceSegments: FenceSegment[] = [];
  readonly pond: Pond;
  readonly ambient: Ambient;
  readonly car: Pickup;

  constructor(private ctx: GameCtx) {
    const g = this.group;
    g.add(createGround());
    g.add(createGrass());
    g.add(createFlowers());
    g.add(createReeds());
    g.add(createForestRing());

    this.pond = new Pond();
    g.add(this.pond.group);
    this.updatables.push(this.pond);

    this.house = new House(ctx);
    g.add(this.house.group);
    this.addColliders(this.house.colliders);
    this.updatables.push(this.house);
    this.blastables.push({ pos: this.house.doorWorld.clone(), receiver: { onBlast: (_c, s) => this.house.jolt(s * 6) } });

    this.barn = new Barn(ctx);
    g.add(this.barn.group);
    this.addColliders(this.barn.colliders);
    this.updatables.push(this.barn);
    this.blastables.push({ pos: new THREE.Vector3(LAYOUT.barn.x, 0, LAYOUT.barn.z + LAYOUT.barn.d / 2), receiver: { onBlast: (_c, s) => this.barn.blast(s) } });

    LAYOUT.trees.forEach((t, i) => {
      const tree = new Tree(ctx, t.x, t.z, t.kind as Tree['kind'], t.s, 100 + i * 17);
      g.add(tree.group);
      this.trees.push(tree);
      this.updatables.push(tree);
      this.addColliders([tree.collider]);
      this.blastables.push({ pos: new THREE.Vector3(t.x, 0, t.z), receiver: tree.collider.owner! });
    });

    LAYOUT.bushes.forEach(([x, z, s], i) => g.add(createBush(x, z, s, 40 + i, i % 3 === 0)));
    LAYOUT.rocks.forEach(([x, z, s], i) => g.add(createRock(x, z, s, i + 3)));

    LAYOUT.picketRuns.forEach((run, i) => this.addFence(new FenceRun(ctx, run, 'picket', 10 + i, 2.0)));
    LAYOUT.rusticRuns.forEach((run, i) => this.addFence(new FenceRun(ctx, run, 'rustic', 30 + i, 2.6)));

    const c = LAYOUT.car;
    this.car = new Pickup(ctx, c.x, c.z, c.rot);
    g.add(this.car.group);
    this.addColliders([this.car.collider]);
    this.updatables.push(this.car);
    this.blastables.push({ pos: new THREE.Vector3(c.x, 0, c.z), receiver: this.car });

    // decor
    const mb = new Mailbox(ctx, LAYOUT.mailbox.x, LAYOUT.mailbox.z);
    g.add(mb.group);
    this.addColliders([mb.collider]);
    this.updatables.push(mb);
    this.blastables.push({ pos: mb.group.position.clone(), receiver: mb });
    const lamp = new LampPost(ctx, LAYOUT.lampPost.x, LAYOUT.lampPost.z);
    g.add(lamp.group);
    this.addColliders([lamp.collider]);
    this.updatables.push(lamp);
    this.blastables.push({ pos: lamp.group.position.clone(), receiver: lamp });
    const sign = new HangingSign(ctx, LAYOUT.sign.x, LAYOUT.sign.z);
    g.add(sign.group);
    this.addColliders(sign.colliders);
    this.updatables.push(sign);
    this.blastables.push({ pos: sign.group.position.clone(), receiver: sign });
    g.add(createClothesline(LAYOUT.clothesline.a, LAYOUT.clothesline.b));
    g.add(createBarricade(LAYOUT.bounds.minX + 0.5, LAYOUT.road.z, Math.PI / 2));
    g.add(createBarricade(LAYOUT.bounds.maxX - 0.5, LAYOUT.road.z, Math.PI / 2));
    g.add(createWheelbarrow(16.3, 4.2, -0.6));
    g.add(this.gardenDecor());

    this.ambient = new Ambient(ctx);
    g.add(this.ambient.group);
    this.updatables.push(this.ambient);
    ctx.addNoiseListener(this.ambient);

    this.spawnProps();
  }

  private addColliders(cs: StaticCollider[]): void {
    for (const c of cs) this.ctx.physics.addStatic(c);
  }

  private addFence(run: FenceRun): void {
    this.group.add(run.group);
    for (const s of run.segments) {
      this.fenceSegments.push(s);
      this.ctx.physics.addStatic(s.collider);
      this.updatables.push(s);
      this.blastables.push({ pos: new THREE.Vector3(s.collider.x, 0.5, s.collider.z), receiver: s });
    }
  }

  private gardenDecor(): THREE.Mesh {
    const r = new Rng(606);
    const b = new GeoBuilder();
    // cabbages & lettuce in the veggie bed
    const veg = LAYOUT.beds[0];
    for (let row = 0; row < veg.rows; row++) {
      const x = veg.x - veg.w / 2 + (row + 0.5) * (veg.w / veg.rows);
      for (let k = 0; k < 5; k++) {
        const z = veg.z - veg.d / 2 + (k + 0.5) * (veg.d / 5);
        const cab = blob(0.2 + r.next() * 0.05, 1, 0.18, row * 5 + k, 0.8);
        b.add(cab, r.chance(0.5) ? 0x9cc774 : 0x86b862, compose(x + r.spread(0.05), 0.14, z + r.spread(0.05)));
        b.add(sphere(0.12, 8, 6), 0xc5e39a, compose(x, 0.24, z));
      }
    }
    // pumpkin patch vines + leaves
    const pp = LAYOUT.beds[3];
    for (let i = 0; i < 26; i++) {
      const x = pp.x + r.spread(pp.w / 2 - 0.2);
      const z = pp.z + r.spread(pp.d / 2 - 0.2);
      b.add(blob(0.2, 1, 0.2, i, 0.35), r.chance(0.5) ? PAL.leafC : PAL.leafA, compose(x, 0.05, z, 0, r.angle(), 0));
    }
    const m = new THREE.Mesh(b.build(), vcToon({ wind: 0.02, windHeight: 2 }));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  private spawnProps(): void {
    const ctx = this.ctx;
    const V = (x: number, z: number, y = 0) => new THREE.Vector3(x, y, z);
    const add = (p: Prop) => {
      this.props.push(p);
      this.updatables.push(p);
    };
    // porch
    add(new Chair(ctx, V(-11.55, -3.15, 0.34), 0.35));
    add(new Chair(ctx, V(-8.45, -3.1, 0.34), -0.4, 0xe9a36b));
    add(new FlowerPot(ctx, V(-11.35, -1.3), PAL.flowerPink));
    add(new FlowerPot(ctx, V(-8.65, -1.3), PAL.flowerYellow));
    add(new FlowerPot(ctx, V(-12.05, -2.2, 0.34), PAL.flowerLavender));
    // around the car
    add(new Can(ctx, V(3.3, 3.1), 0xd8584a));
    add(new Can(ctx, V(3.55, 3.45), 0x6fa8dc));
    add(new Can(ctx, V(-1.6, 3.9), 0x9fd08a));
    add(new Crate(ctx, V(3.6, -0.9), 0.55, 0.4));
    // barn yard
    add(new HayBale(ctx, V(8.4, -4.4), 0.25));
    add(new HayBale(ctx, V(8.9, -3.2), -0.15));
    add(new HayBale(ctx, V(8.6, -3.85, 0.62), 0.1));
    add(new HayBale(ctx, V(18.6, -2.2), 1.3));
    add(new Crate(ctx, V(16.6, -4.3), 0.75, 0.2));
    add(new Crate(ctx, V(17.5, -3.5), 0.7, -0.3));
    add(new Crate(ctx, V(17.0, -3.95, 0.75), 0.55, 0.6));
    add(new Barrel(ctx, V(19.6, -7.0)));
    add(new Barrel(ctx, V(20.1, -6.2)));
    add(new PropaneTank(ctx, V(15.2, -5.3)));
    add(new PropaneTank(ctx, V(7.2, -6.7)));
    add(new PropaneTank(ctx, V(21.8, -0.4)));
    // pumpkin patch
    const pp = LAYOUT.beds[3];
    const r = new Rng(77);
    for (let i = 0; i < 8; i++) {
      add(new Pumpkin(ctx, V(pp.x + r.spread(pp.w / 2 - 0.4), pp.z + r.spread(pp.d / 2 - 0.4)), r.range(0.75, 1.25)));
    }
    // garden
    add(new Crate(ctx, V(-15.2, 3.1), 0.5, 0.2));
    add(new FlowerPot(ctx, V(-15.3, -1.3), PAL.flowerRed));
  }

  update(dt: number, t: number): void {
    for (let i = this.updatables.length - 1; i >= 0; i--) {
      const u = this.updatables[i];
      if (u.dead) {
        this.updatables.splice(i, 1);
        continue;
      }
      u.update(dt, t);
    }
  }
}
