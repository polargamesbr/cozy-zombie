import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../src/physics/world';
import { StaticCollider } from '../src/physics/colliders';
import { NavGrid } from '../src/world/navgrid';

describe('nav grid', () => {
  it('climbs over a long fence but walks around a wall', () => {
    const world = new PhysicsWorld();
    const barrier = StaticCollider.box(0, 0, 12, 0.08, 1.0);
    barrier.climbable = true;
    world.addStatic(barrier);
    const nav = new NavGrid(world);
    nav.compute(0, -4);
    const d = { x: 0, z: 0 };
    expect(nav.direction(0, 4, d)).toBe(true);
    // straight at the fence: going around would be a 16 m detour
    expect(d.z).toBeLessThan(-0.7);

    barrier.climbable = false;
    nav.markDirty();
    nav.compute(0, -4);
    expect(nav.direction(0, 4, d)).toBe(true);
    // a real wall: the field leads sideways around its end
    expect(Math.abs(d.x)).toBeGreaterThan(0.5);
  });
});
