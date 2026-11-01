/**
 * Untrusted automatic result -> a proposal the editor can open, plus what the UI says about it.
 *
 * The backend already validates the plan, but the browser treats it like any other API data:
 * the plan goes through the same parser the 3D viewer uses (malformed elements are dropped and
 * listed), and the report is parsed field by field with safe defaults. Never throws.
 */
import type { ElementKind, FloorPlanData, Selection } from "../floorplan/types";
import { parseFloorPlan } from "../viewer/prepareModel";
import type { ElementConfidence, Interpretation, InterpretationReport, ScaleReport } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const unit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const text = (v: unknown, max = 400): string => (typeof v === "string" ? v.slice(0, max) : "");
const KINDS = new Set<ElementKind>(["wall", "room", "door", "window"]);
/** Same threshold as backend REVIEW_BELOW (app/interpretation/opencv/assemble.py). */
export const REVIEW_BELOW = 0.7;

function parseElement(v: unknown): ElementConfidence | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || !KINDS.has(v.kind as ElementKind)) return null;
  const confidence = unit(v.confidence);
  // Recomputed rather than trusted: "needs review" must never hide a low score.
  return { id: v.id, kind: v.kind as ElementKind, confidence, evidence: text(v.evidence, 200), needs_review: confidence < REVIEW_BELOW };
}

function parseScale(v: unknown): ScaleReport | null {
  if (!isObj(v) || typeof v.meters_per_pixel !== "number" || !(v.meters_per_pixel > 0)) return null;
  return {
    meters_per_pixel: v.meters_per_pixel,
    source: v.source === "doors" ? "doors" : "assumed",
    confidence: unit(v.confidence),
    detail: text(v.detail),
  };
}

export function parseReport(raw: unknown): InterpretationReport {
  const r = isObj(raw) ? raw : {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const omitted: InterpretationReport["omitted"] = {};
  if (isObj(r.omitted)) {
    for (const k of ["walls", "rooms", "doors", "windows"] as const) {
      const n = r.omitted[k];
      if (typeof n === "number" && Number.isInteger(n) && n > 0) omitted[k] = n;
    }
  }
  const supported = r.supported === true;
  return {
    interpreter: "opencv",
    pipeline_version: text(r.pipeline_version, 40) || "unknown",
    supported,
    reason: supported ? null : text(r.reason) || "The automatic detector could not interpret this image.",
    overall_confidence: unit(r.overall_confidence),
    stages: list(r.stages)
      .filter(isObj)
      .map((s) => ({ name: text(s.name, 40), label: text(s.label, 80), summary: text(s.summary, 200), ms: typeof s.ms === "number" ? s.ms : 0 })),
    elements: list(r.elements).map(parseElement).filter((e): e is ElementConfidence => e !== null),
    scale: parseScale(r.scale),
    warnings: list(r.warnings).map((w) => text(w)).filter(Boolean).slice(0, 30),
    omitted,
  };
}

export type AcceptedInterpretation =
  | { ok: true; interpretation: Interpretation; notes: string[] }
  | { ok: false; message: string };

/** Validate an automatic result for plan `planId`. */
export function acceptInterpretation(raw: unknown, planId: string): AcceptedInterpretation {
  if (!isObj(raw)) return { ok: false, message: "The automatic result was empty or unreadable." };
  const parsed = parseFloorPlan(raw.plan);
  if (!parsed.ok) return { ok: false, message: `The automatic result could not be read: ${parsed.message}` };
  const plan: FloorPlanData = { ...parsed.plan, provenance: "opencv", scale: { ...parsed.plan.scale, calibrated: false } };
  if (plan.source.floorplan_id !== planId || !(plan.source.width_px > 0) || !(plan.source.height_px > 0)) {
    return { ok: false, message: "The automatic result belongs to a different image." };
  }
  const report = parseReport(raw.report);
  // Confidence entries must describe elements that are actually in the plan.
  const ids = new Set([...plan.walls, ...plan.rooms, ...plan.doors, ...plan.windows].map((e) => e.id));
  report.elements = report.elements.filter((e) => ids.has(e.id));
  return { ok: true, interpretation: { plan, report }, notes: parsed.notes };
}

export function elementCounts(plan: FloorPlanData) {
  return { walls: plan.walls.length, rooms: plan.rooms.length, doors: plan.doors.length, windows: plan.windows.length };
}

export type ConfidenceBand = "high" | "medium" | "low";
export const confidenceBand = (c: number): ConfidenceBand => (c >= 0.85 ? "high" : c >= 0.6 ? "medium" : "low");

export type ResultOutcome = "found" | "partial" | "uncertain" | "unsupported";

/**
 * How to present an automatic result, so a weak one is never announced like a good one:
 * "partial" when walls were found but no closed room (the plan cannot be used as it is),
 * "uncertain" when the detector's own score is low.
 */
export function resultOutcome(interpretation: Interpretation): ResultOutcome {
  const { plan, report } = interpretation;
  if (!report.supported) return "unsupported";
  if (plan.rooms.length === 0) return "partial";
  return confidenceBand(report.overall_confidence) === "low" ? "uncertain" : "found";
}

export interface ReviewItem extends Selection {
  confidence: number;
  evidence: string;
  label: string;
}

/**
 * Detected elements still in the (possibly edited) plan that the detector was unsure about,
 * least confident first. Elements the user deleted drop out; edited ones stay listed.
 */
export function reviewItems(plan: FloorPlanData, report: InterpretationReport | null): ReviewItem[] {
  if (!report) return [];
  const present = new Map<string, string>([
    ...plan.walls.map((w) => [w.id, w.id] as const),
    ...plan.rooms.map((r) => [r.id, r.name] as const),
    ...plan.doors.map((d) => [d.id, d.id] as const),
    ...plan.windows.map((w) => [w.id, w.id] as const),
  ]);
  return report.elements
    .filter((e) => e.needs_review && present.has(e.id))
    .sort((a, b) => a.confidence - b.confidence || a.id.localeCompare(b.id))
    .map((e) => ({ kind: e.kind, id: e.id, confidence: e.confidence, evidence: e.evidence, label: present.get(e.id)! }));
}
