import type { Scene3D, V3 } from "@/lib/geometry3d";
import { rng } from "./random";

/**
 * Illustrative outdoor surroundings for the desktop viewer: a pure site layout (no Three.js).
 *
 * Everything here is invented for presentation. It is never derived from, and must never be
 * presented as, the property's real location or a surveyed site. The layout depends only on the
 * model's footprint, the chosen style and (optionally) where an exterior door is, and is seeded,
 * so the same plan always gets the same surroundings.
 */

export type SiteStyle = "minimal" | "suburban" | "urban";
export type EnvironmentSetting = SiteStyle | "off";

export const ENVIRONMENT_OPTIONS: readonly { value: EnvironmentSetting; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "suburban", label: "Suburban" },
  { value: "urban", label: "Urban" },
];
export const DEFAULT_ENVIRONMENT: EnvironmentSetting = "suburban";

/** Axis-aligned rectangle on the ground, world metres (x right, z toward the viewer). */
export interface Rect { x0: number; z0: number; x1: number; z1: number }

export type SlabKind = "road" | "marking" | "sidewalk" | "curb" | "driveway" | "path" | "bed" | "plaza" | "grate" | "planter";
/** A flat or raised surface: a box from the ground up to `top` (metres above the ground). */
export interface Slab { kind: SlabKind; rect: Rect; top: number }

export type PlantKind = "tree" | "conifer" | "bush";
/** Sphere (relative to the plant's base, before scaling) that encloses part of its foliage. */
export interface Envelope { y: number; r: number }
export interface PlantSpec { height: number; trunkRadius: number; envelope: Envelope[] }

/**
 * Plant shapes, shared by the layout (sight-line checks) and the geometry builders, which must
 * keep every foliage vertex inside `envelope` (unit tested) so the checks are exact enough.
 */
export const PLANT_SPECS: Record<PlantKind, PlantSpec[]> = {
  tree: [
    { height: 7.6, trunkRadius: 0.17, envelope: [{ y: 4.9, r: 2.7 }] },
    { height: 9.0, trunkRadius: 0.2, envelope: [{ y: 5.9, r: 3.1 }] },
    { height: 5.8, trunkRadius: 0.13, envelope: [{ y: 3.8, r: 2.0 }] },
  ],
  conifer: [
    { height: 8.6, trunkRadius: 0.16, envelope: [{ y: 1.9, r: 2.45 }, { y: 4.0, r: 1.9 }, { y: 6.0, r: 1.3 }, { y: 7.8, r: 0.85 }] },
  ],
  bush: [
    { height: 1.3, trunkRadius: 0, envelope: [{ y: 0.65, r: 0.65 }] },
    { height: 0.96, trunkRadius: 0, envelope: [{ y: 0.48, r: 0.48 }] },
    // Flowering shrub: low, with a few muted blooms.
    { height: 0.84, trunkRadius: 0, envelope: [{ y: 0.42, r: 0.42 }] },
  ],
};

export interface Plant {
  kind: PlantKind;
  variant: number;
  x: number;
  z: number;
  /** Uniform scale of the spec (height and spread). */
  scale: number;
  /** Rotation about the vertical axis, radians. */
  rotation: number;
  /** Height of what it stands on above the ground (a bed, grate or planter), metres. */
  base: number;
}

/** The facade the street runs along, as an outward direction in world space. */
export type Facing = "+z" | "-z" | "+x" | "-x";

export interface SitePlan {
  style: SiteStyle;
  /** Middle of the house footprint (x, z). */
  center: [number, number];
  /** Half-size of the generated ground square around `center`. */
  extent: number;
  /** Distance from `center` where the ground starts and finishes fading into the backdrop. */
  fade: [number, number];
  front: Facing;
  slabs: Slab[];
  plants: Plant[];
}

/** A camera pose that must keep a clear view of the house (default view, reveal, orbit). */
export interface ProtectedView { position: V3; targets: V3[] }

