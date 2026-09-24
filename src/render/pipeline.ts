import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Final color grade: warm tint, gentle saturation, cozy vignette, hurt/flash overlays. */
const GradeShader = {
  name: 'CozyGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.3 },
    uTint: { value: new THREE.Vector3(1.03, 1.0, 0.95) },
    uSaturation: { value: 1.1 },
    uHurt: { value: 0 },
    uFlash: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform vec3 uTint;
    uniform float uSaturation;
    uniform float uHurt;
    uniform float uFlash;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * uTint;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      vec2 d = vUv - 0.5;
      d.x *= uAspect;
      float r = length(d);
      float vig = smoothstep(0.38, 1.0, r);
      col = mix(col, col * vec3(0.72, 0.58, 0.55), vig * uVignette);
      float edge = smoothstep(0.3, 0.95, r);
      col = mix(col, vec3(0.55, 0.04, 0.07), edge * uHurt * 0.75);
      col += uFlash * vec3(1.0, 0.93, 0.8);
      gl_FragColor = vec4(col, c.a);
    }`,
};

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private renderPass: RenderPass;
  private usePost = true;

  constructor(
    container: HTMLElement,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    opts: { preserveDrawingBuffer?: boolean; lowQuality?: boolean } = {},
  ) {
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.lowQuality ? 1 : 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: opts.lowQuality ? 0 : 4,
      stencilBuffer: true,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.28, 0.4, 1.7);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  render(): void {
    this.renderer.info.reset();
    if (this.usePost) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
