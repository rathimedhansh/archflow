/** Client-side pre-checks. The backend re-validates everything; this only gives fast feedback. */

export const MAX_UPLOAD_MB = 15;
export const ACCEPTED_TYPES = ["image/png", "image/jpeg"] as const;
export const ACCEPT_ATTR = ".png,.jpg,.jpeg,image/png,image/jpeg";

export function validateFloorPlanFile(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  if (file.size === 0) return "That file is empty.";
  const typeOk = (ACCEPTED_TYPES as readonly string[]).includes(file.type);
  const extOk = /\.(png|jpe?g)$/i.test(file.name);
  if (!typeOk || !extOk) return "Please choose a PNG or JPG image.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return `File is too large. The limit is ${MAX_UPLOAD_MB} MB.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
