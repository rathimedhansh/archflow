/**
 * Pure project logic (M7): where a property project stands, what the developer should do next,
 * form checks that mirror the backend limits, and share-link helpers. React-free and unit tested.
 */
import type { Project, ProjectFields } from "../api";

export type ProjectStage = "new" | "uploaded" | "draft" | "ready" | "shared" | "damaged";

export const STAGE_INFO: Record<ProjectStage, { label: string; tone: "muted" | "amber" | "accent" | "red" }> = {
  new: { label: "No floor plan", tone: "muted" },
  uploaded: { label: "Plan not saved", tone: "amber" },
  draft: { label: "Draft", tone: "amber" },
  ready: { label: "Ready to share", tone: "accent" },
  shared: { label: "Shared", tone: "accent" },
  damaged: { label: "Plan damaged", tone: "red" },
};

/** A plan is presentable when it is saved, not damaged, has something to show, and is calibrated. */
const presentable = (p: Project) =>
  !!p.plan && p.plan.saved && !p.plan.damaged && p.plan.calibrated && p.plan.walls + p.plan.rooms > 0;

export function projectStage(p: Project): ProjectStage {
  if (!p.floorplan || !p.plan) return "new";
  if (p.plan.damaged) return "damaged";
  if (p.share) return "shared";
  if (!p.plan.saved) return "uploaded";
  return presentable(p) ? "ready" : "draft";
}

export interface Step {
  key: "upload" | "review" | "calibrate" | "share";
  label: string;
  done: boolean;
  detail: string;
}

export function projectSteps(p: Project): Step[] {
  const plan = p.plan;
  const saved = !!plan?.saved && !plan.damaged && plan.walls + plan.rooms > 0;
  return [
    {
      key: "upload", label: "Upload the floor plan", done: !!p.floorplan,
      detail: p.floorplan ? p.floorplan.original_filename : "PNG or JPG of the 2D plan.",
    },
    {
      key: "review", label: "Review & save the plan", done: saved,
      detail: plan?.damaged ? "The saved plan is damaged. Re-upload it."
        : saved ? `${plan!.rooms} room${plan!.rooms === 1 ? "" : "s"}, ${plan!.walls} wall${plan!.walls === 1 ? "" : "s"}`
        : plan?.auto_detected ? "Automatic result waiting for review." : "Detect or trace walls and rooms.",
    },
    {
      key: "calibrate", label: "Set the real scale", done: saved && !!plan?.calibrated,
      detail: plan?.calibrated ? "Measurements verified from a known distance." : "Click a known dimension in the editor.",
    },
    {
      key: "share", label: "Share with buyers", done: !!p.share?.up_to_date,
      detail: !p.share ? "Publish a read-only 3D page." : p.share.up_to_date ? "Buyers see the latest saved plan." : "The plan changed since publishing. Update the page.",
    },
  ];
}

export interface NextAction {
  label: string;
  /** Route to open, or an action the project page performs itself. */
  href?: string;
  action?: "upload" | "publish";
}

export function nextAction(p: Project): NextAction {
  const fid = p.floorplan?.id;
  switch (projectStage(p)) {
    case "new":
    case "damaged":
      return { label: "Upload floor plan", action: "upload" };
    case "uploaded":
      return p.plan?.auto_detected
        ? { label: "Review detected plan", href: `/plans/${fid}/edit?source=auto` }
        : { label: "Open editor", href: `/plans/${fid}/edit` };
    case "draft":
      return { label: p.plan?.calibrated ? "Continue editing" : "Set the scale", href: `/plans/${fid}/edit` };
    case "ready":
      return { label: "Publish buyer page", action: "publish" };
    case "shared":
      return p.share!.up_to_date ? { label: "Open buyer page", href: p.share!.url_path } : { label: "Update buyer page", action: "publish" };
  }
}

// ---- forms --------------------------------------------------------------------------------------

export const LIMITS = { name: 120, address: 200, description: 2000 } as const;

export type FieldErrors = Partial<Record<keyof ProjectFields, string>>;

/** Same rules as the backend (whitespace collapsed, name required, max lengths). */
export function cleanProjectFields(fields: ProjectFields): { value: Required<ProjectFields>; errors: FieldErrors } {
  const oneLine = (s: string | undefined) => (s ?? "").split(/\s+/).filter(Boolean).join(" ");
  const value = { name: oneLine(fields.name), address: oneLine(fields.address), description: (fields.description ?? "").trim() };
  const errors: FieldErrors = {};
  if (!value.name) errors.name = "Give the property a name.";
  for (const key of ["name", "address", "description"] as const) {
    if (value[key].length > LIMITS[key]) errors[key] = `At most ${LIMITS[key]} characters.`;
  }
  return { value, errors };
}

// ---- sharing ------------------------------------------------------------------------------------

/** Absolute buyer link for a share path, on the site the developer is using. */
export function shareUrl(origin: string, urlPath: string): string {
  return `${origin.replace(/\/+$/, "")}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a date. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const d = Math.max(0, now - t);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} day${d < 2 * DAY ? "" : "s"} ago`;
  return new Date(t).toISOString().slice(0, 10);
}
