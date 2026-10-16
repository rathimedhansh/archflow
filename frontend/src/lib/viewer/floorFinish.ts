/**
 * Which floor finish the desktop viewer draws for a room. A purely visual choice made from the
 * room's name (the plan says nothing about finishes); anything not recognised stays neutral.
 */
export type FloorFinish = "wood" | "tile" | "neutral";

// Wet rooms first: "Master bath" is tile even though "master" usually means a bedroom.
const TILE = /\b(bath|bathroom|shower|wc|toilet|lavatory|loo|washroom|restroom|powder|en-?suite|kitchen|kitchenette|utility|laundry|scullery|pantry)/;
const WOOD = /\b(living|lounge|sitting|family|bed|bedroom|master|guest|nursery|kids|dining|study|office|den|library|playroom)/;

export function floorFinishFor(roomName: string | null | undefined): FloorFinish {
  const name = typeof roomName === "string" ? roomName.toLowerCase() : "";
  if (TILE.test(name)) return "tile";
  if (WOOD.test(name)) return "wood";
  return "neutral";
}
