"use client";

import { memo, useEffect, useMemo } from "react";
import type { SceneSpace } from "@/lib/geometry3d";
import { labelAnchor } from "@/lib/viewer/labelAnchor";
import { roomCaption } from "@/lib/vr/navigation";
import { drawTextPanel } from "./textTexture";

/** Label height in metres: world-sized, readable from across a room. */
const LABEL_HEIGHT = 0.26;

/**
 * Room names inside the headset: billboards floating just above head height in each room,
 * at the same interior point the desktop labels use. Hidden by walls like any real object.
 */
function VRRoomLabels({ spaces, calibrated }: { spaces: SceneSpace[]; calibrated: boolean }) {
  const labels = useMemo(
    () => spaces.map((s) => {
      const [name, area] = roomCaption(s, calibrated).split(" · ");
      const panel = drawTextPanel([
        { text: name, size: 44, weight: 600 },
        { text: area, size: 30, color: "#aab4c6", gap: 4 },
      ], { padding: 22, minWidth: 220 });
      const [x, z] = labelAnchor(s.polygon);
      // Above eye level so it never blocks the view, below the top of the walls.
      const y = Math.max(1.9, Math.min(2.15, s.ceilingHeight - 0.3));
      return { id: s.id, panel, position: [x, y, z] as [number, number, number] };
    }),
    [spaces, calibrated],
  );
  useEffect(() => () => labels.forEach((l) => l.panel.texture.dispose()), [labels]);

  return (
    <group name="vr-room-labels">
      {labels.map((l) => (
        <sprite key={l.id} name={`vr-label:${l.id}`} position={l.position} scale={[LABEL_HEIGHT * l.panel.aspect, LABEL_HEIGHT, 1]}>
          <spriteMaterial map={l.panel.texture} transparent depthWrite={false} />
        </sprite>
      ))}
    </group>
  );
}

export default memo(VRRoomLabels);
