"use client";

import { useRef } from "react";
import { polygonArea, polygonCentroid, wallLength, dist } from "@/lib/floorplan/geometry";
import type { FloorPlanData, Point, Selection } from "@/lib/floorplan/types";

export type Tool = "select" | "wall" | "room" | "door" | "window" | "calibrate";

export interface Draft {
  wallStart: Point | null;
  roomPoints: Point[];
  calibPoints: Point[];
  /** Cursor position after snapping, in metres. */
  hover: Point | null;
  hoverWall: { wallId: string; along: number } | null;
}

interface Props {
  plan: FloorPlanData;
  imageUrl: string;
  zoom: number;
  imageOpacity: number;
  tool: Tool;
  selection: Selection | null;
  draft: Draft;
  onMove: (raw: Point) => void;
  onDown: (raw: Point) => void;
  onUp: () => void;
  onContext: () => void;
  onSelect: (sel: Selection | null) => void;
  /** Pointer went down on a draggable handle sitting at this point. */
  onHandleDown: (at: Point) => void;
  /** Ids of automatically detected elements to flag for review. */
  flagged?: ReadonlySet<string>;
}

// Distinct but muted, to sit with the ivory/forest interface; selection (terracotta) differs from review flags (amber).
const ROOM_COLORS = ["#4f8a6c", "#6f72b0", "#c08a2c", "#b0687a", "#6a9550", "#4f88a6"];
const WALL = "#2b302a";
const SELECTED = "#d0532a";
const DOOR = "#9a5f2e";
const WINDOW = "#3a74a6";
const DRAFT = "#6b4fa0";
const FLAG = "#e0a41c";
const NO_FLAGS: ReadonlySet<string> = new Set();

const along = (a: Point, b: Point, d: number): Point => {
  const len = dist(a, b) || 1;
  return [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len];
};

