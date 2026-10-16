/** The step list shown while a plan is uploaded and (optionally) analysed. Pure, for testing. */
import { initialProgress, type StageProgress } from "./stream";

type Status = "pending" | "running" | "done";
export interface StepView {
  key: string;
  label: string;
  status: Status;
  detail?: string;
}

export function buildSteps(
  uploadPhase: "idle" | "uploading" | "processing" | "ready" | "error",
  auto: { phase: "idle" | "running" | "done" | "error"; progress?: StageProgress[] } | null,
): StepView[] {
  const uploaded = uploadPhase === "ready";
  const steps: StepView[] = [
    { key: "upload", label: "Uploading", status: uploadPhase === "uploading" ? "running" : uploadPhase === "processing" || uploaded ? "done" : "pending" },
    { key: "prepare", label: "Validating & preparing image", status: uploadPhase === "processing" ? "running" : uploaded ? "done" : "pending" },
  ];
  if (!auto) return [...steps, { key: "ready", label: "Ready", status: uploaded ? "done" : "pending" }];
  const stages = auto.progress ?? initialProgress();
  steps.push(...stages.map((s) => ({ key: s.id, label: s.label, status: s.status, detail: s.summary || undefined })));
  steps.push({ key: "review", label: "Ready for review", status: auto.phase === "done" ? "done" : "pending" });
  return steps;
}