export interface SiteInput {
  style: SiteStyle;
  /** The house footprint including its plinth, world metres. Nothing is placed on it. */
  footprint: Rect;
  /** World height of the ground the house plinth stands on. */
  groundY: number;
  /** Exterior door positions (x, z), if any: the entrance path leads to one. */
  doors?: [number, number][];
  /** Views no tree or bush may block (see sightLines.ts). */
  views?: ProtectedView[];
}

// ---------------------------------------------------------------------------------------------
// Local frame: u runs along the street-facing facade, v points out of it toward the street.

interface Frame {
  facing: Facing;
  cx: number;
  cz: number;
  /** Half the footprint along u and v. */
  hu: number;
  hv: number;
}

function toWorld(f: Frame, u: number, v: number): [number, number] {
  switch (f.facing) {
    case "+z": return [f.cx + u, f.cz + v];
    case "-z": return [f.cx - u, f.cz - v];
    case "+x": return [f.cx + v, f.cz - u];
    case "-x": return [f.cx - v, f.cz + u];
  }
}

function toLocal(f: Frame, x: number, z: number): [number, number] {
  const dx = x - f.cx, dz = z - f.cz;
  switch (f.facing) {
    case "+z": return [dx, dz];
    case "-z": return [-dx, -dz];
    case "+x": return [-dz, dx];
    case "-x": return [dz, -dx];
  }
}

function rectWorld(f: Frame, u0: number, v0: number, u1: number, v1: number): Rect {
  const [ax, az] = toWorld(f, u0, v0);
  const [bx, bz] = toWorld(f, u1, v1);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}

/** Exterior door centres: door leaves (not glass) lying on the footprint's outline. */
export function doorCenters(scene: Scene3D): [number, number][] {
  const out: [number, number][] = [];
  for (const o of scene.objects) {
    if (o.kind !== "door" || o.material === "glass") continue;
    const p = o.mesh.positions;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
    }
    if (Number.isFinite(minX)) out.push([(minX + maxX) / 2, (minZ + maxZ) / 2]);
  }
  return out;
}

/** Doors closer than this to a footprint edge count as being on that facade, metres. */
const DOOR_EDGE = 0.9;

/**
 * Which facade faces the street, and where along it the entrance is. A facade with an exterior
 * door wins (preferring the ones the default camera looks at); otherwise the front is +z.
 */
export function chooseFront(footprint: Rect, doors: [number, number][]): { facing: Facing; doorU: number | null } {
  for (const facing of ["+z", "+x", "-x", "-z"] as Facing[]) {
    const f = frameFor(footprint, facing);
    const onFacade = doors
      .map(([x, z]) => toLocal(f, x, z))
      .filter(([u, v]) => Math.abs(v - f.hv) < DOOR_EDGE && Math.abs(u) < f.hu);
    if (onFacade.length) {
      onFacade.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
      return { facing, doorU: onFacade[0][0] };
    }
  }
  return { facing: "+z", doorU: null };
}

function frameFor(footprint: Rect, facing: Facing): Frame {
  const cx = (footprint.x0 + footprint.x1) / 2, cz = (footprint.z0 + footprint.z1) / 2;
  const hx = (footprint.x1 - footprint.x0) / 2, hz = (footprint.z1 - footprint.z0) / 2;
  const alongX = facing === "+z" || facing === "-z";
  return { facing, cx, cz, hu: alongX ? hx : hz, hv: alongX ? hz : hx };
}

// ---------------------------------------------------------------------------------------------
// Sight lines

/** World-space spheres that bound a placed plant (foliage, plus its trunk as a column of spheres). */
export function plantSpheres(p: Plant, groundY: number): { c: V3; r: number }[] {
  const spec = PLANT_SPECS[p.kind][p.variant];
  const y0 = groundY + p.base;
  const out = spec.envelope.map((e) => ({ c: [p.x, y0 + e.y * p.scale, p.z] as V3, r: e.r * p.scale }));
  if (spec.trunkRadius > 0) {
    const top = Math.min(...spec.envelope.map((e) => e.y - e.r)) * p.scale;
    for (let y = 0.4; y < top; y += 0.6) out.push({ c: [p.x, y0 + y, p.z], r: spec.trunkRadius * p.scale + 0.15 });
  }
  return out;
}

