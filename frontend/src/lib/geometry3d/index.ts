/**
 * Geometry engine: FloorPlanData -> Scene3D. Independent of React, Three.js and the editor;
 * it depends only on the FloorPlan data types.
 */
export { buildScene, DEFAULT_SCENE_OPTIONS, type SceneOptions } from "./buildScene";
export { sceneFingerprint } from "./fingerprint";
export { meshBounds, meshVolume, triangleCount } from "./meshUtils";
export { summarizeScene, type SceneStats } from "./stats";
export type {
  MaterialKey, MeshData, ObjectKind, Scene3D, SceneBounds, SceneObject, SceneSpace, V3,
} from "./types";
