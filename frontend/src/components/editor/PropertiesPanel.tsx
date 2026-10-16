"use client";

import { polygonArea, wallLength } from "@/lib/floorplan/geometry";
import type { FloorPlanData, OpeningKind, Selection, Window as WindowOpening } from "@/lib/floorplan/types";
import { button } from "@/components/ui";
import { NumberField, TextField } from "./fields";

const ROOM_NAMES = ["Living Room", "Kitchen", "Dining", "Bedroom", "Master Bedroom", "Bathroom", "Toilet", "Hallway", "Balcony", "Study", "Utility", "Storage"];

interface Props {
  plan: FloorPlanData;
  selection: Selection | null;
  onWall: (id: string, patch: { height?: number; thickness?: number }) => void;
  onRoom: (id: string, patch: { name: string }) => void;
  onOpening: (kind: OpeningKind, id: string, patch: Record<string, number>) => void;
  onDelete: () => void;
  /** What automatic detection said about the selected element, if it was detected. */
  detection?: { confidence: number; evidence: string; needs_review: boolean };
}

export default function PropertiesPanel({ plan, selection, onWall, onRoom, onOpening, onDelete, detection }: Props) {
  if (!selection) {
    return (
      <div className="text-sm">
        <h3 className="font-semibold">Selection</h3>
        <p className="mt-1 leading-relaxed text-muted">Click a wall, room, door or window on the plan to rename, resize or delete it.</p>
      </div>
    );
  }

  let body: React.ReactNode = null;
  let title = "";

  if (selection.kind === "wall") {
    const w = plan.walls.find((x) => x.id === selection.id);
    if (!w) return null;
    title = "Wall";
    body = (
      <>
        <NumberField label="Length" value={wallLength(w)} unit="m" readOnly />
        <NumberField label="Height" value={w.height} unit="m" min={0.5} max={10} onCommit={(v) => onWall(w.id, { height: v })} />
        <NumberField label="Thickness" value={w.thickness} unit="m" min={0.03} max={2} step={0.01} onCommit={(v) => onWall(w.id, { thickness: v })} />
      </>
    );
  } else if (selection.kind === "room") {
    const r = plan.rooms.find((x) => x.id === selection.id);
    if (!r) return null;
    title = "Room";
    body = (
      <>
        <datalist id="room-names">{ROOM_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
        <TextField label="Name" value={r.name} list="room-names" onCommit={(name) => onRoom(r.id, { name })} />
        <NumberField label="Area" value={polygonArea(r.polygon)} unit="m²" readOnly />
        <NumberField label="Corners" value={r.polygon.length} readOnly />
      </>
    );
  } else {
    const kind = selection.kind;
    const o = (kind === "door" ? plan.doors : plan.windows).find((x) => x.id === selection.id);
    if (!o) return null;
    title = kind === "door" ? "Door" : "Window";
    const set = (patch: Record<string, number>) => onOpening(kind, o.id, patch);
    body = (
      <>
        <div className="flex items-center justify-between py-1.5 text-sm">
          <span className="text-muted">On wall</span>
          <span className="font-mono text-xs">{o.wall_id}</span>
        </div>
        <NumberField label="Position" value={o.offset} unit="m" min={0} onCommit={(v) => set({ offset: v })} />
        <NumberField label="Width" value={o.width} unit="m" min={0.2} max={kind === "door" ? 5 : 10} onCommit={(v) => set({ width: v })} />
        <NumberField label="Height" value={o.height} unit="m" min={0.2} max={10} onCommit={(v) => set({ height: v })} />
        {kind === "window" && <NumberField label="Sill height" value={(o as WindowOpening).sill} unit="m" min={0} max={10} onCommit={(v) => set({ sill: v })} />}
      </>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-muted">{selection.id}</span>
      </div>
      {body}
      {detection && (
        <p className={`mt-3 rounded-md px-2.5 py-2 text-xs leading-snug ${detection.needs_review ? "bg-warning-bg text-warning" : "bg-stone/70 text-muted"}`}>
          Detected automatically · {Math.round(detection.confidence * 100)}% confidence
          {detection.evidence && <span className="block opacity-80">{detection.evidence}</span>}
        </p>
      )}
      <button
        type="button"
        onClick={onDelete}
        className={button("danger", "sm", "mt-4 w-full")}
      >
        Delete {title.toLowerCase()} <kbd className="rounded border border-danger-line px-1 font-mono text-[10px] leading-4">Del</kbd>
      </button>
    </div>
  );
}
