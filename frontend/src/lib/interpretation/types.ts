/**
 * What the automatic interpreter reports about its own result.
 * Mirrors backend/app/schema/interpretation.py: keep the two in sync.
 *
 * Confidence values are heuristic scores in [0, 1] from the detector's own evidence
 * (e.g. how much of a door arc was found). They are not calibrated probabilities.
 */
import type { ElementKind, FloorPlanData } from "../floorplan/types";

export interface ElementConfidence {
  id: string;
  kind: ElementKind;
  confidence: number;
  evidence: string;
  needs_review: boolean;
}

export interface StageReport {
  name: string;
  label: string;
  summary: string;
  ms: number;
}

export interface ScaleReport {
  meters_per_pixel: number;
  source: "doors" | "assumed";
  confidence: number;
  detail: string;
}

export interface InterpretationReport {
  interpreter: "opencv";
  pipeline_version: string;
  supported: boolean;
  /** Why the drawing is unsupported (when `supported` is false). */
  reason: string | null;
  overall_confidence: number;
  stages: StageReport[];
  elements: ElementConfidence[];
  scale: ScaleReport | null;
  warnings: string[];
  /** Candidates the detector saw but left out because the evidence was too weak. */
  omitted: Partial<Record<"walls" | "rooms" | "doors" | "windows", number>>;
}

export interface Interpretation {
  plan: FloorPlanData;
  report: InterpretationReport;
}

/** The pipeline stages, in order. Keys match backend STAGES in app/interpretation/opencv/pipeline.py. */
export const CV_STAGES = [
  { id: "preprocess", label: "Analyzing floor plan" },
  { id: "walls", label: "Detecting walls" },
  { id: "rooms", label: "Detecting rooms" },
  { id: "openings", label: "Detecting doors & windows" },
  { id: "scale", label: "Estimating scale" },
  { id: "assemble", label: "Building floor plan" },
] as const;

export type CvStageId = (typeof CV_STAGES)[number]["id"];
