import * as THREE from 'three';

/**
 * Every sound is synthesized at runtime with WebAudio: filtered noise bursts, pitch-swept
 * oscillators and simple envelopes. No audio files at all.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  private listener = new THREE.Vector3();
  private right = new THREE.Vector3(1, 0, 0);
  muted = false;
  volume = 0.8;

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambBus = this.ctx.createGain();
      this.ambBus.gain.value = 0.55;
      this.ambBus.connect(this.master);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startAmbience();
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  setListener(pos: THREE.Vector3, right: THREE.Vector3): void {
    this.listener.copy(pos);
    this.right.copy(right);
  }

  // ------------------------------------------------------------------ building blocks

  private gate(name: string, gap: number): boolean {
    if (!this.ctx) return false;
    const t = this.ctx.currentTime;
    const l = this.last.get(name) ?? -1;
    if (t - l < gap) return false;
    this.last.set(name, t);
    return true;
  }

  /** Output node with distance attenuation and stereo pan for a world position. */
  private out(pos?: THREE.Vector3 | null, gain = 1): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    let pan = 0;
    let att = 1;
    if (pos) {
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      att = 1 / (1 + (d / 14) ** 2);
      pan = Math.max(-0.8, Math.min(0.8, (dx * this.right.x + dz * this.right.z) / 14));
    }
    g.gain.value = gain * att;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.sfxBus);
    } else g.connect(this.sfxBus);
    return g;
  }

  private noise(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, freqEnd?: number, attack = 0.002): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const off = Math.random() * 1.5;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, off, dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, dur: number, type: OscillatorType, f0: number, f1: number, peak: number, attack = 0.003): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private get now(): number {
    return this.ctx!.currentTime;
  }

  // ------------------------------------------------------------------ weapons

  pistol(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 0.9);
    this.noise(o, t, 0.16, 'bandpass', 1500, 0.7, 0.9);
    this.noise(o, t, 0.05, 'highpass', 3500, 0.5, 0.5);
    this.tone(o, t, 0.11, 'sine', 170, 45, 0.8);
    this.noise(o, t + 0.01, 0.4, 'lowpass', 900, 0.5, 0.18, 300, 0.02);
  }

  shotgun(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 1.1);
    this.noise(o, t, 0.32, 'lowpass', 2600, 0.4, 1.0, 500);
    this.noise(o, t, 0.07, 'highpass', 2200, 0.5, 0.7);
    this.tone(o, t, 0.24, 'sine', 115, 28, 1.3);
    this.tone(o, t, 0.1, 'triangle', 240, 60, 0.4);
    this.noise(o, t + 0.02, 0.9, 'lowpass', 700, 0.4, 0.3, 150, 0.03);
  }

  pump(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 0.6);
    this.noise(o, t, 0.045, 'bandpass', 2400, 3, 0.6);
    this.tone(o, t, 0.04, 'square', 900, 600, 0.08);
    this.noise(o, t + 0.13, 0.05, 'bandpass', 1700, 3, 0.7);
    this.tone(o, t + 0.13, 0.05, 'square', 700, 400, 0.08);
  }

  reload(pos: THREE.Vector3, shell = false): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 0.45);
    if (shell) {
      this.noise(o, t, 0.05, 'bandpass', 2000, 2, 0.5);
      this.tone(o, t, 0.05, 'triangle', 1400, 900, 0.1);
    } else {
      this.noise(o, t, 0.04, 'bandpass', 3000, 2, 0.5);
      this.noise(o, t + 0.12, 0.05, 'bandpass', 2200, 2, 0.6);
      this.tone(o, t + 0.12, 0.03, 'square', 1500, 1300, 0.06);
    }
  }

  empty(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('empty', 0.12)) return;
    const o = this.out(pos, 0.4);
    this.noise(o, this.now, 0.03, 'highpass', 4000, 1, 0.5);
    this.tone(o, this.now, 0.03, 'square', 2200, 1800, 0.05);
  }

  hiss(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('hiss', 0.09)) return;
    const o = this.out(pos, 0.35);
    this.noise(o, this.now, 0.14, 'highpass', 3500, 0.6, 0.6, 5000, 0.01);
  }

  shellTink(pos: THREE.Vector3, soft = false): void {
    if (!this.ready || !this.gate('tink', 0.035)) return;
    const t = this.now;
    const o = this.out(pos, soft ? 0.12 : 0.22);
    const f = 3200 + Math.random() * 1400;
    this.tone(o, t, 0.12, 'sine', f, f * 0.98, 0.5);
    this.tone(o, t, 0.08, 'sine', f * 1.51, f * 1.5, 0.25);
  }

  // ------------------------------------------------------------------ impacts

  hitFlesh(pos: THREE.Vector3, big = false): void {
    if (!this.ready || !this.gate('flesh', 0.03)) return;
    const t = this.now;
    const o = this.out(pos, big ? 0.9 : 0.6);
    this.noise(o, t, big ? 0.2 : 0.12, 'lowpass', 2200, 1, 0.8, 250);
    this.tone(o, t, 0.09, 'sine', 190, 70, 0.4);
    if (big) this.noise(o, t + 0.03, 0.18, 'bandpass', 600, 1.5, 0.5, 250);
  }

  splat(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('splat', 0.05)) return;
    const t = this.now;
    const o = this.out(pos, 0.5);
    this.noise(o, t, 0.16, 'bandpass', 800, 1.2, 0.7, 250);
    this.tone(o, t, 0.08, 'sine', 320, 120, 0.25);
  }

  thud(pos: THREE.Vector3, strength = 1): void {
    if (!this.ready || !this.gate('thud', 0.04)) return;
    const t = this.now;
    const o = this.out(pos, 0.5 * Math.min(1.5, strength));
    this.tone(o, t, 0.14, 'sine', 95, 45, 0.9);
    this.noise(o, t, 0.1, 'lowpass', 400, 0.7, 0.5);
  }

  woodHit(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('woodhit', 0.03)) return;
    const t = this.now;
    const o = this.out(pos, 0.45);
    this.noise(o, t, 0.06, 'bandpass', 1300, 2.5, 0.8);
    this.tone(o, t, 0.06, 'triangle', 420, 240, 0.35);
  }

  woodBreak(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('woodbreak', 0.05)) return;
    const t = this.now;
    const o = this.out(pos, 0.8);
    for (let i = 0; i < 4; i++) {
      this.noise(o, t + i * 0.028 + Math.random() * 0.01, 0.07, 'bandpass', 900 + Math.random() * 900, 2, 0.7);
    }
    this.tone(o, t, 0.16, 'triangle', 220, 90, 0.5);
  }

  metalHit(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('metal', 0.04)) return;
    const t = this.now;
    const o = this.out(pos, 0.4);
    const f = 800 + Math.random() * 300;
    this.tone(o, t, 0.35, 'sine', f, f * 0.99, 0.3);
    this.tone(o, t, 0.25, 'sine', f * 1.58, f * 1.57, 0.2);
    this.tone(o, t, 0.18, 'sine', f * 2.63, f * 2.6, 0.15);
    this.noise(o, t, 0.03, 'highpass', 3000, 1, 0.4);
  }

  ceramicBreak(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('ceramic', 0.05)) return;
    const t = this.now;
    const o = this.out(pos, 0.6);
    this.noise(o, t, 0.12, 'highpass', 2500, 1, 0.6);
    for (let i = 0; i < 6; i++) {
      const f = 2500 + Math.random() * 3500;
      this.tone(o, t + Math.random() * 0.15, 0.07, 'sine', f, f, 0.12);
    }
  }

  squish(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('squish', 0.05)) return;
    const t = this.now;
    const o = this.out(pos, 0.7);
    this.noise(o, t, 0.22, 'lowpass', 1400, 2, 0.8, 180);
    this.tone(o, t + 0.02, 0.12, 'sine', 420, 140, 0.3);
  }

  splash(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('splash', 0.06)) return;
    const t = this.now;
    const o = this.out(pos, 0.5);
    this.noise(o, t, 0.3, 'bandpass', 1600, 1, 0.6, 500);
    for (let i = 0; i < 3; i++) {
      const f = 600 + Math.random() * 500;
      this.tone(o, t + 0.05 + i * 0.05, 0.06, 'sine', f, f * 1.8, 0.12);
    }
  }

  explosion(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 1.5);
    this.noise(o, t, 1.6, 'lowpass', 1800, 0.6, 1.3, 90, 0.005);
    this.tone(o, t, 1.1, 'sine', 75, 22, 1.6);
    this.noise(o, t, 0.15, 'highpass', 1500, 0.6, 0.8);
    for (let i = 0; i < 7; i++) {
      this.noise(o, t + 0.1 + Math.random() * 0.6, 0.06, 'bandpass', 1200 + Math.random() * 1600, 2, 0.25);
    }
  }

  // ------------------------------------------------------------------ characters

  groan(pos: THREE.Vector3, pitch = 1, short = false): void {
    if (!this.ready || !this.gate('groan', 0.25)) return;
    const ctx = this.ctx!;
    const t = this.now;
    const o = this.out(pos, 0.3);
    const dur = (short ? 0.45 : 0.9 + Math.random() * 0.5) / pitch;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = (95 + Math.random() * 30) * pitch;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * 1.12, t + dur * 0.35);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5 + Math.random() * 3;
    const lfoG = ctx.createGain();
    lfoG.gain.value = base * 0.06;
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.12);
    g.gain.setValueAtTime(0.5, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 520 * pitch;
    f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1150 * pitch;
    f2.Q.value = 7;
    osc.connect(f1);
    osc.connect(f2);
    f1.connect(g);
    f2.connect(g);
    g.connect(o);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  hurt(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 0.7);
    this.tone(o, t, 0.18, 'triangle', 420, 190, 0.5);
    this.noise(o, t, 0.12, 'lowpass', 1200, 1, 0.5, 300);
  }

  whoosh(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const o = this.out(pos, 0.35);
    this.noise(o, this.now, 0.26, 'bandpass', 400, 1.5, 0.6, 1600, 0.06);
  }

  footstep(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('step', 0.09)) return;
    const o = this.out(pos, 0.1);
    this.noise(o, this.now, 0.06, 'lowpass', 600 + Math.random() * 300, 0.7, 0.5);
  }

  pickup(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, 0.35);
    this.tone(o, t, 0.1, 'triangle', 880, 880, 0.4);
    this.tone(o, t + 0.08, 0.14, 'triangle', 1320, 1320, 0.4);
  }

  // ------------------------------------------------------------------ world

  birdsFlap(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('flap', 0.2)) return;
    const t = this.now;
    const o = this.out(pos, 0.35);
    for (let i = 0; i < 7; i++) this.noise(o, t + i * 0.055 + Math.random() * 0.02, 0.04, 'bandpass', 1600 + Math.random() * 600, 1.5, 0.5);
    this.chirp(pos, 0.25);
  }

  chirp(pos: THREE.Vector3 | null, gain = 0.12): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(pos, gain);
    const n = 2 + Math.floor(Math.random() * 3);
    const f = 2600 + Math.random() * 1200;
    for (let i = 0; i < n; i++) this.tone(o, t + i * 0.09, 0.06, 'sine', f, f * 1.45, 0.4);
  }

  alarm(pos: THREE.Vector3, seconds = 3): void {
    if (!this.ready || !this.gate('alarm', seconds)) return;
    const ctx = this.ctx!;
    const t = this.now;
    const o = this.out(pos, 0.14);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    for (let i = 0; i < seconds * 4; i++) osc.frequency.setValueAtTime(i % 2 ? 960 : 720, t + i * 0.25);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
    g.gain.setValueAtTime(0.6, t + seconds - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(f);
    f.connect(g);
    g.connect(o);
    osc.start(t);
    osc.stop(t + seconds + 0.05);
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    // soft wind bed
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.025;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);
    src.connect(f);
    f.connect(g);
    g.connect(this.ambBus);
    src.start();
    lfo.start();
  }
}

export const sfx = new Sfx();
