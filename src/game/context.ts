import type * as THREE from 'three';
import type { PhysicsWorld } from '../physics/world';
import type { Effects } from '../fx/effects';
import type { CameraRig } from '../render/cameraRig';

export interface Updatable {
  update(dt: number, time: number): void;
  /** Return true to be removed from the update list. */
  dead?: boolean;
}

/** Things that care about loud noises (zombies, birds). */
export interface NoiseListener {
  hear(pos: THREE.Vector3, radius: number): void;
}

/** Objects that bend grass / get tracked by ambient systems. */
export interface GrassPusher {
  readonly pushPos: THREE.Vector3;
  readonly pushRadius: number;
}

/** Shared services handed to every world object and entity. */
export interface GameCtx {
  readonly scene: THREE.Scene;
  readonly root: THREE.Group;
  readonly physics: PhysicsWorld;
  readonly fx: Effects;
  readonly cam: CameraRig;
  time: number;
  /** Current player position (for doors, birds, ambient reactions). */
  readonly playerPos: THREE.Vector3;
  noise(pos: THREE.Vector3, radius: number): void;
  hitstop(seconds: number): void;
  slowmo(scale: number, seconds: number): void;
  shake(trauma: number): void;
  explode(pos: THREE.Vector3, power: number): void;
  add(u: Updatable): void;
  addNoiseListener(l: NoiseListener): void;
  addPusher(p: GrassPusher): void;
  removePusher(p: GrassPusher): void;
  /** Ground height (the pond is a shallow dip). */
  groundAt(x: number, z: number): number;
  /** Spawn a pickup (ammo / health). */
  spawnPickup(kind: 'ammoPistol' | 'ammoShotgun' | 'pie', pos: THREE.Vector3): void;
}
