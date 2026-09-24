import * as THREE from 'three';
import { rng } from '../core/rng';
import { bulletHoleTexture, scorchTexture, splatAtlas } from '../render/textures';

const vert = /* glsl */ `
  attribute vec4 iColor; // rgb, alpha
  attribute float iCell;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <fog_pars_vertex>
  void main() {
    vColor = iColor;
    float cols = 4.0;
    vec2 cell = vec2(mod(iCell, cols), cols - 1.0 - floor(iCell / cols));
    vUv = (uv + cell) / cols;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uLightTint;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vColor.a;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor.rgb * t.rgb * uLightTint, a);
    #include <fog_fragment>
  }
`;

interface Decal {
  alive: boolean;
  age: number;
  life: number;
  fade: number;
  color: THREE.Color;
  alpha: number;
  matrix: THREE.Matrix4;
  cell: number;
  grow: number;
  scale: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/**
 * Instanced flat decals with an atlas (splats) or single texture. Oldest are recycled so the
 * ground never gets messier than `max` stains, and everything fades out after a while –
 * "exaggerated on impact, clean afterwards".
 */
export class DecalLayer {
  readonly mesh: THREE.InstancedMesh;
  private decals: Decal[] = [];
  private iColor: THREE.InstancedBufferAttribute;
  private iCell: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private dirty = true;
  private s = new THREE.Vector3();

  constructor(
    private max: number,
    tex: THREE.Texture,
    atlas: boolean,
    order: number,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.iCell = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute('iColor', this.iColor);
    geo.setAttribute('iCell', this.iCell);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: tex }, uLightTint: { value: new THREE.Color(1, 1, 1) } }]),
      vertexShader: atlas ? vert : vert.replace('float cols = 4.0;', 'float cols = 1.0;'),
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2 - order,
      polygonOffsetUnits: -2 - order,
      fog: true,
    });
    mat.uniforms.uMap.value = tex;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1 + order;
    for (let i = 0; i < max; i++) {
      this.decals.push({
        alive: false,
        age: 0,
        life: 40,
        fade: 8,
        color: new THREE.Color(),
        alpha: 1,
        matrix: new THREE.Matrix4(),
        cell: 0,
        grow: 0,
        scale: 1,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
      });
    }
  }

  set lightTint(c: THREE.Color) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uLightTint.value.copy(c);
  }

  /**
   * @param pos surface point
   * @param normal surface normal (decal faces along it)
   * @param size width in meters
   * @param rot rotation around the normal
   */
  add(pos: THREE.Vector3, normal: THREE.Vector3, size: number, color: number, opts: { cell?: number; rot?: number; alpha?: number; life?: number; stretch?: number; grow?: number } = {}): void {
    const d = this.decals[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    d.alive = true;
    d.age = 0;
    d.life = opts.life ?? 45;
    d.fade = Math.min(10, d.life * 0.3);
    d.color.set(color);
    d.alpha = opts.alpha ?? 1;
    d.cell = opts.cell ?? 0;
    d.grow = opts.grow ?? 0.12;
    d.scale = size;
    d.pos.copy(pos).addScaledVector(normal, 0.012 + rng.next() * 0.004);
    const qn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    const qr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.rot ?? rng.angle());
    d.quat.copy(qn).multiply(qr);
    this.s.set(size * (opts.stretch ?? 1), 1, size);
    d.matrix.compose(d.pos, d.quat, this.s);
    this.dirty = true;
  }

  update(dt: number): void {
    let n = 0;
    const col = this.iColor.array as Float32Array;
    const cell = this.iCell.array as Float32Array;
    for (const d of this.decals) {
      if (!d.alive) continue;
      d.age += dt;
      if (d.age > d.life) {
        d.alive = false;
        this.dirty = true;
        continue;
      }
      let a = d.alpha;
      const fadeStart = d.life - d.fade;
      if (d.age > fadeStart) {
        a *= 1 - (d.age - fadeStart) / d.fade;
        this.dirty = true;
      }
      // splats "spread" for a fraction of a second after landing
      if (d.grow > 0 && d.age < 0.25) {
        const k = 1 - d.grow + d.grow * (d.age / 0.25);
        const m = new THREE.Matrix4();
        this.s.setFromMatrixScale(d.matrix);
        m.compose(d.pos, d.quat, this.s.clone().multiplyScalar(k));
        this.mesh.setMatrixAt(n, m);
        this.dirty = true;
      } else {
        this.mesh.setMatrixAt(n, d.matrix);
      }
      col[n * 4] = d.color.r;
      col[n * 4 + 1] = d.color.g;
      col[n * 4 + 2] = d.color.b;
      col[n * 4 + 3] = a;
      cell[n] = d.cell;
      n++;
    }
    if (this.dirty || n !== this.mesh.count) {
      this.mesh.count = n;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.iColor.needsUpdate = true;
      this.iCell.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    for (const d of this.decals) d.alive = false;
    this.dirty = true;
  }
}

export class Decals {
  readonly group = new THREE.Group();
  readonly splats: DecalLayer;
  readonly holes: DecalLayer;
  readonly scorch: DecalLayer;

  constructor() {
    this.scorch = new DecalLayer(12, scorchTexture(), false, 0);
    this.splats = new DecalLayer(220, splatAtlas(), true, 1);
    this.holes = new DecalLayer(90, bulletHoleTexture(), false, 2);
    this.group.add(this.scorch.mesh, this.splats.mesh, this.holes.mesh);
  }

  blood(pos: THREE.Vector3, normal: THREE.Vector3, size: number, opts: { streakDir?: THREE.Vector3; dark?: boolean; life?: number } = {}): void {
    const col = opts.dark ? 0x8e1f33 : rng.pick([0xc9303f, 0xbf2a3c, 0xcf3845]);
    if (opts.streakDir) {
      // orient the streak along the (projected) direction
      const rot = Math.atan2(-opts.streakDir.z, opts.streakDir.x);
      this.splats.add(pos, normal, size, col, { cell: 12 + rng.int(0, 3), rot, stretch: 1.15, life: opts.life ?? 28 });
    } else {
      // small droplets clean up quickly, big pools linger a bit longer
      this.splats.add(pos, normal, size, col, { cell: rng.int(0, 11), life: opts.life ?? (size < 0.3 ? 18 : 36) });
    }
  }

  splat(pos: THREE.Vector3, normal: THREE.Vector3, size: number, color: number, life = 30): void {
    this.splats.add(pos, normal, size, color, { cell: rng.int(0, 11), life });
  }

  bulletHole(pos: THREE.Vector3, normal: THREE.Vector3, size = 0.13): void {
    this.holes.add(pos, normal, size, 0xffffff, { life: 25, grow: 0, alpha: 0.9 });
  }

  scorchMark(pos: THREE.Vector3, size: number): void {
    this.scorch.add(pos, new THREE.Vector3(0, 1, 0), size, 0x3c3431, { life: 60, grow: 0.3, alpha: 0.85 });
  }

  update(dt: number): void {
    this.splats.update(dt);
    this.holes.update(dt);
    this.scorch.update(dt);
  }

  clear(): void {
    this.splats.clear();
    this.holes.clear();
    this.scorch.clear();
  }
}
