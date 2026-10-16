"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { absoluteUrl, ApiError, api, type FloorPlan } from "@/lib/api";
import { dist, polygonArea, snapPoint } from "@/lib/floorplan/geometry";
import { editorReducer, initialEditorState } from "@/lib/floorplan/history";
import {
  addOpening, addRoom, addWall, applyScale, findJoint, moveJoint, nearestWall, removeElement,
  updateOpening, updateRoom, updateWall, type Joint,
} from "@/lib/floorplan/ops";
import type { FloorPlanData, OpeningKind, Point, Selection } from "@/lib/floorplan/types";
import { MIN_WALL_LENGTH_M, validateFloorPlan } from "@/lib/floorplan/validate";
import { useAutoInterpret } from "@/hooks/useAutoInterpret";
import { reviewItems } from "@/lib/interpretation/result";
import type { Interpretation, InterpretationReport } from "@/lib/interpretation/types";
import { useConfirm } from "@/components/ConfirmDialog";
import { button, Notice, Spinner } from "@/components/ui";
import { CheckIcon, CubeIcon, SparkIcon } from "@/components/viewer/icons";
import AutoReviewPanel from "./AutoReviewPanel";
import EditorCanvas, { type Draft, type Tool } from "./EditorCanvas";
import PropertiesPanel from "./PropertiesPanel";

interface Props {
  image: FloorPlan;
  initialPlan: FloorPlanData;
  /** The automatic result the plan came from (its report drives the review panel). */
  interpretation?: Interpretation | null;
  /** Open `initialPlan` as unsaved changes (an automatic proposal the user has not saved yet). */
  startUnsaved?: boolean;
  onSaved?: () => void;
}

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Click an element to edit it. Drag the handles to reshape." },
  { id: "wall", label: "Wall", key: "W", hint: "Click to start, click to place each corner. Right-click or Esc to finish the chain." },
  { id: "room", label: "Room", key: "R", hint: "Click the room's corners, then click the first corner (or press Enter) to close it." },
  { id: "door", label: "Door", key: "D", hint: "Click on a wall to place a door." },
  { id: "window", label: "Window", key: "N", hint: "Click on a wall to place a window." },
  { id: "calibrate", label: "Set scale", key: "C", hint: "Click two points a known distance apart (e.g. a labelled dimension), then enter the real length." },
];

const KEY_TO_TOOL = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id])) as Record<string, Tool>;
const EMPTY_DRAFT: Draft = { wallStart: null, roomPoints: [], calibPoints: [], hover: null, hoverWall: null };
const SNAP_PX = 10;

type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

