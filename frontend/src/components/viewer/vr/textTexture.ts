import * as THREE from "three";

/**
 * Text for VR. DOM overlays (the desktop room labels and toolbar) do not exist inside a
 * headset, so text is drawn on a 2D canvas and used as a texture. No font files, no network.
 */
export interface TextLine {
  text: string;
  /** Font size in canvas pixels. */
  size: number;
  color?: string;
  weight?: 400 | 600 | 700;
  /** Extra space above this line, canvas pixels. */
  gap?: number;
}

export interface TextPanel {
  texture: THREE.CanvasTexture;
  /** width / height of the drawn panel. */
  aspect: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function drawTextPanel(
  lines: readonly TextLine[],
  { minWidth = 0, padding = 28, background = "rgba(11,16,24,0.88)", border = "rgba(255,255,255,0.14)", align = "center" }:
    { minWidth?: number; padding?: number; background?: string; border?: string; align?: "center" | "left" } = {},
): TextPanel {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const font = (l: TextLine) => `${l.weight ?? 400} ${l.size}px ${FONT}`;

  let width = minWidth;
  let height = padding * 2;
  for (const l of lines) {
    ctx.font = font(l);
    width = Math.max(width, ctx.measureText(l.text).width + padding * 2);
    height += l.size * 1.25 + (l.gap ?? 0);
  }
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);

  const r = Math.min(24, canvas.height / 3);
  ctx.beginPath();
  ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, r);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = border;
  ctx.stroke();

  let y = padding;
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  const x = align === "center" ? canvas.width / 2 : padding;
  for (const l of lines) {
    y += l.gap ?? 0;
    ctx.font = font(l);
    ctx.fillStyle = l.color ?? "#ffffff";
    ctx.fillText(l.text, x, y + l.size * 0.1);
    y += l.size * 1.25;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: canvas.width / canvas.height };
}
