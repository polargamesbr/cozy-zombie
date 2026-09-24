import * as THREE from 'three';
import { PAL } from './palette';
import { WINDOW_GLOWS } from './materials';
import type { Lighting } from './lighting';
import type { RenderPipeline } from './pipeline';

/** One mood of the day. Everything that sets the look lives here so the phases stay coherent. */
interface Key {
  sun: number;
  sunI: number;
  sunDir: [number, number, number];
  sky: number;
  ground: number;
  hemiI: number;
  fillI: number;
  /** fog + background */
  fog: number;
  tint: [number, number, number];
  sat: number;
  vignette: number;
  /** atmosphere pass: color of the sunlit mist, strength, fog color and amount */
  shaft: number;
  scatter: number;
  mist: number;
  mistAmt: number;
  /** 0 = day … 1 = night (window glow, lantern, fireflies) */
  night: number;
}

export const DAY_NAMES = ['Tarde', 'Pôr do sol', 'Noite', 'Amanhecer'] as const;

const KEYS: Key[] = [
  // afternoon: the original golden look
  { sun: PAL.sun, sunI: 3.1, sunDir: [-0.5, 0.66, 0.56], sky: PAL.hemiSky, ground: PAL.hemiGround, hemiI: 1.55, fillI: 0.45, fog: PAL.fog, tint: [1.03, 1.0, 0.95], sat: 1.1, vignette: 0.3, shaft: 0xffc780, scatter: 0.028, mist: 0xf6dcb8, mistAmt: 0.012, night: 0 },
  // sunset: low orange sun, pink sky, long shadows, strong light shafts
  { sun: 0xffb07a, sunI: 2.9, sunDir: [-0.74, 0.34, 0.58], sky: 0xb9a6dc, ground: 0x7a6a58, hemiI: 1.45, fillI: 0.5, fog: 0xf0bba0, tint: [1.05, 0.98, 0.95], sat: 1.06, vignette: 0.36, shaft: 0xff9a5e, scatter: 0.04, mist: 0xe9b7a2, mistAmt: 0.014, night: 0.15 },
  // night: cool moonlight, deep blue air, warm windows and lantern
  { sun: 0x9fb2ff, sunI: 1.15, sunDir: [-0.38, 0.8, 0.46], sky: 0x5061a0, ground: 0x2c2c3c, hemiI: 1.05, fillI: 0.3, fog: 0x252d4e, tint: [0.93, 0.97, 1.08], sat: 0.95, vignette: 0.52, shaft: 0x8196ff, scatter: 0.022, mist: 0x2c355c, mistAmt: 0.02, night: 1 },
  // dawn: pale peach and lilac, mist on the ground
  { sun: 0xffc59c, sunI: 2.4, sunDir: [-0.62, 0.38, 0.6], sky: 0xc8b4e2, ground: 0x7a6e5e, hemiI: 1.35, fillI: 0.42, fog: 0xe9c3bd, tint: [1.02, 0.98, 1.0], sat: 1.05, vignette: 0.34, shaft: 0xffb08a, scatter: 0.042, mist: 0xebc6c0, mistAmt: 0.02, night: 0.25 },
];

const _a = new THREE.Color();
const _b = new THREE.Color();

/**
 * Time of day as a number: 0 afternoon → 1 sunset → 2 night → 3 dawn → 4 (= 0) afternoon.
 * `apply` blends the two neighbouring moods into the lights, fog, color grade and atmosphere.
 */
export class DayCycle {
  night = 0;

  constructor(
    private lighting: Lighting,
    private pipeline: RenderPipeline,
  ) {}

  apply(t: number): void {
    const tt = ((t % 4) + 4) % 4;
    const i0 = Math.floor(tt);
    const k0 = KEYS[i0];
    const k1 = KEYS[(i0 + 1) % 4];
    const f0 = tt - i0;
    const f = f0 * f0 * (3 - 2 * f0);
    const num = (a: number, b: number) => a + (b - a) * f;
    const col = (out: THREE.Color, a: number, b: number) => out.copy(_a.set(a)).lerp(_b.set(b), f);

    const L = this.lighting;
    col(L.sun.color, k0.sun, k1.sun);
    L.sun.intensity = num(k0.sunI, k1.sunI);
    L.sunDir.set(num(k0.sunDir[0], k1.sunDir[0]), num(k0.sunDir[1], k1.sunDir[1]), num(k0.sunDir[2], k1.sunDir[2])).normalize();
    col(L.hemi.color, k0.sky, k1.sky);
    col(L.hemi.groundColor, k0.ground, k1.ground);
    L.hemi.intensity = num(k0.hemiI, k1.hemiI);
    L.fill.intensity = num(k0.fillI, k1.fillI);
    col(L.fogColor, k0.fog, k1.fog);

    const g = this.pipeline.grade.uniforms;
    (g.uTint.value as THREE.Vector3).set(num(k0.tint[0], k1.tint[0]), num(k0.tint[1], k1.tint[1]), num(k0.tint[2], k1.tint[2]));
    g.uSaturation.value = num(k0.sat, k1.sat);
    g.uVignette.value = num(k0.vignette, k1.vignette);

    const atmo = this.pipeline.atmosphere;
    if (atmo) {
      col(atmo.sunColor, k0.shaft, k1.shaft);
      col(atmo.fogColor, k0.mist, k1.mist);
      atmo.scatter = num(k0.scatter, k1.scatter);
      atmo.fog = num(k0.mistAmt, k1.mistAmt);
    }

    this.night = num(k0.night, k1.night);
    // lit windows: gentle by day, glowing (bloom) at night
    const w = 1 + this.night * 1.9;
    for (const g of WINDOW_GLOWS) g.mat.color.copy(g.base).multiplyScalar(w);
  }
}
