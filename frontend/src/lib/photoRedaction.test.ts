import { describe, expect, it } from "vitest";
import { blackenPixels, normalizeRedaction } from "./photoRedaction";

describe("photo redaction", () => {
  it("normalizes reverse pointer drags and clamps them to the photo bounds", () => {
    expect(normalizeRedaction({ x: 1.2, y: 0.9 }, { x: -0.2, y: 0.1 })).toEqual({
      left: 0,
      top: 0.1,
      right: 1,
      bottom: 0.9,
    });
    expect(normalizeRedaction({ x: 0.4, y: 0.4 }, { x: 0.401, y: 0.401 })).toBeNull();
  });

  it("changes only selected pixels to opaque black", () => {
    const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(17);
    blackenPixels(pixels, 4, 2, [{ left: 0.25, top: 0, right: 0.75, bottom: 0.5 }]);
    expect(Array.from(pixels.slice(0, 4))).toEqual([17, 17, 17, 17]);
    expect(Array.from(pixels.slice(4, 8))).toEqual([0, 0, 0, 255]);
    expect(Array.from(pixels.slice(8, 12))).toEqual([0, 0, 0, 255]);
    expect(Array.from(pixels.slice(12, 16))).toEqual([17, 17, 17, 17]);
    expect(Array.from(pixels.slice(16, 20))).toEqual([17, 17, 17, 17]);
  });
});
