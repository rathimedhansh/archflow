import { boxInWall, type ResolvedOpening, type WallFrame } from "./walls";
import type { MeshBuilder } from "./meshBuilder";

/** Placeholder proportions (metres). Real product assets replace these later. */
export const FRAME_WIDTH = 0.05;
const FRAME_PROTRUSION = 0.02; // frame sticks out this far past each wall face
const DOOR_LEAF_THICKNESS = 0.04;
const SILL_HEIGHT = 0.03;
const SILL_PROTRUSION = 0.08;
const GLASS_THICKNESS = 0.01;

/** Door: a three-sided frame (jambs + head) and a closed leaf, sitting in the hole in the wall. */
export function buildDoor(b: MeshBuilder, f: WallFrame, o: ResolvedOpening): void {
  const depth = f.thickness + 2 * FRAME_PROTRUSION;
  const headBottom = Math.max(o.bottom, o.top - FRAME_WIDTH);
  boxInWall(b, f, o.a, o.a + FRAME_WIDTH, o.bottom, headBottom, depth); // left jamb
  boxInWall(b, f, o.b - FRAME_WIDTH, o.b, o.bottom, headBottom, depth); // right jamb
  boxInWall(b, f, o.a, o.b, headBottom, o.top, depth); // head
  boxInWall(b, f, o.a + FRAME_WIDTH, o.b - FRAME_WIDTH, o.bottom, headBottom, DOOR_LEAF_THICKNESS); // leaf
}

/** Window: frame with a projecting sill board. Glass is built separately (different material). */
export function buildWindowFrame(b: MeshBuilder, f: WallFrame, o: ResolvedOpening): void {
  const depth = f.thickness + 2 * FRAME_PROTRUSION;
  const sillTop = Math.min(o.top, o.bottom + SILL_HEIGHT);
  const headBottom = Math.max(sillTop, o.top - FRAME_WIDTH);
  boxInWall(b, f, o.a, o.b, o.bottom, sillTop, f.thickness + SILL_PROTRUSION); // sill board
  boxInWall(b, f, o.a, o.a + FRAME_WIDTH, sillTop, headBottom, depth); // left jamb
  boxInWall(b, f, o.b - FRAME_WIDTH, o.b, sillTop, headBottom, depth); // right jamb
  boxInWall(b, f, o.a, o.b, headBottom, o.top, depth); // head
}

/** The transparent pane, inset inside the frame. */
export function buildWindowGlass(b: MeshBuilder, f: WallFrame, o: ResolvedOpening): void {
  const bottom = Math.min(o.top, o.bottom + SILL_HEIGHT);
  const top = Math.max(bottom, o.top - FRAME_WIDTH);
  boxInWall(b, f, o.a + FRAME_WIDTH, o.b - FRAME_WIDTH, bottom, top, GLASS_THICKNESS);
}
