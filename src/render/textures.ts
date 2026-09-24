import * as THREE from 'three';
import { Rng } from '../core/rng';

/**
 * Every texture in the game is painted here at runtime on a <canvas>. Most are near-white
 * so a material color can tint them; a few (faces, bricks, straw) are painted in color.
 */

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const cache = new Map<string, THREE.CanvasTexture>();

export function canvasTexture(
  key: string,
  w: number,
  h: number,
  draw: Draw,
  opts: { repeat?: boolean; srgb?: boolean; mipmaps?: boolean; nearest?: boolean } = {},
): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 4;
  if (opts.nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  } else if (opts.mipmaps === false) {
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
  }
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}

/** Periodic value noise so textures tile seamlessly. */
export class TileNoise {
  private grid: Float32Array;

  constructor(
    private period: number,
    seed: number,
  ) {
    const r = new Rng(seed);
    this.grid = new Float32Array(period * period);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = r.next();
  }

  sample(x: number, y: number): number {
    const p = this.period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const i0 = ((x0 % p) + p) % p;
    const j0 = ((y0 % p) + p) % p;
    const i1 = (i0 + 1) % p;
    const j1 = (j0 + 1) % p;
    const g = this.grid;
    const a = g[j0 * p + i0];
    const b = g[j0 * p + i1];
    const c = g[j1 * p + i0];
    const d = g[j1 * p + i1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
}

/** Fractal periodic noise in [0,1] over a canvas of size w (u in [0,1)). */
export function tileFbm(seed: number, baseCells: number, octaves: number) {
  const layers: { n: TileNoise; cells: number; amp: number }[] = [];
  let amp = 1;
  let cells = baseCells;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: new TileNoise(cells, seed + o * 101), cells, amp });
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return (u: number, v: number) => {
    let s = 0;
    for (const l of layers) s += l.n.sample(u * l.cells, v * l.cells) * l.amp;
    return s / norm;
  };
}

const hex = (c: number, a = 1) => {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
};
export const cssColor = hex;

/** Multiply an sRGB hex color by a scalar (for painted shading). */
export function shade(c: number, k: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}

