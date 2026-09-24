import * as THREE from 'three';
import { clamp } from '../core/math';
import { Input } from '../core/input';
import { rng } from '../core/rng';
import { CameraRig } from '../render/cameraRig';
import { Lighting } from '../render/lighting';
import { QUALITY_NAMES, RenderPipeline, type Quality } from '../render/pipeline';
import { GLOBAL_UNIFORMS, WINDOW_GLOWS } from '../render/materials';
import { DayCycle } from '../render/daycycle';
import { TEX } from '../fx/particles';
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
import type { BlastSource, GameCtx, GrassPusher, NoiseListener, Updatable } from './context';
import { pondDepth } from '../world/pond';

type GameState = 'title' | 'playing' | 'paused' | 'dead';

export interface GameOptions {
  test?: boolean;
  seed?: number;
  /** Skip AO, atmosphere and MSAA for slower GPUs. */
  low?: boolean;
  /** Start at the top quality tier. */
  ultra?: boolean;
}

const QUALITY_KEY = 'cozy-zombie-quality';
/** Last tier the auto-adjust settled on (next launch starts there, still adjusting). */
const QUALITY_AUTO_KEY = 'cozy-zombie-quality-auto';

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
  private perfAcc = 0;
  private perfN = 0;
  private perfCool = 4;
  /** Drop a quality tier automatically when the frame rate sags (off once the player picks one). */
  private autoQuality = true;
  private showFps = false;
  /** Countdown to the next horde after the farm is cleared. */
  private nextWaveT = -1;
  /** Time of day (0 afternoon, 1 sunset, 2 night, 3 dawn, 4 = next afternoon); eases toward the target. */
  dayT = 0;
  private dayTarget = 0;
  readonly dayCycle: DayCycle;
  /** Warm light carried by the player at night (always in the scene: a stable light count). */
  private lantern = new THREE.PointLight(0xffc27a, 0, 11, 1.4);
  /** Zombies still to come out this wave (barn hordes trickle out). */
  private pending: { t: number; type: ZombieType; x: number; z: number; push: THREE.Vector3 | null }[] = [];
  private barnBurstT = -1;
  private repairT = 0;
  private repairSfxT = 0;
  /** Slow-motion close-up on the last kill of a wave. */
  private killCam: { t: number; z: Zombie } | null = null;

  constructor(container: HTMLElement, opts: GameOptions = {}) {
    this.test = !!opts.test;
    if (opts.seed !== undefined) rng.seed(opts.seed);
    this.cam = new CameraRig(window.innerWidth / window.innerHeight);
    this.pipeline = new RenderPipeline(container, this.scene, this.cam.camera, { preserveDrawingBuffer: this.test, lowQuality: !!opts.low });
    this.lighting = new Lighting(this.scene);
    this.pipeline.enableAtmosphere(this.lighting.sun);
    // default to Média: smooth almost everywhere; P goes up to Alta/Ultra on strong GPUs
    let q: Quality = opts.low ? 3 : opts.ultra ? 0 : 2;
    if (this.test) {
      this.autoQuality = false;
      if (!opts.low && !opts.ultra) q = 1;
    } else if (!opts.low && !opts.ultra) {
      try {
        const saved = localStorage.getItem(QUALITY_KEY);
        const auto = localStorage.getItem(QUALITY_AUTO_KEY);
        if (saved !== null && /^[0-3]$/.test(saved)) {
          q = Number(saved) as Quality;
          this.autoQuality = false;
        } else if (auto !== null && /^[0-3]$/.test(auto)) q = Number(auto) as Quality;
      } catch {
        // storage blocked: just use the default
      }
    }
    this.pipeline.setQuality(q);
    this.dayCycle = new DayCycle(this.lighting, this.pipeline);
    this.scene.add(this.lantern);
    this.input = new Input(this.pipeline.domElement);
    this.hud = new Hud(document.body);
    this.overlay = new Overlay(document.body);
    this.overlay.onAction = (mode) => this.onOverlay(mode);
    this.scene.add(this.root);
    this.scene.add(this.fx.group, this.fx.lights);
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
    this.physics.water = pondDepth;
    this.fx.clear();
    this.fx.debris.statics = this.physics.statics;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.updatables = [];
    this.listeners = [];
    this.pushers = [];
    this.zombies = [];
    this.pickups = [];
    WINDOW_GLOWS.length = 0;
    this.farm = new Farm(this);
    this.root.add(this.farm.group);
    this.nav = new NavGrid(this.physics);
    this.combat = new Combat(this, this.farm.pond);
    const sp = LAYOUT.playerSpawn;
    this.player = new Player(this, this.combat, sp.x, sp.z);
    this.player.yaw = 1.2;
    // audio hooks: walls muffle sounds, the barn and house throw echoes back
    sfx.occluded = (p) => !this.physics.segmentClear(this.cam.target.x, this.cam.target.z, p.x, p.z, 1.2);
    sfx.reflectors = [
      new THREE.Vector3(LAYOUT.barn.x, 2.5, LAYOUT.barn.z + LAYOUT.barn.d / 2),
      new THREE.Vector3(LAYOUT.house.x, 1.8, LAYOUT.house.z + LAYOUT.house.d / 2),
      new THREE.Vector3(LAYOUT.barn.x - LAYOUT.barn.w / 2, 2.5, LAYOUT.barn.z),
    ];
    this.player.onDeath = () => {
      sfx.music?.stinger('death');
      sfx.soundtrack?.setDown(true);
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
    this.nextWaveT = -1;
    this.pending = [];
    this.barnBurstT = -1;
    this.dayT = 0;
    this.dayTarget = 0;
    this.dayCycle.apply(0);
    this.applyQuality(this.pipeline.quality);
  }

  /** Jump the clock (tests / screenshots). */
  setDay(t: number): void {
    this.dayT = t;
    this.dayTarget = t;
    this.dayCycle.apply(t);
  }

  /** Apply a quality tier to the renderer, the shadows and the grass density. */
  applyQuality(q: Quality): void {
    if (q !== this.pipeline.quality) this.pipeline.setQuality(q);
    this.lighting.setShadowSize(q >= 2 ? 1024 : 2048);
    const density = [1, 1, 0.65, 0.4][q];
    this.farm.group.traverse((o) => {
      const n = o.userData.lodCount as number | undefined;
      if (n !== undefined) (o as THREE.InstancedMesh).count = Math.round(n * density);
    });
  }

  private cycleQuality(): void {
    const q = ((this.pipeline.quality + 1) % 4) as Quality;
    this.autoQuality = false;
    this.applyQuality(q);
    try {
      localStorage.setItem(QUALITY_KEY, String(q));
    } catch {
      // not persisted, that's fine
    }
    this.hud.toast(`Qualidade: ${QUALITY_NAMES[q]}`, 1.6);
  }

  /** Sun goes down with each horde; at night: lit windows, a lantern, fireflies. */
  private updateDay(dt: number): void {
    if (Math.abs(this.dayTarget - this.dayT) > 1e-4) {
      const step = dt * 0.1;
      this.dayT = this.dayT < this.dayTarget ? Math.min(this.dayTarget, this.dayT + step) : Math.max(this.dayTarget, this.dayT - step);
      this.dayCycle.apply(this.dayT);
    }
    const night = this.dayCycle.night;
    const lamp = Math.max(0, (night - 0.25) / 0.75);
    const p = this.player.pos;
    this.lantern.position.set(p.x, p.y + 2.3, p.z);
    this.lantern.intensity = this.player.alive ? lamp * (9 + Math.sin(this.time * 13) * 0.3) : lamp * 3;
    if (lamp > 0.3 && rng.chance(dt * 9 * lamp)) {
      const c = this.cam.target;
      const a = rng.angle();
      const r = rng.range(2, 14);
      this.fx.particles.glow.spawn(new THREE.Vector3(c.x + Math.cos(a) * r, rng.range(0.3, 1.6), c.z + Math.sin(a) * r), {
        vel: new THREE.Vector3(rng.spread(0.4), rng.spread(0.2), rng.spread(0.4)),
        life: rng.range(2.5, 4.5),
        size: 0.07,
        color: 0xd9ff8f,
        intensity: 2.4,
        alpha: 1,
        alphaEnd: 0,
        fadeIn: 0.4,
        drag: 0.4,
        cell: TEX.soft,
      });
    }
  }

  /** Stand next to a broken fence and hold C to nail it back together. */
  private updateRepair(dt: number): void {
    let seg: (typeof this.farm.fenceSegments)[number] | null = null;
    if (this.state === 'playing' && this.player.alive) {
      let best = 1.9;
      for (const s of this.farm.fenceSegments) {
        if (!s.broken) continue;
        const d = Math.hypot(s.center.x - this.player.pos.x, s.center.z - this.player.pos.z);
        if (d < best) {
          best = d;
          seg = s;
        }
      }
    }
    if (!seg) {
      this.repairT = 0;
      this.hud.setPrompt(null);
      return;
    }
    if (this.input.down('KeyC')) {
      this.repairT += dt;
      this.repairSfxT -= dt;
      if (this.repairSfxT <= 0) {
        this.repairSfxT = 0.22;
        sfx.woodHit(seg.center.setY(0.6));
        this.fx.dust(seg.center.setY(0.3), 1, 0.5, 0xe9dcc6, 0.25);
      }
      this.hud.setPrompt(`Consertando… ${Math.min(100, Math.round((this.repairT / 1.1) * 100))}%`);
      if (this.repairT >= 1.1) {
        seg.repair();
        this.repairT = 0;
        this.feat('CONSERTADO!', seg.center.setY(1.3));
      }
    } else {
      this.repairT = 0;
      this.hud.setPrompt('Segure C para consertar a cerca');
    }
  }

  /** Frame-rate watchdog: average over ~2 s, ignoring hitches (shader compiles, tab switches). */
  private trackPerf(realDt: number): void {
    if (realDt <= 0 || realDt > 0.25) return;
    this.perfAcc += realDt;
    this.perfN++;
    this.perfCool -= realDt;
    if (this.perfAcc < 2) return;
    this.fps = this.perfN / this.perfAcc;
    this.perfAcc = 0;
    this.perfN = 0;
    const q = this.pipeline.quality;
    if (this.autoQuality && this.perfCool <= 0 && this.fps < 48 && q < 3 && this.state !== 'paused') {
      this.applyQuality((q + 1) as Quality);
      this.perfCool = 4;
      try {
        localStorage.setItem(QUALITY_AUTO_KEY, String(q + 1));
      } catch {
        // not persisted
      }
      this.hud.toast(`Qualidade ${QUALITY_NAMES[q + 1]} (auto) · P troca`, 2.2);
    }
  }

  private disposeWorld(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
    this.scene.remove(this.root);
  }

  reset(): void {
    sfx.soundtrack?.setDown(false);
    this.disposeWorld();
    this.buildWorld();
    this.hitstopT = 0;
    this.slowmoT = 0;
    this.flashT = 0;
    this.killCam = null;
    this.cam.focus = 0;
    document.body.classList.remove('killcam');
    this.hurtV = 0;
  }

  spawnZombie(type: ZombieType, x: number, z: number, variant = rng.int(0, 5)): Zombie {
    const zb = new Zombie(this, this.nav, this.player, type, x, z, variant);
    zb.onDeath = (z) => {
      this.killed++;
      this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
      if (this.state === 'playing' && this.player.alive && this.total > 0 && this.killed >= this.total) this.startKillCam(z);
    };
    this.zombies.push(zb);
    this.total++;
    return zb;
  }

  spawnWave(): void {
    this.wave++;
    const n = 4 + this.wave;
    this.killed = 0;
    this.total = 0;
    const pick = (i: number): ZombieType =>
      i === 0 && this.wave % 2 === 1 ? 'brute' : this.wave >= 2 && rng.chance(0.2) ? 'crawler' : rng.chance(0.3) ? 'runner' : 'shambler';
    // every third horde bursts out of the barn: rattling doors, then they fly off
    let fromBarn = 0;
    if (this.wave % 3 === 0) {
      fromBarn = Math.ceil(n * 0.6);
      const door = this.farm.barn.doorFront;
      this.farm.barn.rattle(1.6);
      this.barnBurstT = 1.6;
      sfx.groan(door, 0.8);
      for (let i = 0; i < fromBarn; i++) {
        const push = new THREE.Vector3(rng.spread(1.6), 0, rng.range(3, 4.5));
        this.pending.push({ t: 1.7 + i * 0.32, type: pick(i), x: door.x + rng.spread(1.1), z: door.z + 0.1, push });
      }
      this.feat('O CELEIRO!', door.clone().setY(3));
    }
    for (let i = fromBarn; i < n; i++) {
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
      const zb = this.spawnZombie(pick(i), x, z);
      zb.alert();
    }
    this.clearedT = -1;
    this.nextWaveT = -1;
    this.hud.toast(`Horda ${this.wave}! ${n} zumbis`);
    sfx.groan(this.player.pos, 0.8);
  }

  private objectiveText(): string {
    if (this.clearedT >= 0) return this.nextWaveT > 0 ? `Horda ${this.wave + 1} em ${Math.ceil(this.nextWaveT)}s · N: já` : 'Fazenda limpa!';
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

  feat(text: string, pos?: THREE.Vector3): void {
    let x = window.innerWidth / 2;
    let y = window.innerHeight * 0.3;
    if (pos) {
      const v = pos.clone().project(this.cam.camera);
      x = clamp((v.x * 0.5 + 0.5) * window.innerWidth, 90, window.innerWidth - 90);
      y = clamp((-v.y * 0.5 + 0.5) * window.innerHeight - 40, 70, window.innerHeight - 90);
    }
    this.hud.feat(text, x, y);
  }

  private startKillCam(z: Zombie): void {
    this.killCam = { t: 0, z };
    this.slowmo(0.16, 2.1);
    document.body.classList.add('killcam');
    sfx.slowmo();
    sfx.soundtrack?.slowMo(2);
  }

  explode(pos: THREE.Vector3, power: number, source?: BlastSource): void {
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
    let kills = 0;
    for (const z of this.zombies) {
      if (z.removed) continue;
      const d = Math.hypot(z.pos.x - pos.x, z.pos.z - pos.z);
      if (d < R && z.blast(pos, 1 - d / R)) kills++;
    }
    if (kills > 0 && source) {
      const label = source === 'propane' ? 'BOTIJÃO!' : source === 'truck' ? 'CAMINHONETE!' : 'KABUM!';
      this.feat(kills > 1 ? `${label} ×${kills}` : label, pos.clone().setY(1.6));
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
    sfx.soundtrack?.setPaused(true);
    this.overlay.show('pause');
    document.body.classList.remove('playing');
  }

  private onOverlay(mode: string): void {
    sfx.unlock();
    if (mode === 'title') {
      this.startPlaying();
      this.hud.toast('Que tarde bonita… 🌻', 2.5);
    } else if (mode === 'pause') {
      sfx.soundtrack?.setPaused(false);
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
      this.trackPerf(realDt);
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
      kick: inp.pressed('KeyF') || inp.pressed('KeyV'),
      throwHeld: inp.down('KeyG'),
      throwPressed: inp.pressed('KeyG'),
      throwReleased: inp.released('KeyG'),
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
        // aim where the cursor is on the body: low for legs (and crawlers), capped above the head
        if (hit.kind === 'character') this.aimPoint.y = Math.max(this.player.pos.y + 0.12, Math.min(hit.point.y, gunY + 0.35));
        return;
      }
    }
    const p = this.cam.screenToPlane(m.nx, m.ny, gunY);
    if (p) this.aimPoint.copy(p);
  }

  tick(realDt: number): void {
    const inp = this.input;
    sfx.soundtrack?.update(realDt);
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
    if (inp.pressed('KeyP')) this.cycleQuality();
    if (inp.pressed('KeyI')) this.showFps = !this.showFps;

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
    this.updatables = this.updatables.filter((u) => !u.dead);
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
    if (this.state === 'playing' && this.total > 0 && this.killed >= this.total && this.clearedT < 0 && this.pending.length === 0) {
      this.clearedT = 0;
      sfx.music?.stinger('clear');
      // the day moves on with every horde
      this.dayTarget += 0.5;
      const phase = Number.isInteger(this.dayTarget) ? this.dayTarget % 4 : -1;
      const mood = ['Um novo dia na fazenda! ☀', 'O sol está se pondo…', 'Anoiteceu. Fique perto da luz…', 'Amanhecendo…'][phase] ?? 'Mais zumbis vêm aí…';
      const broken = this.farm.fenceSegments.some((s) => s.broken);
      this.hud.toast(`Fazenda limpa! ✿ ${mood}${broken ? ' · C conserta cercas' : ''}`, 3.5);
      this.nextWaveT = 12;
      this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
      this.spawnPickup('pie', this.player.pos.clone().add(new THREE.Vector3(1.5, 0.3, 1.5)));
      if (this.player.dynamite < this.player.maxDynamite) this.spawnPickup('dynamite', this.player.pos.clone().add(new THREE.Vector3(-1.5, 0.3, 1.2)));
    }
    // barn hordes and other delayed arrivals
    if (this.barnBurstT > 0) {
      this.barnBurstT -= dt;
      if (this.barnBurstT <= 0) this.farm.barn.burstDoors();
    }
    if (this.pending.length) {
      for (const q of this.pending) q.t -= dt;
      const ready = this.pending.filter((q) => q.t <= 0);
      if (ready.length) {
        this.pending = this.pending.filter((q) => q.t > 0);
        for (const q of ready) {
          const zb = this.spawnZombie(q.type, q.x, q.z);
          if (q.push) zb.burstOut(q.push);
          else zb.alert();
        }
        this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
      }
    }
    this.updateDay(dt);
    this.updateRepair(dt);
    // the next horde comes on its own (N skips the wait)
    if (this.state === 'playing' && this.nextWaveT > 0) {
      this.nextWaveT -= dt;
      if (this.nextWaveT <= 3 && this.nextWaveT + dt > 3) sfx.groan(this.player.pos.clone().add(new THREE.Vector3(12, 0, -8)), 0.8);
      if (this.nextWaveT <= 0) this.spawnWave();
      else this.hud.setObjective(this.objectiveText(), `${this.killed}/${this.total}`);
    }
    if (this.state === 'dead') {
      this.deadT += realDt;
      if (this.deadT > 2.2 && this.overlay.mode !== 'dead') {
        this.overlay.show('dead', `Zumbis derrubados: ${this.killed}`);
        document.body.classList.remove('playing');
      }
    }

    // --- camera, light, audio, hud
    let follow = this.player.alive ? this.player.pos : this.player.pos.clone();
    let look: THREE.Vector3 | null = this.state === 'playing' && this.player.alive ? this.aimPoint : null;
    if (this.killCam) {
      // kill-cam: frame the player and the last body, pull in, letterbox
      const kc = this.killCam;
      kc.t += realDt;
      const f = kc.t < 0.25 ? kc.t / 0.25 : kc.t < 1.7 ? 1 : Math.max(0, 1 - (kc.t - 1.7) / 0.5);
      this.cam.focus = f * f * (3 - 2 * f);
      this.cam.focusPoint.lerpVectors(this.player.pos, kc.z.pos, 0.6);
      this.cam.focusZoom = 10;
      if (kc.t > 1.9) document.body.classList.remove('killcam');
      if (kc.t > 2.2 || !this.player.alive) {
        this.killCam = null;
        this.cam.focus = 0;
        document.body.classList.remove('killcam');
      }
      follow = this.player.pos;
      look = null;
    }
    let rot = 0;
    if (inp.down('KeyQ')) rot -= 1;
    if (inp.down('KeyE')) rot += 1;
    this.cam.update(follow, look, rot, inp.orbitDX, inp.wheel, realDt);
    this.lighting.update(this.cam.target);
    GLOBAL_UNIFORMS.uSunView.value.copy(this.lighting.sunDir).transformDirection(this.cam.camera.matrixWorldInverse);
    sfx.setListener(this.cam.target, this.cam.right);
    // music follows the danger: alerted zombies nearby push it toward the tense mix
    if (sfx.music) {
      let danger = 0;
      if (this.player.alive && this.state === 'playing') {
        for (const z of this.zombies) {
          if (!z.alive || !z.alerted) continue;
          const d = Math.hypot(z.pos.x - this.player.pos.x, z.pos.z - this.player.pos.z);
          if (d < 22) danger += d < 10 ? 0.55 : 0.3;
        }
      }
      sfx.music.setIntensity(Math.min(1, danger));
      sfx.soundtrack?.setIntensity(Math.min(1, danger));
    }
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
    this.hud.setFps(this.showFps ? `${Math.round(this.fps)} fps · ${QUALITY_NAMES[this.pipeline.quality]}` : null);
    inp.endFrame();
  }

  stop(): void {
    this.running = false;
  }
}
