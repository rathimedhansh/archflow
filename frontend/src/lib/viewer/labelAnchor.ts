/**
 * Where to put a room's name. The area centroid is ideal for most rooms, but for L- and
 * U-shaped rooms it can fall in a corner or even outside the room. Then the label goes to
 * the interior point furthest from the walls (an approximate "pole of inaccessibility").
 *
 * Pure and deterministic (fixed grid, first-best wins), plan coordinates in metres.
 */
type P = readonly [number, number];

export function pointInPolygon([x, y]: P, poly: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToOutline([x, y]: P, poly: readonly P[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const ex = x - (ax + t * dx);
    const ey = y - (ay + t * dy);
    best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
  }
  return best;
}

function areaCentroid(poly: readonly P[]): [number, number] | null {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cr = x1 * y2 - x2 * y1;
    a += cr;
    cx += (x1 + x2) * cr;
    cy += (y1 + y2) * cr;
  }
  return a === 0 ? null : [cx / (3 * a), cy / (3 * a)];
}

const GRID = 24;
/** Keep the centroid unless a grid point is clearly roomier (label stays visually centred in boxy rooms). */
const CENTROID_PREFERENCE = 0.75;

export function labelAnchor(polygon: readonly P[]): [number, number] {
  if (polygon.length === 0) return [0, 0];
  const centroid = areaCentroid(polygon);
  const centroidScore = centroid && pointInPolygon(centroid, polygon) ? distanceToOutline(centroid, polygon) : -1;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  let best: [number, number] | null = null;
  let bestScore = -1;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const p: [number, number] = [minX + ((i + 0.5) / GRID) * (maxX - minX), minY + ((j + 0.5) / GRID) * (maxY - minY)];
      if (!pointInPolygon(p, polygon)) continue;
      const score = distanceToOutline(p, polygon);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
  }

  if (centroid && centroidScore >= 0 && centroidScore >= bestScore * CENTROID_PREFERENCE) return centroid;
  if (best) return best;
  return centroid ?? [(minX + maxX) / 2, (minY + maxY) / 2];
}
