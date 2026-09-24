/**
 * Pure DSP / music-theory helpers (no WebAudio objects here, so they are unit-testable in Node).
 */
import { Rng } from '../core/rng';

/**
 * Stereo impulse response for an open-air farm: a few sparse early reflections (house, barn,
 * trees) followed by a short, darkening diffuse tail. Returns [left, right].
 */
export function makeImpulseResponse(sampleRate: number, seconds = 2.2, seed = 7): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.floor(sampleRate * seconds));
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const r = new Rng(seed);
  const pre = Math.floor(sampleRate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch];
    // early reflections
    for (let k = 0; k < 9; k++) {
      const t = 0.018 + r.next() * 0.11;
      const i = Math.floor(t * sampleRate);
      if (i < n) d[i] += (r.next() * 0.7 + 0.3) * (1 - t * 4) * (r.chance(0.5) ? 1 : -1) * 0.8;
    }
    // diffuse tail with a one-pole lowpass whose cutoff falls over time (air absorbs highs)
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp(-t / 0.42) * Math.min(1, t / 0.03);
      const k = 0.55 - 0.45 * Math.min(1, t / seconds);
      lp += (r.next() * 2 - 1 - lp) * k;
      d[i] += lp * env * 0.55;
    }
  }
  // normalise to a sane peak
  let peak = 0;
  for (const d of out) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (const d of out) for (let i = 0; i < n; i++) d[i] /= peak;
  return out;
}

/**
 * Karplus–Strong plucked string rendered offline. Warm and slightly nylon-like when `brightness`
 * is low. `decay` scales the sustain (1 = natural).
 */
export function karplusStrong(sampleRate: number, freq: number, seconds: number, brightness = 0.5, decay = 1, seed = 1): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds));
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(sampleRate / freq));
  const buf = new Float32Array(period);
  const r = new Rng(seed + Math.round(freq * 13));
  // excitation: filtered noise burst (lower brightness = softer pick)
  let prev = 0;
  for (let i = 0; i < period; i++) {
    const w = r.next() * 2 - 1;
    prev += (w - prev) * (0.15 + brightness * 0.85);
    buf[i] = prev;
  }
  // loop gain chosen so the note rings for ~`seconds * decay`
  const cyclesPerSecond = sampleRate / period;
  const g = Math.pow(0.001, 1 / Math.max(1, cyclesPerSecond * seconds * 0.85 * decay));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx];
    const b = buf[(idx + 1) % period];
    out[i] = a;
    buf[idx] = (a + b) * 0.5 * g;
    idx = (idx + 1) % period;
  }
  // tiny fade in/out to avoid clicks
  const fi = Math.min(n, Math.floor(sampleRate * 0.002));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  const fo = Math.min(n, Math.floor(sampleRate * 0.05));
  for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export type ChordQuality = 'maj7' | 'm7' | 'maj' | 'min' | '6' | '7';

const QUALITIES: Record<ChordQuality, number[]> = {
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '6': [0, 4, 7, 9],
  '7': [0, 4, 7, 10],
};

export interface Chord {
  root: number;
  quality: ChordQuality;
}

export function chordTones(c: Chord): number[] {
  return QUALITIES[c.quality].map((i) => c.root + i);
}

/** Cozy D-major loop, and its darker parallel-minor twin used while fighting. */
export const PROGRESSIONS: Record<'calm' | 'tense', Chord[]> = {
  calm: [
    { root: 50, quality: 'maj7' }, // Dmaj7
    { root: 47, quality: 'm7' }, // Bm7
    { root: 43, quality: 'maj7' }, // Gmaj7
    { root: 45, quality: '6' }, // A6
  ],
  tense: [
    { root: 50, quality: 'min' }, // Dm
    { root: 46, quality: 'maj' }, // Bb
    { root: 43, quality: 'min' }, // Gm
    { root: 45, quality: '7' }, // A7
  ],
};

/** D major pentatonic (calm) and D harmonic minor flavour (tense), as semitone offsets. */
export const SCALES = {
  calm: [0, 2, 4, 7, 9],
  tense: [0, 2, 3, 7, 8],
};

/**
 * A short melodic phrase over one bar (16 steps): returns [step, midi, length-in-steps].
 * Strong beats snap to chord tones so it always sounds "right".
 */
export function melodyBar(chord: Chord, mode: 'calm' | 'tense', rng: Rng, octaveBase = 74): [number, number, number][] {
  const templates = [
    [0, 4, 6, 8, 12],
    [0, 3, 6, 10, 12, 14],
    [2, 4, 8, 11],
    [0, 8, 10, 12],
    [0, 2, 4, 6, 8],
  ];
  const steps = rng.pick(templates);
  const scale = SCALES[mode];
  // chord tones as offsets from the key root (D, pitch class 2)
  const tones = chordTones(chord).map((m) => (((m - 2) % 12) + 12) % 12);
  const notes: [number, number, number][] = [];
  let degree = rng.int(0, scale.length - 1);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const strong = s % 4 === 0;
    degree = Math.max(0, Math.min(scale.length * 2 - 1, degree + rng.pick([-1, -1, 0, 1, 1, 2, -2])));
    let pc = scale[degree % scale.length] + (degree >= scale.length ? 12 : 0);
    if (strong) {
      // snap to the nearest chord tone
      let best = pc;
      let bestD = 99;
      for (const t of tones) {
        for (const o of [-12, 0, 12]) {
          const d = Math.abs(t + o - pc);
          if (d < bestD) {
            bestD = d;
            best = t + o;
          }
        }
      }
      pc = best;
    }
    const next = steps[i + 1] ?? 16;
    notes.push([s, octaveBase + pc, Math.min(4, next - s)]);
  }
  return notes;
}
