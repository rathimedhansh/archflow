import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PLANT_SPECS, type PlantKind } from "../../../lib/viewer/environment";
import { rng, valueNoise3 } from "../../../lib/viewer/random";

/**
 * Procedural plants: generated at runtime from a seed (no model files, no network). Each variant
 * is one geometry with position, normal and colour attributes, drawn instanced. Every foliage
 * vertex stays inside the variant's PLANT_SPECS envelope (unit tested), which is what the site
 * layout uses to keep plants out of the camera's view of the house.
 */

/** Organic surface wobble: the radius of a lump varies by up to this fraction either way. */
const WOBBLE = 0.14;

type Rgb = [number, number, number];
const hsl = (h: number, s: number, l: number): Rgb => {
  const c = new THREE.Color().setHSL(h / 360, s, l, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

function setColors(g: THREE.BufferGeometry, color: (p: THREE.Vector3, n: THREE.Vector3, i: number) => Rgb) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const out = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    out.set(color(p, n, i), i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(out, 3));
}

/** Only the attributes the plant material reads, so variants merge cleanly. */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  return g;
}

/**
 * A soft foliage lump: a subdivided sphere, smoothed, wobbled by 3D noise. Normals are bent
 * toward `canopyCenter` -> vertex, so the lumps shade as one rounded crown rather than as balls.
 */
function lump(center: THREE.Vector3, radius: number, detail: number, seed: number, canopyCenter: THREE.Vector3, bend: number) {
  const g = mergeVertices(strip(new THREE.IcosahedronGeometry(radius, detail)));
  const pos = g.getAttribute("position");
  const v = new THREE.Vector3();
  const freq = 1.6 / radius;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Broad bulges plus finer leafy bumps; together never more than WOBBLE.
    const broad = 2 * valueNoise3(v.x * freq + seed, v.y * freq, v.z * freq, seed) - 1;
    const fine = 2 * valueNoise3(v.x * freq * 3.1, v.y * freq * 3.1, v.z * freq * 3.1, seed + 1) - 1;
    const k = 1 + WOBBLE * (0.62 * broad + 0.38 * fine);
    v.multiplyScalar(k).add(center);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const nor = g.getAttribute("normal");
  const n = new THREE.Vector3(), radial = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    radial.subVectors(v, canopyCenter).normalize();
    n.lerp(radial, bend).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}

/** Leaf colour: darker underneath and inside the crown, light speckle on top; muted greens. */
function foliageColor(base: { h: number; s: number; l: number }, center: THREE.Vector3, radius: number, seed: number, blossom?: Rgb) {
  return (p: THREE.Vector3, n: THREE.Vector3, i: number): Rgb => {
    const r = rng(seed * 7919 + i)();
    if (blossom && r < 0.11 && n.y > -0.2) return blossom;
    const up = THREE.MathUtils.clamp((p.y - center.y) / radius, -1, 1);
    const depth = THREE.MathUtils.clamp(p.distanceTo(center) / radius, 0.3, 1);
    const shade = 0.55 + 0.3 * (up + 1) / 2 + 0.2 * (depth - 0.3);
    const tint = valueNoise3(p.x * 1.3, p.y * 1.3, p.z * 1.3, seed) - 0.5;
    return hsl(base.h + tint * 14 + (r - 0.5) * 6, base.s + tint * 0.08, base.l * shade * (0.9 + r * 0.2));
  };
}

function trunk(height: number, radius: number, seed: number) {
  const g = strip(new THREE.CylinderGeometry(radius * 0.55, radius, height, 7, 3));
  g.translate(0, height / 2, 0);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // A gentle lean, so trunks are not ruler-straight.
    pos.setX(i, pos.getX(i) + 0.06 * Math.sin(y * 1.3 + seed));
  }
  g.computeVertexNormals();
  setColors(g, (p, _n, i) => hsl(28, 0.16, 0.25 + 0.06 * rng(seed + i)()));
  return g;
}

/** Deciduous tree: a trunk and a crown of overlapping lumps, all inside the envelope sphere. */
function buildTree(variant: number, detail: number) {
  const spec = PLANT_SPECS.tree[variant];
  const env = spec.envelope[0];
  const seed = 11 + variant * 17;
  const r = rng(seed);
  const c = new THREE.Vector3(0, env.y, 0);
  const parts: THREE.BufferGeometry[] = [trunk(env.y + env.r * 0.1, spec.trunkRadius, seed)];
  const greens = [{ h: 92, s: 0.32, l: 0.34 }, { h: 84, s: 0.3, l: 0.36 }, { h: 100, s: 0.26, l: 0.3 }];
  const leaf = greens[variant % greens.length];
  const lumps: [THREE.Vector3, number][] = [[new THREE.Vector3(0, env.r * 0.08, 0), env.r * 0.58]];
  // Two rings of smaller lumps, the upper one tucked in: an irregular, layered crown.
  const n = 11;
  for (let k = 0; k < n; k++) {
    const upper = k >= 7;
    const a = (k / (upper ? 4 : 7)) * Math.PI * 2 + r() * 0.6 + (upper ? 0.4 : 0);
    const up = upper ? 0.7 + r() * 0.4 : -0.25 + r() * 0.5;
    const lr = env.r * (upper ? 0.3 + r() * 0.06 : 0.32 + r() * 0.1);
    // Lump centre so that, wobble included, it stays inside the envelope.
    const reach = env.r - lr * (1 + WOBBLE) - 0.02;
    const dir = new THREE.Vector3(Math.cos(a), up, Math.sin(a)).normalize();
    lumps.push([dir.multiplyScalar(reach * (0.85 + r() * 0.15)), lr]);
  }
  lumps.forEach(([offset, lr], k) => {
    const center = offset.clone().add(c);
    // Clamp the central lump too (it sits slightly above the middle).
    const max = env.r - lr * (1 + WOBBLE) - 0.02;
    if (offset.length() > max) center.copy(offset.setLength(max)).add(c);
    const g = lump(center, lr, detail, seed + k, c, 0.55);
    setColors(g, foliageColor(leaf, c, env.r, seed + k));
    parts.push(g);
  });
  return parts;
}

