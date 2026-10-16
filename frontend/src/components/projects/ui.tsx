import type { ReactNode } from "react";
import { Badge, button, Notice, Panel, type Tone } from "@/components/ui";
import type { Project } from "@/lib/api";
import { projectStage, STAGE_INFO } from "@/lib/projects/status";

// Kept for existing callers; all styling comes from the shared kit in components/ui.
export const primaryBtn = button("primary");
export const secondaryBtn = button("secondary");
export const dangerBtn = button("danger");

const TONE: Record<(typeof STAGE_INFO)[keyof typeof STAGE_INFO]["tone"], Tone> = {
  muted: "neutral",
  amber: "warning",
  accent: "success",
  red: "danger",
};

export function StageBadge({ project }: { project: Project }) {
  const info = STAGE_INFO[projectStage(project)];
  return <Badge tone={TONE[info.tone]} testId="stage-badge">{info.label}</Badge>;
}

export function Card({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <Panel testId={testId} className={className}>{children}</Panel>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <Notice tone="danger">{children}</Notice>;
}
