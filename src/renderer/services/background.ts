/** Backgrounds stay on this device and are normalized before being stored. */
export const MAX_BACKGROUND_LENGTH = 2_000_000;
export function isBackgroundImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BACKGROUND_LENGTH && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export async function prepareBackground(file: File): Promise<string> {
  if (!/^image\/(?:jpeg|png|webp|gif|avif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF, or AVIF image.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("This image could not be opened. Try another picture."); }
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.fillStyle = "#17232d"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let result = canvas.toDataURL("image/jpeg", .82);
    if (result.length > MAX_BACKGROUND_LENGTH) result = canvas.toDataURL("image/jpeg", .6);
    if (!isBackgroundImage(result)) throw new Error("The image is too large to save. Try a smaller picture.");
    return result;
  } finally { bitmap.close(); }
}

export function applyBackground(value: string): void {
  const enabled = isBackgroundImage(value);
  document.body.classList.toggle("custom-background", enabled);
  if (enabled) document.body.style.setProperty("--app-background-image", `url("${value}")`);
  else document.body.style.removeProperty("--app-background-image");
}