/** Conifer: stacked, slightly ragged cones on a short trunk. */
function buildConifer(variant: number) {
  const spec = PLANT_SPECS.conifer[variant];
  const seed = 71 + variant * 13;
  const parts: THREE.BufferGeometry[] = [trunk(1.6, spec.trunkRadius, seed)];
  // Seven overlapping skirts of foliage, each with a ragged, slightly drooping hem.
  const tiers = [
    { y: 0.75, h: 2.0, r: 1.7 },
    { y: 1.75, h: 2.0, r: 1.5 },
    { y: 2.75, h: 1.9, r: 1.28 },
    { y: 3.7, h: 1.8, r: 1.05 },
    { y: 4.6, h: 1.75, r: 0.82 },
    { y: 5.5, h: 1.7, r: 0.6 },
    { y: 6.4, h: 2.15, r: 0.38 },
  ];
  const axis = new THREE.Vector3(0, spec.height / 2, 0);
  tiers.forEach((t, k) => {
    const g = mergeVertices(strip(new THREE.ConeGeometry(t.r, t.h, 16, 3, false)));
    g.translate(0, t.y + t.h / 2, 0);
    const pos = g.getAttribute("position");
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const a = Math.atan2(v.z, v.x);
      const ragged = 2 * valueNoise3(Math.cos(a) * 2.6 + k, Math.sin(a) * 2.6, v.y * 1.8, seed + k) - 1;
      const k2 = 1 + 0.14 * ragged;
      // The hem (lowest ring) droops a little where it reaches out furthest.
      const hem = v.y < t.y + 0.01 ? -0.12 * Math.max(0, ragged) : 0;
      pos.setXYZ(i, v.x * k2, v.y + hem, v.z * k2);
    }
    g.computeVertexNormals();
    const nor = g.getAttribute("normal");
    const n = new THREE.Vector3(), radial = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nor, i);
      radial.subVectors(v, axis).setY(0.3).normalize();
      n.lerp(radial, 0.35).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    setColors(g, foliageColor({ h: 135, s: 0.2, l: 0.29 }, new THREE.Vector3(0, t.y + t.h * 0.6, 0), t.r + 0.4, seed + k));
    parts.push(g);
  });
  return parts;
}

/** Bushes: a few low lumps; variant 2 carries sparse muted blossoms. */
function buildBush(variant: number) {
  const spec = PLANT_SPECS.bush[variant];
  const env = spec.envelope[0];
  const seed = 131 + variant * 29;
  const r = rng(seed);
  const c = new THREE.Vector3(0, env.y, 0);
  const leaf = [{ h: 96, s: 0.3, l: 0.33 }, { h: 110, s: 0.24, l: 0.3 }, { h: 88, s: 0.26, l: 0.36 }][variant];
  const blossom = variant === 2 ? hsl(330, 0.22, 0.78) : undefined;
  const parts: THREE.BufferGeometry[] = [];
  const n = 4;
  for (let k = 0; k < n; k++) {
    const lr = env.r * (k === 0 ? 0.62 : 0.48);
    const reach = env.r - lr * (1 + WOBBLE) - 0.01;
    const a = (k / (n - 1)) * Math.PI * 2 + r();
    const offset = k === 0 ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(Math.cos(a), -0.25 + r() * 0.3, Math.sin(a)).setLength(reach);
    const g = lump(offset.add(c), lr, 2, seed + k, c, 0.5);
    setColors(g, foliageColor(leaf, c, env.r, seed + k, blossom));
    parts.push(g);
  }
  return parts;
}

/** All plant variants, keyed `${kind}:${variant}`. The caller owns (and disposes) the geometries. */
export function buildPlantGeometries(): Map<string, THREE.BufferGeometry> {
  const out = new Map<string, THREE.BufferGeometry>();
  const merged = (parts: THREE.BufferGeometry[]) => {
    // Every part is indexed (mergeVertices / cylinder); mixed parts could not be merged.
    const g = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    if (!g) throw new Error("plant geometry merge failed");
    g.computeBoundingSphere();
    return g;
  };
  (Object.keys(PLANT_SPECS) as PlantKind[]).forEach((kind) => {
    PLANT_SPECS[kind].forEach((_, variant) => {
      const parts = kind === "tree" ? buildTree(variant, 2) : kind === "conifer" ? buildConifer(variant) : buildBush(variant);
      out.set(`${kind}:${variant}`, merged(parts));
    });
  });
  return out;
}