function segmentHitsSphere(a: V3, b: V3, c: V3, r: number): boolean {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
  const t = Math.min(1, Math.max(0, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1] + (c[2] - a[2]) * d[2]) / len2));
  const q: V3 = [a[0] + d[0] * t - c[0], a[1] + d[1] * t - c[1], a[2] + d[2] * t - c[2]];
  return q[0] ** 2 + q[1] ** 2 + q[2] ** 2 < r * r;
}

/** Extra clearance around foliage for sight-line checks, metres. */
const SIGHT_MARGIN = 0.3;

/** True if the plant would hide any protected target from any protected camera position. */
export function blocksView(p: Plant, groundY: number, views: readonly ProtectedView[]): boolean {
  const spheres = plantSpheres(p, groundY);
  for (const v of views) {
    for (const t of v.targets) {
      for (const s of spheres) if (segmentHitsSphere(v.position, t, s.c, s.r + SIGHT_MARGIN)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Layout

const insideRect = (r: Rect, x: number, z: number, pad = 0) => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;

/** Upper bounds on what a site may contain (performance budget; unit tested). */
export const SITE_BUDGET = { trees: 40, bushes: 90, slabs: 160 };

/** Build the site. Pure and deterministic. */
export function planSite(input: SiteInput): SitePlan {
  const { style, footprint, groundY, views = [] } = input;
  const { facing, doorU } = chooseFront(footprint, input.doors ?? []);
  const f = frameFor(footprint, facing);
  const R = Math.hypot(f.hu, f.hv);
  const extent = Math.max(45, R * 3 + 20);
  const random = rng(style === "minimal" ? 101 : style === "suburban" ? 202 : 303);

  const slabs: Slab[] = [];
  const add = (kind: SlabKind, u0: number, v0: number, u1: number, v1: number, top: number) =>
    slabs.push({ kind, rect: rectWorld(f, u0, v0, u1, v1), top });
  const { hu, hv } = f;
  // Entrance along the front facade (clamped so the path meets the wall, not a corner).
  const entrance = doorU === null ? 0 : Math.max(-hu + 1, Math.min(hu - 1, doorU));

  // Wanted planting spots, in priority order; filtered below.
  const wanted: Plant[] = [];
  const want = (kind: PlantKind, u: number, v: number, variant?: number, scale?: number) => {
    const [x, z] = toWorld(f, u, v);
    const variants = PLANT_SPECS[kind].length;
    wanted.push({
      kind,
      variant: variant ?? Math.floor(random() * variants),
      x, z,
      scale: scale ?? 0.88 + random() * 0.24,
      rotation: random() * Math.PI * 2,
      base: 0,
    });
  };
  const jitter = (a: number) => (random() - 0.5) * 2 * a;

  /** A row of street markings: dashes of `dash` metres every `period` along u at offset v. */
  const dashes = (v: number, width: number, dash: number, period: number) => {
    for (let u = -extent; u < extent; u += period) add("marking", u, v - width / 2, Math.min(u + dash, extent), v + width / 2, 0.026);
  };

  if (style === "suburban") {
    // House side -> street: front lawn, sidewalk, grass verge with street trees, curb, road, and the same mirrored.
    const sw0 = hv + 4, sw1 = sw0 + 1.5, curb0 = sw1 + 1.3, road0 = curb0 + 0.15, road1 = road0 + 7, far0 = road1 + 0.15;
    const driveSide = entrance > hu * 0.3 ? -1 : 1;
    const drive = driveSide > 0 ? [hu + 0.8, hu + 4.1] : [-hu - 4.1, -hu - 0.8];
    add("road", -extent, road0, extent, road1, 0.02);
    dashes((road0 + road1) / 2, 0.12, 3, 8);
    for (const [a, b] of [[-extent, drive[0] - 0.6], [drive[1] + 0.6, extent]]) add("curb", a, curb0, b, road0, 0.15);
    add("curb", -extent, road1, extent, far0, 0.15);
    add("sidewalk", -extent, sw0, extent, sw1, 0.1);
    add("sidewalk", -extent, far0 + 1.3, extent, far0 + 2.8, 0.1);
    add("driveway", drive[0], hv - 3, drive[1], curb0, 0.06);
    add("driveway", drive[0] - 0.6, sw1, drive[1] + 0.6, road0, 0.03); // apron with dropped curb
    add("path", entrance - 0.6, hv, entrance + 0.6, sw0, 0.05);
    // Planting beds along the facade, either side of the path, with a rhythm of shrubs.
    for (const [a, b] of [[-hu, entrance - 0.9], [entrance + 0.9, hu]]) {
      if (b - a < 1.2) continue;
      add("bed", a, hv, b, hv + 1.3, 0.035);
      const n = Math.max(1, Math.floor((b - a) / 1.5));
      for (let i = 0; i < n; i++) want("bush", a + ((i + 0.5) * (b - a)) / n, hv + 0.65, i % 3 === 1 ? 2 : i % 2, 0.85 + random() * 0.2);
    }
    // Loose shrub groups at the back corners and along the sides; specimen trees behind them.
    const group = (u: number, v: number) => {
      want("bush", u, v, 0, 1);
      want("bush", u + 1.1, v + 0.5, 1, 0.9);
      want("bush", u - 0.4, v + 1.2, random() < 0.5 ? 1 : 2, 0.85);
    };
    for (const s of [-1, 1]) {
      group(s * (hu + 2.5), -hv - 6);
      group(s * (hu + 6.5), hv - 1);
    }
    for (const s of [-1, 1]) {
      want("tree", s * (hu + 5.5), -hv - 4.5, 1);
      want("tree", s * (hu + 8.5), -hv - 1.5);
      want("conifer", s * (hu + 7), -hv - 10.5);
      want("tree", s * (hu + 10), hv + 1.5, 2);
      want("bush", s * (hu + 3.2), -hv - 2.5, 0);
      want("bush", s * (hu + 3.8), -hv - 1.4, 1);
    }
    for (let u = -hu - 2; u <= hu + 2; u += 6.5) want(random() < 0.4 ? "conifer" : "tree", u + jitter(1), -hv - 12 - random() * 2);
    // Street trees in the verge, then across the street.
    for (let u = -extent * 0.75; u <= extent * 0.75; u += 9) want("tree", u + jitter(0.5), sw1 + 0.65, random() < 0.5 ? 0 : 2);
    for (let u = -extent * 0.7; u <= extent * 0.7; u += 8) want(random() < 0.3 ? "conifer" : "tree", u + jitter(1.5), far0 + 6 + random() * 3);
    // A small ornamental tree in the front lawn, away from the path and driveway.
    want("tree", -driveSide * (hu - 0.5), hv + 3.2, 2, 0.75);
  } else if (style === "urban") {
    // Paved forecourt, a wide pavement with tree grates, parking lane + two lanes, crossing.
    const pl0 = hv + 4.5, curb0 = pl0 + 3.5, road0 = curb0 + 0.15, road1 = road0 + 10, far0 = road1 + 0.15;
    add("plaza", -hu - 3, -hv - 3, hu + 3, pl0, 0.06);
    add("sidewalk", -extent, pl0, extent, curb0, 0.1);
    add("curb", -extent, curb0, extent, road0, 0.15);
    add("road", -extent, road0, extent, road1, 0.02);
    add("curb", -extent, road1, extent, far0, 0.15);
    add("sidewalk", -extent, far0, extent, far0 + 3.5, 0.1);
    add("marking", -extent, road0 + 2.3, extent, road0 + 2.4, 0.026); // parking lane
    dashes(road0 + 6.2, 0.12, 3, 7);
    // Zebra crossing to the side of the house.
    const xu = -hu - 7;
    for (let v = road0 + 0.6; v < road1 - 0.6; v += 1.0) add("marking", xu - 2, v, xu + 2, v + 0.5, 0.026);
    // Street trees in grates along the curb; planters with clipped shrubs at the forecourt corners.
    for (let i = 0, u = -extent * 0.8; u <= extent * 0.8; i++, u += 7.5) {
      if (Math.abs(u - xu) < 3) continue;
      add("grate", u - 0.7, curb0 - 1.9, u + 0.7, curb0 - 0.5, 0.105);
      want("tree", u, curb0 - 1.2, i % 2 ? 0 : 2);
    }
    for (const s of [-1, 1]) {
      add("planter", s * (hu + 1.4) - 0.55, hv + 0.6, s * (hu + 1.4) + 0.55, hv + 3.6, 0.5);
      for (let k = 0; k < 3; k++) want("bush", s * (hu + 1.4), hv + 1.1 + k, 1, 0.85);
      want("tree", s * (hu + 6), -hv - 6, 1);
    }
    for (let u = -extent * 0.7; u <= extent * 0.7; u += 8) want("tree", u + jitter(1), far0 + 7 + random() * 3);
    for (let u = -hu - 6; u <= hu + 6; u += 7) want(random() < 0.35 ? "conifer" : "tree", u + jitter(1), -hv - 11 - random() * 2);
  } else {
    // Minimal: lawn, a paved path to the entrance, two small beds, a few trees well behind.
    add("path", entrance - 0.6, hv, entrance + 0.6, hv + 7, 0.05);
    for (const s of [-1, 1]) {
      const u = s * (hu - 1.2);
      add("bed", u - 1.1, hv + 0.3, u + 1.1, hv + 1.5, 0.035);
      want("bush", u - 0.55, hv + 0.9, 1, 0.9);
      want("bush", u + 0.55, hv + 0.9, s > 0 ? 2 : 0, 0.8);
      want("tree", s * (hu + 6), -hv - 7, 2);
    }
    want("tree", 0, -hv - 11, 1);
  }

  // Keep what fits: off the house, the hard surfaces and each other; inside the fade; never
  // in front of the house from a protected view.
  const keepOff = slabs.filter((s) => s.kind !== "bed" && s.kind !== "grate" && s.kind !== "planter" && s.kind !== "marking").map((s) => s.rect);
  const holders = slabs.filter((s) => s.kind === "bed" || s.kind === "grate" || s.kind === "planter");
  const plants: Plant[] = [];
  for (const p of wanted) {
    p.base = Math.max(0, ...holders.filter((s) => insideRect(s.rect, p.x, p.z)).map((s) => s.top));
    const spec = PLANT_SPECS[p.kind][p.variant];
    const spread = Math.max(...spec.envelope.map((e) => e.r)) * p.scale;
    const trunkPad = p.kind === "bush" ? spread * 0.6 : 0.6;
    if (insideRect(footprint, p.x, p.z, p.kind === "bush" ? 0.15 : 2)) continue;
    if (Math.hypot(p.x - f.cx, p.z - f.cz) > extent * 0.72) continue;
    // Grates, planters and beds are made for planting, even where they sit in paving.
    const planted = holders.some((s) => insideRect(s.rect, p.x, p.z));
    if (!planted && keepOff.some((r) => insideRect(r, p.x, p.z, trunkPad))) continue;
    if (plants.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < (spread + Math.max(...PLANT_SPECS[q.kind][q.variant].envelope.map((e) => e.r)) * q.scale) * (p.kind === "bush" && q.kind === "bush" ? 0.75 : 0.85))) continue;
    if (blocksView(p, groundY, views)) continue;
    plants.push(p);
    const trees = plants.filter((q) => q.kind !== "bush").length;
    if (trees > SITE_BUDGET.trees || plants.length - trees > SITE_BUDGET.bushes) plants.pop();
  }

  return { style, center: [f.cx, f.cz], extent, fade: [extent * 0.55, extent * 0.95], front: facing, slabs, plants };
}
