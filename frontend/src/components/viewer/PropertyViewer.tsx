"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useVRSupport } from "@/hooks/useVRSupport";
import { sceneFingerprint, type Scene3D, type SceneSpace, type SceneStats } from "@/lib/geometry3d";
import { DEFAULT_ENVIRONMENT, type EnvironmentSetting } from "@/lib/viewer/environment";
import { DEFAULT_LAYERS, type LayerKey, type Layers } from "@/lib/viewer/layers";
import { initialTour, TOUR_INTERVAL_MS, tourReducer, tourStops, type TourAction, type TourState } from "@/lib/viewer/tour";
import { initialVRStatus, supportMessage, VR_HOW_TO, vrReducer } from "@/lib/vr/support";
import type { CameraApi } from "./CameraRig";
import { CloseIcon, CollapseIcon, ExpandIcon, HelpIcon, InfoIcon, MinusIcon, PanelIcon, PlayIcon, PlusIcon, ResetIcon, TopViewIcon, VRIcon, WarningIcon } from "./icons";
import { button } from "@/components/ui";
import PresentationOverlay from "./PresentationOverlay";
import PropertyPanel from "./PropertyPanel";
import ViewerErrorBoundary from "./ViewerErrorBoundary";
import type { VRApi, VREvent } from "./vr/VRSession";

// WebGL only exists in the browser.
const Viewer3D = dynamic(() => import("./Viewer3D"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted" role="status">
      Preparing 3D viewer…
    </div>
  ),
});

const ZOOM_STEP = 0.75;

/** On-canvas controls: paper chips that sit quietly on the studio backdrop. */
const glass = "rounded-lg border border-border bg-surface/95 text-foreground/80 shadow-sm shadow-[#22261f]/10";
const chipBtn = `${glass} inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent`;

/** Buttons that belong together share one rounded strip (cleaner than a row of separate boxes). */
function ToolGroup({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div role="group" aria-label={label} className={`${glass} flex h-9 items-stretch divide-x divide-border overflow-hidden`}>
      {children}
    </div>
  );
}

function ToolButton({ id, label, shortcut, onClick, children, pressed, text = true, disabled, testId, expanded, controls, title, display }: {
  id?: string; label: string; shortcut?: string; onClick: () => void; children: ReactNode; pressed?: boolean; text?: boolean; disabled?: boolean; testId?: string;
  /** Disclosure buttons (they open a panel rather than toggle a state). */
  expanded?: boolean; controls?: string;
  /** Tooltip, when it should say more than the label. */
  title?: string;
  /** Visible text, when shorter than the accessible label. */
  display?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
      className={`inline-flex min-w-9 items-center justify-center gap-1.5 px-2.5 text-xs font-medium transition-colors hover:bg-stone hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50 ${
        pressed || expanded ? "bg-accent-soft text-accent" : ""
      }`}
    >
      {children}
      {text && <span className="hidden sm:inline">{display ?? label}</span>}
    </button>
  );
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && (t as HTMLInputElement).type !== "checkbox");

interface Props {
  planId: string;
  scene: Scene3D;
  stats: SceneStats;
  notes: string[];
  /** "public" hides everything that leads to editing (buyer share pages). */
  audience?: "developer" | "public";
  /** Shown on the presentation title card. */
  title?: string;
  subtitle?: string;
  /** Open straight into presentation mode (e.g. `?present=1`). */
  startPresenting?: boolean;
}

