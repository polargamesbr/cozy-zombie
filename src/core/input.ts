/** Keyboard + mouse state with per-frame edge detection. Keys use `KeyboardEvent.code`. */
export class Input {
  readonly mouse = { x: 0, y: 0, nx: 0, ny: 0, inside: false };
  private keys = new Set<string>();
  private pressedKeys = new Set<string>();
  private releasedKeys = new Set<string>();
  private buttons = new Set<number>();
  private pressedButtons = new Set<number>();
  wheel = 0;
  /** Accumulated mouse movement while the orbit button (right/middle) is held. */
  orbitDX = 0;
  enabled = true;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.pressedKeys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.releasedKeys.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => {
      this.setMouse(e.clientX, e.clientY);
      if (this.buttons.has(2) || this.buttons.has(1)) this.orbitDX += e.movementX;
    });
    el.addEventListener('pointerdown', (e) => {
      this.setMouse(e.clientX, e.clientY);
      this.buttons.add(e.button);
      this.pressedButtons.add(e.button);
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('pointerup', (e) => {
      this.buttons.delete(e.button);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: false },
    );
    el.addEventListener('pointerenter', () => (this.mouse.inside = true));
    el.addEventListener('pointerleave', () => (this.mouse.inside = false));
    this.setMouse(window.innerWidth * 0.62, window.innerHeight * 0.45);
  }

  private setMouse(x: number, y: number): void {
    this.mouse.x = x;
    this.mouse.y = y;
    const r = this.el.getBoundingClientRect();
    this.mouse.nx = ((x - r.left) / Math.max(1, r.width)) * 2 - 1;
    this.mouse.ny = -((y - r.top) / Math.max(1, r.height)) * 2 + 1;
  }

  /** Programmatic cursor placement (used by the test API). */
  setMouseNdc(nx: number, ny: number): void {
    const r = this.el.getBoundingClientRect();
    this.setMouse(r.left + ((nx + 1) / 2) * r.width, r.top + ((1 - ny) / 2) * r.height);
  }

  down(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  pressed(code: string): boolean {
    return this.enabled && this.pressedKeys.has(code);
  }

  released(code: string): boolean {
    return this.releasedKeys.has(code);
  }

  button(b: number): boolean {
    return this.enabled && this.buttons.has(b);
  }

  buttonPressed(b: number): boolean {
    return this.enabled && this.pressedButtons.has(b);
  }

  /** Simulate input from automation. */
  press(code: string, hold = false): void {
    this.pressedKeys.add(code);
    if (hold) this.keys.add(code);
  }

  release(code: string): void {
    if (this.keys.delete(code)) this.releasedKeys.add(code);
  }

  clickButton(b: number, hold = false): void {
    this.pressedButtons.add(b);
    if (hold) this.buttons.add(b);
  }

  releaseButton(b: number): void {
    this.buttons.delete(b);
  }

  endFrame(): void {
    this.pressedKeys.clear();
    this.releasedKeys.clear();
    this.pressedButtons.clear();
    this.wheel = 0;
    this.orbitDX = 0;
  }
}
