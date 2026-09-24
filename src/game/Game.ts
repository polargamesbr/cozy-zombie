import * as THREE from 'three';
import { clamp } from '../core/math';
import { Input } from '../core/input';
import { rng } from '../core/rng';
import { CameraRig } from '../render/cameraRig';
import { Lighting } from '../render/lighting';
import { RenderPipeline } from '../render/pipeline';
import { GLOBAL_UNIFORMS } from '../render/materials';
import { PhysicsWorld, GRAVITY } from '../physics/world';
import { Effects } from '../fx/effects';
import { sfx } from '../audio/sfx';
import { Farm } from '../world/farm';
import { NavGrid } from '../world/navgrid';
import { PUSHERS } from '../world/nature';
import { LAYOUT, isOpenGround } from '../world/layout';
import { Player, type PlayerInput } from '../entities/player';
import { Zombie, type ZombieType } from '../entities/zombie';
import { Combat } from '../entities/combat';
import { Pickup, type PickupKind } from '../entities/pickup';
import type { WeaponId } from '../entities/weapons';
import { Hud } from '../ui/hud';
import { Overlay } from '../ui/overlay';
import type { GameCtx, GrassPusher, NoiseListener, Updatable } from './context';

type GameState = 'title' | 'playing' | 'paused' | 'dead';

export interface GameOptions {
  test?: boolean;
  seed?: number;
}

export class Game implements GameCtx {
  readonly scene = new THREE.Scene();
  root = new THREE.Group();
  physics = new PhysicsWorld();
  fx = new Effects();
  readonly cam: CameraRig;
  readonly pipeline: RenderPipeline;
  readonly lighting: Lighting;
  readonly input: Input;
  readonly hud: Hud;
  readonly overlay: Overlay;
  time = 0;
  readonly playerPos = new THREE.Vector3();
  farm!: Farm;
  player!: Player;
  combat!: Combat;
  nav!: NavGrid;
  zombies: Zombie[] = [];
  pickups: Pickup[] = [];
  state: GameState = 'title';
  private updatables: Updatable[] = [];
  private listeners: NoiseListener[] = [];
  private pushers: GrassPusher[] = [];
  private hitstopT = 0;
  private slowmoT = 0;
  private slowmoDur = 1;
  private slowmoScale = 1;
  private flashT = 0;
  private hurtV = 0;
  private lastHp = 5;
  private navT = 0;
  private deadT = 0;
  private lastFrame = 0;
  private aimPoint = new THREE.Vector3();
  aimOverride: THREE.Vector3 | null = null;
  wave = 1;
  killed = 0;
  total = 0;
  private clearedT = -1;
  readonly test: boolean;
  private running = true;
  fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;

  constructor(container: HTMLElement, opts: GameOptions = {}) {
    this.test = !!opts.test;
    if (opts.seed !== undefined) rng.seed(opts.seed);
    this.cam = new CameraRig(window.innerWidth / window.innerHeight);
    this.pipeline = new RenderPipeline(container, this.scene, this.cam.camera, { preserveDrawingBuffer: this.test });
    this.lighting = new Lighting(this.scene);
    this.input = new Input(this.pipeline.domElement);
    this.hud = new Hud(document.body);
    this.overlay = new Overlay(document.body);
    this.overlay.onAction = (mode) => this.onOverlay(mode);
    this.scene.add(this.root);
    this.scene.add(this.fx.group);
    this.buildWorld();
    window.addEventListener('blur', () => {
      if (this.state === 'playing' && !this.test) this.pause();
    });
    if (this.test) {
      this.startPlaying();
    } else {
      this.state = 'title';
      this.overlay.show('title');
      this.hud.setVisible(false);
      this.cam.idleOrbit = 0.07;
    }
  }

  // ======================================================================== world lifecycle

  private buildWorld(): void {
    this.physics = new PhysicsWorld();
    this.fx.clear();
    this.fx.debris.statics = this.physics.statics;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.updatables = [];
    this.listeners = [];
    this.pushers = [];
    this.zombies = [];
    this.pickups = [];
    this.farm = new Farm(this);
    this.root.add(this.farm.group);
    this.nav = new NavGrid(this.physics);
    this.combat = new Combat(this, this.farm.pond);
    const sp = LAYOUT.playerSpawn;
    this.player = new Player(this, this.combat, sp.x, sp.z);
    this.player.yaw = 1.2;
    this.player.onDeath = () => {
      this.state = 'dead';
      this.deadT = 0;
    };
    this.playerPos.copy(this.player.pos);
    this.cam.snapTo(this.player.pos);
    this.wave = 1;
    this.killed = 0;
    this.total = 0;
    this.clearedT = -1;
    LAYOUT.zombieSpawns.forEach((s, i) => this.spawnZombie(s.type, s.x, s.z, i));
    this.nav.compute(this.player.pos.x, this.player.pos.z);
    this.lastHp = this.player.hp;
  }

