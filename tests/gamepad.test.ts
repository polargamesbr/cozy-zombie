import { describe, expect, it } from 'vitest';
import { Pad, PAD, type PadLike } from '../src/core/gamepad';

function fake(axes: number[], held: number[], log: Record<string, number>[]): PadLike {
  return {
    connected: true,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })),
    vibrationActuator: {
      playEffect: (_t: string, p: Record<string, number>) => {
        log.push(p);
        return Promise.resolve();
      },
    },
  };
}

describe('gamepad', () => {
  it('applies a radial dead zone and rescales the sticks', () => {
    const pad = new Pad();
    const log: Record<string, number>[] = [];
    pad.provider = () => fake([0.1, 0.1, 1, 0], [], log);
    pad.poll();
    expect(pad.lx).toBe(0);
    expect(pad.ly).toBe(0);
    expect(pad.rx).toBeCloseTo(1, 5);
    expect(pad.active).toBe(true);
  });

  it('reports button edges once', () => {
    const pad = new Pad();
    const log: Record<string, number>[] = [];
    let held: number[] = [PAD.RT];
    pad.provider = () => fake([0, 0, 0, 0], held, log);
    pad.poll();
    expect(pad.pressed(PAD.RT)).toBe(true);
    pad.poll();
    expect(pad.pressed(PAD.RT)).toBe(false);
    expect(pad.down(PAD.RT)).toBe(true);
    held = [];
    pad.poll();
    expect(pad.released(PAD.RT)).toBe(true);
  });

  it('never lets a weak rumble cut a stronger one short', () => {
    const pad = new Pad();
    const log: Record<string, number>[] = [];
    pad.provider = () => fake([0, 0, 0, 0], [], log);
    pad.poll();
    pad.rumble(0.9, 0.9, 400);
    pad.rumble(0.1, 0.2, 100);
    pad.rumble(1, 1, 200);
    expect(log.length).toBe(2);
    expect(log[0].strongMagnitude).toBeCloseTo(0.9);
    expect(log[1].strongMagnitude).toBe(1);
  });
});
