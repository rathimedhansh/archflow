import { describe, expect, it } from "vitest";
import { editorReducer, initialEditorState } from "../floorplan/history";
import type { FloorPlanData } from "../floorplan/types";
import { validateFloorPlan } from "../floorplan/validate";
import { acceptInterpretation, confidenceBand, parseReport, resultOutcome, reviewItems } from "./result";
import { buildSteps } from "./steps";
import { applyStage, initialProgress, parseStreamLine, readLines } from "./stream";

const plan = (over: Partial<FloorPlanData> = {}): FloorPlanData => ({
  version: 1, units: "meters", provenance: "opencv",
  source: { floorplan_id: "abc", width_px: 1000, height_px: 800 },
  scale: { meters_per_pixel: 0.01, calibrated: false },
  walls: [
    { id: "wall-1", start: [1, 1], end: [6, 1], height: 2.8, thickness: 0.2 },
    { id: "wall-2", start: [1, 1], end: [1, 5], height: 2.8, thickness: 0.2 },
  ],
  rooms: [{ id: "room-1", name: "Room 1", polygon: [[1, 1], [6, 1], [6, 5], [1, 5]] }],
  doors: [{ id: "door-1", wall_id: "wall-1", offset: 1, width: 0.9, height: 2.1 }],
  windows: [],
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({
  interpreter: "opencv", pipeline_version: "opencv-1", supported: true, reason: null, overall_confidence: 0.82,
  stages: [], scale: { meters_per_pixel: 0.01, source: "doors", confidence: 0.5, detail: "From 1 door." },
  elements: [
    { id: "wall-1", kind: "wall", confidence: 0.95, evidence: "", needs_review: false },
    { id: "wall-2", kind: "wall", confidence: 0.55, evidence: "", needs_review: true },
    { id: "room-1", kind: "room", confidence: 0.62, evidence: "enclosed", needs_review: true },
    { id: "door-1", kind: "door", confidence: 0.9, evidence: "arc", needs_review: false },
  ],
  warnings: ["1 wall opening could not be identified."], omitted: { doors: 2, rooms: 0 },
  ...over,
});

describe("stream lines", () => {
  it("parses stage, result and error messages", () => {
    expect(parseStreamLine('{"type":"stage","stage":"walls","status":"done","summary":"9 walls","ms":12}'))
      .toEqual({ type: "stage", stage: "walls", status: "done", summary: "9 walls", ms: 12 });
    expect(parseStreamLine('{"type":"result","interpretation":{"a":1}}')).toEqual({ type: "result", interpretation: { a: 1 } });
    expect(parseStreamLine('{"type":"error","message":"boom"}')).toEqual({ type: "error", message: "boom" });
  });

  it("ignores malformed or unknown lines instead of throwing", () => {
    for (const line of ["", "   ", "{not json", "42", "null", "[]", '{"type":"stage","stage":"hack","status":"done"}',
      '{"type":"stage","stage":"walls","status":"exploded"}', '{"type":"telemetry"}', '{"type":"result"}']) {
      expect(parseStreamLine(line)).toBeNull();
    }
    expect(parseStreamLine('{"type":"stage","stage":"rooms","status":"done","ms":-5,"summary":7}'))
      .toEqual({ type: "stage", stage: "rooms", status: "done", summary: "", ms: 0 });
  });

  it("reassembles lines split across chunks", async () => {
    const enc = new TextEncoder();
    const chunks = ['{"type":"st', 'age","stage":"walls","status":"started"}\n{"type":"err', 'or","message":"x"}\n', '{"tail":1}'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((s) => c.enqueue(enc.encode(s)));
        c.close();
      },
    });
    const lines: string[] = [];
    await readLines(body, (l) => lines.push(l));
    expect(lines).toEqual(['{"type":"stage","stage":"walls","status":"started"}', '{"type":"error","message":"x"}', '{"tail":1}']);
  });

  it("tracks stage progress in order", () => {
    let p = initialProgress();
    p = applyStage(p, { type: "stage", stage: "preprocess", status: "started", summary: "", ms: 0 });
    expect(p.map((s) => s.status)).toEqual(["running", "pending", "pending", "pending", "pending", "pending"]);
    // A later stage starting implies the earlier ones finished, even if a "done" line was lost.
    p = applyStage(p, { type: "stage", stage: "rooms", status: "started", summary: "", ms: 0 });
    expect(p.map((s) => s.status)).toEqual(["done", "done", "running", "pending", "pending", "pending"]);
    p = applyStage(p, { type: "stage", stage: "rooms", status: "done", summary: "4 rooms", ms: 3 });
    expect(p[2]).toMatchObject({ status: "done", summary: "4 rooms" });
  });
});

