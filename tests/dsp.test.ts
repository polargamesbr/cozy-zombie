import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { chordTones, karplusStrong, makeImpulseResponse, melodyBar, midiToFreq, PROGRESSIONS, SCALES } from '../src/audio/dsp';

describe('dsp', () => {
  it('builds a decaying stereo impulse response', () => {
    const [l, r] = makeImpulseResponse(22050, 2);
    expect(l.length).toBe(44100);
    expect(r.length).toBe(44100);
    const energy = (a: Float32Array, from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += a[i] * a[i];
      return e;
    };
    // the tail dies away
    expect(energy(l, 0, 11025)).toBeGreaterThan(energy(l, 33075, 44100) * 20);
    expect(l.some((v) => Number.isNaN(v))).toBe(false);
  });

  it('plucks a string at the requested pitch that fades out', () => {
    const sr = 44100;
    const f = midiToFreq(57); // A3 = 220 Hz
    const d = karplusStrong(sr, f, 1.5, 0.5);
    // autocorrelation peak → period of the note
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = 60; lag < 400; lag++) {
      let c = 0;
      for (let i = 2000; i < 6000; i++) c += d[i] * d[i + lag];
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    expect(Math.abs(bestLag - sr / f)).toBeLessThan(3);
    const rms = (from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += d[i] * d[i];
      return Math.sqrt(e / (to - from));
    };
    expect(rms(0, 4410)).toBeGreaterThan(rms(sr, sr + 4410) * 3);
  });

  it('writes melodies that stay in the scale and land on chord tones on strong beats', () => {
    const rng = new Rng(3);
    for (const mode of ['calm', 'tense'] as const) {
      for (const chord of PROGRESSIONS[mode]) {
        const tones = chordTones(chord).map((m) => (((m - 2) % 12) + 12) % 12);
        const allowed = new Set([...SCALES[mode], ...tones]);
        for (let k = 0; k < 20; k++) {
          for (const [step, midi, len] of melodyBar(chord, mode, rng)) {
            const pc = (((midi - 2) % 12) + 12) % 12;
            expect(allowed.has(pc)).toBe(true);
            if (step % 4 === 0) expect(tones).toContain(pc);
            expect(len).toBeGreaterThan(0);
            expect(step).toBeLessThan(16);
          }
        }
      }
    }
  });
});
