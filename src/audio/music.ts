import { Rng } from '../core/rng';
import { chordTones, karplusStrong, melodyBar, midiToFreq, PROGRESSIONS, type Chord } from './dsp';

const BPM = 86;
const STEP = 60 / BPM / 4; // sixteenth note
const LOOKAHEAD = 0.18;

/**
 * Procedural soundtrack. A cozy nylon-guitar + kalimba loop in D major that slides into its
 * parallel minor with drums and a pulsing bass when zombies are close. Everything is synthesized
 * (Karplus–Strong plucks rendered offline, oscillators for the rest).
 */
export class Music {
  private out: GainNode;
  private calm: GainNode;
  private tense: GainNode;
  private plucks = new Map<number, AudioBuffer>();
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private mode: 'calm' | 'tense' = 'calm';
  private intensity = 0;
  private target = 0;
  private rng = new Rng(2024);
  private phrase: [number, number, number][] = [];
  private noise: AudioBuffer;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
  ) {
    this.noise = noise;
    this.out = ctx.createGain();
    this.out.gain.value = 0.2;
    this.out.connect(dest);
    this.calm = ctx.createGain();
    this.tense = ctx.createGain();
    this.tense.gain.value = 0;
    this.calm.connect(this.out);
    this.tense.connect(this.out);
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 40);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** 0 = peaceful farm, 1 = full fight. Smoothed internally. */
  setIntensity(v: number): void {
    this.target = Math.max(0, Math.min(1, v));
  }

  get currentMode(): 'calm' | 'tense' {
    return this.mode;
  }

  stinger(kind: 'clear' | 'death'): void {
    this.playStinger(this.ctx.currentTime + 0.05, kind);
    if (kind === 'death') this.target = 0;
  }

  // ------------------------------------------------------------------ scheduling

  private schedule(): void {
    const ctx = this.ctx;
    // intensity rises quickly, relaxes slowly after the fight
    const k = this.target > this.intensity ? 0.08 : 0.012;
    this.intensity += (this.target - this.intensity) * k;
    const now = ctx.currentTime;
    this.calm.gain.setTargetAtTime(1 - this.intensity * 0.55, now, 0.4);
    this.tense.gain.setTargetAtTime(this.intensity, now, 0.25);
    if (this.nextTime < now - 0.5) this.nextTime = now + 0.05; // tab was asleep
    while (this.nextTime < now + LOOKAHEAD) {
      this.playStep(this.nextTime);
      this.nextTime += STEP;
      this.step++;
      if (this.step % 16 === 0) this.bar++;
    }
  }

  private playStep(t: number): void {
    const s = this.step % 16;
    if (s === 0) {
      // bar boundary: maybe switch mode (with hysteresis) and write a new phrase
      if (this.mode === 'calm' && this.intensity > 0.5) this.mode = 'tense';
      else if (this.mode === 'tense' && this.intensity < 0.18) this.mode = 'calm';
      const chord = this.chord();
      this.phrase = this.bar % 4 < 2 || this.mode === 'tense' ? melodyBar(chord, this.mode, this.rng, this.mode === 'tense' ? 62 : 74) : [];
    }
    const chord = this.chord();
    const tones = chordTones(chord);
    const calm = this.mode === 'calm';

    // ---- guitar: gentle arpeggio (calm) / muted chugs (tense)
    if (calm) {
      if (s % 2 === 0) {
        const voicing = [tones[0] - 12, tones[2] - 12, tones[1], tones[3] ?? tones[0] + 12, tones[2]];
        const order = [0, 1, 2, 3, 4, 3, 2, 1];
        const m = voicing[order[(s / 2) % order.length]];
        this.pluck(this.calm, t, m, s === 0 ? 0.55 : 0.36, 0.45);
      }
    } else if (s % 2 === 0 || s === 3 || s === 11) {
      this.pluck(this.tense, t, tones[0] - 12 + (s % 8 === 6 ? 7 : 0), 0.35, 0.18, 0.35);
    }

    // ---- melody (kalimba in calm, low marimba in tense)
    for (const [ns, m, len] of this.phrase) {
      if (ns === s) this.kalimba(calm ? this.calm : this.tense, t, m, len * STEP, calm ? 0.28 : 0.22);
    }

    // ---- bass
    if (calm) {
      if (s === 0 || s === 10) this.bass(this.calm, t, tones[0] - 12, STEP * 5, 0.35);
    } else if (s % 2 === 0) {
      this.bass(this.tense, t, tones[0] - 12, STEP * 1.6, s % 4 === 0 ? 0.42 : 0.3, true);
    }

    // ---- percussion
    if (calm) {
      if (s % 4 === 2) this.shaker(this.calm, t, 0.05);
    } else {
      if (s === 0 || s === 8 || (s === 10 && this.bar % 2 === 1)) this.kick(this.tense, t, 0.8);
      if (s === 4 || s === 12) this.snare(this.tense, t, 0.35);
      if (s % 2 === 0) this.hat(this.tense, t, s % 4 === 2 ? 0.12 : 0.06);
      if (this.bar % 4 === 3 && s >= 12) this.tom(this.tense, t, 0.3, 110 - (s - 12) * 12);
    }
  }

  private chord(): Chord {
    const prog = PROGRESSIONS[this.mode];
    return prog[this.bar % prog.length];
  }

  // ------------------------------------------------------------------ instruments

  private pluckBuffer(midi: number, bright: number): AudioBuffer {
    const key = midi * 10 + Math.round(bright * 9);
    let b = this.plucks.get(key);
    if (!b) {
      const sr = this.ctx.sampleRate;
      const data = karplusStrong(sr, midiToFreq(midi), 2.2, bright, 1, midi);
      b = this.ctx.createBuffer(1, data.length, sr);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.plucks.set(key, b);
    }
    return b;
  }

  private pluck(dest: AudioNode, t: number, midi: number, gain: number, bright: number, dur = 2): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.pluckBuffer(midi, bright);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setTargetAtTime(0, t + dur, 0.08);
    src.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + dur + 0.5);
  }

  private kalimba(dest: AudioNode, t: number, midi: number, len: number, gain: number): void {
    const f = midiToFreq(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.4, len * 2.2));
    g.connect(dest);
    for (const [mult, amp] of [
      [1, 1],
      [3.9, 0.18],
      [6.1, 0.06],
    ]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const og = this.ctx.createGain();
      og.gain.value = amp;
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + Math.max(0.45, len * 2.2) + 0.05);
    }
  }

  private bass(dest: AudioNode, t: number, midi: number, len: number, gain: number, pulse = false): void {
    const o = this.ctx.createOscillator();
    o.type = pulse ? 'sawtooth' : 'triangle';
    o.frequency.value = midiToFreq(midi);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = pulse ? 260 + this.intensity * 700 : 420;
    f.Q.value = pulse ? 4 : 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(f);
    f.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private noiseHit(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, gain: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private shaker(dest: AudioNode, t: number, gain: number): void {
    this.noiseHit(dest, t, 0.07, 'highpass', 6000, gain);
  }

  private hat(dest: AudioNode, t: number, gain: number): void {
    this.noiseHit(dest, t, 0.04, 'highpass', 8000, gain);
  }

  private snare(dest: AudioNode, t: number, gain: number): void {
    this.noiseHit(dest, t, 0.16, 'bandpass', 1900, gain);
    this.tone(dest, t, 0.09, 190, 150, gain * 0.7);
  }

  private kick(dest: AudioNode, t: number, gain: number): void {
    this.tone(dest, t, 0.28, 140, 42, gain);
  }

  private tom(dest: AudioNode, t: number, gain: number, f: number): void {
    this.tone(dest, t, 0.22, f, f * 0.6, gain);
  }

  private tone(dest: AudioNode, t: number, dur: number, f0: number, f1: number, gain: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Little musical rewards: a bright rising arpeggio when the farm is clear, a sigh on death. */
  private playStinger(t: number, kind: 'clear' | 'death'): void {
    const notes = kind === 'clear' ? [62, 66, 69, 74, 78, 81] : [69, 65, 62, 57];
    notes.forEach((m, i) => this.pluck(this.out, t + i * (kind === 'clear' ? 0.09 : 0.22), m, 0.5, 0.6, 2.5));
    if (kind === 'clear') this.kalimba(this.out, t + notes.length * 0.09, 86, 4 * STEP, 0.25);
  }
}
