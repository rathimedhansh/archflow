import { describe, expect, it } from "vitest";
import type { SceneBounds, V3 } from "@/lib/geometry3d";
import { computeFraming, FOV_DEG, viewPose } from "./framing";
import { revealEase, revealPose } from "./reveal";

const house: SceneBounds = { min: [0, -0.1, 0], max: [10, 2.8, 6] };
const long: SceneBounds = { min: [-2, -0.1, 3], max: [22, 3.0, 9] };

/** Is a world point inside the camera's view frustum? (camera looking at target, world up = +Y) */
function inView(pose: { position: V3; target: V3 }, p: V3, aspect: number): boolean {
  const f = [pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  const fw = f.map((v) => v / fl);
  let r = [-fw[2], 0, fw[0]]; // fw x up
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  r = r.map((v) => v / rl);
  const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
  const d = [p[0] - pose.position[0], p[1] - pose.position[1], p[2] - pose.position[2]];
  const z = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
  const x = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
  const y = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const tv = Math.tan((FOV_DEG * Math.PI) / 360);
  return z > 0 && Math.abs(y / z) <= tv + 1e-9 && Math.abs(x / z) <= tv * aspect + 1e-9;
}
const corners = (b: SceneBounds): V3[] =>
  [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => [[b.min, b.max][i][0], [b.min, b.max][j][1], [b.min, b.max][k][2]] as V3)));
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const steps = Array.from({ length: 41 }, (_, i) => i / 40);

describe("opening reveal", () => {
  it("eases from 0 to 1, gently at both ends, never overshooting", () => {
    expect(revealEase(0)).toBe(0);
    expect(revealEase(1)).toBe(1);
    expect(revealEase(-1)).toBe(0);
    expect(revealEase(2)).toBe(1);
    expect(revealEase(0.05)).toBeLessThan(0.01);
    expect(revealEase(0.95)).toBeGreaterThan(0.99);
    for (let i = 1; i < steps.length; i++) expect(revealEase(steps[i])).toBeGreaterThanOrEqual(revealEase(steps[i - 1]));
  });

  it.each([16 / 9, 390 / 400])("ends exactly on the existing overview pose (aspect %d)", (aspect) => {
    const end = viewPose(house, "overview", aspect);
    expect(revealPose(end, 1)).toEqual(end);
    const almost = revealPose(end, 1 - 1e-9);
    expect(len(sub(almost.position, end.position))).toBeLessThan(1e-6);
  });

  it("keeps the target fixed, so the model stays centred throughout", () => {
    const end = viewPose(house, "overview", 1.5);
    for (const k of steps) expect(revealPose(end, k).target).toEqual(end.target);
  });

  it("is a gentle rise and swing: camera height only rises, distance only shrinks, about 30 degrees of turn", () => {
    const end = viewPose(house, "overview", 1.5);
    const poses = steps.map((k) => revealPose(end, k));
    for (let i = 1; i < poses.length; i++) {
      expect(poses[i].position[1]).toBeGreaterThan(poses[i - 1].position[1]);
      expect(len(sub(poses[i].position, end.target))).toBeLessThanOrEqual(len(sub(poses[i - 1].position, end.target)) + 1e-9);
    }
    const az = (p: V3) => Math.atan2(p[0] - end.target[0], p[2] - end.target[2]);
    const turnDeg = ((az(end.position) - az(poses[0].position)) * 180) / Math.PI;
    expect(turnDeg).toBeGreaterThan(20);
    expect(turnDeg).toBeLessThan(40);
  });

  it.each([
    ["house", house, 16 / 9],
    ["house", house, 390 / 400],
    ["long plan", long, 16 / 9],
    ["long plan", long, 390 / 400],
  ] as const)("the whole %s stays in view all the way (aspect %d)", (_name, bounds, aspect) => {
    const end = viewPose(bounds, "overview", aspect);
    for (const k of steps) for (const c of corners(bounds)) expect(inView(revealPose(end, k), c, aspect)).toBe(true);
  });

  it("stays above the ground and within the orbit limits (never below the floor, never too close or far)", () => {
    const f = computeFraming(house);
    const end = viewPose(house, "overview", 1.5);
    for (const k of steps) {
      const p = revealPose(end, k);
      const off = sub(p.position, p.target);
      const d = len(off);
      expect(Math.acos(off[1] / d)).toBeLessThan(Math.PI / 2 - 0.02); // CameraRig's maxPolarAngle
      expect(d).toBeGreaterThanOrEqual(f.minDistance);
      expect(d).toBeLessThanOrEqual(f.maxDistance);
    }
  });
});
