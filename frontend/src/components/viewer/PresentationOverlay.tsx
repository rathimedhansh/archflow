"use client";

import { stopCaption, type TourStop } from "@/lib/viewer/tour";
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from "./icons";

interface Props {
  title?: string;
  subtitle?: string;
  stops: TourStop[];
  index: number;
  playing: boolean;
  calibrated: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGoto: (index: number) => void;
  onToggle: () => void;
  onExit: () => void;
}

/** Charcoal ink over the model: readable on any part of the scene, and clearly "presentation" chrome. */
const glass = "rounded-xl border border-white/10 bg-[#22261f]/88 text-on-accent shadow-soft backdrop-blur-sm";
const iconBtn = "inline-flex h-10 w-10 items-center justify-center rounded-lg text-on-accent/90 transition-colors hover:bg-white/10 hover:text-on-accent focus-visible:outline-2 focus-visible:outline-sage disabled:opacity-30";

/** Presentation mode chrome: a title card and a guided-tour bar. The canvas stays fully interactive. */
export default function PresentationOverlay({ title, subtitle, stops, index, playing, calibrated, onPrev, onNext, onGoto, onToggle, onExit }: Props) {
  const stop = stops[Math.min(index, stops.length - 1)];
  return (
    <>
      {(title || subtitle) && (
        <div className={`${glass} pointer-events-none absolute left-4 top-4 z-30 max-w-[min(28rem,calc(100%-6rem))] px-5 py-4`} data-testid="presentation-title">
          {title && <h2 className="font-display text-xl font-medium leading-tight tracking-[-0.01em] sm:text-[1.6rem]">{title}</h2>}
          {subtitle && <p className="mt-1 text-sm text-on-accent/70">{subtitle}</p>}
        </div>
      )}

      <button type="button" onClick={onExit} aria-label="Exit presentation" title="Exit presentation (Esc)"
        className={`${glass} ${iconBtn} absolute right-4 top-4 z-30`}>
        <CloseIcon />
      </button>

      <div className="absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
        <div className={`${glass} flex max-w-full items-center gap-1 p-1.5`} role="toolbar" aria-label="Presentation tour" data-testid="presentation-bar">
          <button type="button" onClick={onPrev} disabled={index === 0} aria-label="Previous stop" className={iconBtn}>
            <PrevIcon />
          </button>
          <div className="min-w-0 px-3 text-center">
            <div className="truncate text-sm font-semibold" aria-live="polite" data-testid="presentation-caption">{stopCaption(stop, calibrated)}</div>
            <div className="mt-1 flex justify-center gap-1.5" aria-hidden>
              {stops.map((s, i) => (
                <button key={s.kind === "room" ? s.id : "overview"} type="button" tabIndex={-1} onClick={() => onGoto(i)}
                  className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-sage" : "w-1.5 bg-white/30 hover:bg-white/60"}`} />
              ))}
            </div>
          </div>
          <button type="button" onClick={onNext} disabled={index >= stops.length - 1} aria-label="Next stop" className={iconBtn}>
            <NextIcon />
          </button>
          <span className="mx-1 h-6 w-px bg-white/15" />
          <button type="button" onClick={onToggle} disabled={stops.length < 2} aria-label={playing ? "Pause tour" : "Play tour"} aria-pressed={playing} className={iconBtn}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
        </div>
      </div>
    </>
  );
}
