import * as THREE from 'three';
import { makeImpulseResponse } from './dsp';
import { Music } from './music';

interface OutOpts {
  /** reverb send (0..1) */
  wet?: number;
  /** strength of the slap-back echo from nearby buildings (0..1) */
  echo?: number;
  /** muffle when a wall stands between the sound and the listener */
  occlude?: boolean;
}

/**
 * Every sound is synthesized at runtime with WebAudio: filtered noise bursts, pitch-swept
 * oscillators and simple envelopes. No audio files at all.
 *
 * Routing: each sound → (optional wall muffling) → dry HRTF panner → sfx bus
 *                                              ↘ reverb send (convolver with a generated IR)
 *                                              ↘ delayed, filtered echo panned from the barn/house
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  private listener = new THREE.Vector3();
  private right = new THREE.Vector3(1, 0, 0);
  private analyser: AnalyserNode | null = null;
  music: Music | null = null;
  muted = false;
  volume = 0.8;
  /** Big flat surfaces that throw gunshots back at you. */
  reflectors: THREE.Vector3[] = [];
  /** Is there a wall between the listener and this point? (set by the game) */
  occluded: ((p: THREE.Vector3) => boolean) | null = null;

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      comp.connect(this.analyser);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambBus = ctx.createGain();
      this.ambBus.gain.value = 0.55;
      this.ambBus.connect(this.master);
      // generated outdoor impulse response
      const [l, r] = makeImpulseResponse(ctx.sampleRate, 2.2);
      const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
      ir.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
      ir.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      this.reverbSend = ctx.createGain();
      const wetOut = ctx.createGain();
      wetOut.gain.value = 0.55;
      this.reverbSend.connect(conv);
      conv.connect(wetOut);
      wetOut.connect(this.master);
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startAmbience();
      this.music = new Music(ctx, this.master, this.noiseBuf);
      this.music.start();
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

  /** RMS of the final mix (debug / tests). */
  level(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.sqrt(s / buf.length);
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

  /** Relative placement of a world point for the HRTF panner: always slightly "in front". */
  private place(p: PannerNode, pos: THREE.Vector3): void {
    const dx = pos.x - this.listener.x;
    const dz = pos.z - this.listener.z;
    const side = Math.max(-1, Math.min(1, (dx * this.right.x + dz * this.right.z) / 12));
    const x = side;
    const z = -(1 - Math.abs(side) * 0.6);
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = 0;
      p.positionZ.value = z;
    } else p.setPosition(x, 0, z);
  }

  private panner(pos: THREE.Vector3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.refDistance = 1;
    p.maxDistance = 10000;
    p.rolloffFactor = 0;
    this.place(p, pos);
    return p;
  }

  /** Output node for a sound: distance attenuation, HRTF direction, muffling, reverb and echo. */
  private out(pos?: THREE.Vector3 | null, gain = 1, opts: OutOpts = {}): AudioNode {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    let src: AudioNode = input;
    let att = 1;
    let dist = 0;
    if (pos) {
      dist = Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z);
      att = 1 / (1 + (dist / 14) ** 2);
      if ((opts.occlude ?? true) && dist > 2.5 && this.occluded?.(pos)) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        input.connect(lp);
        src = lp;
        att *= 0.7;
      }
    }
    const dry = ctx.createGain();
    dry.gain.value = gain * att;
    src.connect(dry);
    if (pos) {
      const p = this.panner(pos);
      dry.connect(p);
      p.connect(this.sfxBus);
    } else dry.connect(this.sfxBus);
    // far sounds are wetter
    const wet = (opts.wet ?? 0.12) * gain * (0.35 + 0.65 * Math.sqrt(att)) * (1 + Math.min(1, dist / 25) * 0.6);
    if (wet > 0.001) {
      const w = ctx.createGain();
      w.gain.value = wet;
      src.connect(w);
      w.connect(this.reverbSend);
    }
    // slap-back echo from buildings: the extra path length becomes the delay
    if (pos && opts.echo) {
      for (const r of this.reflectors) {
        const toWall = pos.distanceTo(r);
        const back = r.distanceTo(this.listener);
        const extra = toWall + back - dist;
        if (toWall > 40 || extra < 4) continue;
        const delay = ctx.createDelay(1);
        delay.delayTime.value = Math.min(0.95, extra / 343);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1700;
        const g = ctx.createGain();
        g.gain.value = opts.echo * gain * 0.32 / (1 + (toWall + back) / 25);
        src.connect(delay);
        delay.connect(lp);
        lp.connect(g);
        const p = this.panner(r);
        g.connect(p);
        p.connect(this.sfxBus);
        const w = ctx.createGain();
        w.gain.value = 0.4;
        g.connect(w);
        w.connect(this.reverbSend);
      }
    }
    return input;
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

  /** ±6% per-shot variation so repeated shots never sound identical. */
  private vary(): number {
    return 1 + (Math.random() * 2 - 1) * 0.06;
  }

  // ------------------------------------------------------------------ weapons

  pistol(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const v = this.vary();
    const o = this.out(pos, 0.9, { wet: 0.32, echo: 0.45, occlude: false });
    // crack · body · thump · slide · tail
    this.noise(o, t, 0.04, 'highpass', 3600 * v, 0.6, 0.65);
    this.noise(o, t, 0.15, 'bandpass', 1500 * v, 0.7, 0.9);
    this.tone(o, t, 0.11, 'sine', 175 * v, 45, 0.85);
    this.noise(o, t + 0.035, 0.025, 'bandpass', 3200, 3, 0.3);
    this.tone(o, t + 0.035, 0.02, 'square', 2100 * v, 1800, 0.05);
    this.noise(o, t + 0.01, 0.45, 'lowpass', 900 * v, 0.5, 0.2, 250, 0.02);
  }

  shotgun(pos: THREE.Vector3): void {
    if (!this.ready) return;
    const t = this.now;
    const v = this.vary();
    const o = this.out(pos, 1.1, { wet: 0.42, echo: 0.6, occlude: false });
    // crack · roar · chest thump · sub · long rolling tail
    this.noise(o, t, 0.07, 'highpass', 2200 * v, 0.5, 0.75);
    this.noise(o, t, 0.34, 'lowpass', 2700 * v, 0.4, 1.0, 420);
    this.tone(o, t, 0.26, 'sine', 118 * v, 28, 1.3);
    this.tone(o, t, 0.1, 'triangle', 240 * v, 60, 0.4);
    this.tone(o, t, 0.38, 'sine', 58 * v, 30, 0.75);
    this.noise(o, t + 0.02, 1.0, 'lowpass', 700 * v, 0.4, 0.32, 140, 0.03);
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

  /** Burning fuse: a crackly sizzle. */
  fuse(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('fuse', 0.15)) return;
    const t = this.now;
    const o = this.out(pos, 0.22);
    this.noise(o, t, 0.24, 'highpass', 4200, 0.8, 0.5, 6000, 0.02);
    for (let i = 0; i < 3; i++) this.noise(o, t + Math.random() * 0.2, 0.012, 'bandpass', 2500 + Math.random() * 2500, 3, 0.4);
  }

  /** Big boot connecting: low punch, cloth slap and a crunch. */
  kick(pos: THREE.Vector3, flesh = true): void {
    if (!this.ready || !this.gate('kick', 0.05)) return;
    const t = this.now;
    const o = this.out(pos, 0.9);
    this.tone(o, t, 0.18, 'sine', 130, 42, 1.1);
    this.noise(o, t, 0.08, 'lowpass', 1800, 0.8, 0.9, 300);
    if (flesh) this.noise(o, t + 0.01, 0.14, 'bandpass', 700, 1.4, 0.5, 250);
  }

  /** Kill-cam: time slows down (a descending, filtered whoosh with a low hit). */
  slowmo(): void {
    if (!this.ready) return;
    const t = this.now;
    const o = this.out(null, 0.5, { wet: 0.8 });
    this.noise(o, t, 1.2, 'bandpass', 1400, 1.2, 0.5, 180, 0.05);
    this.tone(o, t, 1.3, 'sine', 110, 38, 0.8, 0.01);
  }

  /** Something big catching fire: a low roar. */
  roar(pos: THREE.Vector3): void {
    if (!this.ready || !this.gate('roar', 0.35)) return;
    const o = this.out(pos, 0.35);
    this.noise(o, this.now, 0.5, 'lowpass', 500, 0.6, 0.6, 300, 0.08);
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
    const o = this.out(pos, 0.8, { wet: 0.2, echo: 0.25 });
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
    const o = this.out(pos, 1.5, { wet: 0.7, echo: 0.8, occlude: false });
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
    const o = this.out(pos, 0.3, { wet: 0.22 });
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
