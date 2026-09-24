/** Standard-mapping button indices. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

/** The bits of the Gamepad API we use (so tests can hand in a fake controller). */
export interface PadLike {
  connected: boolean;
  mapping?: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
  vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
  hapticActuators?: readonly { pulse?: (value: number, duration: number) => Promise<unknown> }[];
}

const DEAD = 0.18;

function stick(x = 0, y = 0): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const k = (Math.min(1, m) - DEAD) / (1 - DEAD) / m;
  return [x * k, y * k];
}

function firstPad(): PadLike | null {
  const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  let any: PadLike | null = null;
  for (const g of list) {
    if (!g || !g.connected) continue;
    if (g.mapping === 'standard') return g as unknown as PadLike;
    any ??= g as unknown as PadLike;
  }
  return any;
}

/**
 * Game controller: polled once per frame, with button edges, radial dead zones and rumble.
 * `active` tells whether the pad (rather than mouse/keyboard) was the last thing touched, so the
 * game knows which aim to trust.
 */
export class Pad {
  connected = false;
  active = false;
  lx = 0;
  ly = 0;
  rx = 0;
  ry = 0;
  vibration = true;
  /** Tests inject a fake controller here. */
  provider: (() => PadLike | null) | null = null;
  onConnect: (() => void) | null = null;
  private now: boolean[] = [];
  private prev: boolean[] = [];
  private current: PadLike | null = null;
  private rumbleUntil = 0;
  private rumbleMag = 0;

  poll(): void {
    const gp = this.provider ? this.provider() : firstPad();
    this.current = gp;
    const was = this.connected;
    this.connected = !!gp && gp.connected;
    if (this.connected && !was) this.onConnect?.();
    this.prev = this.now;
    this.now = [];
    if (!gp || !this.connected) {
      this.lx = this.ly = this.rx = this.ry = 0;
      this.active = false;
      return;
    }
    [this.lx, this.ly] = stick(gp.axes[0], gp.axes[1]);
    [this.rx, this.ry] = stick(gp.axes[2], gp.axes[3]);
    let any = Math.hypot(this.lx, this.ly) > 0.3 || Math.hypot(this.rx, this.ry) > 0.3;
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      const on = b.pressed || (b.value ?? 0) > 0.35;
      this.now[i] = on;
      if (on) any = true;
    }
    if (any) this.active = true;
  }

  down(i: number): boolean {
    return !!this.now[i];
  }

  pressed(i: number): boolean {
    return !!this.now[i] && !this.prev[i];
  }

  released(i: number): boolean {
    return !this.now[i] && !!this.prev[i];
  }

  /** Two-motor rumble. A weaker request never cuts a stronger one that's still playing. */
  rumble(strong: number, weak: number, ms: number): void {
    const gp = this.current;
    if (!this.vibration || !this.connected || !gp) return;
    const t = performance.now();
    const mag = Math.max(strong, weak);
    if (t < this.rumbleUntil && mag <= this.rumbleMag) return;
    this.rumbleUntil = t + ms;
    this.rumbleMag = mag;
    const s = Math.min(1, Math.max(0, strong));
    const w = Math.min(1, Math.max(0, weak));
    const act = gp.vibrationActuator;
    if (act?.playEffect) {
      act.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(ms), strongMagnitude: s, weakMagnitude: w }).catch(() => undefined);
    } else {
      gp.hapticActuators?.[0]?.pulse?.(Math.max(s, w), ms)?.catch(() => undefined);
    }
  }
}
