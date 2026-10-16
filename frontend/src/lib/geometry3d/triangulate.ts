/** Ear-clipping triangulation of a simple polygon (convex or concave, no holes). */

export type P2 = readonly [number, number];

const EPS = 1e-12;

const cross2 = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const same = (a: P2, b: P2) => a[0] === b[0] && a[1] === b[1];

/** Shoelace area; positive when the vertices run counter-clockwise in the (x, y) math plane. */
export function signedArea(poly: readonly P2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export interface Triangulation {
  /** Index triples into the input array. */
  triangles: [number, number, number][];
  /** False if the outline was degenerate or self-intersecting and only part could be filled. */
  ok: boolean;
}

export function triangulate(poly: readonly P2[]): Triangulation {
  // Work on indices, skipping repeated points (including a closing point equal to the first).
  const ids: number[] = [];
  poly.forEach((p, i) => {
    if (!ids.length || !same(p, poly[ids[ids.length - 1]])) ids.push(i);
  });
  if (ids.length > 1 && same(poly[ids[0]], poly[ids[ids.length - 1]])) ids.pop();
  if (ids.length < 3) return { triangles: [], ok: false };

  if (signedArea(ids.map((i) => poly[i])) < 0) ids.reverse(); // normalise to counter-clockwise

  const triangles: [number, number, number][] = [];
  let guard = ids.length * ids.length + 10;

  while (ids.length > 3 && guard-- > 0) {
    const n = ids.length;
    let clipped = false;
    for (let k = 0; k < n && !clipped; k++) {
      const ia = ids[(k + n - 1) % n];
      const ib = ids[k];
      const ic = ids[(k + 1) % n];
      const [a, b, c] = [poly[ia], poly[ib], poly[ic]];
      if (cross2(a, b, c) <= EPS) continue; // reflex or collinear corner is never an ear
      const blocked = ids.some((j) => {
        if (j === ia || j === ib || j === ic) return false;
        const p = poly[j];
        if (same(p, a) || same(p, b) || same(p, c)) return false;
        return cross2(a, b, p) >= -EPS && cross2(b, c, p) >= -EPS && cross2(c, a, p) >= -EPS;
      });
      if (blocked) continue;
      triangles.push([ia, ib, ic]);
      ids.splice(k, 1);
      clipped = true;
    }
    if (clipped) continue;

    // No ear: usually collinear vertices. Drop one (it adds no area) and retry.
    const collinear = ids.findIndex(
      (_, k) => Math.abs(cross2(poly[ids[(k + n - 1) % n]], poly[ids[k]], poly[ids[(k + 1) % n]])) <= EPS,
    );
    if (collinear < 0) return { triangles, ok: false };
    ids.splice(collinear, 1);
  }

  if (ids.length === 3 && cross2(poly[ids[0]], poly[ids[1]], poly[ids[2]]) > EPS) {
    triangles.push([ids[0], ids[1], ids[2]]);
  }
  return { triangles, ok: guard > 0 };
}
