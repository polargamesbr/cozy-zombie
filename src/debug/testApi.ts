import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { HitPart, ZombieType } from '../entities/zombie';
import type { FaceKind } from '../render/textures';
import type { WeaponId } from '../entities/weapons';
import { sfx } from '../audio/sfx';

/**
 * `window.__game` – a small automation surface used by the screenshot script (and handy in the
 * browser console). In `?test` mode the game loop is paused and time only advances through
 * `advance()`, which makes captures deterministic.
 */
export function installTestApi(game: Game): void {
  const api = {
    game,
    ready: true,
    advance(seconds: number, fps = 60): void {
      const n = Math.max(1, Math.round(seconds * fps));
      for (let i = 0; i < n; i++) game.tick(1 / fps);
      game.render();
    },
    render(): void {
      game.render();
    },
    camera(opts: { yaw?: number; zoom?: number }): void {
      if (opts.yaw !== undefined) game.cam.yaw = opts.yaw;
      if (opts.zoom !== undefined) {
        game.cam.zoomTarget = opts.zoom;
        game.cam.distance = opts.zoom;
      }
    },
    snapCamera(): void {
      game.cam.snapTo(game.player.pos);
    },
    teleport(x: number, z: number, yaw?: number): void {
      game.player.pos.set(x, 0, z);
      game.player.body.x = x;
      game.player.body.z = z;
      if (yaw !== undefined) game.player.yaw = yaw;
      game.cam.snapTo(game.player.pos);
    },
    aim(x: number, z: number, y = 0.72): void {
      game.aimOverride = new THREE.Vector3(x, y, z);
    },
    clearAim(): void {
      game.aimOverride = null;
    },
    fire(): void {
      game.input.clickButton(0, true);
      game.tick(1 / 60);
      game.input.releaseButton(0);
    },
    key(code: string, hold = false): void {
      game.input.press(code, hold);
    },
    release(code: string): void {
      game.input.release(code);
    },
    weapon(id: WeaponId): void {
      game.input.press(id === 'pistol' ? 'Digit1' : 'Digit2');
    },
    spawn(type: ZombieType, x: number, z: number, alert = false): number {
      const zb = game.spawnZombie(type, x, z);
      if (alert) zb.alert();
      return game.zombies.length - 1;
    },
    freeze(on: boolean): void {
      for (const z of game.zombies) z.frozen = on;
    },
    clearZombies(): void {
      for (const z of game.zombies) z.remove();
      game.zombies = [];
      game.total = 0;
      game.killed = 0;
    },
    explode(x: number, z: number, power = 1): void {
      game.explode(new THREE.Vector3(x, 0.4, z), power);
    },
    /** Shoot a zombie in a given body part (goes through the normal hit path). */
    hit(i: number, part: HitPart, dmg: number, weapon: 'pistol' | 'shotgun' = 'pistol', dist = 3): void {
      const z = game.zombies[i];
      if (!z) return;
      const from = game.player.pos;
      const dir = new THREE.Vector3(z.pos.x - from.x, 0, z.pos.z - from.z).normalize();
      const y = part === 'head' ? 1 : part === 'legL' || part === 'legR' ? 0.2 : part === 'torso' ? 0.5 : 0.6;
      const point = z.pos.clone().setY(y * z.model.s).addScaledVector(dir, -0.3);
      z.takeHit(dmg, dir.clone().multiplyScalar(weapon === 'shotgun' ? 12 : 5), point, part === 'head', weapon, dist, { [part]: dmg });
    },
    tearArm(i: number, side: 0 | 1): void {
      const z = game.zombies[i];
      if (z) z.tearArm(side, new THREE.Vector3(Math.sin(z.yaw + (side ? -1.2 : 1.2)), 0.3, Math.cos(z.yaw + (side ? -1.2 : 1.2))));
    },
    express(i: number, kind: FaceKind, seconds = 1): void {
      const m = i < 0 ? game.player.model : game.zombies[i]?.model;
      m?.express(kind, seconds);
    },
    godMode(): void {
      game.player.invincible = true;
    },
    /** Audio smoke test helpers. */
    audio: {
      unlock: () => sfx.unlock(),
      level: () => sfx.level(),
      state: () => ({ ready: sfx.ready, mode: sfx.music?.currentMode ?? null }),
      intensity: (v: number) => sfx.music?.setIntensity(v),
      shots: () => {
        const p = game.player.pos.clone();
        sfx.pistol(p.clone().add(new THREE.Vector3(3, 0, 0)));
        sfx.shotgun(p.clone().add(new THREE.Vector3(-4, 0, 2)));
        sfx.explosion(p.clone().add(new THREE.Vector3(8, 0, -6)));
        sfx.groan(p.clone().add(new THREE.Vector3(2, 0, 2)));
        sfx.woodBreak(p.clone().add(new THREE.Vector3(-2, 0, -2)));
      },
      stinger: (k: 'clear' | 'death') => sfx.music?.stinger(k),
    },
    /** Debug: what is under a screen pixel? */
    pick(px: number, py: number) {
      const ray = new THREE.Raycaster();
      const nx = (px / window.innerWidth) * 2 - 1;
      const ny = -(py / window.innerHeight) * 2 + 1;
      ray.setFromCamera(new THREE.Vector2(nx, ny), game.cam.camera);
      const hits = ray.intersectObjects(game.scene.children, true).slice(0, 6);
      return hits.map((h) => {
        const chain: string[] = [];
        let o: THREE.Object3D | null = h.object;
        while (o) {
          chain.push(o.name || o.type);
          o = o.parent;
        }
        const m = (h.object as THREE.Mesh).material as THREE.Material;
        return { dist: +h.distance.toFixed(2), point: h.point.toArray().map((v) => +v.toFixed(2)), type: h.object.type, mat: m?.type, instanceId: h.instanceId, chain: chain.join(' < '), geo: (h.object as THREE.Mesh).geometry?.type };
      });
    },
    state() {
      return {
        time: game.time,
        state: game.state,
        player: { x: game.player.pos.x, z: game.player.pos.z, hp: game.player.hp, weapon: game.player.weapon.id, ammo: game.player.currentAmmo },
        zombies: game.zombies.map((z) => ({ type: z.type, x: +z.pos.x.toFixed(2), z: +z.pos.z.toFixed(2), state: z.state, hp: +z.hp.toFixed(2), crawl: z.crawl, limp: z.limpSide, arms: z.model.armLost.map((l) => !l) })),
        bodies: game.physics.bodies.length,
        ragdolls: game.physics.ragdolls.length,
        drawCalls: game.pipeline.renderer.info.render.calls,
        triangles: game.pipeline.renderer.info.render.triangles,
      };
    },
  };
  (window as unknown as { __game: typeof api }).__game = api;
}
