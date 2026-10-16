import type { MeshData, Scene3D } from "./types";

/**
 * A short hash of a scene's exact geometry. Two scenes have the same fingerprint iff they were
 * built from equivalent plans, which makes determinism ("same plan, same scene") cheap to test
 * and lets the UI expose which model is on screen. Not cryptographic.
 */
export function sceneFingerprint(scene: Scene3D): string {
  // Two independent FNV-1a lanes -> 64 bits of state.
  const lanes = [0x811c9dc5, 0x01000193 ^ 0xdeadbeef];
  const eat = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      for (let l = 0; l < 2; l++) lanes[l] = Math.imul(lanes[l] ^ bytes[i], 0x01000193 + l * 2);
    }
  };
  const text = new TextEncoder();
  const eatString = (s: string) => eat(text.encode(`${s}\u0000`));
  const eatMesh = (m: MeshData) => {
    for (const arr of [m.positions, m.normals, m.indices]) eat(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  };

  for (const o of scene.objects) {
    eatString(`${o.id}|${o.kind}|${o.material}|${o.roomId ?? ""}`);
    eatMesh(o.mesh);
  }
  for (const s of scene.spaces) {
    eatString(`${s.id}|${s.name}|${s.ceilingHeight}`);
    eatMesh(s.volume);
  }
  return lanes.map((l) => (l >>> 0).toString(16).padStart(8, "0")).join("");
}
