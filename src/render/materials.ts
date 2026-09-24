import * as THREE from 'three';

/** Uniforms shared by every animated shader (wind, water, grass...). */
export const GLOBAL_UNIFORMS = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.35) },
  /** A radial gust (explosions, shotgun blasts): xyz = world pos, w = start time. */
  uGust: { value: new THREE.Vector4(0, 0, 0, -100) },
  uGustStrength: { value: 0 },
  /** Sun direction in view space (updated every frame) for rim lights and lit particles. */
  uSunView: { value: new THREE.Vector3(0, 1, 0) },
};

let rampTexture: THREE.DataTexture | null = null;

/**
 * Soft three-band toon ramp. MeshToonMaterial samples it with (N·L)*0.5+0.5, so 0.5 is the
 * terminator. Soft edges keep it "painted" rather than harsh cel shading.
 */
export function toonRamp(): THREE.DataTexture {
  if (rampTexture) return rampTexture;
  const n = 256;
  const data = new Uint8Array(n * 4);
  const soft = (a: number, w: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - (a - w)) / (2 * w)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    // shadow → mid → lit
    const v = 0.0 + 0.58 * soft(0.47, 0.035, x) + 0.42 * soft(0.63, 0.05, x);
    const b = Math.round(Math.min(1, v) * 255);
    data[i * 4] = b;
    data[i * 4 + 1] = b;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  rampTexture = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  rampTexture.magFilter = THREE.LinearFilter;
  rampTexture.minFilter = THREE.LinearFilter;
  rampTexture.generateMipmaps = false;
  rampTexture.needsUpdate = true;
  return rampTexture;
}

export interface MatOpts {
  map?: THREE.Texture | null;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  vertexColors?: boolean;
  wind?: number;
  windHeight?: number;
}

const cache = new Map<string, THREE.MeshToonMaterial>();

/** Cached toon material. Do not mutate the returned instance – use `toonUnique` for that. */
export function toon(color: number, opts: MatOpts = {}): THREE.MeshToonMaterial {
  const key = `${color}|${opts.map?.uuid ?? ''}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}|${
    opts.transparent ?? ''
  }|${opts.opacity ?? ''}|${opts.side ?? ''}|${opts.vertexColors ?? ''}|${opts.wind ?? ''}|${opts.windHeight ?? ''}`;
  let m = cache.get(key);
  if (!m) {
    m = toonUnique(color, opts);
    cache.set(key, m);
  }
  return m;
}

export function toonUnique(color: number, opts: MatOpts = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonRamp(),
    map: opts.map ?? null,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    vertexColors: opts.vertexColors ?? false,
  });
  if (opts.emissive !== undefined) {
    m.emissive = new THREE.Color(opts.emissive);
    m.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  if (opts.wind) addWind(m, opts.wind, opts.windHeight ?? 0.5);
  return m;
}

/** White vertex-colored toon material used by merged static geometry. */
export function vcToon(opts: MatOpts = {}): THREE.MeshToonMaterial {
  return toon(0xffffff, { ...opts, vertexColors: true });
}

/**
 * Inject a gentle wind wobble into a material's vertex shader. `heightScale` converts
 * local-space height into sway weight so the base of a plant stays planted.
 */
export function addWind(m: THREE.Material, strength: number, heightScale: number): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uGust = GLOBAL_UNIFORMS.uGust;
    shader.uniforms.uGustStrength = GLOBAL_UNIFORMS.uGustStrength;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec4 uGust;
         uniform float uGustStrength;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           mat4 czModel = modelMatrix;
           #ifdef USE_INSTANCING
             czModel = modelMatrix * instanceMatrix;
           #endif
           vec3 czWp = (czModel * vec4(transformed, 1.0)).xyz;
           float czH = clamp(position.y * ${heightScale.toFixed(3)}, 0.0, 1.0);
           czH *= czH;
           float czT = uTime;
           vec2 czSway = vec2(
             sin(czT * 1.3 + czWp.x * 0.45 + czWp.z * 0.3) + 0.5 * sin(czT * 2.7 + czWp.z * 1.3),
             cos(czT * 1.1 + czWp.x * 0.35 - czWp.z * 0.45) * 0.6
           );
           // explosion gust: push away from origin as a travelling ring
           vec2 czD = czWp.xz - uGust.xz;
           float czDist = length(czD) + 0.001;
           float czAge = czT - uGust.w;
           float czRing = exp(-pow((czDist - czAge * 14.0) * 0.7, 2.0)) * exp(-czAge * 1.8) * uGustStrength;
           vec2 czPush = czD / czDist * czRing;
           transformed.x += (czSway.x * ${strength.toFixed(3)} + czPush.x * 0.35) * czH;
           transformed.z += (czSway.y * ${strength.toFixed(3)} + czPush.y * 0.35) * czH;
         }`,
      );
  };
  m.customProgramCacheKey = () => `wind-${strength}-${heightScale}`;
}

/** Inverted-hull outline material (characters). */
export function outlineMaterial(color: number, width: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       transformed += normalize(normal) * ${width.toFixed(4)};`,
    );
  };
  m.customProgramCacheKey = () => `outline-${width}`;
  return m;
}

/** Unlit color material (glows, UI-ish things in world). */
export function basic(color: number, opts: { transparent?: boolean; opacity?: number; additive?: boolean } = {}) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opts.transparent ?? opts.additive ?? false,
    opacity: opts.opacity ?? 1,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !(opts.transparent || opts.additive),
    toneMapped: !opts.additive,
  });
}

/**
 * Warm rim light (stronger on the side facing the sun) so characters pop off the grass.
 * Chains with any existing onBeforeCompile.
 */
export function addRim(m: THREE.Material, color: THREE.ColorRepresentation, strength: number): void {
  const prev = m.onBeforeCompile;
  const rimColor = new THREE.Color(color).multiplyScalar(strength);
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uSunView = GLOBAL_UNIFORMS.uSunView;
    shader.uniforms.uRimColor = { value: rimColor };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uRimColor;')
      .replace(
        '#include <opaque_fragment>',
        `{
           vec3 rimV = normalize(vViewPosition);
           float rimF = 1.0 - clamp(dot(normal, rimV), 0.0, 1.0);
           float sunF = clamp(dot(normal, uSunView) * 0.5 + 0.5, 0.0, 1.0);
           outgoingLight += uRimColor * pow(rimF, 3.0) * (0.3 + 0.7 * sunF);
         }
         #include <opaque_fragment>`,
      );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => prevKey() + '|rim';
}
