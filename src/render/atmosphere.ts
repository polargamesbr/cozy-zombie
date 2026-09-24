import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Golden-hour air: a thin mist layer hugging the ground is raymarched against the sun's shadow
 * map, so trees, the barn and the house carve light shafts into it; plus a soft height fog.
 * Runs at the AO resolution and reuses the AO pass's depth buffer.
 */
const scatterFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tDepth;
  uniform highp sampler2DShadow tShadow;
  uniform mat4 uProjInv;
  uniform mat4 uCamWorld;
  uniform mat4 uShadowMatrix;
  uniform vec3 uCamPos;
  uniform float uHasShadow;
  uniform float uLayer;
  varying vec2 vUv;

  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  vec3 worldAt(vec2 uv, float d) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uProjInv * ndc;
    v /= v.w;
    return (uCamWorld * v).xyz;
  }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    vec3 P = worldAt(vUv, min(d, 0.9999));
    vec3 C = uCamPos;
    vec3 ray = P - C;
    float len = length(ray);
    vec3 dir = ray / len;
    // only march the part of the ray inside the mist layer [0, uLayer]
    float t0 = 0.0;
    if (C.y > uLayer) {
      if (dir.y >= -1e-4) { gl_FragColor = vec4(0.0); return; }
      t0 = (uLayer - C.y) / dir.y;
    }
    t0 = clamp(t0, 0.0, len);
    float seg = len - t0;
    const int N = 12;
    float jitter = ign(gl_FragCoord.xy);
    float lit = 0.0;
    float dens = 0.0;
    for (int i = 0; i < N; i++) {
      float t = t0 + (float(i) + jitter) / float(N) * seg;
      vec3 X = C + dir * t;
      float rho = exp(-max(X.y, 0.0) / (uLayer * 0.38));
      float s = 1.0;
      if (uHasShadow > 0.5) {
        vec4 sc = uShadowMatrix * vec4(X, 1.0);
        sc.xyz /= sc.w;
        if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) {
          s = texture(tShadow, vec3(sc.xy, sc.z - 0.002));
        }
      }
      lit += s * rho;
      dens += rho;
    }
    float stepLen = seg / float(N);
    gl_FragColor = vec4(lit * stepLen, dens * stepLen, 0.0, 1.0);
  }
`;

const blurFrag = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(tInput, vUv) * 0.2941;
    s += texture2D(tInput, vUv + uDir * 1.3333) * 0.3529;
    s += texture2D(tInput, vUv - uDir * 1.3333) * 0.3529;
    gl_FragColor = s;
  }
`;

const compositeFrag = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tScatter;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform float uScatter;
  uniform float uFog;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tDiffuse, vUv);
    vec2 a = texture2D(tScatter, vUv).rg;
    float fog = 1.0 - exp(-a.g * uFog);
    vec3 col = mix(c.rgb, uFogColor, fog);
    col += uSunColor * (a.r * uScatter);
    gl_FragColor = vec4(col, c.a);
  }
`;

export class AtmospherePass extends Pass {
  private scatterRT: THREE.WebGLRenderTarget;
  private tmpRT: THREE.WebGLRenderTarget;
  private scatterQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private compositeQuad: FullScreenQuad;
  private scatterMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  /** Strength of the sunlit mist and of the plain height fog. */
  scatter = 0.028;
  fog = 0.012;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private sun: THREE.DirectionalLight,
    depth: THREE.Texture,
    width: number,
    height: number,
  ) {
    super();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.scatterRT = new THREE.WebGLRenderTarget(width, height, opts);
    this.tmpRT = new THREE.WebGLRenderTarget(width, height, opts);
    this.scatterMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: depth },
        tShadow: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uHasShadow: { value: 0 },
        uLayer: { value: 3.4 },
      },
      vertexShader: quadVert,
      fragmentShader: scatterFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: quadVert,
      fragmentShader: blurFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tScatter: { value: this.scatterRT.texture },
        uSunColor: { value: new THREE.Color(1.0, 0.78, 0.5) },
        uFogColor: { value: new THREE.Color(0xf6dcb8) },
        uScatter: { value: this.scatter },
        uFog: { value: this.fog },
      },
      vertexShader: quadVert,
      fragmentShader: compositeFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.scatterQuad = new FullScreenQuad(this.scatterMat);
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.compositeQuad = new FullScreenQuad(this.compositeMat);
  }

  setAtmosphereSize(width: number, height: number): void {
    this.scatterRT.setSize(width, height);
    this.tmpRT.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const u = this.scatterMat.uniforms;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    const shadowTex = this.sun.shadow.map?.depthTexture ?? null;
    u.tShadow.value = shadowTex;
    u.uHasShadow.value = shadowTex ? 1 : 0;
    u.uShadowMatrix.value.copy(this.sun.shadow.matrix);
    renderer.setRenderTarget(this.scatterRT);
    this.scatterQuad.render(renderer);
    // small separable blur hides the ray-march noise
    const w = this.scatterRT.width;
    const h = this.scatterRT.height;
    this.blurMat.uniforms.tInput.value = this.scatterRT.texture;
    this.blurMat.uniforms.uDir.value.set(1 / w, 0);
    renderer.setRenderTarget(this.tmpRT);
    this.blurQuad.render(renderer);
    this.blurMat.uniforms.tInput.value = this.tmpRT.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / h);
    renderer.setRenderTarget(this.scatterRT);
    this.blurQuad.render(renderer);

    const c = this.compositeMat.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.uScatter.value = this.scatter;
    c.uFog.value = this.fog;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compositeQuad.render(renderer);
  }

  dispose(): void {
    this.scatterRT.dispose();
    this.tmpRT.dispose();
    this.scatterMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.scatterQuad.dispose();
    this.blurQuad.dispose();
    this.compositeQuad.dispose();
  }
}
