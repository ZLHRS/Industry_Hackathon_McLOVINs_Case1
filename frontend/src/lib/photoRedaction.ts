export type RedactionRect = { left: number; top: number; right: number; bottom: number };

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Produces a bounded normalized rectangle for both pointer and numeric entry. */
export function normalizeRedaction(
  first: { x: number; y: number },
  second: { x: number; y: number },
): RedactionRect | null {
  const left = clamp(Math.min(first.x, second.x));
  const right = clamp(Math.max(first.x, second.x));
  const top = clamp(Math.min(first.y, second.y));
  const bottom = clamp(Math.max(first.y, second.y));
  return right - left >= 0.005 && bottom - top >= 0.005 ? { left, top, right, bottom } : null;
}

/** Paints opaque black pixels into an RGBA frame. It mutates only the selected regions. */
export function blackenPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  redactions: RedactionRect[],
) {
  for (const redaction of redactions) {
    const left = Math.max(0, Math.min(width, Math.floor(redaction.left * width)));
    const right = Math.max(left, Math.min(width, Math.ceil(redaction.right * width)));
    const top = Math.max(0, Math.min(height, Math.floor(redaction.top * height)));
    const bottom = Math.max(top, Math.min(height, Math.ceil(redaction.bottom * height)));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = 0;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
        pixels[index + 3] = 255;
      }
    }
  }
}
