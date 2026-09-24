import * as THREE from 'three';
import { compose } from '../core/math';
import { cyl, GeoBuilder, rbox } from '../render/geometry';
import { outlineMaterial, vcToon } from '../render/materials';

export type WeaponId = 'pistol' | 'shotgun';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  mag: number;
  reserveMax: number;
  startReserve: number;
  fireInterval: number;
  reloadTime: number;
  /** shotgun loads shell by shell */
  perShell: boolean;
  pellets: number;
  spread: number;
  damage: number;
  falloffStart: number;
  falloffEnd: number;
  /** impulse per pellet (N·s) */
  force: number;
  range: number;
  shake: number;
  camKick: number;
  recoil: number;
  hitstop: number;
  noise: number;
  muzzle: THREE.Vector3;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Pistola',
    mag: 8,
    reserveMax: 64,
    startReserve: 32,
    fireInterval: 0.15,
    reloadTime: 0.95,
    perShell: false,
    pellets: 1,
    spread: 0.018,
    damage: 1.35,
    falloffStart: 18,
    falloffEnd: 34,
    force: 5.5,
    range: 34,
    shake: 0.22,
    camKick: 0.12,
    recoil: 0.9,
    hitstop: 0.018,
    noise: 22,
    muzzle: new THREE.Vector3(0, 0.035, 0.27),
  },
  shotgun: {
    id: 'shotgun',
    name: 'Espingarda',
    mag: 6,
    reserveMax: 36,
    startReserve: 24,
    fireInterval: 0.7,
    reloadTime: 0.4,
    perShell: true,
    pellets: 11,
    spread: 0.19,
    damage: 0.78,
    falloffStart: 3.5,
    falloffEnd: 15,
    force: 2.6,
    range: 22,
    shake: 0.6,
    camKick: 0.45,
    recoil: 4.2,
    hitstop: 0.045,
    noise: 32,
    muzzle: new THREE.Vector3(0, 0.03, 0.78),
  },
};

const DARK = 0x3d3a44;
const DARK2 = 0x57535f;
const WOOD = 0xa56b43;
const WOOD2 = 0x8a5536;

/** Gun meshes, grip at the origin, barrel along +Z. Built bigger than life so they read at distance. */
export function buildGun(id: WeaponId): THREE.Group {
  const g = new GeoBuilder();
  if (id === 'pistol') {
    g.add(rbox(0.065, 0.075, 0.3, 0.02), DARK, compose(0, 0.045, 0.1));
    g.add(rbox(0.07, 0.03, 0.26, 0.012), DARK2, compose(0, 0.09, 0.1));
    g.add(rbox(0.055, 0.14, 0.075, 0.018), WOOD, compose(0, -0.035, -0.015, 0.25, 0, 0));
    g.add(rbox(0.02, 0.025, 0.02, 0.005), 0xf2d37a, compose(0, 0.11, 0.23));
    g.add(cyl(0.018, 0.018, 0.04, 8), 0x2a272e, compose(0, 0.045, 0.26, Math.PI / 2, 0, 0));
  } else {
    // barrel + magazine tube
    g.add(cyl(0.024, 0.024, 0.72, 10), DARK, compose(0, 0.045, 0.42, Math.PI / 2, 0, 0));
    g.add(cyl(0.019, 0.019, 0.6, 8), DARK2, compose(0, 0.0, 0.37, Math.PI / 2, 0, 0));
    // receiver
    g.add(rbox(0.07, 0.1, 0.24, 0.02), DARK, compose(0, 0.02, 0.0));
    // pump
    g.add(rbox(0.075, 0.07, 0.2, 0.025), WOOD, compose(0, 0.0, 0.42));
    for (let i = 0; i < 4; i++) g.add(rbox(0.078, 0.012, 0.012, 0.004), WOOD2, compose(0, 0.0, 0.35 + i * 0.045));
    // stock
    g.add(rbox(0.065, 0.12, 0.34, 0.035), WOOD, compose(0, -0.04, -0.26, -0.18, 0, 0));
    g.add(rbox(0.055, 0.1, 0.1, 0.02), WOOD2, compose(0, -0.02, -0.07, 0.4, 0, 0));
    g.add(cyl(0.01, 0.01, 0.02, 6), 0xf2d37a, compose(0, 0.075, 0.76));
  }
  const geo = g.build();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, vcToon());
  mesh.castShadow = true;
  group.add(mesh);
  group.add(new THREE.Mesh(geo, outlineMaterial(0x2b2226, 0.012)));
  return group;
}
