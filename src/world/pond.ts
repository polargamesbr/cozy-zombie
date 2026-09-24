import * as THREE from 'three';
import { Rng } from '../core/rng';
import { compose } from '../core/math';
import { PAL } from '../render/palette';
import { cone, GeoBuilder } from '../render/geometry';
import { GLOBAL_UNIFORMS, vcToon } from '../render/materials';
import type { Updatable } from '../game/context';
import { LAYOUT } from './layout';

const vert = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vLocal = position.xy;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFoam;
  uniform vec4 uRipples[6];
  varying vec2 vLocal;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  void main() {
    float r = length(vLocal);
    float depth = smoothstep(1.0, 0.15, r);
    vec3 col = mix(uShallow, uDeep, depth);
    float w = sin(vWorld.x * 2.1 + uTime * 1.1) * sin(vWorld.z * 2.7 - uTime * 0.8);
    w += 0.6 * sin((vWorld.x + vWorld.z) * 3.7 + uTime * 1.9);
    col *= 1.0 + 0.035 * w;
    // light bands, like reflected sky
    float band = smoothstep(0.55, 1.0, sin(vWorld.x * 0.9 - vWorld.z * 1.4 + uTime * 0.35 + w * 0.3));
    col = mix(col, vec3(0.83, 0.93, 0.95), band * 0.12);
    // sparkles
    float sp = sin(vWorld.x * 7.3 + uTime * 2.3) * sin(vWorld.z * 8.1 - uTime * 1.6) * sin((vWorld.x - vWorld.z) * 4.7 + uTime * 0.9);
    col += smoothstep(0.6, 0.95, sp) * vec3(1.0, 0.92, 0.75) * 0.45;
    // impact ripples
    for (int i = 0; i < 6; i++) {
      vec4 rp = uRipples[i];
      float age = uTime - rp.z;
      if (age < 0.0 || age > 2.5) continue;
      float d = length(vWorld.xz - rp.xy);
      float front = age * 2.2;
      float ring = sin((d - front) * 14.0) * exp(-abs(d - front) * 3.0) * exp(-age * 1.6) * rp.w;
      col += ring * 0.16;
    }
    // shore foam, wobbly
    float a = atan(vLocal.y, vLocal.x);
    float edge = r + 0.025 * sin(a * 9.0 + uTime * 1.4) + 0.015 * sin(a * 17.0 - uTime * 2.0);
    float foam = smoothstep(0.86, 0.94, edge);
    col = mix(col, uFoam, foam * 0.85);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class Pond implements Updatable {
  readonly group = new THREE.Group();
  private ripples: THREE.Vector4[] = Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -100, 0));
  private cursor = 0;
  private pads: THREE.Mesh;

  constructor() {
    const p = LAYOUT.pond;
    const geo = new THREE.CircleGeometry(1, 64);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: GLOBAL_UNIFORMS.uTime,
          uDeep: { value: new THREE.Color(PAL.waterDeep) },
          uShallow: { value: new THREE.Color(PAL.water) },
          uFoam: { value: new THREE.Color(PAL.waterFoam) },
          uRipples: { value: this.ripples },
        },
      ]),
      vertexShader: vert,
      fragmentShader: frag,
      fog: true,
    });
    mat.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    mat.uniforms.uRipples.value = this.ripples;
    const water = new THREE.Mesh(geo, mat);
    water.rotation.x = -Math.PI / 2;
    water.scale.set(p.rx, p.rz, 1);
    water.position.set(p.x, 0.05, p.z);
    water.receiveShadow = false;
    this.group.add(water);

    // lily pads + a few flowers
    const r = new Rng(505);
    const pads = new GeoBuilder();
    for (let i = 0; i < 11; i++) {
      const a = r.angle();
      const d = Math.sqrt(r.next()) * 0.75;
      const x = p.x + Math.cos(a) * p.rx * d;
      const z = p.z + Math.sin(a) * p.rz * d;
      const s = r.range(0.25, 0.42);
      const pad = new THREE.CircleGeometry(s, 14, 0.35, Math.PI * 2 - 0.7);
      pad.rotateX(-Math.PI / 2);
      pads.add(pad, r.chance(0.5) ? PAL.lily : 0x92c178, compose(x, 0.075, z, 0, r.angle(), 0));
      if (r.chance(0.35)) {
        for (let k = 0; k < 6; k++) {
          const pa = (k / 6) * Math.PI * 2;
          pads.add(cone(0.05, 0.14, 4), 0xf6b5c8, compose(x + Math.cos(pa) * 0.05, 0.14, z + Math.sin(pa) * 0.05, Math.sin(pa) * 0.6, 0, -Math.cos(pa) * 0.6));
        }
        pads.add(new THREE.SphereGeometry(0.035, 6, 4), PAL.flowerYellow, compose(x, 0.15, z));
      }
    }
    this.pads = new THREE.Mesh(pads.build(), vcToon());
    this.pads.receiveShadow = true;
    this.group.add(this.pads);
  }

  ripple(x: number, z: number, t: number, strength = 1): void {
    this.ripples[this.cursor].set(x, z, t, strength);
    this.cursor = (this.cursor + 1) % this.ripples.length;
  }

  update(_dt: number, t: number): void {
    this.pads.position.y = Math.sin(t * 1.1) * 0.008;
  }
}

/** Push a circle out of the pond ellipse (characters can't wade in). */
export function pondPush(pos: { x: number; z: number }, radius: number): boolean {
  const p = LAYOUT.pond;
  const rx = p.rx + radius - 0.35;
  const rz = p.rz + radius - 0.35;
  const dx = pos.x - p.x;
  const dz = pos.z - p.z;
  const k = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
  if (k >= 1) return false;
  const s = 1 / Math.sqrt(k || 1e-6);
  pos.x = p.x + dx * s;
  pos.z = p.z + dz * s;
  return true;
}

/** Depth of the pond bottom under a point (0 outside the water). */
export function pondDepth(x: number, z: number): number {
  const p = LAYOUT.pond;
  const dx = (x - p.x) / (p.rx - 0.2);
  const dz = (z - p.z) / (p.rz - 0.2);
  const k = dx * dx + dz * dz;
  return k >= 1 ? 0 : 0.95 * Math.sqrt(1 - k);
}
