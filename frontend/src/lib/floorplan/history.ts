/** Undo/redo history over immutable FloorPlanData snapshots. */
import type { FloorPlanData } from "./types";

export interface EditorState {
  plan: FloorPlanData;
  /**
   * The last plan known to be persisted; `plan !== saved` means unsaved changes. `null` when the
   * editor opened a plan that is not saved yet (e.g. an automatic detection proposal).
   */
  saved: FloorPlanData | null;
  past: FloorPlanData[];
  future: FloorPlanData[];
}

export type EditorAction =
  /** `checkpoint: false` is for continuous edits (e.g. dragging) that belong to one undo step. */
  | { type: "apply"; plan: FloorPlanData; checkpoint: boolean }
  /** Push the current plan onto the undo stack without changing it (call at drag start). */
  | { type: "checkpoint" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; plan: FloorPlanData };

const MAX_HISTORY = 100;

export const initialEditorState = (plan: FloorPlanData, opts: { unsaved?: boolean } = {}): EditorState => ({
  plan, saved: opts.unsaved ? null : plan, past: [], future: [],
});

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      if (action.plan === state.plan) return state;
      return action.checkpoint
        ? { ...state, plan: action.plan, past: [...state.past, state.plan].slice(-MAX_HISTORY), future: [] }
        : { ...state, plan: action.plan };
    }
    case "checkpoint":
      return { ...state, past: [...state.past, state.plan].slice(-MAX_HISTORY), future: [] };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return { ...state, plan: previous, past: state.past.slice(0, -1), future: [state.plan, ...state.future] };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...state, plan: next, past: [...state.past, state.plan], future: rest };
    }
    case "saved":
      // `plan` is the exact object that was sent to the server. If the user kept editing
      // while the request was in flight, state.plan differs and stays dirty.
      return { ...state, saved: action.plan };
  }
}
