"use client";

import { useRef, useState } from "react";
import { UploadIcon } from "@/components/viewer/icons";
import { ACCEPT_ATTR, MAX_UPLOAD_MB } from "@/lib/upload";

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export default function UploadDropzone({ onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Upload a floor plan image"
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
      className={`drafting-paper group flex cursor-pointer flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed px-6 py-14 text-center transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        dragging ? "border-accent !bg-accent-soft" : "border-border-strong hover:border-accent/60"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        data-testid="floorplan-input"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = ""; // allow re-selecting the same file after an error
        }}
      />
      <span className={`flex h-12 w-12 items-center justify-center rounded-full border bg-surface text-accent transition-colors ${dragging ? "border-accent" : "border-border-strong group-hover:border-accent/50"}`}>
        <UploadIcon className="h-5 w-5" />
      </span>
      <p className="mt-5 font-display text-xl font-medium">{dragging ? "Drop it here" : "Drop the floor plan here"}</p>
      <p className="mt-1.5 text-sm text-muted">
        or <span className="font-medium text-accent underline decoration-accent/30 underline-offset-[3px]">choose a file</span> from your computer
      </p>
      <p className="mt-5 text-xs text-muted">PNG or JPG · up to {MAX_UPLOAD_MB} MB</p>
    </div>
  );
}
