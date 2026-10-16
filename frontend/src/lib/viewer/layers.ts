/** What the viewer can show or hide. Pure data: the renderer only reads the booleans. */
export type LayerKey = "walls" | "floors" | "doors" | "windows" | "labels" | "grid";
export type Layers = Readonly<Record<LayerKey, boolean>>;

export const DEFAULT_LAYERS: Layers = {
  walls: true,
  floors: true,
  doors: true,
  windows: true,
  labels: true,
  grid: true,
};

export const LAYER_INFO: readonly { key: LayerKey; label: string; shortcut?: string }[] = [
  { key: "walls", label: "Walls" },
  { key: "floors", label: "Floors" },
  { key: "doors", label: "Doors" },
  { key: "windows", label: "Windows" },
  { key: "labels", label: "Room labels", shortcut: "L" },
  { key: "grid", label: "1 m ground grid" },
];
