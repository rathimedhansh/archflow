import { describe, expect, it } from "vitest";
import { signedArea, triangulate, type P2 } from "./triangulate";

const areaOf = (poly: P2[], tris: [number, number, number][]) =>
  tris.reduce((sum, [a, b, c]) => sum + Math.abs(signedArea([poly[a], poly[b], poly[c]])), 0);

describe("triangulate", () => {
  it("splits a square into 2 triangles covering its area", () => {
    const sq: P2[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
    const { triangles, ok } = triangulate(sq);
    expect(ok).toBe(true);
    expect(triangles).toHaveLength(2);
    expect(areaOf(sq, triangles)).toBeCloseTo(12);
  });

  it("handles clockwise input the same as counter-clockwise", () => {
    const cw: P2[] = [[0, 0], [0, 3], [4, 3], [4, 0]];
    expect(areaOf(cw, triangulate(cw).triangles)).toBeCloseTo(12);
  });

  it("fills a concave L-shape exactly (no triangle spills into the notch)", () => {
    const l: P2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    const { triangles, ok } = triangulate(l);
    expect(ok).toBe(true);
    expect(triangles).toHaveLength(4);
    expect(areaOf(l, triangles)).toBeCloseTo(12);
    // No triangle centroid may lie inside the removed 2x2 notch (x>2, y>2).
    for (const [a, b, c] of triangles) {
      const cx = (l[a][0] + l[b][0] + l[c][0]) / 3;
      const cy = (l[a][1] + l[b][1] + l[c][1]) / 3;
      expect(cx > 2 && cy > 2).toBe(false);
    }
  });

  it("handles a U-shape and a closing duplicate point", () => {
    const u: P2[] = [[0, 0], [6, 0], [6, 4], [4, 4], [4, 2], [2, 2], [2, 4], [0, 4], [0, 0]];
    expect(areaOf(u, triangulate(u).triangles)).toBeCloseTo(24 - 4);
  });

  it("ignores collinear vertices", () => {
    const p: P2[] = [[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]];
    const { triangles, ok } = triangulate(p);
    expect(ok).toBe(true);
    expect(areaOf(p, triangles)).toBeCloseTo(16);
  });

  it("reports failure for degenerate input instead of throwing", () => {
    expect(triangulate([[0, 0], [1, 1]]).ok).toBe(false);
    expect(triangulate([[0, 0], [1, 1], [2, 2]]).triangles).toHaveLength(0);
  });
});