export default function FloorPlanEditor({ image, initialPlan, interpretation = null, startUnsaved = false, onSaved }: Props) {
  const [state, dispatch] = useReducer(editorReducer, initialPlan, (p) => initialEditorState(p, { unsaved: startUnsaved }));
  const { plan } = state;
  const dirty = plan !== state.saved;
  const [report, setReport] = useState<InterpretationReport | null>(interpretation?.report.supported ? interpretation.report : null);
  const [highlight, setHighlight] = useState(true);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const auto = useAutoInterpret();
  const [confirm, confirmDialog] = useConfirm();
  const toReview = useMemo(() => reviewItems(plan, report), [plan, report]);
  const flagged = useMemo(() => new Set(highlight ? toReview.map((i) => i.id) : []), [highlight, toReview]);

  const [tool, setToolState] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [zoom, setZoom] = useState(1);
  const [imageOpacity, setImageOpacity] = useState(0.7);
  const [ortho, setOrtho] = useState(true);
  const [calib, setCalib] = useState<{ points: [Point, Point]; value: string } | null>(null);
  const [save, setSave] = useState<SaveStatus>({ kind: "idle" });

  const dragRef = useRef<Joint | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mpp = plan.scale.meters_per_pixel;
  const u = mpp / zoom; // metres per screen pixel
  const issues = useMemo(() => validateFloorPlan(plan), [plan]);

  // Fit the plan to the available width on first render.
  useLayoutEffect(() => {
    const w = scrollRef.current?.clientWidth;
    if (w) setZoom(Math.min(1, Math.max(0.2, (w - 2) / plan.source.width_px)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    setDraft(EMPTY_DRAFT);
    setCalib(null);
    dragRef.current = null;
  }, []);

  const apply = useCallback((next: FloorPlanData, checkpoint = true) => dispatch({ type: "apply", plan: next, checkpoint }), []);

  const snapTargets = useCallback(
    (exclude?: Point): Point[] => {
      const pts = [...plan.walls.flatMap((w) => [w.start, w.end]), ...plan.rooms.flatMap((r) => r.polygon)];
      return exclude ? pts.filter((p) => dist(p, exclude) > 1e-6) : pts;
    },
    [plan],
  );

  const snap = (raw: Point, orthoFrom?: Point, exclude?: Point) =>
    snapPoint(raw, { targets: snapTargets(exclude), radius: SNAP_PX * u, orthoFrom: ortho ? orthoFrom : undefined }).point;

  const orthoAnchor = (): Point | undefined =>
    tool === "wall" ? (draft.wallStart ?? undefined) : tool === "room" ? draft.roomPoints[draft.roomPoints.length - 1] : undefined;

  // ---- canvas events -------------------------------------------------------------

  const onMove = (raw: Point) => {
    const joint = dragRef.current;
    if (joint) {
      const current = joint.wallEnds.length
        ? (() => {
            const w = plan.walls.find((x) => x.id === joint.wallEnds[0].wallId)!;
            return w[joint.wallEnds[0].end];
          })()
        : plan.rooms.find((r) => r.id === joint.roomVertices[0].roomId)!.polygon[joint.roomVertices[0].index];
      apply(moveJoint(plan, joint, snap(raw, undefined, current)), false);
      return;
    }
    if (tool === "select") return;
    const hoverWall =
      tool === "door" || tool === "window"
        ? (() => {
            const hit = nearestWall(plan, raw, 16 * u);
            return hit ? { wallId: hit.wall.id, along: hit.along } : null;
          })()
        : null;
    const hover = tool === "door" || tool === "window" ? raw : snap(raw, orthoAnchor());
    setDraft((d) => ({ ...d, hover, hoverWall }));
  };

  const finishRoom = (points: Point[]) => {
    const unique = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 1e-6);
    if (unique.length < 3) return;
    const r = addRoom(plan, unique);
    apply(r.plan);
    setSelection({ kind: "room", id: r.id });
    setDraft(EMPTY_DRAFT);
  };

  const onDown = (raw: Point) => {
    switch (tool) {
      case "select":
        setSelection(null);
        break;
      case "wall": {
        const p = snap(raw, draft.wallStart ?? undefined);
        if (!draft.wallStart) return setDraft((d) => ({ ...d, wallStart: p }));
        if (dist(p, draft.wallStart) < MIN_WALL_LENGTH_M) return;
        apply(addWall(plan, draft.wallStart, p).plan);
        setDraft((d) => ({ ...d, wallStart: p })); // chain: next wall starts where this ended
        break;
      }
      case "room": {
        const p = snap(raw, draft.roomPoints[draft.roomPoints.length - 1]);
        const first = draft.roomPoints[0];
        if (first && draft.roomPoints.length >= 3 && dist(p, first) <= SNAP_PX * 1.5 * u) return finishRoom(draft.roomPoints);
        setDraft((d) => ({ ...d, roomPoints: [...d.roomPoints, p] }));
        break;
      }
      case "door":
      case "window": {
        const hit = nearestWall(plan, raw, 16 * u);
        if (!hit) return;
        const r = addOpening(plan, tool, hit.wall.id, hit.along);
        if (!r) return;
        apply(r.plan);
        setSelection({ kind: tool, id: r.id });
        break;
      }
      case "calibrate": {
        const p = snap(raw);
        if (draft.calibPoints.length >= 2) return;
        const points = [...draft.calibPoints, p];
        setDraft((d) => ({ ...d, calibPoints: points }));
        if (points.length === 2 && dist(points[0], points[1]) > 1e-6) setCalib({ points: [points[0], points[1]], value: "" });
        break;
      }
    }
  };

  const onHandleDown = (at: Point) => {
    dispatch({ type: "checkpoint" }); // whole drag = one undo step
    dragRef.current = findJoint(plan, at);
  };
  const onUp = () => {
    dragRef.current = null;
  };

  const onContext = () => {
    if (tool === "wall") setDraft((d) => ({ ...d, wallStart: null }));
    else if (tool === "room") setDraft((d) => ({ ...d, roomPoints: [] }));
  };

  const deleteSelection = useCallback(() => {
    if (!selection) return;
    apply(removeElement(plan, selection));
    setSelection(null);
  }, [apply, plan, selection]);

  const doSave = useCallback(async () => {
    const errors = validateFloorPlan(plan);
    if (errors.length) return setSave({ kind: "error", message: `Fix ${errors.length} issue${errors.length > 1 ? "s" : ""} before saving.` });
    const sent = plan;
    setSave({ kind: "saving" });
    try {
      await api.saveStructure(image.id, sent);
      dispatch({ type: "saved", plan: sent });
      setSave({ kind: "saved" });
      onSaved?.();
    } catch (err) {
      setSave({ kind: "error", message: err instanceof ApiError ? err.message : "Save failed." });
    }
  }, [plan, image.id, onSaved]);

  /** Run automatic detection and load the result as one undoable edit. */
  const autoDetect = async () => {
    const hasContent = plan.walls.length + plan.rooms.length + plan.doors.length + plan.windows.length > 0;
    if (hasContent && !(await confirm({
      title: "Replace the current plan?",
      body: "The automatic result replaces what is drawn now. You can undo this.",
      confirmLabel: "Replace with detection",
    }))) return;
    setAutoNote(null);
    const outcome = await auto.run(image.id);
    if (!outcome) return;
    if (outcome.phase === "error") return setAutoNote(outcome.message);
    const { plan: proposal, report: rep } = outcome.interpretation;
    if (!rep.supported) return setAutoNote(`Not interpreted: ${rep.reason ?? "unsupported drawing."} The plan was left unchanged.`);
    apply(proposal);
    setReport(rep);
    setSelection(null);
    setTool("select");
  };

  const confirmCalibration = () => {
    if (!calib) return;
    const real = Number(calib.value);
    if (!Number.isFinite(real) || real <= 0) return;
    const pixels = dist(...calib.points) / mpp;
    const next = real / pixels;
    if (!(next > 0 && next < 100)) return;
    apply(applyScale(plan, next));
    setCalib(null);
    setTool("select");
  };

  // ---- keyboard ------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        if (draft.wallStart || draft.roomPoints.length || draft.calibPoints.length) setDraft(EMPTY_DRAFT);
        else if (calib) setCalib(null);
        else setSelection(null);
      } else if (e.key === "Enter" && tool === "room") {
        finishRoom(draft.roomPoints);
      } else if (!mod && KEY_TO_TOOL[e.key.toLowerCase()]) {
        setTool(KEY_TO_TOOL[e.key.toLowerCase()]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const totalArea = plan.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0);

  const zoomTo = (z: number) => setZoom(Math.min(4, Math.max(0.2, z)));
  const activeTool = TOOLS.find((t) => t.id === tool)!;
  const toolBtn = (on: boolean) =>
    `inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
      on ? "bg-accent text-on-accent shadow-[0_1px_0_rgb(0_0_0/0.08)]" : "text-foreground/80 hover:bg-stone hover:text-foreground"}`;
  const kbd = (on: boolean) => `rounded border px-1 font-mono text-[10px] leading-4 ${on ? "border-on-accent/30 text-on-accent/80" : "border-border-strong text-muted"}`;
  const plainBtn = "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[13px] text-foreground/80 transition-colors hover:bg-stone hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 space-y-3">
        {/* Toolbar: drawing tools · history · view */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface p-1.5">
          <div role="toolbar" aria-label="Drawing tools" className="flex flex-wrap items-center gap-0.5">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTool(t.id)}
                aria-pressed={tool === t.id}
                title={`${t.label} (${t.key})`}
                className={toolBtn(tool === t.id)}
              >
                {t.label} <kbd className={kbd(tool === t.id)}>{t.key}</kbd>
              </button>
            ))}
          </div>
          <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
          <div className="flex items-center gap-0.5">
            <button type="button" className={plainBtn} disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })} title="Undo (Ctrl+Z)">Undo</button>
            <button type="button" className={plainBtn} disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })} title="Redo (Ctrl+Shift+Z)">Redo</button>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 pr-1 text-xs text-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="accent-[var(--accent)]" checked={ortho} onChange={(e) => setOrtho(e.target.checked)} /> Straight lines
            </label>
            <label className="flex items-center gap-1.5">
              Plan
              <input type="range" min={0.15} max={1} step={0.05} value={imageOpacity} onChange={(e) => setImageOpacity(Number(e.target.value))} className="w-20 accent-[var(--accent)]" aria-label="Plan image opacity" />
            </label>
            <span className="flex items-center rounded-md border border-border">
              <button type="button" className={plainBtn} onClick={() => zoomTo(zoom / 1.25)} aria-label="Zoom out">−</button>
              <span className="w-11 text-center text-xs tabular-nums text-foreground/80">{Math.round(zoom * 100)}%</span>
              <button type="button" className={plainBtn} onClick={() => zoomTo(zoom * 1.25)} aria-label="Zoom in">+</button>
            </span>
          </div>
        </div>

        <p className="min-h-5 text-sm text-muted"><span className="font-medium text-foreground">{activeTool.label}</span> · {activeTool.hint}</p>

        {!plan.scale.calibrated && !calib && (
          <Notice tone="warning" action={<button type="button" onClick={() => setTool("calibrate")} className={button("secondary", "sm")}>Set scale</button>}>
            The scale is {report?.scale?.source === "doors" ? "estimated from door widths" : "assumed"} (the image is about {(plan.source.width_px * mpp).toFixed(0)} m wide).
            Set the real scale so sizes and areas are accurate.
          </Notice>
        )}

        {calib && (
          <form
            onSubmit={(e) => { e.preventDefault(); confirmCalibration(); }}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm"
          >
            <span>The two points are</span>
            <input
              autoFocus type="number" min="0.01" step="any" placeholder="e.g. 4.5"
              value={calib.value} onChange={(e) => setCalib({ ...calib, value: e.target.value })}
              className="h-9 w-24 rounded-md border border-border-strong bg-surface px-2 text-right tabular-nums outline-none focus:border-accent focus:ring-3 focus:ring-accent/15" aria-label="Real distance in metres"
            />
            <span>metres apart in real life.</span>
            <span className="flex gap-2 sm:ml-auto">
              <button type="submit" disabled={!(Number(calib.value) > 0)} className={button("primary", "sm")}>Apply scale</button>
              <button type="button" onClick={() => setTool("calibrate")} className={button("secondary", "sm")}>Redo points</button>
            </span>
          </form>
        )}

        <div ref={scrollRef} className="max-h-[72vh] overflow-auto rounded-xl border border-border bg-white shadow-[inset_0_0_0_1px_rgb(255_255_255)]">
          <EditorCanvas
            plan={plan} imageUrl={absoluteUrl(image.image_url)} zoom={zoom} imageOpacity={imageOpacity}
            tool={tool} selection={selection} draft={draft} flagged={flagged}
            onMove={onMove} onDown={onDown} onUp={onUp} onContext={onContext}
            onSelect={setSelection} onHandleDown={onHandleDown}
          />
        </div>
      </section>

      <aside className="space-y-5">
        <div className="rounded-xl border border-border bg-surface p-4">
          <button
            type="button" onClick={() => void doSave()} disabled={!dirty || save.kind === "saving"}
            className={dirty || save.kind === "saving"
              ? button("primary", "md", "w-full")
              : button("secondary", "md", "w-full !border-success-line !bg-success-bg !text-success !opacity-100")}
          >
            {save.kind === "saving" ? <><Spinner /> Saving…</> : dirty ? "Save structure" : <><CheckIcon /> Saved</>}
          </button>
          <p role="status" className={`mt-2 min-h-4 text-center text-xs ${save.kind === "error" ? "font-medium text-danger" : "text-muted"}`}>
            {save.kind === "error" ? save.message : save.kind === "saved" && !dirty ? "Structure saved." : dirty ? "Unsaved changes · Ctrl+S" : ""}
          </p>
          <Link href={`/plans/${image.id}/view`} className={button("secondary", "md", "mt-2 w-full")}>
            <CubeIcon /> View in 3D
          </Link>
          <p className="mt-2 text-center text-xs text-muted">
            {state.saved === null ? "Save first: nothing is saved yet." : dirty ? "3D shows the last saved version." : "Shows the saved plan."}
          </p>
        </div>

        {issues.length > 0 && (
          <Notice tone="danger" title={`${issues.length} thing${issues.length > 1 ? "s" : ""} to fix before saving`}>
            <ul className="mt-1 space-y-1">
              {issues.map((i, n) => (
                <li key={n}>
                  <button type="button" disabled={!i.ref} onClick={() => i.ref && setSelection(i.ref)} className="text-left underline decoration-danger/30 underline-offset-2 hover:decoration-danger disabled:no-underline">
                    {i.message}
                  </button>
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {report && (
          <AutoReviewPanel
            report={report} items={toReview} unsaved={state.saved === null}
            highlight={highlight} onHighlight={setHighlight}
            onSelect={(sel) => { setTool("select"); setSelection(sel); }}
            onCalibrate={() => setTool("calibrate")}
          />
        )}

        <div className="rounded-xl border border-border bg-surface p-4">
          <PropertiesPanel
            plan={plan} selection={selection}
            detection={selection ? report?.elements.find((e) => e.id === selection.id) : undefined}
            onWall={(id, patch) => apply(updateWall(plan, id, patch))}
            onRoom={(id, patch) => apply(updateRoom(plan, id, patch))}
            onOpening={(kind: OpeningKind, id, patch) => apply(updateOpening(plan, kind, id, patch))}
            onDelete={deleteSelection}
          />
        </div>

        <div className="rounded-xl border border-border bg-surface p-4 text-sm">
          <h3 className="font-semibold">This plan</h3>
          <dl className="mt-2 divide-y divide-border">
            {([["Walls", plan.walls.length], ["Rooms", plan.rooms.length], ["Doors", plan.doors.length], ["Windows", plan.windows.length]] as const).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{v}</dd></div>
            ))}
            <div className="flex justify-between py-1.5"><dt className="text-muted">Room area</dt><dd className="tabular-nums">{totalArea.toFixed(1)} m²</dd></div>
            <div className="flex justify-between py-1.5"><dt className="text-muted">Scale</dt><dd className="tabular-nums">{plan.scale.calibrated ? `${(1 / mpp).toFixed(1)} px/m` : report?.scale?.source === "doors" ? "estimated" : "assumed"}</dd></div>
          </dl>
          <div className="mt-4 border-t border-border pt-4">
            <button
              type="button" onClick={() => void autoDetect()} disabled={auto.state.phase === "running"}
              className={button("secondary", "md", "w-full")}
            >
              {auto.state.phase === "running"
                ? <><Spinner /> {`${auto.state.progress.find((s) => s.status === "running")?.label ?? "Analyzing floor plan"}…`}</>
                : <><SparkIcon /> {report ? "Run automatic detection again" : "Auto-detect from image"}</>}
            </button>
            <p role="status" className="mt-2 text-xs leading-relaxed text-muted">
              {autoNote ?? "Finds walls, rooms, doors and windows in the uploaded image. Replaces the current plan; you can undo it."}
            </p>
          </div>
        </div>
      </aside>
      {confirmDialog}
    </div>
  );
}