export default function EditorCanvas(p: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { plan, tool, selection, draft } = p;
  const flagged = p.flagged ?? NO_FLAGS;
  const { width_px: W, height_px: H } = plan.source;
  const mpp = plan.scale.meters_per_pixel;
  const u = mpp / p.zoom; // metres per screen pixel: used for constant on-screen sizes
  const isSelect = tool === "select";

  const toMetres = (e: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * W * mpp, ((e.clientY - rect.top) / rect.height) * H * mpp];
  };

  const isSel = (kind: Selection["kind"], id: string) => selection?.kind === kind && selection.id === id;
  const pick = (kind: Selection["kind"], id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!isSelect || e.button !== 0) return;
      e.stopPropagation();
      p.onSelect({ kind, id });
    },
    style: { pointerEvents: isSelect ? ("auto" as const) : ("none" as const), cursor: "pointer" },
  });

  const handle = (at: Point, key: string) => (
    <circle
      key={key}
      cx={at[0]} cy={at[1]} r={6 * u}
      fill="#fff" stroke={SELECTED} strokeWidth={2 * u}
      style={{ cursor: "grab" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId); // keep receiving moves off-handle
        p.onHandleDown(at);
      }}
    />
  );

  const selWall = selection?.kind === "wall" ? plan.walls.find((w) => w.id === selection.id) : null;
  const selRoom = selection?.kind === "room" ? plan.rooms.find((r) => r.id === selection.id) : null;
  const label = { fontSize: 13 * u, fontFamily: "var(--font-geist-sans), sans-serif", pointerEvents: "none" as const };
  const halo = { stroke: "#fff", strokeWidth: 3.5 * u, paintOrder: "stroke" as const };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width={W * p.zoom}
      height={H * p.zoom}
      className="block select-none touch-none"
      style={{ cursor: isSelect ? "default" : "crosshair" }}
      onPointerMove={(e) => p.onMove(toMetres(e))}
      onPointerDown={(e) => e.button === 0 && p.onDown(toMetres(e))}
      onPointerUp={p.onUp}
      onPointerCancel={p.onUp}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onContext();
      }}
      data-testid="editor-canvas"
    >
      <rect width={W} height={H} fill="#fff" />
      <image href={p.imageUrl} width={W} height={H} opacity={p.imageOpacity} preserveAspectRatio="none" />

      <g transform={`scale(${1 / mpp})`}>
        {/* Rooms */}
        {plan.rooms.map((r, i) => {
          const c = polygonCentroid(r.polygon);
          const color = ROOM_COLORS[i % ROOM_COLORS.length];
          const flag = flagged.has(r.id);
          return (
            <g key={r.id} data-flagged={flag || undefined}>
              <polygon
                points={r.polygon.map((v) => v.join(",")).join(" ")}
                fill={color} fillOpacity={isSel("room", r.id) ? 0.38 : 0.2}
                stroke={isSel("room", r.id) ? SELECTED : flag ? FLAG : color} strokeWidth={(isSel("room", r.id) || flag ? 2.5 : 1.5) * u}
                strokeDasharray={`${6 * u} ${4 * u}`}
                {...pick("room", r.id)}
              />
              <text x={c[0]} y={c[1]} textAnchor="middle" {...label} {...halo} fill="none" fontWeight={600}>{r.name}</text>
              <text x={c[0]} y={c[1]} textAnchor="middle" {...label} fill="#0f172a" fontWeight={600}>{r.name}</text>
              <text x={c[0]} y={c[1] + 15 * u} textAnchor="middle" {...label} fontSize={11 * u} {...halo} fill="none">{polygonArea(r.polygon).toFixed(1)} m²</text>
              <text x={c[0]} y={c[1] + 15 * u} textAnchor="middle" {...label} fontSize={11 * u} fill="#334155">{polygonArea(r.polygon).toFixed(1)} m²</text>
            </g>
          );
        })}

        {/* Walls */}
        {plan.walls.map((w) => (
          <g key={w.id} data-flagged={flagged.has(w.id) || undefined}>
            {flagged.has(w.id) && (
              <line
                x1={w.start[0]} y1={w.start[1]} x2={w.end[0]} y2={w.end[1]} stroke={FLAG} strokeOpacity={0.8}
                strokeWidth={Math.max(w.thickness, 3 * u) + 8 * u} strokeDasharray={`${8 * u} ${5 * u}`} pointerEvents="none"
              />
            )}
            <line
              x1={w.start[0]} y1={w.start[1]} x2={w.end[0]} y2={w.end[1]}
              stroke={isSel("wall", w.id) ? SELECTED : WALL}
              strokeWidth={Math.max(w.thickness, 3 * u)}
              pointerEvents="none"
            />
            {/* Wider invisible hit target so thin walls are easy to grab. */}
            <line
              x1={w.start[0]} y1={w.start[1]} x2={w.end[0]} y2={w.end[1]}
              stroke="transparent" strokeWidth={Math.max(w.thickness, 14 * u)}
              {...pick("wall", w.id)}
            />
          </g>
        ))}

        {/* Doors and windows sit on their host wall */}
        {[...plan.doors.map((o) => ({ kind: "door" as const, o })), ...plan.windows.map((o) => ({ kind: "window" as const, o }))].map(({ kind, o }) => {
          const wall = plan.walls.find((w) => w.id === o.wall_id);
          if (!wall) return null;
          const a = along(wall.start, wall.end, o.offset);
          const b = along(wall.start, wall.end, o.offset + o.width);
          const color = isSel(kind, o.id) ? SELECTED : kind === "door" ? DOOR : WINDOW;
          const flag = flagged.has(o.id);
          return (
            <g key={o.id} data-flagged={flag || undefined}>
              <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={flag ? FLAG : "#fff"} strokeWidth={Math.max(wall.thickness, 3 * u) * 1.5 + (flag ? 6 * u : 0)} pointerEvents="none" />
              <line
                x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color}
                strokeWidth={Math.max(wall.thickness, 3 * u) * (kind === "door" ? 1.1 : 0.55)}
                {...pick(kind, o.id)}
              />
            </g>
          );
        })}

        {/* Handles for the selected element */}
        {isSelect && selWall && [handle(selWall.start, "s"), handle(selWall.end, "e")]}
        {isSelect && selRoom && selRoom.polygon.map((v, i) => handle(v, `v${i}`))}

        {/* Drafts */}
        {tool === "wall" && draft.wallStart && draft.hover && (
          <g pointerEvents="none">
            <line x1={draft.wallStart[0]} y1={draft.wallStart[1]} x2={draft.hover[0]} y2={draft.hover[1]}
              stroke={DRAFT} strokeWidth={3 * u} strokeDasharray={`${8 * u} ${5 * u}`} />
            <text x={(draft.wallStart[0] + draft.hover[0]) / 2} y={(draft.wallStart[1] + draft.hover[1]) / 2 - 8 * u}
              textAnchor="middle" {...label} {...halo} fill={DRAFT} fontWeight={600}>
              {wallLength({ start: draft.wallStart, end: draft.hover }).toFixed(2)} m
            </text>
          </g>
        )}
        {tool === "room" && draft.roomPoints.length > 0 && (
          <g pointerEvents="none">
            <polyline
              points={[...draft.roomPoints, ...(draft.hover ? [draft.hover] : [])].map((v) => v.join(",")).join(" ")}
              fill={DRAFT} fillOpacity={0.12} stroke={DRAFT} strokeWidth={2.5 * u} strokeDasharray={`${8 * u} ${5 * u}`}
            />
            {draft.roomPoints.map((v, i) => (
              <circle key={i} cx={v[0]} cy={v[1]} r={(i === 0 ? 7 : 4) * u} fill={i === 0 ? "#fff" : DRAFT} stroke={DRAFT} strokeWidth={2 * u} />
            ))}
          </g>
        )}
        {tool === "calibrate" && draft.calibPoints.length > 0 && (
          <g pointerEvents="none">
            {draft.calibPoints.length === 2 || draft.hover ? (
              <line x1={draft.calibPoints[0][0]} y1={draft.calibPoints[0][1]}
                x2={(draft.calibPoints[1] ?? draft.hover!)[0]} y2={(draft.calibPoints[1] ?? draft.hover!)[1]}
                stroke="#b33a2b" strokeWidth={2.5 * u} strokeDasharray={`${8 * u} ${5 * u}`} />
            ) : null}
            {draft.calibPoints.map((v, i) => <circle key={i} cx={v[0]} cy={v[1]} r={5 * u} fill="#b33a2b" />)}
          </g>
        )}
        {(tool === "door" || tool === "window") && draft.hoverWall && (() => {
          const wall = plan.walls.find((w) => w.id === draft.hoverWall!.wallId);
          return wall ? (
            <line x1={wall.start[0]} y1={wall.start[1]} x2={wall.end[0]} y2={wall.end[1]}
              stroke={tool === "door" ? DOOR : WINDOW} strokeOpacity={0.55} strokeWidth={Math.max(wall.thickness * 1.6, 8 * u)} pointerEvents="none" />
          ) : null;
        })()}

        {/* Snap cursor */}
        {draft.hover && tool !== "select" && (
          <circle cx={draft.hover[0]} cy={draft.hover[1]} r={4 * u} fill="none" stroke={DRAFT} strokeWidth={1.5 * u} pointerEvents="none" />
        )}
      </g>
    </svg>
  );
}
