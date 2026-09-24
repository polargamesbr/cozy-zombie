import * as THREE from 'three';
import { PAL } from './palette';

/**
 * Late-afternoon light rig: warm low sun from the south-west (so the faces the camera sees
 * by default are lit and shadows fall "up" the screen), lavender sky fill, warm haze.
 */
export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3(-0.5, 0.66, 0.56).normalize();
  /** Shared by the fog and the background (the day cycle tints it). */
  readonly fogColor = new THREE.Color(PAL.fog);
  private shadowExtent = 26;

  constructor(scene: THREE.Scene) {
    scene.background = this.fogColor;
    const fog = new THREE.Fog(PAL.fog, 42, 110);
    fog.color = this.fogColor;
    scene.fog = fog;

    this.hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.55);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(PAL.sun, 3.1);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.near = 1;
    s.camera.far = 120;
    s.camera.left = -this.shadowExtent;
    s.camera.right = this.shadowExtent;
    s.camera.top = this.shadowExtent;
    s.camera.bottom = -this.shadowExtent;
    s.bias = -0.0004;
    s.normalBias = 0.035;
    s.radius = 3.2;
    s.intensity = 1;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // cool, weak bounce from the opposite side so shadowed faces keep some shape
    this.fill = new THREE.DirectionalLight(0xa9b8ff, 0.45);
    this.fill.position.set(0.6, 0.5, -0.7).multiplyScalar(30);
    scene.add(this.fill);
  }

  /** Shadow map resolution (quality settings). */
  setShadowSize(size: number): void {
    const s = this.sun.shadow;
    if (s.mapSize.x === size) return;
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }

  /** Keep the shadow frustum centered on the view, snapped to texels to avoid shimmering. */
  update(center: THREE.Vector3): void {
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    // snap in light space
    const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), this.sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const c = center.clone().applyMatrix4(inv);
    c.x = Math.round(c.x / texel) * texel;
    c.y = Math.round(c.y / texel) * texel;
    c.applyMatrix4(lightRot);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, 60);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}