  private disposeWorld(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
    this.scene.remove(this.root);
  }

  reset(): void {
    this.disposeWorld();
    this.buildWorld();
    this.hitstopT = 0;
    this.slowmoT = 0;
    this.flashT = 0;
    this.hurtV = 0;
  }

  spawnZombie(type: ZombieType, x: number, z: number, variant = rng.int(0, 5)): Zombie {
    const zb = new Zombie(this, this.nav, this.player, type, x, z, variant);
    zb.onDeath = () => {
      this.killed++;
      this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
    };
    this.zombies.push(zb);
    this.total++;
    return zb;
  }

  private spawnWave(): void {
    this.wave++;
    const n = 4 + this.wave;
    this.killed = 0;
    this.total = 0;
    for (let i = 0; i < n; i++) {
      // spawn at the edges, away from the player
      let x = 0;
      let z = 0;
      for (let k = 0; k < 30; k++) {
        const side = rng.int(0, 3);
        const b = LAYOUT.bounds;
        x = side === 0 ? b.minX + 1 : side === 1 ? b.maxX - 1 : rng.range(b.minX + 2, b.maxX - 2);
        z = side === 2 ? b.minZ + 1 : side === 3 ? b.maxZ - 1 : rng.range(b.minZ + 2, b.maxZ - 2);
        if (isOpenGround(x, z, 0.3) && Math.hypot(x - this.player.pos.x, z - this.player.pos.z) > 14) break;
      }
      const type: ZombieType = i === 0 && this.wave % 2 === 1 ? 'brute' : rng.chance(0.3) ? 'runner' : 'shambler';
      const zb = this.spawnZombie(type, x, z);
      zb.alert();
    }
    this.clearedT = -1;
    this.hud.toast(`Horda ${this.wave}! ${n} zumbis`);
    sfx.groan(this.player.pos, 0.8);
  }

  private objectiveText(): string {
    if (this.clearedT >= 0) return 'Fazenda limpa! · N: nova horda';
    return this.wave === 1 ? 'Limpe a fazenda' : `Horda ${this.wave}`;
  }

  // ======================================================================== GameCtx

  noise(pos: THREE.Vector3, radius: number): void {
    for (const l of this.listeners) l.hear(pos, radius);
  }

  hitstop(seconds: number): void {
    this.hitstopT = Math.max(this.hitstopT, seconds);
  }

  slowmo(scale: number, seconds: number): void {
    this.slowmoScale = scale;
    this.slowmoT = seconds;
    this.slowmoDur = seconds;
  }

  shake(trauma: number): void {
    this.cam.addTrauma(trauma);
  }

  add(u: Updatable): void {
    this.updatables.push(u);
  }

  addNoiseListener(l: NoiseListener): void {
    this.listeners.push(l);
  }

  addPusher(p: GrassPusher): void {
    this.pushers.push(p);
  }

  removePusher(p: GrassPusher): void {
    const i = this.pushers.indexOf(p);
    if (i >= 0) this.pushers.splice(i, 1);
  }

  groundAt(x: number, z: number): number {
    return this.physics.heightAt(x, z);
  }

  spawnPickup(kind: PickupKind, pos: THREE.Vector3): void {
    this.pickups.push(new Pickup(this, kind, pos.clone()));
  }

  explode(pos: THREE.Vector3, power: number): void {
    this.fx.explosion(pos, power);
    sfx.explosion(pos);
    this.shake(0.9 * power);
    this.hitstop(0.11);
    this.flashT = 0.12;
    this.cam.punchFov(-2.5 * power);
    GLOBAL_UNIFORMS.uGust.value.set(pos.x, 0, pos.z, this.time);
    GLOBAL_UNIFORMS.uGustStrength.value = 1.4 * power;
    this.physics.blast(pos, 7.5 * power, 15 * power);
    const R = 7.5 * power;
    for (const z of this.zombies) {
      if (z.removed) continue;
      const d = Math.hypot(z.pos.x - pos.x, z.pos.z - pos.z);
      if (d < R) z.blast(pos, 1 - d / R);
    }
    if (this.player.alive) {
      const d = Math.hypot(this.player.pos.x - pos.x, this.player.pos.z - pos.z);
      if (d < 5) {
        const dir = new THREE.Vector3(this.player.pos.x - pos.x, 0, this.player.pos.z - pos.z).normalize();
        this.player.damage(d < 2.6 ? 2 : 1, dir, 12 * (1 - d / 5) + 4);
      }
    }
    for (const b of this.farm.blastables) {
      const d = b.pos.distanceTo(pos);
      if (d < 9) b.receiver.onBlast?.(pos, 1 - d / 9);
    }
    for (const body of [...this.physics.bodies]) {
      const d = body.pos.distanceTo(pos);
      if (d < 6) body.owner?.onBlast?.(pos, 1 - d / 6);
    }
    for (const t of this.farm.trees) {
      const d = Math.hypot(t.group.position.x - pos.x, t.group.position.z - pos.z);
      if (d < 12) t.dropLeaves(Math.round(10 * (1 - d / 12)));
    }
    this.noise(pos, 45);
  }