describe("step list", () => {
  it("shows upload steps, detection stages and review", () => {
    expect(buildSteps("uploading", { phase: "idle" }).map((s) => s.status)[0]).toBe("running");
    const steps = buildSteps("ready", { phase: "done", progress: initialProgress().map((s) => ({ ...s, status: "done" as const })) });
    expect(steps.map((s) => s.label)).toEqual([
      "Uploading", "Validating & preparing image", "Analyzing floor plan", "Detecting walls", "Detecting rooms",
      "Detecting doors & windows", "Estimating scale", "Building floor plan", "Ready for review",
    ]);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(buildSteps("processing", null).map((s) => s.key)).toEqual(["upload", "prepare", "ready"]);
  });
});

describe("accepting an automatic result", () => {
  it("accepts a valid result that the editor can open without issues", () => {
    const r = acceptInterpretation({ plan: plan(), report: report() }, "abc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.interpretation.plan.provenance).toBe("opencv");
    expect(validateFloorPlan(r.interpretation.plan)).toEqual([]);
    expect(r.interpretation.report.scale?.source).toBe("doors");
  });

  it("never marks an automatic plan as calibrated", () => {
    const r = acceptInterpretation({ plan: plan({ scale: { meters_per_pixel: 0.01, calibrated: true } }), report: report() }, "abc");
    expect(r.ok && r.interpretation.plan.scale.calibrated).toBe(false);
  });

  it("rejects results that are not plans, or belong to another image", () => {
    for (const raw of [null, 42, "x", [], {}, { plan: { version: 2 } }, { plan: "nope", report: report() }]) {
      expect(acceptInterpretation(raw, "abc").ok).toBe(false);
    }
    expect(acceptInterpretation({ plan: plan(), report: report() }, "other").ok).toBe(false);
  });

  it("drops malformed elements and keeps the rest", () => {
    const broken = { ...plan(), walls: [...plan().walls, { id: "wall-x", start: [NaN, 1], end: [2, 2] }, "junk"] };
    const r = acceptInterpretation({ plan: broken, report: report() }, "abc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.interpretation.plan.walls.map((w) => w.id)).toEqual(["wall-1", "wall-2"]);
    expect(r.notes.join(" ")).toMatch(/2 walls/);
  });

  it("parses a malformed report with safe defaults", () => {
    const rep = parseReport({ supported: "yes", overall_confidence: 7, elements: [{ id: 3 }, { id: "w", kind: "tree" }], warnings: "x", omitted: { doors: -1, rooms: 2.5, walls: 3 } });
    expect(rep.supported).toBe(false);
    expect(rep.reason).toMatch(/could not interpret/);
    expect(rep.overall_confidence).toBe(1);
    expect(rep.elements).toEqual([]);
    expect(rep.warnings).toEqual([]);
    expect(rep.omitted).toEqual({ walls: 3 });
    expect(parseReport(undefined).supported).toBe(false);
  });

  it("recomputes needs_review from the score and drops confidences for absent elements", () => {
    const r = acceptInterpretation({
      plan: plan(),
      report: report({ elements: [{ id: "wall-2", kind: "wall", confidence: 0.2, needs_review: false }, { id: "ghost", kind: "wall", confidence: 0.1 }] }),
    }, "abc");
    expect(r.ok && r.interpretation.report.elements).toEqual([{ id: "wall-2", kind: "wall", confidence: 0.2, evidence: "", needs_review: true }]);
  });
});

describe("review list", () => {
  const rep = parseReport(report());

  it("lists uncertain elements, least confident first", () => {
    expect(reviewItems(plan(), rep).map((i) => [i.id, i.label])).toEqual([["wall-2", "wall-2"], ["room-1", "Room 1"]]);
    expect(reviewItems(plan(), null)).toEqual([]);
  });

  it("follows the user's corrections: deleted elements drop out", () => {
    const edited = plan({ walls: [plan().walls[0]], rooms: [] });
    expect(reviewItems(edited, rep)).toEqual([]);
  });

  it("bands confidence for display", () => {
    expect([confidenceBand(0.9), confidenceBand(0.7), confidenceBand(0.3)]).toEqual(["high", "medium", "low"]);
  });

  it("never presents a weak result like a good one", () => {
    const outcome = (p: FloorPlanData, r: Record<string, unknown>) => resultOutcome({ plan: p, report: parseReport(report(r)) });
    expect(outcome(plan(), {})).toBe("found");
    expect(outcome(plan({ rooms: [] }), {})).toBe("partial"); // walls without any closed room: not a usable plan
    expect(outcome(plan({ rooms: [] }), { overall_confidence: 0.3 })).toBe("partial");
    expect(outcome(plan(), { overall_confidence: 0.45 })).toBe("uncertain");
    expect(outcome(plan({ walls: [], rooms: [], doors: [] }), { supported: false, reason: "too small" })).toBe("unsupported");
  });
});

describe("opening a proposal in the editor", () => {
  it("starts unsaved and becomes clean once saved", () => {
    const p = plan();
    const s0 = initialEditorState(p, { unsaved: true });
    expect(s0.plan).not.toBe(s0.saved);
    const s1 = editorReducer(s0, { type: "saved", plan: p });
    expect(s1.plan).toBe(s1.saved);
  });
});
