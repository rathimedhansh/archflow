/**
 * Presentation-mode tour (M7): an overview, then each room in plan order. A pure state machine,
 * React- and Three.js-free; the viewer maps each stop to a camera move it already has
 * (reset for the overview, focusRoom for a room).
 */

export interface TourSpace {
  id: string;
  name: string;
  area: number;
}

export type TourStop = { kind: "overview" } | { kind: "room"; id: string; name: string; area: number };

export interface TourState {
  index: number;
  playing: boolean;
}

export type TourAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  /** Autoplay timer fired: advance, and loop back to the overview after the last room. */
  | { type: "tick" };

/** Seconds each stop is shown while playing. */
export const TOUR_INTERVAL_MS = 6000;

export function tourStops(spaces: readonly TourSpace[]): TourStop[] {
  return [{ kind: "overview" }, ...spaces.map((s) => ({ kind: "room" as const, id: s.id, name: s.name, area: s.area }))];
}

export const initialTour = (playing = false): TourState => ({ index: 0, playing });

export function tourReducer(state: TourState, action: TourAction, stopCount: number): TourState {
  const n = Math.max(1, stopCount);
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, Math.trunc(Number.isFinite(i) ? i : 0)));
  switch (action.type) {
    case "next":
      return { ...state, index: clamp(state.index + 1) };
    case "prev":
      return { ...state, index: clamp(state.index - 1) };
    case "goto":
      return { ...state, index: clamp(action.index) };
    case "play":
      return { ...state, playing: n > 1 };
    case "pause":
      return { ...state, playing: false };
    case "toggle":
      return { ...state, playing: !state.playing && n > 1 };
    case "tick":
      return state.playing ? { ...state, index: (clamp(state.index) + 1) % n } : state;
  }
}

/** Caption for a stop, e.g. "Kitchen · 12.4 m²" (areas prefixed with ≈ when the scale is not calibrated). */
export function stopCaption(stop: TourStop, calibrated: boolean): string {
  if (stop.kind === "overview") return "Overview";
  return `${stop.name} · ${calibrated ? "" : "≈ "}${stop.area.toFixed(1)} m²`;
}
