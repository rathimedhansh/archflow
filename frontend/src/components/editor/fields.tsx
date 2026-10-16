"use client";

interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  readOnly?: boolean;
  onCommit?: (value: number) => void;
}

const inputCls =
  "h-8 w-24 rounded-md border border-border-strong bg-surface px-2 text-right text-sm tabular-nums outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15";

/**
 * Commits on blur / Enter rather than per keystroke, so typing "0.9" never passes through
 * an invalid intermediate value and one edit is one undo step. Remounts (via `key`) when the
 * underlying value changes from elsewhere, e.g. undo or dragging.
 */
export function NumberField({ label, value, unit, min, max, step = 0.05, readOnly, onCommit }: NumberFieldProps) {
  const shown = Number(value.toFixed(3));
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          key={shown}
          type="number"
          defaultValue={shown}
          min={min}
          max={max}
          step={step}
          readOnly={readOnly}
          className={`${inputCls} ${readOnly ? "opacity-60" : ""}`}
          onBlur={(e) => {
            if (readOnly) return;
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || e.target.value === "") return void (e.target.value = String(shown));
            const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
            if (clamped !== shown) onCommit?.(clamped);
            else e.target.value = String(shown);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className="w-4 text-xs text-muted">{unit}</span>
      </span>
    </label>
  );
}

export function TextField({ label, value, onCommit, list }: { label: string; value: string; onCommit: (v: string) => void; list?: string }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <input
        key={value}
        defaultValue={value}
        list={list}
        maxLength={60}
        className="h-8 w-40 rounded-md border border-border-strong bg-surface px-2 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (!v) e.target.value = value;
          else if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}
