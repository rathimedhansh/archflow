"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Fullscreen for one element. Uses the Fullscreen API where available; where it is missing or
 * refused (iPhone Safari, some embedded browsers) it falls back to an in-page overlay that
 * fills the window. Esc leaves either mode.
 */
export type FullscreenMode = "off" | "native" | "fallback";

type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fullscreenElement = () => document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null;

export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<FullscreenMode>("off");

  useEffect(() => {
    const onChange = () => {
      const active = ref.current !== null && fullscreenElement() === ref.current;
      setMode((m) => (active ? "native" : m === "native" ? "off" : m));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [ref]);

  // The fallback overlay: lock page scroll and let Esc close it (native mode gets Esc for free).
  useEffect(() => {
    if (mode !== "fallback") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMode("off");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [mode]);

  const enter = useCallback(async () => {
    const el = ref.current as WebkitElement | null;
    if (!el) return;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else throw new Error("unsupported");
      // Some engines do not fire the change event reliably; confirm directly.
      if (fullscreenElement() === el) setMode("native");
    } catch {
      setMode("fallback");
    }
  }, [ref]);

  const exit = useCallback(async () => {
    if (fullscreenElement()) {
      const doc = document as WebkitDocument;
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await doc.webkitExitFullscreen?.();
      } catch {
        /* already left */
      }
    }
    setMode("off");
  }, []);

  const toggle = useCallback(() => (mode === "off" ? enter() : exit()), [enter, exit, mode]);

  return { mode, active: mode !== "off", enter, exit, toggle };
}
