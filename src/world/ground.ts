import * as THREE from 'three';
import { Rng } from '../core/rng';
import { noise } from '../core/noise';
import { PAL } from '../render/palette';
import { asphaltTexture, cssColor, groundDetailTexture, mixColor, shade } from '../render/textures';
import { GLOBAL_UNIFORMS, toon } from '../render/materials';
import { LAYOUT, inPond } from './layout';

const N = 2048;

/** Paint the whole farm floor onto one big canvas: grass variation, paths, beds, shores. */
function paintGround(): HTMLCanvasElement {
  const S = LAYOUT.paintSize;
  const k = N / S;
  const X = (x: number) => (x + S / 2) * k;
  const Z = (z: number) => (z + S / 2) * k;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d')!;
  const r = new Rng(777);

  ctx.fillStyle = cssColor(PAL.grass);
  ctx.fillRect(0, 0, N, N);

  // --- large soft color variation from an upscaled noise canvas
  const lowRes = (size: number, freq: number, seed: number, alpha: number, colors: [number, number, number]) => {
    const s = document.createElement('canvas');
    s.width = size;
    s.height = size;
    const sc = s.getContext('2d')!;
    const img = sc.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const wx = (x / size) * S;
        const wz = (y / size) * S;
        const n = noise.fbm2(wx * freq + seed, wz * freq - seed, 3) * 0.5 + 0.5;
        const col = n < 0.5 ? mixColor(colors[0], colors[1], n * 2) : mixColor(colors[1], colors[2], (n - 0.5) * 2);
        const i = (y * size + x) * 4;
        img.data[i] = (col >> 16) & 255;
        img.data[i + 1] = (col >> 8) & 255;
        img.data[i + 2] = col & 255;
        img.data[i + 3] = 255;
      }
    }
    sc.putImageData(img, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, N, N);
    ctx.globalAlpha = 1;
  };
  lowRes(96, 0.035, 11, 0.85, [PAL.grassDark, PAL.grass, PAL.grassLight]);
  lowRes(220, 0.11, 47, 0.3, [PAL.grassDeep, PAL.grass, 0xcbd48c]);

  // warm sun-bleached patches
  for (let i = 0; i < 70; i++) {
    const x = r.range(-S / 2, S / 2);
    const z = r.range(-S / 2, S / 2);
    const rad = r.range(1.5, 5) * k;
    const g = ctx.createRadialGradient(X(x), Z(z), 0, X(x), Z(z), rad);
    const col = r.chance(0.5) ? 0xd2d690 : PAL.grassDeep;
    g.addColorStop(0, cssColor(col, 0.22));
    g.addColorStop(1, cssColor(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(X(x) - rad, Z(z) - rad, rad * 2, rad * 2);
  }

  // --- soft contact shadow / AO around big things
  const ao = (x: number, z: number, rad: number, a: number) => {
    const g = ctx.createRadialGradient(X(x), Z(z), 0, X(x), Z(z), rad * k);
    g.addColorStop(0, `rgba(60,80,40,${a})`);
    g.addColorStop(0.6, `rgba(60,80,40,${a * 0.5})`);
    g.addColorStop(1, 'rgba(60,80,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(X(x), Z(z), rad * k, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const t of LAYOUT.trees) ao(t.x, t.z, 2.6 * t.s, 0.22);
  for (const [x, z, s] of LAYOUT.bushes) ao(x, z, 1.3 * s, 0.25);
  const aoRect = (x: number, z: number, w: number, d: number, pad: number, a: number) => {
    ctx.save();
    ctx.filter = `blur(${pad * k * 0.5}px)`;
    ctx.fillStyle = `rgba(55,70,40,${a})`;
    ctx.fillRect(X(x - w / 2 - pad * 0.4), Z(z - d / 2 - pad * 0.4), (w + pad * 0.8) * k, (d + pad * 0.8) * k);
    ctx.restore();
  };
  const h = LAYOUT.house;
  aoRect(h.x, h.z, h.w, h.d, 1.2, 0.35);
  const b = LAYOUT.barn;
  aoRect(b.x, b.z, b.w, b.d, 1.4, 0.35);

  // --- road shoulder (gravel)
  const road = LAYOUT.road;
  ctx.save();
  ctx.filter = `blur(${0.25 * k}px)`;
  ctx.fillStyle = cssColor(PAL.gravel);
  ctx.fillRect(0, Z(road.z - road.width / 2 - 0.7), N, (road.width + 1.4) * k);
  ctx.restore();
  for (let i = 0; i < 900; i++) {
    const x = r.range(-S / 2, S / 2);
    const side = r.sign();
    const z = road.z + side * (road.width / 2 + r.range(0, 0.9));
    ctx.fillStyle = cssColor(r.pick([0xb8ab96, 0xd9cfbd, 0xa89c88]), 0.8);
    ctx.fillRect(X(x), Z(z), r.range(2, 4), r.range(2, 4));
  }

  // --- paths
  for (const p of LAYOUT.paths) {
    const base = p.kind === 'stone' ? 0xdccfb8 : p.kind === 'trail' ? mixColor(PAL.dirt, PAL.grass, 0.45) : PAL.dirt;
    const stroke = (w: number, col: number, a: number, blur: number) => {
      ctx.save();
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.strokeStyle = cssColor(col, a);
      ctx.lineWidth = w * k;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      p.pts.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z))));
      ctx.stroke();
      ctx.restore();
    };
    stroke(p.width + 0.5, mixColor(base, PAL.grassDark, 0.5), 0.5, 0.35 * k);
    stroke(p.width, base, 1, 0.12 * k);
    if (p.kind === 'dirt') {
      // tire tracks
      for (const off of [-0.55, 0.55]) {
        ctx.save();
        ctx.strokeStyle = cssColor(PAL.dirtDark, 0.45);
        ctx.lineWidth = 0.32 * k;
        ctx.lineCap = 'round';
        ctx.filter = `blur(${0.08 * k}px)`;
        ctx.beginPath();
        p.pts.forEach(([x, z], i) => {
          const j = Math.min(i, p.pts.length - 2);
          const dx = p.pts[j + 1][0] - p.pts[j][0];
          const dz = p.pts[j + 1][1] - p.pts[j][1];
          const l = Math.hypot(dx, dz);
          const nx = -dz / l;
          const nz = dx / l;
          const px = X(x + nx * off);
          const pz = Z(z + nz * off);
          if (i) ctx.lineTo(px, pz);
          else ctx.moveTo(px, pz);
        });
        ctx.stroke();
        ctx.restore();
      }
    }
    if (p.kind === 'stone') {
      // stepping stones
      for (let i = 0; i < p.pts.length - 1; i++) {
        const [ax, az] = p.pts[i];
        const [bx, bz] = p.pts[i + 1];
        const l = Math.hypot(bx - ax, bz - az);
        const n = Math.floor(l / 0.75);
        for (let s = 0; s < n; s++) {
          const t = (s + 0.5) / n;
          const x = ax + (bx - ax) * t + r.spread(0.12);
          const z = az + (bz - az) * t + r.spread(0.08);
          ctx.fillStyle = cssColor(shade(0xe9e0cf, r.range(0.94, 1.04)));
          ctx.strokeStyle = cssColor(0xb6a78e, 0.6);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(X(x), Z(z), r.range(0.26, 0.34) * k, r.range(0.2, 0.26) * k, r.spread(0.5), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    // pebbles
    for (let i = 0; i < p.pts.length - 1; i++) {
      const [ax, az] = p.pts[i];
      const [bx, bz] = p.pts[i + 1];
      const l = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < l * 14; s++) {
        const t = r.next();
        const x = ax + (bx - ax) * t + r.spread(p.width * 0.45);
        const z = az + (bz - az) * t + r.spread(p.width * 0.45);
        ctx.fillStyle = cssColor(r.pick([PAL.dirtDark, 0xe8d7b6, 0xc7ab85]), 0.55);
        ctx.beginPath();
        ctx.arc(X(x), Z(z), r.range(1.2, 2.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // --- garden beds
  for (const bed of LAYOUT.beds) {
    const x0 = X(bed.x - bed.w / 2);
    const z0 = Z(bed.z - bed.d / 2);
    ctx.save();
    ctx.filter = `blur(${0.15 * k}px)`;
    ctx.fillStyle = cssColor(mixColor(PAL.soil, PAL.grassDark, 0.4), 0.6);
    ctx.beginPath();
    ctx.roundRect(x0 - 0.25 * k, z0 - 0.25 * k, (bed.w + 0.5) * k, (bed.d + 0.5) * k, 0.4 * k);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = cssColor(PAL.soil);
    ctx.beginPath();
    ctx.roundRect(x0, z0, bed.w * k, bed.d * k, 0.25 * k);
    ctx.fill();
    // furrows
    if (bed.rows > 0) {
      const vertical = bed.d > bed.w;
      for (let i = 0; i < bed.rows; i++) {
        const t = (i + 0.5) / bed.rows;
        ctx.strokeStyle = cssColor(PAL.soilDark, 0.7);
        ctx.lineWidth = 0.16 * k;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (vertical) {
          const x = x0 + bed.w * k * t;
          ctx.moveTo(x, z0 + 0.2 * k);
          ctx.lineTo(x, z0 + (bed.d - 0.2) * k);
        } else {
          const z = z0 + bed.d * k * t;
          ctx.moveTo(x0 + 0.2 * k, z);
          ctx.lineTo(x0 + (bed.w - 0.2) * k, z);
        }
        ctx.stroke();
      }
    }
    for (let i = 0; i < bed.w * bed.d * 30; i++) {
      ctx.fillStyle = cssColor(r.pick([PAL.soilDark, 0xb08a68]), 0.6);
      ctx.fillRect(x0 + r.next() * bed.w * k, z0 + r.next() * bed.d * k, 2, 2);
    }
  }

  // --- pond shore & bed
  const p = LAYOUT.pond;
  const ell = (rx: number, rz: number, col: number, a: number, blur: number) => {
    ctx.save();
    if (blur) ctx.filter = `blur(${blur * k}px)`;
    ctx.fillStyle = cssColor(col, a);
    ctx.beginPath();
    ctx.ellipse(X(p.x), Z(p.z), rx * k, rz * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  ell(p.rx + 1.6, p.rz + 1.4, PAL.grassDeep, 0.45, 0.8);
  ell(p.rx + 0.75, p.rz + 0.65, 0xcdb88f, 1, 0.25);
  ell(p.rx + 0.3, p.rz + 0.25, 0x9d8a66, 1, 0.15);

  // painterly grass strokes
  for (let i = 0; i < 16000; i++) {
    const x = r.range(-S / 2, S / 2);
    const z = r.range(-S / 2, S / 2);
    if (inPond(x, z, 0.8)) continue;
    const light = r.chance(0.5);
    ctx.strokeStyle = light ? 'rgba(236,240,170,0.16)' : 'rgba(70,100,50,0.13)';
    ctx.lineWidth = r.range(1.5, 3);
    ctx.lineCap = 'round';
    const a = -Math.PI / 2 + r.spread(0.5);
    const l = r.range(4, 9);
    ctx.beginPath();
    ctx.moveTo(X(x), Z(z));
    ctx.lineTo(X(x) + Math.cos(a) * l, Z(z) + Math.sin(a) * l);
    ctx.stroke();
  }
  return c;
}

export function createGround(): THREE.Group {
  const group = new THREE.Group();
  const S = LAYOUT.paintSize;
  const tex = new THREE.CanvasTexture(paintGround());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;

  const size = 420;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) + S / 2) / S, 1 - (pos.getZ(i) + S / 2) / S);
  }
  const mat = toon(0xffffff, { map: tex }).clone();
  const detail = groundDetailTexture();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uBase = { value: new THREE.Color(PAL.grass) };
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGroundWorld;
         uniform sampler2D uDetail;
         uniform vec3 uBase;
         uniform float uTime;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec2 guv = vMapUv;
           float inside = 1.0 - smoothstep(0.44, 0.5, max(abs(guv.x - 0.5), abs(guv.y - 0.5)));
           float far = texture2D(uDetail, vGroundWorld.xz * 0.013).r;
           vec3 outer = uBase * (0.86 + far * 0.3);
           diffuseColor.rgb = mix(outer, diffuseColor.rgb, inside);
           float d = texture2D(uDetail, vGroundWorld.xz * 0.42).r;
           float d2 = texture2D(uDetail, vGroundWorld.xz * 0.13 + 0.37).r;
           diffuseColor.rgb *= 0.86 + d * 0.2 + d2 * 0.08;
           // slow drifting cloud shadows
           float cloud = texture2D(uDetail, vGroundWorld.xz * 0.012 + vec2(uTime * 0.004, uTime * 0.0015)).r;
           diffuseColor.rgb *= 1.0 - smoothstep(0.52, 0.68, cloud) * 0.1;
         }`,
      );
  };
  mat.customProgramCacheKey = () => 'ground';
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  // road
  const road = LAYOUT.road;
  const rgeo = new THREE.PlaneGeometry(200, road.width, 1, 1);
  rgeo.rotateX(-Math.PI / 2);
  const ruv = rgeo.getAttribute('uv') as THREE.BufferAttribute;
  const rpos = rgeo.getAttribute('position');
  const repeatLen = road.width * 4;
  for (let i = 0; i < rpos.count; i++) ruv.setXY(i, rpos.getX(i) / repeatLen, ruv.getY(i));
  const rtex = asphaltTexture();
  const rmesh = new THREE.Mesh(rgeo, toon(0xffffff, { map: rtex }));
  rmesh.position.set(0, 0.012, road.z);
  rmesh.receiveShadow = true;
  group.add(rmesh);
  return group;
}
