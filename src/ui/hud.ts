import { crosshairSvg, dynamiteSvg, heartSvg, pistolSvg, shotgunSvg, zombieHeadSvg } from './icons';
import type { Player } from '../entities/player';

/**
 * Minimal HUD: hearts (top-left), weapon + ammo (bottom-right), a small objective (top-right)
 * and a custom crosshair. Everything else is the world.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private hearts: HTMLDivElement;
  private heartEls: HTMLDivElement[] = [];
  private weaponIcon: HTMLDivElement;
  private mag: HTMLSpanElement;
  private reserve: HTMLSpanElement;
  private weaponBox: HTMLDivElement;
  private objective: HTMLDivElement;
  private objText: HTMLSpanElement;
  private objCount: HTMLSpanElement;
  private cross: HTMLDivElement;
  private crossRing: SVGGElement;
  private crossHit: SVGGElement;
  private crossReload: SVGCircleElement;
  private toastEl: HTMLDivElement;
  private toastT = 0;
  private fpsEl!: HTMLDivElement;
  private dyn: HTMLDivElement;
  private dynCount: HTMLSpanElement;
  private lastDyn = -1;
  private lastHp = -1;
  private lastWeapon = '';
  private lastMag = -1;
  private lastReserve = -1;
  visible = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-hearts"></div>
      <div class="hud-fps"></div>
      <div class="hud-objective"><span class="obj-icon">${zombieHeadSvg}</span><span class="obj-text"></span><span class="obj-count"></span></div>
      <div class="hud-weapon"><div class="weapon-icon"></div><div class="ammo"><span class="mag">0</span><span class="sep">/</span><span class="reserve">0</span></div></div>
      <div class="hud-dyn" title="G: dinamite"><span class="dyn-icon">${dynamiteSvg}</span><span class="dyn-count">×0</span><span class="dyn-key">G</span></div>
      <div class="hud-toast"></div>
      <div class="hud-bars"><i></i><i></i></div>
      <div class="crosshair">${crosshairSvg}</div>
    `;
    parent.appendChild(this.root);
    this.hearts = this.root.querySelector('.hud-hearts')!;
    this.weaponIcon = this.root.querySelector('.weapon-icon')!;
    this.weaponBox = this.root.querySelector('.hud-weapon')!;
    this.mag = this.root.querySelector('.mag')!;
    this.reserve = this.root.querySelector('.reserve')!;
    this.objective = this.root.querySelector('.hud-objective')!;
    this.objText = this.root.querySelector('.obj-text')!;
    this.objCount = this.root.querySelector('.obj-count')!;
    this.cross = this.root.querySelector('.crosshair')!;
    this.crossRing = this.root.querySelector('.ch-ring')!;
    this.crossHit = this.root.querySelector('.ch-hit')!;
    this.crossReload = this.root.querySelector('.ch-reload')!;
    this.toastEl = this.root.querySelector('.hud-toast')!;
    this.dyn = this.root.querySelector('.hud-dyn')!;
    this.fpsEl = this.root.querySelector('.hud-fps')!;
    this.dynCount = this.root.querySelector('.dyn-count')!;
  }

  /** Small FPS / quality readout (null hides it). */
  setFps(text: string | null): void {
    const t = text ?? '';
    if (this.fpsEl.textContent !== t) this.fpsEl.textContent = t;
  }

  /** A chunky label that pops out of a screen point and floats up (environmental kills etc.). */
  feat(text: string, x: number, y: number): void {
    const el = document.createElement('div');
    el.className = 'hud-feat';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--tilt', `${(Math.random() * 10 - 5).toFixed(1)}deg`);
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  setObjective(text: string, count: string): void {
    if (this.objText.textContent !== text) this.objText.textContent = text;
    if (this.objCount.textContent !== count) {
      this.objCount.textContent = count;
      this.objective.classList.remove('pulse');
      void this.objective.offsetWidth;
      this.objective.classList.add('pulse');
    }
  }

  toast(msg: string, seconds = 2.2): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this.toastT = seconds;
  }

  update(dt: number, p: Player, mouseX: number, mouseY: number): void {
    // hearts
    if (p.maxHp !== this.heartEls.length) {
      this.hearts.innerHTML = '';
      this.heartEls = [];
      for (let i = 0; i < p.maxHp; i++) {
        const h = document.createElement('div');
        h.className = 'heart';
        this.hearts.appendChild(h);
        this.heartEls.push(h);
      }
      this.lastHp = -1;
    }
    const hp = Math.max(0, Math.ceil(p.hp));
    if (hp !== this.lastHp) {
      const lost = this.lastHp > hp;
      this.heartEls.forEach((h, i) => {
        const full = i < hp;
        h.innerHTML = heartSvg(full ? '#ef6b6b' : '#e9d9c9', full ? '#5b3a36' : '#b9a595');
        h.classList.toggle('empty', !full);
        if (lost && i === hp) {
          h.classList.remove('pop');
          void h.offsetWidth;
          h.classList.add('pop');
        }
      });
      this.lastHp = hp;
    }
    this.hearts.classList.toggle('low', hp <= 1 && p.alive);

    // weapon
    if (p.weapon.id !== this.lastWeapon) {
      this.weaponIcon.innerHTML = p.weapon.id === 'shotgun' ? shotgunSvg : pistolSvg;
      this.lastWeapon = p.weapon.id;
      this.weaponBox.classList.remove('swap');
      void this.weaponBox.offsetWidth;
      this.weaponBox.classList.add('swap');
    }
    const a = p.currentAmmo;
    if (a.mag !== this.lastMag) {
      this.mag.textContent = String(a.mag);
      if (a.mag < this.lastMag) {
        this.mag.classList.remove('kick');
        void this.mag.offsetWidth;
        this.mag.classList.add('kick');
      }
      this.lastMag = a.mag;
    }
    if (a.reserve !== this.lastReserve) {
      this.reserve.textContent = String(a.reserve);
      this.lastReserve = a.reserve;
    }
    this.mag.classList.toggle('empty', a.mag === 0);

    // dynamite
    if (p.dynamite !== this.lastDyn) {
      this.dynCount.textContent = `×${p.dynamite}`;
      this.dyn.classList.toggle('empty', p.dynamite === 0);
      if (this.lastDyn >= 0) {
        this.dyn.classList.remove('bump');
        void this.dyn.offsetWidth;
        this.dyn.classList.add('bump');
      }
      this.lastDyn = p.dynamite;
    }

    // crosshair
    this.cross.style.transform = `translate(${mouseX}px, ${mouseY}px) translate(-50%, -50%)`;
    const spread = 1 + p.spreadKick * (p.weapon.id === 'shotgun' ? 0.8 : 0.45) + (p.weapon.id === 'shotgun' ? 0.25 : 0);
    this.crossRing.style.transform = `scale(${spread.toFixed(3)})`;
    const hitA = Math.max(0, 1 - p.lastHitT / 0.18);
    this.crossHit.setAttribute('opacity', hitA.toFixed(2));
    this.crossHit.setAttribute('stroke', p.lastKillT < 0.25 ? '#ff7b6b' : '#ffffff');
    const prog = p.reloadProgress;
    this.crossReload.style.strokeDashoffset = String(100.5 * (1 - prog));
    this.crossReload.style.opacity = p.reloading ? '1' : '0';

    // toast
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.classList.remove('show');
    }
  }
}
