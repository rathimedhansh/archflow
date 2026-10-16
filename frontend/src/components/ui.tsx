import type { ReactNode } from "react";
import { CheckIcon, InfoIcon, WarningIcon } from "@/components/viewer/icons";

/*
 * The ARCHFLOW interface kit: one set of buttons, badges, notices and fields used by every page (server-safe;
 * the confirmation dialog lives in ConfirmDialog.tsx because it needs client hooks).
 * Class-string helpers (not wrapper components) for buttons and fields, so links, buttons and labels can share them.
 */

// ---- Buttons --------------------------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45";
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-[15px]",
};
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent shadow-[0_1px_0_rgb(0_0_0/0.06)] hover:bg-accent-strong",
  secondary: "border border-border-strong bg-surface text-foreground hover:border-foreground/35 hover:bg-stone/60",
  quiet: "text-foreground/80 hover:bg-stone hover:text-foreground",
  danger: "border border-danger-line bg-surface text-danger hover:bg-danger-bg",
};

export function button(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = "") {
  return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${extra}`;
}

/** Inline text link in running text or under a heading. */
export const textLink =
  "font-medium text-accent underline decoration-accent/30 underline-offset-[3px] transition-colors hover:decoration-accent";

// ---- Badges -------------------------------------------------------------------------------------------

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-border bg-stone/70 text-muted",
  success: "border-success-line bg-success-bg text-success",
  warning: "border-warning-line bg-warning-bg text-warning",
  danger: "border-danger-line bg-danger-bg text-danger",
  accent: "border-accent/25 bg-accent-soft text-accent",
};
const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-muted/60", success: "bg-success", warning: "bg-[#c08a2c]", danger: "bg-danger", accent: "bg-accent",
};

export function Badge({ tone = "neutral", children, testId, className = "" }: { tone?: Tone; children: ReactNode; testId?: string; className?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE_TONE[tone]} ${className}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} />
      {children}
    </span>
  );
}

// ---- Notices ------------------------------------------------------------------------------------------

const NOTICE_TONE = {
  info: "border-border bg-stone/60 text-foreground/85",
  success: "border-success-line bg-success-bg text-success",
  warning: "border-warning-line bg-warning-bg text-warning",
  danger: "border-danger-line bg-danger-bg text-danger",
} as const;
const NOTICE_ICON = { info: InfoIcon, success: CheckIcon, warning: WarningIcon, danger: WarningIcon } as const;

/** A calm inline message. Errors are announced (role="alert"); the rest are notes. */
export function Notice({ tone = "info", title, children, action, className = "", testId }: {
  tone?: keyof typeof NOTICE_TONE; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; testId?: string;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div role={tone === "danger" ? "alert" : "note"} data-testid={testId}
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed ${NOTICE_TONE[tone]} ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  );
}

// ---- Layout -------------------------------------------------------------------------------------------

/** A raised paper surface. Use for genuine groups of content, never nested in another Panel. */
export function Panel({ children, className = "", testId, as: Tag = "section" }: { children: ReactNode; className?: string; testId?: string; as?: "section" | "div" | "aside" }) {
  return <Tag data-testid={testId} className={`rounded-xl border border-border bg-surface p-5 sm:p-6 ${className}`}>{children}</Tag>;
}

export function SectionTitle({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return <h2 id={id} className={`text-[15px] font-semibold text-foreground ${className}`}>{children}</h2>;
}

/** Page title block: optional breadcrumb/eyebrow, serif title, a lead sentence, actions on the right. */
export function PageHeader({ eyebrow, title, lead, actions, titleTestId, badge }: {
  eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode; titleTestId?: string; badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="mb-3">{eyebrow}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 data-testid={titleTestId} className="font-display text-[2rem] font-medium leading-[1.1] tracking-[-0.01em] text-foreground sm:text-[2.5rem]">
            {title}
          </h1>
          {badge}
        </div>
        {lead && <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{lead}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}

/** Centre column width shared by all app pages. */
export const pageWidth = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

// ---- Forms --------------------------------------------------------------------------------------------

export const fieldLabel = "block text-sm font-medium text-foreground";
export const fieldHint = "mt-1 block text-[13px] font-normal text-muted";
export const fieldError = "mt-1.5 block text-[13px] font-medium text-danger";
export const fieldInput =
  "mt-2 block w-full rounded-md border border-border-strong bg-surface px-3 py-2.5 text-[15px] text-foreground placeholder:text-muted/70 transition-[border-color,box-shadow] duration-150 outline-none hover:border-foreground/30 focus:border-accent focus:ring-3 focus:ring-accent/15 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15";

// ---- Loading ------------------------------------------------------------------------------------------

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-stone ${className}`} />;
}

/** A polite loading line with a spinner. */
export function Loading({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <p role="status" data-testid={testId} className={`flex items-center gap-2.5 text-sm text-muted ${className}`}>
      <Spinner /> {children}
    </p>
  );
}
