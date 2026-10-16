import * as THREE from "three";
import type { MaterialKey } from "@/lib/geometry3d";
import type { FloorFinish } from "@/lib/viewer/floorFinish";
import { createFloorTexture } from "./proceduralTextures";

/** All look-and-feel lives here; the geometry engine only names material slots. */
export interface SceneMaterials {
  byKey: Record<MaterialKey, THREE.Material>;
  /** Floors are tinted per room so adjacent spaces read as distinct. */
  floors: THREE.Material[];
  /** The floor of the room the viewer has selected. */
  floorSelected: THREE.Material;
  /** Doors in VR: see-through, so a closed leaf still reads as "you can walk through here". */
  doorOpen: THREE.Material;
  /** Desktop showroom: textured floor finishes, a few tint variants each so neighbours differ. */
  finishes: Record<FloorFinish, THREE.Material[]>;
  /** Desktop showroom: the selected room, stronger so it still stands out in the brighter studio. */
  floorSelectedStudio: THREE.Material;
  /** Desktop showroom: walls with a dark top cap (needs the `color` attribute of toDisplayGeometry). */
  wallCapped: THREE.Material;
  dispose: () => void;
}

const FLOOR_TINTS = ["#cdb894", "#b9c4b0", "#c6b3a6", "#b4bfc9", "#d2c3a1", "#bfb2c4"];
/** Multiplied with each finish texture: subtle, so the finish still reads as the same material. */
const FINISH_TINTS: Record<FloorFinish, string[]> = {
  wood: ["#ffffff", "#efe4d8", "#f7efe6"],
  tile: ["#ffffff", "#eef1f3", "#f5f1ea"],
  neutral: ["#ffffff", "#f0eeeb", "#e9ecee"],
};
const FINISH_ROUGHNESS: Record<FloorFinish, number> = { wood: 0.62, tile: 0.42, neutral: 0.8 };

export function createMaterials(): SceneMaterials {
  const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra });

  const floors = FLOOR_TINTS.map((c) => std(c, { roughness: 0.75 }));
  const byKey: Record<MaterialKey, THREE.Material> = {
    wall: std("#ece8e0"),
    floor: floors[0],
    door: std("#8b5a34", { roughness: 0.6 }),
    windowFrame: std("#f4f4f2", { roughness: 0.5 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: "#a9d8f5", roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false,
    }),
  };
  const floorSelected = std("#d9ecdf", { roughness: 0.7, emissive: "#2dd4bf", emissiveIntensity: 0.28 });
  const doorOpen = std("#b98352", { roughness: 0.6, transparent: true, opacity: 0.3, depthWrite: false });

  const textures: THREE.Texture[] = [];
  const finishes = {} as Record<FloorFinish, THREE.Material[]>;
  for (const finish of Object.keys(FINISH_TINTS) as FloorFinish[]) {
    const map = createFloorTexture(finish);
    if (map) textures.push(map);
    finishes[finish] = FINISH_TINTS[finish].map((tint) =>
      // Without a canvas (never in a browser) fall back to the plain tints.
      map ? std(tint, { map, roughness: FINISH_ROUGHNESS[finish] }) : std(FLOOR_TINTS[0], { roughness: 0.75 }),
    );
  }
  // White base: the vertex colours carry the wall colour (unchanged) and the dark cap.
  const wallCapped = std("#ffffff", { vertexColors: true });
  const floorSelectedStudio = std("#9fdccf", { roughness: 0.7, emissive: "#14b8a6", emissiveIntensity: 0.35 });

  const all = [...Object.values(byKey), ...floors, floorSelected, doorOpen, ...Object.values(finishes).flat(), wallCapped, floorSelectedStudio];
  return {
    byKey,
    floors,
    floorSelected,
    doorOpen,
    finishes,
    floorSelectedStudio,
    wallCapped,
    dispose: () => {
      all.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
