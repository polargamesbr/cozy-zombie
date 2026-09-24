import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Ragdoll, J, JOINT_COUNT } from '../src/physics/ragdoll';
import { PhysicsWorld, PHYS_DT, GRAVITY } from '../src/physics/world';
import { StaticCollider } from '../src/physics/colliders';

function makeRagdoll(): Ragdoll {
  const s = 1;
  const radii = [0.27, 0.11, 0.11, 0.11, 0.11, 0.07, 0.07, 0.08, 0.08];
  const masses = [3, 4, 4, 4, 4, 0.8, 0.8, 1, 1];
  const rd = new Ragdoll(radii, masses);
  const rest: THREE.Vector3[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) rest.push(new THREE.Vector3());
  rest[J.head].set(0, 0.98 * s, 0);
  rest[J.shoulderL].set(0.2, 0.64, 0);
  rest[J.shoulderR].set(-0.2, 0.64, 0);
  rest[J.hipL].set(0.1, 0.34, 0);
  rest[J.hipR].set(-0.1, 0.34, 0);
  rest[J.handL].set(0.2, 0.36, 0);
  rest[J.handR].set(-0.2, 0.36, 0);
  rest[J.footL].set(0.1, 0.08, 0);
  rest[J.footR].set(-0.1, 0.08, 0);
  const T = [J.shoulderL, J.shoulderR, J.hipL, J.hipR];
  for (let i = 0; i < 4; i++) for (let k = i + 1; k < 4; k++) rd.link(T[i], T[k], rest);
  rd.link(J.head, J.shoulderL, rest);
  rd.link(J.head, J.shoulderR, rest);
  rd.link(J.handL, J.shoulderL, rest);
  rd.link(J.handR, J.shoulderR, rest);
  rd.link(J.footL, J.hipL, rest);
  rd.link(J.footR, J.hipR, rest);
  return Object.assign(rd, { rest });
}

function launch(vx: number, vy: number, world = new PhysicsWorld()): { rd: Ragdoll; dist: number; maxH: number } {
  const rd = makeRagdoll();
  const rest = (rd as unknown as { rest: THREE.Vector3[] }).rest;
  rd.setPositions(rest, rest.map(() => new THREE.Vector3(vx, vy, 0)));
  world.addRagdoll(rd);
  let maxH = 0;
  for (let i = 0; i < 120 * 4; i++) {
    world.update(PHYS_DT);
    maxH = Math.max(maxH, rd.p[J.hipL * 3 + 1]);
  }
  const c = rd.center(new THREE.Vector3());
  return { rd, dist: c.x, maxH };
}

describe('ragdoll', () => {
  it('flies, lands and only skids a little after a shotgun-like launch', () => {
    const vx = 9.6;
    const vy = 6.6;
    const { dist, maxH } = launch(vx, vy);
    // ballistic flight of the pelvis (launched from ~0.35 m), then a short skid
    const t = (vy + Math.sqrt(vy * vy + 2 * -GRAVITY * 0.3)) / -GRAVITY;
    const flight = vx * t;
    expect(dist).toBeGreaterThan(flight * 0.8);
    expect(dist).toBeLessThan(flight + 1.6);
    expect(maxH).toBeGreaterThan(0.8);
  });

  it('comes to rest (sleeps) after a few seconds', () => {
    const { rd } = launch(4, 3);
    expect(rd.sleeping).toBe(true);
  });

  it('does not explode when spawned inside a wall', () => {
    const world = new PhysicsWorld();
    world.addStatic(StaticCollider.box(0, 0, 2, 2, 3));
    const { dist } = launch(0, 0, world);
    // it has to leave the 4x4 box, but calmly
    expect(Math.abs(dist)).toBeLessThan(3.2);
  });
});

describe('ragdoll in water', () => {
  it('floats at the surface, then sinks to the bottom without buoyancy', () => {
    const world = new PhysicsWorld();
    world.water = () => 1;
    const rd = makeRagdoll();
    const rest = (rd as unknown as { rest: THREE.Vector3[] }).rest;
    rd.setPositions(rest.map((p) => p.clone().setY(p.y + 1)), rest.map(() => new THREE.Vector3(2, 0, 0)));
    world.addRagdoll(rd);
    for (let i = 0; i < 120 * 3; i++) world.update(PHYS_DT);
    const floating = rd.center(new THREE.Vector3());
    expect(floating.y).toBeGreaterThan(-0.25);
    expect(floating.y).toBeLessThan(0.4);
    // heavy drag: it doesn't glide across the pond
    expect(floating.x).toBeLessThan(2.5);
    expect(rd.submerged).toBeGreaterThan(3);
    rd.buoyancy = 0;
    rd.wake();
    for (let i = 0; i < 120 * 4; i++) world.update(PHYS_DT);
    expect(rd.center(new THREE.Vector3()).y).toBeLessThan(-0.6);
  });
});
