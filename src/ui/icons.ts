/** Tiny hand-authored SVG icons (drawn by code, no image files). */

export const heartSvg = (fill: string, stroke = '#5b3a36') => `
<svg viewBox="0 0 32 30" width="30" height="28" aria-hidden="true">
  <path d="M16 28 C 5 20, 1 14, 2.5 8.5 C 3.8 3.5, 10.5 1.5, 16 7.5 C 21.5 1.5, 28.2 3.5, 29.5 8.5 C 31 14, 27 20, 16 28 Z"
        fill="${fill}" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
  <ellipse cx="9.5" cy="9.5" rx="3" ry="2" fill="rgba(255,255,255,0.55)" transform="rotate(-30 9.5 9.5)"/>
</svg>`;

export const pistolSvg = `
<svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
  <path d="M6 10 h40 a4 4 0 0 1 4 4 v6 a3 3 0 0 1 -3 3 H28 l-4 12 a3 3 0 0 1 -3 2 h-7 a2 2 0 0 1 -2 -2.6 L16 23 H8 a3 3 0 0 1 -3 -3 v-7 a3 3 0 0 1 1 -3 z"
        fill="#57535f" stroke="#2b2226" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M15 24 L12 35 h8 l3 -11 z" fill="#a56b43" stroke="#2b2226" stroke-width="2.2" stroke-linejoin="round"/>
  <rect x="8" y="12" width="38" height="3" rx="1.5" fill="rgba(255,255,255,0.25)"/>
</svg>`;

export const shotgunSvg = `
<svg viewBox="0 0 110 40" width="110" height="40" aria-hidden="true">
  <path d="M30 12 h74 a3 3 0 0 1 0 6 H30 z" fill="#57535f" stroke="#2b2226" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M58 18 h30 a3 3 0 0 1 0 6 h-30 z" fill="#a56b43" stroke="#2b2226" stroke-width="2.2"/>
  <path d="M22 10 h14 v14 h-14 z" fill="#3d3a44" stroke="#2b2226" stroke-width="2.2"/>
  <path d="M24 20 L4 30 a3 3 0 0 0 -1 4 l2 2 a3 3 0 0 0 3 1 L30 26 z" fill="#a56b43" stroke="#2b2226" stroke-width="2.4" stroke-linejoin="round"/>
  <rect x="32" y="13" width="70" height="2" rx="1" fill="rgba(255,255,255,0.25)"/>
</svg>`;

export const zombieHeadSvg = `
<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
  <circle cx="16" cy="17" r="12" fill="#9ec3a6" stroke="#2e3b35" stroke-width="2.2"/>
  <circle cx="11.5" cy="15.5" r="3.4" fill="#fff6c9" stroke="#2e3b35" stroke-width="1.2"/>
  <circle cx="20.5" cy="16" r="2.4" fill="#fff6c9" stroke="#2e3b35" stroke-width="1.2"/>
  <circle cx="12" cy="16" r="1.2" fill="#5a1f2a"/><circle cx="20.6" cy="16.4" r="0.9" fill="#5a1f2a"/>
  <ellipse cx="16.5" cy="22.5" rx="4" ry="2.4" fill="#4a1d27"/>
</svg>`;

export const crosshairSvg = `
<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <g class="ch-ring" fill="none" stroke="#fff8ea" stroke-width="3" stroke-linecap="round">
    <path d="M32 10 v8 M32 46 v8 M10 32 h8 M46 32 h8"/>
  </g>
  <g class="ch-ring-shadow" fill="none" stroke="rgba(60,40,40,0.45)" stroke-width="6" stroke-linecap="round" style="mix-blend-mode:multiply">
  </g>
  <circle cx="32" cy="32" r="2.6" fill="#fff8ea" stroke="rgba(60,40,40,0.6)" stroke-width="1.2"/>
  <circle class="ch-reload" cx="32" cy="32" r="16" fill="none" stroke="#ffd98a" stroke-width="3.5"
          stroke-dasharray="100.5" stroke-dashoffset="100.5" transform="rotate(-90 32 32)" stroke-linecap="round"/>
  <g class="ch-hit" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" opacity="0">
    <path d="M20 20 l6 6 M44 20 l-6 6 M20 44 l6 -6 M44 44 l-6 -6"/>
  </g>
</svg>`;