/** The complete viewing experience: canvas, on-canvas controls, and the property panel. */
export default function PropertyViewer({ planId, scene, stats, notes, audience = "developer", title, subtitle, startPresenting = false }: Props) {
  const shellRef = useRef<HTMLElement>(null);
  const camera = useRef<CameraApi>(null);
  const fullscreen = useFullscreen(shellRef);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  // Illustrative surroundings (never the real site); the 1 m grid shows only without them.
  const [environment, setEnvironment] = useState<EnvironmentSetting>(DEFAULT_ENVIRONMENT);
  const outdoor = environment !== "off";
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  // Starts as a one-line hint chip; the full card opens on request.
  const [helpOpen, setHelpOpen] = useState(false);
  const fingerprint = useMemo(() => sceneFingerprint(scene), [scene]);
  const selectedRoom = scene.spaces.find((s) => s.id === selectedRoomId) ?? null;

  // ---- VR: an optional way to view this same scene in a WebXR headset ----
  const vrSupport = useVRSupport();
  const vrRef = useRef<VRApi>(null);
  const [vrStatus, dispatchVR] = useReducer(vrReducer, initialVRStatus);
  const [vrInfoOpen, setVrInfoOpen] = useState(false);
  const inVR = vrStatus.phase === "active";
  const enterVR = useCallback(() => {
    setVrInfoOpen(false);
    dispatchVR({ type: "request" });
    // The desktop pose saved for after VR must be the finished overview, never a mid-reveal frame.
    camera.current?.finishReveal();
    vrRef.current?.enter(); // synchronously inside the click: the browser requires a user gesture
  }, []);
  const exitVR = useCallback(() => vrRef.current?.exit(), []);
  const onVREvent = useCallback((e: VREvent) => {
    if (e.type === "failed") dispatchVR({ type: "failed", message: e.message });
    else dispatchVR({ type: e.type });
  }, []);

  // ---- presentation mode: fullscreen, no panels, title card and a guided room tour ----
  const [presenting, setPresenting] = useState(startPresenting);
  const stops = useMemo(() => tourStops(scene.spaces), [scene.spaces]);
  const [tour, dispatchTour] = useReducer(
    (s: TourState, a: TourAction) => tourReducer(s, a, stops.length), undefined, () => initialTour(startPresenting && stops.length > 1),
  );
  const { enter: enterFullscreen, exit: exitFullscreen } = fullscreen;
  const startPresentation = useCallback(() => {
    camera.current?.finishReveal();
    setPresenting(true);
    dispatchTour({ type: "goto", index: 0 });
    dispatchTour({ type: "play" });
    void enterFullscreen();
  }, [enterFullscreen]);
  const stopPresentation = useCallback(() => {
    setPresenting(false);
    dispatchTour({ type: "pause" });
    void exitFullscreen();
  }, [exitFullscreen]);
  // Leaving fullscreen (Esc, browser UI) ends the presentation too.
  const wasFullscreen = useRef(false);
  useEffect(() => {
    if (wasFullscreen.current && !fullscreen.active && presenting) {
      setPresenting(false);
      dispatchTour({ type: "pause" });
    }
    wasFullscreen.current = fullscreen.active;
  }, [fullscreen.active, presenting]);
  useEffect(() => {
    // Opened with ?present=1: without a click the browser usually refuses real fullscreen, so this
    // falls back to the window-filling overlay.
    if (startPresenting) void enterFullscreen();
    // Only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each stop is a camera move the viewer already has; the room being shown is highlighted.
  const stop = stops[Math.min(tour.index, stops.length - 1)];
  const tourRoom = presenting && stop.kind === "room" ? (scene.spaces.find((s) => s.id === stop.id) ?? null) : null;
  const highlightedRoomId = presenting ? (tourRoom?.id ?? null) : selectedRoomId;
  useEffect(() => {
    if (!presenting) return;
    if (tourRoom) camera.current?.focusRoom(tourRoom);
    else camera.current?.reset();
  }, [presenting, tourRoom]);
  useEffect(() => {
    if (!presenting || !tour.playing) return;
    const timer = window.setInterval(() => dispatchTour({ type: "tick" }), TOUR_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [presenting, tour.playing, tour.index]);

  const toggleLayer = useCallback((key: LayerKey) => setLayers((l) => ({ ...l, [key]: !l[key] })), []);
  const selectRoom = useCallback((space: SceneSpace | null) => {
    setSelectedRoomId(space?.id ?? null);
    if (space) camera.current?.focusRoom(space);
    else camera.current?.reset();
  }, []);
  const resetView = useCallback(() => {
    setSelectedRoomId(null);
    camera.current?.reset();
  }, []);
  const topView = useCallback(() => camera.current?.view("top"), []);
  const zoom = useCallback((factor: number) => camera.current?.zoom(factor), []);
  const { toggle: toggleFullscreen } = fullscreen;

  // Keyboard shortcuts, ignored while typing or with modifier keys (browser shortcuts win).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a headset is on, the desktop camera is not in charge.
      if (inVR || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      // Esc closes the "View in VR" panel first and returns focus to its button.
      if (vrInfoOpen && !presenting && e.key === "Escape") {
        e.preventDefault();
        setVrInfoOpen(false);
        shellRef.current?.querySelector<HTMLButtonElement>("#vr-info-toggle")?.focus();
        return;
      }
      const actions: Record<string, () => void> = {
        r: resetView, t: topView, f: () => void toggleFullscreen(), l: () => toggleLayer("labels"),
        "+": () => zoom(ZOOM_STEP), "=": () => zoom(ZOOM_STEP), "-": () => zoom(1 / ZOOM_STEP),
        p: () => (presenting ? stopPresentation() : startPresentation()),
      };
      if (presenting) {
        const pause = () => dispatchTour({ type: "pause" });
        Object.assign(actions, {
          arrowright: () => { pause(); dispatchTour({ type: "next" }); },
          pagedown: () => { pause(); dispatchTour({ type: "next" }); },
          arrowleft: () => { pause(); dispatchTour({ type: "prev" }); },
          pageup: () => { pause(); dispatchTour({ type: "prev" }); },
          " ": () => dispatchTour({ type: "toggle" }),
          escape: stopPresentation,
        });
      }
      const action = actions[e.key.toLowerCase()];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inVR, presenting, resetView, startPresentation, stopPresentation, toggleFullscreen, toggleLayer, topView, zoom, vrInfoOpen]);

  const fs = fullscreen.active;
  const showPanel = panelOpen && !presenting;

  return (
    <section
      ref={shellRef}
      data-testid="viewer-shell"
      data-fullscreen={fullscreen.mode}
      aria-label="3D property viewer"
      className={
        fs
          ? "fixed inset-0 z-50 flex flex-col bg-background lg:flex-row"
          : "flex flex-col overflow-hidden rounded-xl border border-border bg-surface lg:h-[76vh] lg:min-h-[540px] lg:flex-row"
      }
    >
      <div className={`relative min-w-0 bg-stone ${fs ? "min-h-0 flex-1" : "h-[62vh] min-h-[380px] lg:h-auto lg:flex-1"}`}>
        <ViewerErrorBoundary>
          <Viewer3D
            scene={scene} fingerprint={fingerprint} layers={layers} selectedRoomId={highlightedRoomId} cameraRef={camera}
            vrRef={vrRef} onVREvent={onVREvent} title={title}
            // Opened straight into a presentation: the tour's first move is the entrance instead.
            reveal={!startPresenting}
            environment={environment}
          />
        </ViewerErrorBoundary>

        {presenting && (
          <PresentationOverlay
            title={title} subtitle={subtitle} stops={stops} index={tour.index} playing={tour.playing} calibrated={stats.calibrated}
            onPrev={() => { dispatchTour({ type: "pause" }); dispatchTour({ type: "prev" }); }}
            onNext={() => { dispatchTour({ type: "pause" }); dispatchTour({ type: "next" }); }}
            onGoto={(i) => { dispatchTour({ type: "pause" }); dispatchTour({ type: "goto", index: i }); }}
            onToggle={() => dispatchTour({ type: "toggle" })}
            onExit={stopPresentation}
          />
        )}

        {/* Camera controls */}
        {!presenting && <>
        {/* Camera on the left, viewing modes on the right. Icon-only on phones, so both fit one row. */}
        <div className="absolute left-3 top-3 z-30 flex max-w-[calc(50%-1rem)] flex-wrap gap-2 sm:max-w-none" role="toolbar" aria-label="Camera">
          <ToolGroup label="Camera">
            <ToolButton label="Reset view" shortcut="R" onClick={resetView} display="Reset">
              <ResetIcon />
            </ToolButton>
            <ToolButton label="Top view" shortcut="T" onClick={topView} display="Top">
              <TopViewIcon />
            </ToolButton>
            <ToolButton label="Zoom in" shortcut="+" onClick={() => zoom(ZOOM_STEP)} text={false}>
              <PlusIcon />
            </ToolButton>
            <ToolButton label="Zoom out" shortcut="−" onClick={() => zoom(1 / ZOOM_STEP)} text={false}>
              <MinusIcon />
            </ToolButton>
          </ToolGroup>
        </div>

        <div className="absolute right-3 top-3 z-30 flex gap-2" role="toolbar" aria-label="View">
          <ToolGroup label="Viewing modes">
            {vrSupport === "supported" ? (
              <ToolButton label={vrStatus.phase === "starting" ? "Starting VR…" : "Enter VR"} onClick={enterVR} disabled={vrStatus.phase !== "idle"} testId="vr-enter">
                <VRIcon />
              </ToolButton>
            ) : (
              // Not a promise: it opens what VR needs and whether this device has it.
              <ToolButton
                id="vr-info-toggle"
                label="View in VR"
                title="View in VR: see what you need"
                onClick={() => setVrInfoOpen((o) => !o)}
                expanded={vrInfoOpen}
                controls="vr-info"
                testId="vr-unavailable"
              >
                <VRIcon />
              </ToolButton>
            )}
            <ToolButton label="Present" shortcut="P" onClick={startPresentation}>
              <PlayIcon />
            </ToolButton>
          </ToolGroup>
          <ToolGroup label="Layout">
            <ToolButton label={panelOpen ? "Hide details" : "Show details"} onClick={() => setPanelOpen((o) => !o)} pressed={panelOpen} text={false}>
              <PanelIcon />
            </ToolButton>
            <ToolButton label={fs ? "Exit fullscreen" : "Fullscreen"} shortcut="F" onClick={() => void toggleFullscreen()} text={false}>
              {fs ? <CollapseIcon /> : <ExpandIcon />}
            </ToolButton>
          </ToolGroup>
        </div>

        {vrInfoOpen && vrSupport !== "supported" && (
          <div
            id="vr-info"
            className={`${glass} absolute right-3 top-14 z-40 w-80 max-w-[calc(100%-1.5rem)] !bg-surface p-3.5 text-xs shadow-lg`}
            data-testid="vr-info"
            data-support={vrSupport}
            role="region"
            aria-label="View in VR"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <VRIcon className="h-4 w-4 text-accent" /> View in VR
              </span>
              <button type="button" onClick={() => setVrInfoOpen(false)} aria-label="Close VR information" className="rounded p-1 text-muted hover:bg-stone hover:text-foreground">
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1 text-muted">Walk through this property at real size with a VR headset.</p>
            <p className="mt-2.5 flex items-start gap-2 rounded-md bg-stone/70 px-2.5 py-2 text-foreground/80" data-testid="vr-status">
              <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-muted" />
              <span>{supportMessage(vrSupport)}</span>
            </p>
            <p className="mt-2.5 font-medium text-foreground">What you need</p>
            <p className="mt-0.5 text-muted">{VR_HOW_TO}</p>
          </div>
        )}

        {vrStatus.error && !inVR && (
          <div role="alert" data-testid="vr-error" className="absolute left-1/2 top-16 z-40 flex w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2 items-start gap-2.5 rounded-lg border border-warning-line bg-warning-bg p-3 text-xs leading-relaxed text-warning shadow-soft">
            <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{vrStatus.error} The 3D view below still works.</span>
            <button type="button" onClick={() => dispatchVR({ type: "dismiss" })} aria-label="Dismiss" className="rounded p-0.5 hover:bg-warning-line/40">
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {selectedRoom && (
          <div className={`${glass} absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-2 py-1 pl-3 pr-1 text-xs`} data-testid="selected-room">
            <span className="text-muted">Viewing</span>
            <span className="font-semibold text-foreground">{selectedRoom.name}</span>
            <button type="button" onClick={resetView} aria-label="Back to whole property" className="rounded p-1 text-muted hover:bg-stone hover:text-foreground">
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* How to navigate: plain language for first-time visitors. */}
        <div className="absolute bottom-3 left-3 z-30 max-w-[calc(100%-1.5rem)]">
          {helpOpen ? (
            <div className={`${glass} w-72 max-w-full !bg-surface p-3 text-xs shadow-lg`} data-testid="viewer-help">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-foreground">How to explore</span>
                <button type="button" onClick={() => setHelpOpen(false)} aria-label="Hide help" className="rounded p-1 text-muted hover:bg-stone hover:text-foreground">
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted">
                <dt className="font-medium text-foreground">Rotate</dt>
                <dd>drag · one finger</dd>
                <dt className="font-medium text-foreground">Zoom</dt>
                <dd>scroll · pinch · + / − buttons</dd>
                <dt className="font-medium text-foreground">Move</dt>
                <dd>right-drag · Shift+drag · two fingers</dd>
                <dt className="font-medium text-foreground">Lost?</dt>
                <dd>press Reset view (R)</dd>
                {vrSupport === "supported" && (
                  <>
                    <dt className="font-medium text-foreground">VR</dt>
                    <dd>Enter VR, then put on the headset</dd>
                  </>
                )}
              </dl>
              <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted">
                Keys: <kbd className="font-mono">R</kbd> reset · <kbd className="font-mono">T</kbd> top · <kbd className="font-mono">L</kbd> labels ·{" "}
                <kbd className="font-mono">F</kbd> fullscreen · <kbd className="font-mono">P</kbd> present
              </p>
            </div>
          ) : (
            // A quiet one-line hint (just "?" on phones); the full card opens on request.
            <button type="button" onClick={() => setHelpOpen(true)} className={`${chipBtn} text-muted`} aria-label="Show navigation help" aria-expanded={false}>
              <HelpIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Drag to rotate · scroll to zoom</span>
            </button>
          )}
        </div>
        </>}

        {inVR && (
          <div data-testid="vr-active" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center">
            <VRIcon className="h-8 w-8 text-accent" />
            <p className="text-sm font-semibold">Viewing in your VR headset</p>
            <p className="max-w-sm text-xs text-muted">The walkthrough continues in the headset. Leave VR there (hold both grip buttons), or here:</p>
            <button type="button" onClick={exitVR} className={button("primary")} data-testid="vr-exit">
              Exit VR
            </button>
          </div>
        )}

        {/* Scale honesty, visible in fullscreen too; so is the note that the surroundings are invented. */}
        <div className={`absolute right-3 z-30 flex flex-col items-end gap-1.5 ${presenting ? "bottom-24 sm:bottom-3" : "bottom-3"}`}>
          {outdoor && !inVR && (
            <span
              className={`${glass} inline-block px-2 py-1 text-[11px] text-muted`}
              data-testid="environment-note"
              title="The road, landscaping and trees are generated for presentation. They do not show the property's real location or site."
            >
              Illustrative surroundings
              <span className="sr-only">: generated for presentation, not the property&apos;s real location or site.</span>
            </span>
          )}
        <div data-testid="scale-badge">
          {/* Compact, but never hidden: the full sentence is in the tooltip and for screen readers. */}
          {stats.calibrated ? (
            <span className={`${glass} inline-block px-2 py-1 text-[11px] text-muted`}>{outdoor ? "True scale" : "True scale · 1 m grid"}</span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-warning-line bg-warning-bg/95 px-2 py-1 text-[11px] font-medium text-warning shadow-sm"
              title="The plan's scale was not calibrated, so sizes are approximate."
            >
              <WarningIcon className="h-3 w-3" />
              <span aria-hidden>Approximate sizes</span>
              <span className="sr-only">Scale not calibrated: sizes are approximate.</span>
            </span>
          )}
        </div>
        </div>
      </div>

      {showPanel && (
        <aside
          aria-label="Property details"
          data-testid="viewer-panel"
          className={`border-border bg-surface lg:w-[330px] lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0 ${
            fs ? "max-h-[42%] overflow-y-auto border-t lg:max-h-none" : "border-t"
          }`}
        >
          <PropertyPanel
            planId={planId}
            audience={audience}
            stats={stats}
            spaces={scene.spaces}
            notes={notes}
            fingerprint={fingerprint}
            layers={layers}
            onToggleLayer={toggleLayer}
            environment={environment}
            onEnvironment={setEnvironment}
            selectedRoomId={selectedRoomId}
            onSelectRoom={selectRoom}
          />
        </aside>
      )}
    </section>
  );
}
