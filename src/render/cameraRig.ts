import * as THREE from 'three';
import { clamp, damp, lerp, Spring } from '../core/math';
import { noise } from '../core/noise';

/**
 * 2.5D orbit-follow camera. Tilted perspective with a narrow FOV so it reads almost like an
 * isometric diorama, but it can rotate freely around the player (Q/E or right-drag).
 * Also owns screen shake ("trauma"), directional kicks and FOV punches.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  yaw = -0.42;
  private yawVel = 0;
  pitch = 0.94;
  distance = 18;
  zoomTarget = 18;
  readonly minZoom = 12;
  readonly maxZoom = 32;
  /** 0..1 – shake amount, decays over time. Shake strength is trauma². */
  trauma = 0;
  private kickX = new Spring(0, 260, 18);
  private kickY = new Spring(0, 260, 18);
  private kickZ = new Spring(0, 260, 18);
  private fovPunch = new Spring(0, 180, 14);
  private baseFov = 33;
  private time = 0;
  /** Extra slow orbit (title screen). */
  idleOrbit = 0;
  /** Cinematic pull (kill-cam): 0..1 blend toward `focusPoint` at `focusZoom`. */
  focus = 0;
  readonly focusPoint = new THREE.Vector3();
  focusZoom = 10;

  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.5, 420);
  }

  /** Screen-right and screen-forward directions projected on the ground. */
  get right(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  addTrauma(t: number): void {
    this.trauma = clamp(this.trauma + t, 0, 1);
  }

  /** Nudge the camera along a world direction (e.g. opposite of the shot). */
  kick(dir: THREE.Vector3, amount: number): void {
    this.kickX.kick(dir.x * amount * 12);
    this.kickY.kick(dir.y * amount * 12);
    this.kickZ.kick(dir.z * amount * 12);
  }

  punchFov(amount: number): void {
    this.fovPunch.kick(amount * 40);
  }

  rotate(delta: number): void {
    this.yaw += delta;
  }

  snapTo(pos: THREE.Vector3): void {
    this.target.copy(pos);
  }

  /**
   * @param follow point to follow (player)
   * @param look optional look-ahead point (aim), pulls the frame toward it
   * @param rotateInput -1..1 keyboard rotation
   * @param dragDX horizontal mouse drag in pixels this frame
   * @param zoomSteps mouse wheel steps this frame
   * @param realDt unscaled delta (camera keeps shaking during hit-stop)
   */
  update(
    follow: THREE.Vector3,
    look: THREE.Vector3 | null,
    rotateInput: number,
    dragDX: number,
    zoomSteps: number,
    realDt: number,
  ): void {
    const dt = Math.min(realDt, 0.05);
    this.time += dt;

    // rotation: keyboard has inertia, drag is direct
    this.yawVel = damp(this.yawVel, rotateInput * 1.9, rotateInput !== 0 ? 5 : 7, dt);
    this.yaw += this.yawVel * dt + this.idleOrbit * dt - dragDX * 0.0055;

    if (zoomSteps !== 0) this.zoomTarget = clamp(this.zoomTarget + zoomSteps * 2.2, this.minZoom, this.maxZoom);
    this.distance = damp(this.distance, this.zoomTarget, 8, dt);
    const dist = lerp(this.distance, Math.min(this.distance, this.focusZoom), this.focus);
    // closer → slightly lower, more cinematic angle
    const zt = (dist - this.minZoom) / (this.maxZoom - this.minZoom);
    this.pitch = lerp(0.8, 1.02, clamp(zt, -0.4, 1));

    // follow with look-ahead
    const desired = new THREE.Vector3().copy(follow);
    if (look) {
      const la = new THREE.Vector3().subVectors(look, follow);
      la.y = 0;
      const l = la.length();
      if (l > 0.001) la.multiplyScalar(Math.min(l * 0.28, 3.2) / l);
      desired.add(la);
    }
    if (this.focus > 0) desired.lerp(this.focusPoint, this.focus);
    this.target.x = damp(this.target.x, desired.x, 6.5, dt);
    this.target.y = damp(this.target.y, desired.y, 6.5, dt);
    this.target.z = damp(this.target.z, desired.z, 6.5, dt);

    // springs
    this.kickX.update(dt);
    this.kickY.update(dt);
    this.kickZ.update(dt);
    this.fovPunch.update(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    const s = this.trauma * this.trauma;
    const t = this.time * 22;
    const shakeX = noise.noise2(t, 1.3) * s * 0.55;
    const shakeY = noise.noise2(t, 7.9) * s * 0.4;
    const shakeZ = noise.noise2(t, 13.1) * s * 0.55;
    const roll = noise.noise2(t, 21.7) * s * 0.035;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const off = new THREE.Vector3(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp).multiplyScalar(dist);
    const kick = new THREE.Vector3(this.kickX.value, this.kickY.value, this.kickZ.value);
    const lookAt = new THREE.Vector3().copy(this.target).add(kick);
    lookAt.y += 0.6;
    this.camera.position.copy(lookAt).add(off);
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;
    this.camera.position.z += shakeZ;
    this.camera.lookAt(lookAt.x + shakeX * 0.5, lookAt.y + shakeY * 0.5, lookAt.z + shakeZ * 0.5);
    this.camera.rotateZ(roll);
    const fov = this.baseFov + this.fovPunch.value;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  /** Intersect the view ray through NDC (nx, ny) with a horizontal plane at `y`. */
  screenToPlane(nx: number, ny: number, y: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, out);
  }

  ray(nx: number, ny: number): THREE.Ray {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.raycaster.ray.clone();
  }

  /** Project a world point to NDC. */
  project(p: THREE.Vector3): THREE.Vector3 {
    return p.clone().project(this.camera);
  }
}