  // ======================================================================== flow

  private startPlaying(): void {
    this.state = 'playing';
    this.overlay.show('none');
    this.hud.setVisible(true);
    this.cam.idleOrbit = 0;
    document.body.classList.add('playing');
    this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
  }

  private pause(): void {
    this.state = 'paused';
    this.overlay.show('pause');
    document.body.classList.remove('playing');
  }

  private onOverlay(mode: string): void {
    sfx.unlock();
    if (mode === 'title') {
      this.startPlaying();
      this.hud.toast('Que tarde bonita… 🌻', 2.5);
    } else if (mode === 'pause') {
      this.state = 'playing';
      this.overlay.show('none');
      document.body.classList.add('playing');
    } else if (mode === 'dead') {
      this.reset();
      this.startPlaying();
    }
  }

  start(): void {
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const realDt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      if (this.test) return; // driven manually
      this.tick(realDt);
      this.render();
      this.fpsAcc += realDt;
      this.fpsN++;
      if (this.fpsAcc > 0.5) {
        this.fps = this.fpsN / this.fpsAcc;
        this.fpsAcc = 0;
        this.fpsN = 0;
      }
    };
    requestAnimationFrame(loop);
  }

  render(): void {
    this.pipeline.render();
  }

  private readInput(): PlayerInput {
    const inp = this.input;
    let mx = 0;
    let mz = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) mz += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) mz -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    const r = this.cam.right;
    const f = this.cam.forward;
    const wx = r.x * mx + f.x * mz;
    const wz = r.z * mx + f.z * mz;
    let switchTo: WeaponId | null = null;
    if (inp.pressed('Digit1')) switchTo = 'pistol';
    if (inp.pressed('Digit2')) switchTo = 'shotgun';
    if (inp.pressed('Tab')) switchTo = this.player.weapon.id === 'pistol' ? 'shotgun' : 'pistol';
    return {
      moveX: wx,
      moveZ: wz,
      aim: this.aimPoint,
      fire: inp.button(0),
      firePressed: inp.buttonPressed(0),
      reload: inp.pressed('KeyR'),
      dodge: inp.pressed('Space') || inp.pressed('ShiftLeft'),
      switchTo,
    };
  }

  private computeAim(): void {
    if (this.aimOverride) {
      this.aimPoint.copy(this.aimOverride);
      return;
    }
    const m = this.input.mouse;
    const ray = this.cam.ray(m.nx, m.ny);
    const hit = this.physics.raycast(ray.origin, ray.direction, 200, this.player.body);
    const gunY = this.player.pos.y + 0.72;
    if (hit && (hit.kind === 'character' || hit.kind === 'body' || hit.kind === 'ragdoll')) {
      const d = Math.hypot(hit.point.x - this.player.pos.x, hit.point.z - this.player.pos.z);
      if (d > 1.4) {
        this.aimPoint.copy(hit.point);
        if (hit.kind === 'character') this.aimPoint.y = Math.max(gunY - 0.1, Math.min(hit.point.y, gunY + 0.35));
        return;
      }
    }
    const p = this.cam.screenToPlane(m.nx, m.ny, gunY);
    if (p) this.aimPoint.copy(p);
  }

  tick(realDt: number): void {
    const inp = this.input;
    if (inp.pressed('KeyM')) this.hud.toast(sfx.toggleMute() ? 'Som desligado' : 'Som ligado', 1.2);
    if (inp.pressed('Escape') && (this.state === 'playing' || this.state === 'paused')) {
      if (this.state === 'playing') this.pause();
      else this.onOverlay('pause');
    }
    if (this.state === 'paused') {
      inp.endFrame();
      return;
    }
    if (inp.pressed('KeyN') && this.state === 'playing') this.spawnWave();

    // --- time scaling (hit-stop freezes the world, camera keeps shaking)
    let scale = 1;
    if (this.hitstopT > 0) {
      this.hitstopT -= realDt;
      scale = 0.03;
    } else if (this.slowmoT > 0) {
      this.slowmoT -= realDt;
      const k = clamp(this.slowmoT / this.slowmoDur, 0, 1);
      scale = this.slowmoScale + (1 - this.slowmoScale) * (1 - k * k);
    }
    const dt = Math.min(realDt, 1 / 20) * scale;
    this.time += dt;
    GLOBAL_UNIFORMS.uTime.value = this.time;
    if (this.time - GLOBAL_UNIFORMS.uGust.value.w > 4) GLOBAL_UNIFORMS.uGustStrength.value = 0;

    // --- player
    const playing = this.state === 'playing' || this.state === 'dead';
    this.computeAim();
    const pin: PlayerInput =
      this.state === 'playing'
        ? this.readInput()
        : { moveX: 0, moveZ: 0, aim: this.aimPoint, fire: false, firePressed: false, reload: false, dodge: false, switchTo: null };
    if (this.state === 'title') pin.aim = this.player.pos.clone().add(new THREE.Vector3(Math.sin(this.time * 0.3) * 3, 0.7, 3));
    this.player.update(dt, pin);
    this.playerPos.copy(this.player.pos);

    // --- zombies
    if (playing) {
      this.navT -= dt;
      if (this.navT <= 0) {
        this.navT = 0.3;
        this.nav.compute(this.player.pos.x, this.player.pos.z);
      }
    }
    for (const z of this.zombies) if (!z.removed && this.state !== 'title') z.update(dt, this.time);
    // separation between standing characters
    const standing = this.zombies.filter((z) => !z.ragdoll && !z.removed);
    for (let i = 0; i < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        const a = standing[i];
        const b = standing[j];
        a.separate(b.pos.x, b.pos.z, b.def.radius);
        b.separate(a.pos.x, a.pos.z, a.def.radius);
      }
      if (this.player.alive) standing[i].separate(this.player.pos.x, this.player.pos.z, this.player.body.radius, 1);
    }
    this.zombies = this.zombies.filter((z) => !z.removed);

    // --- physics & world
    this.physics.update(dt);
    for (const u of this.updatables) u.update(dt, this.time);
    this.farm.update(dt, this.time);
    for (const p of this.pickups) {
      const msg = p.update(dt, this.player);
      if (msg) this.hud.toast(msg, 1.6);
    }
    this.pickups = this.pickups.filter((p) => !p.dead);
    this.fx.update(dt, GRAVITY, this.cam.camera.position);

    // --- grass pushers
    const pv = PUSHERS.value;
    let n = 0;
    for (const p of this.pushers) {
      if (n >= pv.length) break;
      const dx = p.pushPos.x - this.cam.target.x;
      const dz = p.pushPos.z - this.cam.target.z;
      if (dx * dx + dz * dz > 30 * 30) continue;
      pv[n++].set(p.pushPos.x, p.pushPos.z, p.pushRadius, 1);
    }
    for (; n < pv.length; n++) pv[n].set(0, 0, 0, 0);

    // --- objective / flow
    if (this.state === 'playing' && this.total > 0 && this.killed >= this.total && this.clearedT < 0) {
      this.clearedT = 0;
      this.hud.toast('Fazenda limpa! ✿', 3);
      this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
      this.spawnPickup('pie', this.player.pos.clone().add(new THREE.Vector3(1.5, 0.3, 1.5)));
    }
    if (this.state === 'dead') {
      this.deadT += realDt;
      if (this.deadT > 2.2 && this.overlay.mode !== 'dead') {
        this.overlay.show('dead', `Zumbis derrubados: ${this.killed}`);
        document.body.classList.remove('playing');
      }
    }

    // --- camera, light, audio, hud
    const follow = this.player.alive ? this.player.pos : this.player.pos.clone();
    const look = this.state === 'playing' && this.player.alive ? this.aimPoint : null;
    let rot = 0;
    if (inp.down('KeyQ')) rot -= 1;
    if (inp.down('KeyE')) rot += 1;
    this.cam.update(follow, look, rot, inp.orbitDX, inp.wheel, realDt);
    this.lighting.update(this.cam.target);
    sfx.setListener(this.cam.target, this.cam.right);
    // hurt / flash overlays
    if (this.player.hp < this.lastHp) this.hurtV = 1;
    this.lastHp = this.player.hp;
    this.hurtV = Math.max(this.player.hp <= 1 && this.player.alive ? 0.35 + Math.sin(this.time * 6) * 0.1 : 0, this.hurtV - realDt * 1.6);
    this.flashT = Math.max(0, this.flashT - realDt);
    this.pipeline.grade.uniforms.uHurt.value = this.hurtV;
    this.pipeline.grade.uniforms.uFlash.value = this.flashT > 0 ? (this.flashT / 0.12) * 0.12 : 0;
    const mx = inp.mouse.x;
    const my = inp.mouse.y;
    this.hud.update(realDt, this.player, mx, my);
    inp.endFrame();
  }

  stop(): void {
    this.running = false;
  }
}
