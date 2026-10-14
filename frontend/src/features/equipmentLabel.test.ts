import { describe, expect, it } from "vitest";
import {
  centeredPlacement,
  defaultLabelSettings,
  fullPrintablePreset,
  labelSizeLimits,
  maxQrMm,
  paddingLimits,
  parseLabelNumber,
  placementLimits,
  sanitizeLabelSettings,
} from "./equipmentLabel";

describe("equipment label sizing", () => {
  it("falls back from invalid dimensions and keeps a printable QR size", () => {
    const settings = sanitizeLabelSettings({ widthMm: Number.NaN, heightMm: Infinity, qrMm: -5 });
    expect(settings.widthMm).toBe(defaultLabelSettings.widthMm);
    expect(settings.heightMm).toBe(defaultLabelSettings.heightMm);
    expect(settings.qrMm).toBe(10);
  });

  it("caps QR size inside its padded label and reserves text room beside it", () => {
    const compact = sanitizeLabelSettings({
      widthMm: 50,
      heightMm: 30,
      paddingMm: 3,
      layout: "left",
      qrMm: 80,
    });
    expect(compact.qrMm).toBe(maxQrMm(compact));
    expect(compact.qrMm).toBeLessThan(30);
  });

  it("recalculates the QR allowance for the selected layout", () => {
    expect(maxQrMm({ widthMm: 30, heightMm: 80, paddingMm: 3, layout: "top" })).toBeGreaterThan(
      maxQrMm({ widthMm: 30, heightMm: 80, paddingMm: 3, layout: "left" }),
    );
  });

  it("keeps A4 placement inside safe page margins and centers on request", () => {
    const settings = sanitizeLabelSettings({
      paper: "a4-portrait",
      widthMm: 80,
      heightMm: 50,
      positionXmm: 999,
      positionYmm: -4,
    });
    expect(settings.positionXmm).toBe(122);
    expect(settings.positionYmm).toBe(8);
    expect(centeredPlacement(settings)).toEqual({ positionXmm: 65, positionYmm: 123.5 });
    expect(placementLimits({ ...settings, paper: "label" })).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("uses the selected landscape page bounds for physical placement", () => {
    const settings = sanitizeLabelSettings({
      paper: "a4-landscape",
      widthMm: 120,
      heightMm: 80,
      positionXmm: 400,
      positionYmm: 400,
    });
    expect(placementLimits(settings)).toEqual({ minX: 8, minY: 8, maxX: 169, maxY: 122 });
    expect(settings.positionXmm).toBe(169);
    expect(settings.positionYmm).toBe(122);
  });

  it("uses the 8 mm A4 printable rectangle and permits larger label stock", () => {
    expect(labelSizeLimits("a4-portrait")).toMatchObject({ maxWidthMm: 194, maxHeightMm: 281 });
    expect(labelSizeLimits("a4-landscape")).toMatchObject({ maxWidthMm: 281, maxHeightMm: 194 });
    expect(labelSizeLimits("label")).toMatchObject({ maxWidthMm: 300, maxHeightMm: 300 });
    expect(fullPrintablePreset("a4-portrait")).toMatchObject({ widthMm: 194, heightMm: 281 });
  });

  it("clamps a paper switch to the selected printable area while retaining large label-only dimensions", () => {
    const labelOnly = sanitizeLabelSettings({
      paper: "label",
      widthMm: 420,
      heightMm: 420,
      paddingMm: 20,
      fontSizePt: 120,
    });
    expect(labelOnly).toMatchObject({ widthMm: 300, heightMm: 300, paddingMm: 20, fontSizePt: 96 });
    const portrait = sanitizeLabelSettings({ ...labelOnly, paper: "a4-portrait" });
    expect(portrait).toMatchObject({ widthMm: 194, heightMm: 281, positionXmm: 8, positionYmm: 8 });
  });

  it("allows a large QR from its actual label geometry and retains its clearance", () => {
    const large = sanitizeLabelSettings({
      paper: "a4-portrait",
      widthMm: 150,
      heightMm: 100,
      paddingMm: 12,
      layout: "left",
      qrMm: 200,
    });
    expect(paddingLimits(large).maxMm).toBe(20);
    expect(large.qrMm).toBe(maxQrMm(large));
    expect(large.qrMm).toBeGreaterThan(60);
    expect(large.qrMm + large.paddingMm * 2 + 3).toBeLessThanOrEqual(large.heightMm);
  });
});

describe("decimal label inputs", () => {
  it.each([
    ["128.3", 128.3],
    ["128,3", 128.3],
    [" 80,25 ", 80.25],
    [".5", 0.5],
    ["8.", 8],
  ])("parses %s", (input, expected) => {
    expect(parseLabelNumber(input)).toBe(expected);
  });
  it.each(["", " ", "1,2,3", "1e2", "Infinity", "NaN", "2mm", ".", "--2"])("rejects %s", (input) => {
    expect(parseLabelNumber(input)).toBeNull();
  });
  it("keeps computed bounds, padding and placement on the same decimal grid", () => {
    for (const size of [25.1, 40.3, 62.9, 193.7]) {
      const settings = sanitizeLabelSettings({
        widthMm: size,
        heightMm: size,
        paddingMm: 999,
        positionXmm: 999,
        positionYmm: 999,
      });
      const padding = paddingLimits(settings);
      const placement = placementLimits(settings);
      expect(settings.paddingMm).toBeLessThanOrEqual(padding.maxMm);
      expect(settings.positionXmm).toBeLessThanOrEqual(placement.maxX);
      expect(settings.positionYmm).toBeLessThanOrEqual(placement.maxY);
      expect(placement.maxX).toBe(Number(placement.maxX.toFixed(1)));
      expect(sanitizeLabelSettings(settings)).toEqual(settings);
    }
  });
  it("retains decimal positions produced by centering or dragging", () => {
    const settings = sanitizeLabelSettings({
      widthMm: 80.3,
      heightMm: 50.3,
      positionXmm: 23.7,
      positionYmm: 128.3,
      paddingMm: 3.2,
    });
    expect(settings).toMatchObject({ positionXmm: 23.7, positionYmm: 128.3, paddingMm: 3.2 });
    expect(centeredPlacement(settings)).toEqual({ positionXmm: 64.9, positionYmm: 123.4 });
  });
  it("uses the full inner square when all label text is hidden", () => {
    const settings = sanitizeLabelSettings({
      widthMm: 50,
      heightMm: 50,
      layout: "top",
      showInventory: false,
      showName: false,
      showArea: false,
      showType: false,
      qrMm: 100,
    });
    expect(settings.qrMm).toBe(41);
  });
});
