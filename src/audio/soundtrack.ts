/**
 * The main soundtrack ("Harvest Hush"), streamed from an <audio> element and looped. It stays out
 * of the WebAudio graph on purpose (no decoding a 5-minute track into memory, no cross-origin
 * silence), so its "mixing" is plain element volume and playback rate:
 *   - ducks a little in heavy fights so the guns punch through
 *   - slows down and drops in pitch during the kill-cam
 *   - fades almost out when the player dies or pauses
 */
export class Soundtrack {
  readonly el: HTMLAudioElement;
  failed = false;
  private base = 0.42;
  private vol = 0;
  private target = 0;
  private duck = 0;
  private slowT = 0;
  private down = false;
  private paused = false;
  private started = false;

  constructor(
    url: string,
    private onFail: () => void,
  ) {
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    el.addEventListener('error', () => this.fail());
    this.el = el;
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.onFail();
  }

  get playing(): boolean {
    return this.started && !this.el.paused;
  }

  /** Call from a user gesture. Blocked autoplay just waits for the next gesture. */
  play(): void {
    if (this.failed || this.playing) return;
    this.started = true;
    const p = this.el.play();
    if (p)
      p.catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'NotAllowedError') this.started = false;
        else this.fail();
      });
  }

  set muted(m: boolean) {
    this.el.muted = m;
  }

  /** 0 calm … 1 full fight. */
  setIntensity(v: number): void {
    this.duck = Math.max(0, Math.min(1, v));
  }

  /** Kill-cam: slow, lower tape for a moment. */
  slowMo(seconds: number): void {
    this.slowT = seconds;
  }

  /** Player died (true) / new run (false). */
  setDown(on: boolean): void {
    this.down = on;
  }

  setPaused(on: boolean): void {
    this.paused = on;
  }

  update(dt: number): void {
    if (!this.started || this.failed) return;
    this.target = this.down ? 0.1 : this.paused ? 0.14 : this.base * (1 - 0.3 * this.duck);
    this.vol += (this.target - this.vol) * Math.min(1, dt * (this.vol < this.target ? 0.8 : 2.5));
    const v = Math.max(0, Math.min(1, this.vol));
    if (Math.abs(this.el.volume - v) > 0.002) this.el.volume = v;
    let rate = 1;
    if (this.slowT > 0) {
      this.slowT -= dt;
      rate = this.slowT > 0.4 ? 0.72 : 1 - 0.28 * (this.slowT / 0.4);
    }
    const el = this.el as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    if (Math.abs(el.playbackRate - rate) > 0.005) {
      el.preservesPitch = false;
      el.webkitPreservesPitch = false;
      el.playbackRate = Math.max(0.5, rate);
    }
  }
}
