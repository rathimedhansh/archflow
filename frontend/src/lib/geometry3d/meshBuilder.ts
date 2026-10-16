import type { MeshData, V3 } from "./types";
import { triangulate, signedArea, type P2 } from "./triangulate";
import { add, cross, dot, length, scale, sub } from "./vec";

const MIN_EDGE = 1e-9;
const MIN_DOUBLE_AREA_SQ = 1e-12;

/** Accumulates flat-shaded triangles. Every face is oriented to match the normal you give it. */
export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private indices: number[] = [];

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /** Winding is fixed up so the triangle faces along `n` (a unit vector). Degenerate ones are dropped. */
  addTriangle(a: V3, b: V3, c: V3, n: V3): void {
    const g = cross(sub(b, a), sub(c, a));
    if (dot(g, g) < MIN_DOUBLE_AREA_SQ) return;
    if (dot(g, n) < 0) [b, c] = [c, b];
    const base = this.positions.length / 3;
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
    }
    this.indices.push(base, base + 1, base + 2);
  }

  /** `a b c d` run around the quad. */
  addQuad(a: V3, b: V3, c: V3, d: V3, n: V3): void {
    this.addTriangle(a, b, c, n);
    this.addTriangle(a, c, d, n);
  }

  /**
   * Closed box spanning `origin + s*ax + t*ay + u*az` for s,t,u in [0,1].
   * The three edge vectors must be mutually perpendicular.
   */
  addBox(origin: V3, ax: V3, ay: V3, az: V3): void {
    const [lx, ly, lz] = [length(ax), length(ay), length(az)];
    if (lx < MIN_EDGE || ly < MIN_EDGE || lz < MIN_EDGE) return;
    const [ux, uy, uz] = [scale(ax, 1 / lx), scale(ay, 1 / ly), scale(az, 1 / lz)];
    const p = (s: number, t: number, u: number): V3 =>
      add(origin, add(scale(ax, s), add(scale(ay, t), scale(az, u))));

    for (const s of [0, 1]) this.addQuad(p(s, 0, 0), p(s, 0, 1), p(s, 1, 1), p(s, 1, 0), scale(ux, s ? 1 : -1));
    for (const t of [0, 1]) this.addQuad(p(0, t, 0), p(1, t, 0), p(1, t, 1), p(0, t, 1), scale(uy, t ? 1 : -1));
    for (const u of [0, 1]) this.addQuad(p(0, 0, u), p(1, 0, u), p(1, 1, u), p(0, 1, u), scale(uz, u ? 1 : -1));
  }

  /**
   * Closed prism over a plan-space polygon, from world height `yBottom` up to `yTop`.
   * Returns false if the outline could not be fully triangulated.
   */
  addPrism(polygon: readonly P2[], yBottom: number, yTop: number): boolean {
    const { triangles, ok } = triangulate(polygon);
    const at = (i: number, y: number): V3 => [polygon[i][0], y, polygon[i][1]];
    for (const [i, j, k] of triangles) {
      this.addTriangle(at(i, yTop), at(j, yTop), at(k, yTop), [0, 1, 0]);
      this.addTriangle(at(i, yBottom), at(j, yBottom), at(k, yBottom), [0, -1, 0]);
    }
    // Outward side normal depends on winding: for counter-clockwise (x, y), it is (dy, -dx).
    const ccw = signedArea(polygon) >= 0;
    for (let i = 0; i < polygon.length; i++) {
      const [p, q] = [polygon[i], polygon[(i + 1) % polygon.length]];
      const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < MIN_EDGE) continue;
      const [nx, nz] = ccw ? [dy / len, -dx / len] : [-dy / len, dx / len];
      this.addQuad(at(i, yBottom), at((i + 1) % polygon.length, yBottom), at((i + 1) % polygon.length, yTop), at(i, yTop), [nx, 0, nz]);
    }
    return ok;
  }

  build(): MeshData {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      indices: Uint32Array.from(this.indices),
    };
  }
}
