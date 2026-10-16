import { describe, expect, it } from "vitest";
import type { SceneBounds, V3 } from "@/lib/geometry3d";
import { computeFraming, dollyPose, fitDistance, FOV_DEG, roomPose, viewPose } from "./framing";

const house: SceneBounds = { min: [0, -0.1, 0], max: [10, 2.8, 6] };
const dist = (a: V3, b: V3) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

/** Is a world point inside the camera's view frustum? (camera looking at target, world up = +Y) */
function inView(pose: { position: V3; target: V3 }, p: V3, aspect: number): boolean {
  const f = [pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  const fw = f.map((v) => v / fl);
  let r = [fw[1] * 0 - fw[2] * 1, fw[2] * 0 - fw[0] * 0, fw[0] * 1 - fw[1] * 0]; // fw x up
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

describe("camera framing", () => {
  it.each([16 / 9, 1, 0.5])("overview shows the whole property at aspect %d", (aspect) => {
    const pose = viewPose(house, "overview", aspect);
    for (const c of corners(house)) expect(inView(pose, c, aspect)).toBe(true);
  });

  it.each([16 / 9, 0.5])("top view looks straight down and shows the whole footprint at aspect %d", (aspect) => {
    const pose = viewPose(house, "top", aspect);
    expect(pose.position[0]).toBeCloseTo(5, 6);
    expect(pose.position[1]).toBeGreaterThan(house.max[1]);
    expect(Math.abs(pose.position[2] - pose.target[2]) / pose.position[1]).toBeLessThan(0.01);
    for (const c of corners(house)) expect(inView(pose, c, aspect)).toBe(true);
  });

  it("a narrow (portrait) viewport moves the camera further back", () => {
    expect(fitDistance(5, 0.5)).toBeGreaterThan(fitDistance(5, 16 / 9));
    expect(fitDistance(5, 2)).toBeCloseTo(fitDistance(5, 1), 9);
  });

  it("reset is deterministic: the same model always gets the same pose", () => {
    expect(viewPose(house, "overview", 1.5)).toEqual(viewPose(house, "overview", 1.5));
  });

  it("scales with the model", () => {
    const big: SceneBounds = { min: [0, 0, 0], max: [40, 3, 30] };
    expect(computeFraming(big).radius).toBeGreaterThan(computeFraming(house).radius * 3);
    expect(dist(viewPose(big, "overview", 1).position, [20, 1.5, 15])).toBeGreaterThan(dist(viewPose(house, "overview", 1).position, [5, 1.35, 3]) * 3);
  });

  it("guards against a zero-size model and a bogus aspect ratio", () => {
    const zero: SceneBounds = { min: [0, 0, 0], max: [0, 0, 0] };
    const pose = viewPose(zero, "overview", NaN);
    expect([...pose.position, ...pose.target].every(Number.isFinite)).toBe(true);
    expect(computeFraming(zero).radius).toBe(1);
  });

  it("frames a single room and aims at it", () => {
    const pose = roomPose([[6, 3], [10, 3], [10, 6], [6, 6]], 2.8, 1.5);
    expect(pose.target[0]).toBeCloseTo(8, 9);
    expect(pose.target[2]).toBeCloseTo(4.5, 9);
    for (const c of corners({ min: [6, 0, 3], max: [10, 2.8, 6] })) expect(inView(pose, c, 1.5)).toBe(true);
    expect(dist(pose.position, pose.target)).toBeLessThan(dist(viewPose(house, "overview", 1.5).position, [5, 1.35, 3]));
  });

  it("zoom moves along the line of sight and respects the limits", () => {
    const pose = { position: [10, 10, 10] as V3, target: [0, 0, 0] as V3 };
    const d0 = dist(pose.position, pose.target);
    const zin = dollyPose(pose, 0.5, 1, 100);
    expect(dist(zin.position, zin.target)).toBeCloseTo(d0 / 2, 9);
    expect(zin.position[0] / zin.position[1]).toBeCloseTo(1, 9);
    expect(dist(dollyPose(pose, 0.001, 1, 100).position, pose.target)).toBeCloseTo(1, 9);
    expect(dist(dollyPose(pose, 1000, 1, 100).position, pose.target)).toBeCloseTo(100, 9);
  });
});
