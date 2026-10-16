"use client";

import { useState, type FormEvent } from "react";
import { button, fieldError, fieldHint, fieldInput, fieldLabel, Spinner } from "@/components/ui";
import type { ProjectFields } from "@/lib/api";
import { cleanProjectFields, LIMITS, type FieldErrors } from "@/lib/projects/status";

interface Props {
  initial?: ProjectFields;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (fields: Required<ProjectFields>) => void;
  onCancel?: () => void;
}

/** Name / address / description, checked with the same rules as the backend before sending. */
export default function ProjectForm({ initial, submitLabel, busy = false, onSubmit, onCancel }: Props) {
  const [fields, setFields] = useState<ProjectFields>(initial ?? { name: "", address: "", description: "" });
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { value, errors } = cleanProjectFields(fields);
    setErrors(errors);
    if (Object.keys(errors).length === 0) onSubmit(value);
  };
  const field = (key: keyof ProjectFields) => ({
    value: fields[key] ?? "",
    onChange: (e: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: e.target.value })),
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `${key}-error` : `${key}-hint`,
  });
  const error = (key: keyof ProjectFields) =>
    errors[key] && <span id={`${key}-error`} className={fieldError}>{errors[key]}</span>;

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <label className={fieldLabel}>
        Property name
        <span id="name-hint" className={fieldHint}>How you and your buyers will recognise it.</span>
        <input {...field("name")} className={fieldInput} maxLength={LIMITS.name + 20} placeholder="e.g. Harbour View, Apartment 12" autoFocus />
        {error("name")}
      </label>
      <label className={fieldLabel}>
        Address <span className="font-normal text-muted">· optional</span>
        <span id="address-hint" className={fieldHint}>Shown under the name on the buyer page.</span>
        <input {...field("address")} className={fieldInput} maxLength={LIMITS.address + 20} placeholder="Street, city" />
        {error("address")}
      </label>
      <label className={fieldLabel}>
        Description for buyers <span className="font-normal text-muted">· optional</span>
        <span id="description-hint" className={fieldHint}>A few sentences about the home. You can change it later.</span>
        <textarea {...field("description")} rows={4} className={`${fieldInput} resize-y`} maxLength={LIMITS.description + 20}
          placeholder="Two bedrooms, open-plan kitchen, south-facing balcony…" />
        {error("description")}
      </label>
      <div className="flex flex-wrap gap-3 pt-1">
        <button type="submit" disabled={busy} className={button("primary")}>
          {busy && <Spinner />} {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className={button("quiet")}>Cancel</button>}
      </div>
    </form>
  );
}