export function mixColor(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

// ---------------------------------------------------------------------------------------------
// Building materials
// ---------------------------------------------------------------------------------------------

export function woodSidingTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'siding',
    256,
    256,
    (ctx, w, h) => {
      const r = new Rng(11);
      const rows = 8;
      const rh = h / rows;
      for (let i = 0; i < rows; i++) {
        const y = i * rh;
        const v = 242 + r.int(0, 13);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, y, w, rh);
        // soft grain
        for (let k = 0; k < 5; k++) {
          ctx.strokeStyle = `rgba(110,80,60,${0.03 + r.next() * 0.03})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          const gy = y + 4 + r.next() * (rh - 10);
          ctx.moveTo(0, gy);
          for (let x = 0; x <= w; x += 16) ctx.lineTo(x, gy + Math.sin(x * 0.05 + k) * 1.2);
          ctx.stroke();
        }
        // plank shadow edge + highlight
        const grad = ctx.createLinearGradient(0, y + rh - 7, 0, y + rh);
        grad.addColorStop(0, 'rgba(90,60,45,0)');
        grad.addColorStop(1, 'rgba(90,60,45,0.28)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, y + rh - 7, w, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(0, y, w, 1.5);
        // butt joints
        const jx = r.next() * w;
        ctx.fillStyle = 'rgba(90,60,45,0.22)';
        ctx.fillRect(jx, y, 1.5, rh);
      }
    },
    { repeat: true },
  );
}

export function shingleTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'shingles',
    256,
    256,
    (ctx, w, h) => {
      const r = new Rng(21);
      ctx.fillStyle = 'rgb(205,205,205)';
      ctx.fillRect(0, 0, w, h);
      const rows = 8;
      const rh = h / rows;
      const sw = 32;
      for (let i = rows; i >= -1; i--) {
        const y = i * rh;
        const off = i % 2 === 0 ? 0 : sw / 2;
        for (let x = -sw; x < w + sw; x += sw) {
          const v = 228 + r.int(0, 27);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.beginPath();
          const x0 = x + off + 1;
          const x1 = x + off + sw - 1;
          ctx.moveTo(x0, y - 2);
          ctx.lineTo(x1, y - 2);
          ctx.lineTo(x1, y + rh - 8);
          ctx.quadraticCurveTo(x1, y + rh + 2, (x0 + x1) / 2, y + rh + 2);
          ctx.quadraticCurveTo(x0, y + rh + 2, x0, y + rh - 8);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(80,50,40,0.25)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // bottom shade inside shingle
          const g = ctx.createLinearGradient(0, y + rh - 10, 0, y + rh + 2);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(60,30,30,0.12)');
          ctx.fillStyle = g;
          ctx.fill();
        }
      }
    },
    { repeat: true },
  );
}

export function brickTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'bricks',
    128,
    128,
    (ctx, w, h) => {
      const r = new Rng(31);
      ctx.fillStyle = '#eadfcf';
      ctx.fillRect(0, 0, w, h);
      const rows = 8;
      const rh = h / rows;
      const bw = 32;
      for (let i = 0; i < rows; i++) {
        const off = i % 2 ? bw / 2 : 0;
        for (let x = -bw; x < w + bw; x += bw) {
          const k = 0.88 + r.next() * 0.2;
          ctx.fillStyle = hex(shade(0xc47a62, k));
          ctx.beginPath();
          ctx.roundRect(x + off + 1.5, i * rh + 1.5, bw - 3, rh - 3, 2);
          ctx.fill();
        }
      }
    },
    { repeat: true },
  );
}

export function barnBoardTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'barnboards',
    256,
    256,
    (ctx, w, h) => {
      const r = new Rng(41);
      const cols = 8;
      const cw = w / cols;
      for (let i = 0; i < cols; i++) {
        const v = 236 + r.int(0, 19);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(i * cw, 0, cw, h);
        for (let k = 0; k < 4; k++) {
          ctx.strokeStyle = `rgba(90,40,30,${0.04 + r.next() * 0.04})`;
          ctx.beginPath();
          const gx = i * cw + 4 + r.next() * (cw - 8);
          ctx.moveTo(gx, 0);
          for (let y = 0; y <= h; y += 16) ctx.lineTo(gx + Math.sin(y * 0.04 + k * 2) * 1.4, y);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(70,30,25,0.3)';
        ctx.fillRect(i * cw + cw - 2.5, 0, 2.5, h);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(i * cw, 0, 1.2, h);
      }
    },
    { repeat: true },
  );
}

export function crateTexture(): THREE.CanvasTexture {
  return canvasTexture('crate', 128, 128, (ctx, w, h) => {
    const r = new Rng(51);
    const base = 0xcf9f6b;
    ctx.fillStyle = hex(base);
    ctx.fillRect(0, 0, w, h);
    const planks = 4;
    for (let i = 0; i < planks; i++) {
      ctx.fillStyle = hex(shade(base, 0.92 + r.next() * 0.14));
      ctx.fillRect(0, (i * h) / planks, w, h / planks - 2);
      ctx.fillStyle = hex(shade(base, 0.7), 0.6);
      ctx.fillRect(0, ((i + 1) * h) / planks - 2, w, 2);
    }
    // frame
    const f = 14;
    ctx.fillStyle = hex(shade(base, 0.82));
    ctx.fillRect(0, 0, w, f);
    ctx.fillRect(0, h - f, w, f);
    ctx.fillRect(0, 0, f, h);
    ctx.fillRect(w - f, 0, f, h);
    // brace
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 4);
    ctx.fillRect(-w * 0.7, -f / 2, w * 1.4, f);
    ctx.restore();
    ctx.strokeStyle = hex(shade(base, 0.6), 0.5);
    ctx.lineWidth = 2;
    ctx.strokeRect(f, f, w - 2 * f, h - 2 * f);
    ctx.strokeRect(1, 1, w - 2, h - 2);
    // nails
    ctx.fillStyle = 'rgba(70,60,60,0.8)';
    for (const [x, y] of [
      [7, 7],
      [w - 7, 7],
      [7, h - 7],
      [w - 7, h - 7],
    ])
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  });
}

export function strawTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'straw',
    128,
    128,
    (ctx, w, h) => {
      const r = new Rng(61);
      ctx.fillStyle = hex(0xe6c46b);
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 420; i++) {
        const x = r.next() * w;
        const y = r.next() * h;
        const a = r.spread(0.5);
        const l = 5 + r.next() * 10;
        ctx.strokeStyle = hex(r.pick([0xf4dc8e, 0xd2a94f, 0xf7e7a6, 0xc99c45]), 0.8);
        ctx.lineWidth = 1 + r.next();
        ctx.beginPath();
        for (const ox of [0, w, -w]) {
          for (const oy of [0, h, -h]) {
            ctx.moveTo(x + ox, y + oy);
            ctx.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
          }
        }
        ctx.stroke();
      }
    },
    { repeat: true },
  );
}

export function asphaltTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'asphalt',
    512,
    128,
    (ctx, w, h) => {
      const r = new Rng(71);
      const n = tileFbm(7, 8, 4);
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = n(x / w, (y / h) * 0.25);
          const k = 0.93 + v * 0.12 + (r.next() - 0.5) * 0.05;
          const i = (y * w + x) * 4;
          img.data[i] = 142 * k;
          img.data[i + 1] = 143 * k;
          img.data[i + 2] = 156 * k;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // worn edges (lighter)
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(210,205,200,0.55)');
      g.addColorStop(0.07, 'rgba(210,205,200,0.0)');
      g.addColorStop(0.93, 'rgba(210,205,200,0.0)');
      g.addColorStop(1, 'rgba(210,205,200,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // dashed center line, slightly worn
      ctx.fillStyle = hex(0xf1d27f, 0.92);
      for (let x = 0; x < w; x += 256) {
        ctx.beginPath();
        ctx.roundRect(x + 30, h / 2 - 3, 150, 6, 3);
        ctx.fill();
      }
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = 'rgba(142,143,156,0.6)';
        ctx.fillRect(r.next() * w, h / 2 - 3 + r.next() * 6, 2 + r.next() * 3, 1.5);
      }
      // a few cracks
      ctx.strokeStyle = 'rgba(90,90,100,0.25)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        let x = r.next() * w;
        let y = r.next() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) {
          x += r.spread(14);
          y += r.spread(8);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    },
    { repeat: true },
  );
}

// ---------------------------------------------------------------------------------------------
// FX sprites
// ---------------------------------------------------------------------------------------------

export function softCircleTexture(): THREE.CanvasTexture {
  return canvasTexture('softcircle', 64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Cartoon puff: solid-ish disc with a soft rim and a subtle baked highlight. */
export function puffTexture(): THREE.CanvasTexture {
  return canvasTexture('puff', 128, 128, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, w * 0.3, cx, cy, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // inner shading: darker bottom-right to give volume
    ctx.globalCompositeOperation = 'source-atop';
    const s = ctx.createRadialGradient(cx - w * 0.14, cy - h * 0.16, w * 0.05, cx, cy, w * 0.52);
    s.addColorStop(0, 'rgba(255,255,255,0)');
    s.addColorStop(0.6, 'rgba(200,196,205,0.0)');
    s.addColorStop(1, 'rgba(150,140,160,0.45)');
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Muzzle flash star, painted in its final colors (used additively). */
export function flashTexture(): THREE.CanvasTexture {
  return canvasTexture('flash', 128, 128, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
    glow.addColorStop(0, 'rgba(255,240,190,0.9)');
    glow.addColorStop(0.35, 'rgba(255,180,80,0.35)');
    glow.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const spikes = 7;
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const rad = i % 2 === 0 ? w * (0.36 + (i % 4 === 0 ? 0.1 : 0)) : w * 0.12;
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,214,120,1)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,235,1)';
    ctx.fill();
  });
}

export function ringTexture(): THREE.CanvasTexture {
  return canvasTexture('ring', 128, 128, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, w * 0.3, cx, cy, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,1)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/**
 * 4x4 atlas of stylized splats. Cells 0-11: round splats with droplets. 12-15: directional
 * streaks (pointing +x) for sliding trails and wall hits.
 */
export function splatAtlas(): THREE.CanvasTexture {
  return canvasTexture('splats', 512, 512, (ctx, w) => {
    const cell = w / 4;
    const r = new Rng(81);
    for (let i = 0; i < 16; i++) {
      const cx = (i % 4) * cell + cell / 2;
      const cy = Math.floor(i / 4) * cell + cell / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - cell / 2, cy - cell / 2, cell, cell);
      ctx.clip();
      const streak = i >= 12;
      // rim tone slightly darker than core
      const blobs: [number, number, number][] = [];
      if (!streak) {
        const n = 5 + r.int(0, 4);
        for (let k = 0; k < n; k++) {
          const a = r.angle();
          const d = r.next() * cell * 0.13;
          blobs.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, cell * (0.1 + r.next() * 0.11)]);
        }
        const drops = 5 + r.int(0, 7);
        for (let k = 0; k < drops; k++) {
          const a = r.angle();
          const d = cell * (0.25 + r.next() * 0.18);
          blobs.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, cell * (0.015 + r.next() * 0.035)]);
        }
      } else {
        // tear-drop smear: fat head, short tapering tail, a few flung droplets ahead
        const len = cell * 0.3;
        for (let k = 0; k < 9; k++) {
          const t = k / 8;
          blobs.push([cx + len - t * len * 2, cy + r.spread(cell * 0.015), cell * (0.15 - t * 0.1)]);
        }
        for (let k = 0; k < 5; k++) {
          blobs.push([cx + len * (1.3 + r.next() * 0.5), cy + r.spread(cell * 0.1), cell * (0.015 + r.next() * 0.025)]);
        }
      }
      ctx.fillStyle = 'rgb(205,205,205)';
      for (const [x, y, rad] of blobs) {
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgb(255,255,255)';
      for (const [x, y, rad] of blobs) {
        ctx.beginPath();
        ctx.arc(x - rad * 0.08, y - rad * 0.08, rad * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  });
}

export function scorchTexture(): THREE.CanvasTexture {
  return canvasTexture('scorch', 256, 256, (ctx, w, h) => {
    const r = new Rng(91);
    const cx = w / 2;
    const cy = h / 2;
    for (let i = 0; i < 28; i++) {
      const a = r.angle();
      const len = w * (0.25 + r.next() * 0.22);
      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 4 + r.next() * 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.32);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export function bulletHoleTexture(): THREE.CanvasTexture {
  return canvasTexture('bullethole', 64, 64, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
    g.addColorStop(0, 'rgba(40,30,30,1)');
    g.addColorStop(0.28, 'rgba(40,30,30,1)');
    g.addColorStop(0.36, 'rgba(90,70,60,0.6)');
    g.addColorStop(0.62, 'rgba(90,70,60,0.18)');
    g.addColorStop(1, 'rgba(90,70,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export function leafTexture(): THREE.CanvasTexture {
  return canvasTexture('leaf', 64, 64, (ctx, w, h) => {
    ctx.translate(w / 2, h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.42);
    ctx.bezierCurveTo(w * 0.36, -h * 0.2, w * 0.3, h * 0.25, 0, h * 0.42);
    ctx.bezierCurveTo(-w * 0.3, h * 0.25, -w * 0.36, -h * 0.2, 0, -h * 0.42);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,120,120,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.35);
    ctx.lineTo(0, h * 0.4);
    ctx.stroke();
  });
}

/** Shared tileable ground detail (0.5 = neutral). */
export function groundDetailTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'grounddetail',
    256,
    256,
    (ctx, w, h) => {
      const n = tileFbm(3, 6, 4);
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = n(x / w, y / h);
          const k = 128 + (v - 0.5) * 70;
          const i = (y * w + x) * 4;
          img.data[i] = k;
          img.data[i + 1] = k;
          img.data[i + 2] = k;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // small painterly strokes
      const r = new Rng(5);
      for (let i = 0; i < 260; i++) {
        const x = r.next() * w;
        const y = r.next() * h;
        const light = r.chance(0.5);
        ctx.strokeStyle = light ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1.5 + r.next() * 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const a = -Math.PI / 2 + r.spread(0.6);
        const l = 3 + r.next() * 5;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        ctx.stroke();
      }
    },
    { repeat: true, srgb: false },
  );
}

// ---------------------------------------------------------------------------------------------
// Faces (painted onto head spheres; +Z front is at u = 0.25)
// ---------------------------------------------------------------------------------------------

export type FaceKind =
  | 'player'
  | 'playerBlink'
  | 'playerHurt'
  | 'playerDead'
  | 'zombie'
  | 'zombieBlink'
  | 'zombieAttack'
  | 'zombieHurt'
  | 'zombieDead';

/**
 * Painted face for a head sphere. Expressions share everything but eyes/mouth so swapping the
 * texture reads as the same character blinking, flinching or opening its mouth. Zombie faces
 * are painted at half resolution (there are many of them and they are never seen up close).
 */
export function faceTexture(kind: FaceKind, skin: number, variant = 0): THREE.CanvasTexture {
  const player = kind.startsWith('player');
  const res = player ? 1024 : 512;
  return canvasTexture(`face-${kind}-${skin}-${variant}`, res, res / 2, (ctx) => {
    ctx.scale(res / 1024, res / 1024);
    const w = 1024;
    const h = 512;
    const r = new Rng(100 + variant * 7);
    ctx.fillStyle = hex(skin);
    ctx.fillRect(0, 0, w, h);
    const fx = w * 0.25; // face center u
    const eyeY = h * 0.54;
    const px = (du: number) => fx + du * w; // du in u-units
    const py = (dv: number) => dv * h;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (!player) {
      // blotches
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = hex(shade(skin, 0.86), 0.35);
        ctx.beginPath();
        ctx.ellipse(r.next() * w, h * (0.3 + r.next() * 0.5), 10 + r.next() * 22, 8 + r.next() * 16, r.angle(), 0, Math.PI * 2);
        ctx.fill();
      }
      // stitches
      ctx.strokeStyle = hex(shade(skin, 0.45), 0.9);
      ctx.lineWidth = 3;
      const sx = px(0.07 + variant * 0.01);
      const sy = py(0.36);
      ctx.beginPath();
      ctx.moveTo(sx - 30, sy);
      ctx.quadraticCurveTo(sx, sy - 10, sx + 30, sy + 4);
      ctx.stroke();
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(sx + k * 12 - 4, sy - 9 + Math.abs(k));
        ctx.lineTo(sx + k * 12 + 4, sy + 7 + Math.abs(k));
        ctx.stroke();
      }
    }

    // ---------------------------------------------------------------- player
    if (player && kind !== 'playerDead') {
      // blush
      for (const s of [-1, 1]) {
        ctx.fillStyle = kind === 'playerHurt' ? 'rgba(240,110,110,0.5)' : 'rgba(240,120,120,0.35)';
        ctx.beginPath();
        ctx.ellipse(px(s * 0.078), py(0.6), 22, 12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (kind === 'player' || kind === 'playerBlink') {
      for (const s of [-1, 1]) {
        const x = px(s * 0.043);
        if (kind === 'player') {
          ctx.fillStyle = '#2b2226';
          ctx.beginPath();
          ctx.ellipse(x, eyeY, 11, 17, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x + 3, eyeY - 6, 4.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // closed: a soft lash curve
          ctx.strokeStyle = '#2b2226';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(x, eyeY - 4, 12, 0.18 * Math.PI, 0.82 * Math.PI);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = '#6b3b34';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(fx, py(0.61), 10, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    if (kind === 'playerHurt') {
      // squeezed eyes > <
      ctx.strokeStyle = '#2b2226';
      ctx.lineWidth = 5;
      for (const s of [-1, 1]) {
        const x = px(s * 0.043);
        ctx.beginPath();
        ctx.moveTo(x - 10 * s, eyeY - 10);
        ctx.lineTo(x + 6 * s, eyeY);
        ctx.lineTo(x - 10 * s, eyeY + 10);
        ctx.stroke();
      }
      ctx.fillStyle = '#6b3b34';
      ctx.beginPath();
      ctx.ellipse(fx, py(0.63), 8, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (kind === 'playerDead') {
      ctx.strokeStyle = '#2b2226';
      ctx.lineWidth = 5;
      for (const s of [-1, 1]) {
        const x = px(s * 0.043);
        ctx.beginPath();
        ctx.moveTo(x - 9, eyeY - 9);
        ctx.lineTo(x + 9, eyeY + 9);
        ctx.moveTo(x + 9, eyeY - 9);
        ctx.lineTo(x - 9, eyeY + 9);
        ctx.stroke();
      }
    }

    // ---------------------------------------------------------------- zombie
    if (player) return;
    const big = variant % 2 === 0 ? 1 : -1;
    const lidColor = hex(shade(skin, 0.8));
    const rim = hex(shade(skin, 0.5), 0.8);
    const brow = hex(shade(skin, 0.45));
    if (kind === 'zombie' || kind === 'zombieAttack') {
      const attack = kind === 'zombieAttack';
      for (const s of [-1, 1]) {
        const rad = (s === big ? 17 : 12) * (attack ? 1.25 : 1);
        const x = px(s * 0.046);
        ctx.fillStyle = hex(0xfff6c9);
        ctx.beginPath();
        ctx.arc(x, eyeY, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rim;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = attack ? '#8a1f2c' : '#5a1f2a';
        ctx.beginPath();
        ctx.arc(x + s * 2 + (variant % 3) - 1, eyeY + 2, rad * (attack ? 0.22 : 0.32), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = brow;
      ctx.lineWidth = 5;
      if (attack) {
        // angry brows slanting to the nose
        for (const s of [-1, 1]) {
          const x = px(s * 0.046);
          ctx.beginPath();
          ctx.moveTo(x + s * 20, eyeY - 30);
          ctx.lineTo(x - s * 14, eyeY - 19);
          ctx.stroke();
        }
      } else {
        // droopy brow on the small eye
        ctx.beginPath();
        ctx.moveTo(px(-big * 0.046) - 14, eyeY - 18);
        ctx.lineTo(px(-big * 0.046) + 14, eyeY - 13);
        ctx.stroke();
      }
    } else if (kind === 'zombieBlink') {
      for (const s of [-1, 1]) {
        const rad = s === big ? 17 : 12;
        const x = px(s * 0.046);
        ctx.fillStyle = lidColor;
        ctx.beginPath();
        ctx.arc(x, eyeY, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rim;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.strokeStyle = brow;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x - rad * 0.95, eyeY + 1);
        ctx.quadraticCurveTo(x, eyeY + rad * 0.5, x + rad * 0.95, eyeY + 1);
        ctx.stroke();
      }
    } else if (kind === 'zombieHurt') {
      ctx.strokeStyle = '#3a2228';
      ctx.lineWidth = 6;
      for (const s of [-1, 1]) {
        const x = px(s * 0.046);
        ctx.beginPath();
        ctx.moveTo(x - 12 * s, eyeY - 12);
        ctx.lineTo(x + 7 * s, eyeY);
        ctx.lineTo(x - 12 * s, eyeY + 12);
        ctx.stroke();
      }
    } else if (kind === 'zombieDead') {
      ctx.strokeStyle = '#3a2228';
      ctx.lineWidth = 6;
      for (const s of [-1, 1]) {
        const x = px(s * 0.046);
        ctx.beginPath();
        ctx.moveTo(x - 11, eyeY - 11);
        ctx.lineTo(x + 11, eyeY + 11);
        ctx.moveTo(x + 11, eyeY - 11);
        ctx.lineTo(x - 11, eyeY + 11);
        ctx.stroke();
      }
    }

    // mouths
    const my = py(0.66);
    if (kind === 'zombieAttack') {
      // gaping mouth: two rows of teeth and a tongue
      ctx.fillStyle = '#3e1520';
      ctx.beginPath();
      ctx.ellipse(fx + 4, my + 8, 30, 27, 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c95a6a';
      ctx.beginPath();
      ctx.ellipse(fx + 8, my + 24, 16, 9, 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fbf4dc';
      ctx.fillRect(fx - 14, my - 18, 8, 10);
      ctx.fillRect(fx + 2, my - 19, 7, 9);
      ctx.fillRect(fx + 16, my - 16, 6, 7);
      ctx.fillRect(fx - 6, my + 27, 7, 7);
      ctx.fillRect(fx + 12, my + 26, 6, 7);
    } else if (kind === 'zombieHurt') {
      // clenched grimace
      ctx.fillStyle = '#4a1d27';
      ctx.beginPath();
      ctx.ellipse(fx + 4, my + 2, 22, 9, 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fbf4dc';
      ctx.fillRect(fx - 12, my - 4, 30, 6);
      ctx.strokeStyle = '#4a1d27';
      ctx.lineWidth = 2;
      for (let k = -1; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(fx + k * 7, my - 4);
        ctx.lineTo(fx + k * 7, my + 2);
        ctx.stroke();
      }
    } else {
      // open mouth with two teeth
      const dead = kind === 'zombieDead';
      ctx.fillStyle = '#4a1d27';
      ctx.beginPath();
      ctx.ellipse(fx + 4, my, 20, dead ? 9 : 14, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fbf4dc';
      ctx.fillRect(fx - 8, my - (dead ? 8 : 13), 7, 8);
      ctx.fillRect(fx + 6, my - (dead ? 8 : 13), 6, 6);
      if (dead) {
        ctx.fillStyle = '#e07a86';
        ctx.beginPath();
        ctx.ellipse(fx + 10, my + 10, 8, 11, 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}
