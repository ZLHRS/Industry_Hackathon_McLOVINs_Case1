export type LabelLayout = "left" | "right" | "top";
export type LabelPaper = "a4-portrait" | "a4-landscape" | "label";

export type LabelSettings = {
  widthMm: number;
  heightMm: number;
  paddingMm: number;
  qrMm: number;
  layout: LabelLayout;
  fontSizePt: number;
  textAlign: "left" | "center";
  showInventory: boolean;
  showName: boolean;
  showArea: boolean;
  showType: boolean;
  paper: LabelPaper;
  positionXmm: number;
  positionYmm: number;
};

export const labelPresets = [
  { id: "50x30", label: "50 × 30 мм", widthMm: 50, heightMm: 30 },
  { id: "62x40", label: "62 × 40 мм", widthMm: 62, heightMm: 40 },
  { id: "80x50", label: "80 × 50 мм", widthMm: 80, heightMm: 50 },
  { id: "100x70", label: "100 × 70 мм", widthMm: 100, heightMm: 70 },
  { id: "150x100", label: "150 × 100 мм", widthMm: 150, heightMm: 100 },
] as const;

export const defaultLabelSettings: LabelSettings = {
  widthMm: 62,
  heightMm: 40,
  paddingMm: 3,
  qrMm: 28,
  layout: "left",
  fontSizePt: 9,
  textAlign: "left",
  showInventory: true,
  showName: true,
  showArea: true,
  showType: false,
  paper: "a4-portrait",
  positionXmm: 74,
  positionYmm: 128.5,
};

export const labelPapers = [
  { id: "a4-portrait", label: "A4 · 210 × 297 мм", widthMm: 210, heightMm: 297 },
  { id: "a4-landscape", label: "A4 · 297 × 210 мм", widthMm: 297, heightMm: 210 },
  { id: "label", label: "Только наклейка", widthMm: 0, heightMm: 0 },
] as const;

const limits = { fontSizePt: [6, 96] } as const;
const minimumSize = { widthMm: 25, heightMm: 20 } as const;
const labelOnlyMaximumMm = 300;
const safePageMarginMm = 8;

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));
export const roundLabelNumber = (value: number) => Math.round(value * 10) / 10;
const round = roundLabelNumber;

/** Accept decimal commas from mobile keyboards, but never blank, exponent or partial garbage. */
export function parseLabelNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function paperDimensions(settings: Pick<LabelSettings, "paper" | "widthMm" | "heightMm">) {
  if (settings.paper === "label") return { widthMm: settings.widthMm, heightMm: settings.heightMm };
  return settings.paper === "a4-landscape"
    ? { widthMm: 297, heightMm: 210 }
    : { widthMm: 210, heightMm: 297 };
}

/** A4 labels stay within an 8 mm edge margin; label stock can be up to 300 mm per side. */
export function labelSizeLimits(paper: LabelPaper) {
  if (paper === "label") {
    return {
      minWidthMm: minimumSize.widthMm,
      maxWidthMm: labelOnlyMaximumMm,
      minHeightMm: minimumSize.heightMm,
      maxHeightMm: labelOnlyMaximumMm,
    };
  }
  const page = paperDimensions({ paper, widthMm: 0, heightMm: 0 });
  return {
    minWidthMm: minimumSize.widthMm,
    maxWidthMm: page.widthMm - safePageMarginMm * 2,
    minHeightMm: minimumSize.heightMm,
    maxHeightMm: page.heightMm - safePageMarginMm * 2,
  };
}

export function paddingLimits(settings: Pick<LabelSettings, "widthMm" | "heightMm">) {
  const shortestSide = Math.min(settings.widthMm, settings.heightMm);
  return { minMm: 1.5, maxMm: Math.max(1.5, Math.min(20, Math.floor((shortestSide - 13) * 5 + 1e-7) / 10)) };
}

export function fullPrintablePreset(paper: LabelPaper) {
  if (paper === "label") return null;
  const size = labelSizeLimits(paper);
  return {
    id: "full-printable",
    label: `A4 · ${size.maxWidthMm} × ${size.maxHeightMm} мм`,
    widthMm: size.maxWidthMm,
    heightMm: size.maxHeightMm,
  } as const;
}

export function placementLimits(settings: Pick<LabelSettings, "paper" | "widthMm" | "heightMm">) {
  if (settings.paper === "label") return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const paper = paperDimensions(settings);
  const margin = safePageMarginMm;
  return {
    minX: margin,
    minY: margin,
    maxX: round(Math.max(margin, paper.widthMm - margin - settings.widthMm)),
    maxY: round(Math.max(margin, paper.heightMm - margin - settings.heightMm)),
  };
}

export function centeredPlacement(settings: Pick<LabelSettings, "paper" | "widthMm" | "heightMm">) {
  const paper = paperDimensions(settings);
  const limits = placementLimits(settings);
  return {
    positionXmm: round(Math.min(limits.maxX, Math.max(limits.minX, (paper.widthMm - settings.widthMm) / 2))),
    positionYmm: round(
      Math.min(limits.maxY, Math.max(limits.minY, (paper.heightMm - settings.heightMm) / 2)),
    ),
  };
}

/** The SVG carries a quiet zone; retain an additional 3 mm clearance around its geometry. */
export function maxQrMm(
  settings: Pick<LabelSettings, "widthMm" | "heightMm" | "paddingMm" | "layout"> &
    Partial<Pick<LabelSettings, "showInventory" | "showName" | "showArea" | "showType">>,
) {
  const width = Math.max(minimumSize.widthMm, finite(settings.widthMm, defaultLabelSettings.widthMm));
  const height = Math.max(minimumSize.heightMm, finite(settings.heightMm, defaultLabelSettings.heightMm));
  const padding = Math.max(1.5, finite(settings.paddingMm, defaultLabelSettings.paddingMm));
  const clearEdgeMm = 3;
  const gapMm = settings.layout === "top" ? 1.8 : 2.4;
  const contentWidth = width - padding * 2;
  const contentHeight = height - padding * 2;
  const hasText =
    (settings.showInventory ?? true) ||
    (settings.showName ?? true) ||
    (settings.showArea ?? true) ||
    (settings.showType ?? false);
  if (!hasText) return Math.max(10, Math.floor(Math.min(contentWidth, contentHeight) - clearEdgeMm));
  // A fixed text rail keeps the code readable without penalising larger labels by a percentage.
  const reservedTextMm = settings.layout === "top" ? 16 : 14;
  const available =
    settings.layout === "top"
      ? Math.min(contentWidth - clearEdgeMm, contentHeight - reservedTextMm - gapMm - clearEdgeMm)
      : Math.min(contentHeight - clearEdgeMm, contentWidth - reservedTextMm - gapMm - clearEdgeMm);
  return Math.max(10, Math.floor(available));
}

export function sanitizeLabelSettings(input: Partial<LabelSettings>): LabelSettings {
  const layout: LabelLayout = input.layout === "right" || input.layout === "top" ? input.layout : "left";
  const paper: LabelPaper =
    input.paper === "a4-landscape" || input.paper === "label" ? input.paper : "a4-portrait";
  const size = labelSizeLimits(paper);
  const widthMm = round(
    clamp(finite(input.widthMm ?? NaN, defaultLabelSettings.widthMm), [size.minWidthMm, size.maxWidthMm]),
  );
  const heightMm = round(
    clamp(finite(input.heightMm ?? NaN, defaultLabelSettings.heightMm), [size.minHeightMm, size.maxHeightMm]),
  );
  const padding = paddingLimits({ widthMm, heightMm });
  const paddingMm = round(
    clamp(finite(input.paddingMm ?? NaN, defaultLabelSettings.paddingMm), [padding.minMm, padding.maxMm]),
  );
  const maxQr = maxQrMm({ ...input, widthMm, heightMm, paddingMm, layout });
  const desiredQr = finite(input.qrMm ?? NaN, defaultLabelSettings.qrMm);
  const placement = placementLimits({ paper, widthMm, heightMm });
  return {
    widthMm,
    heightMm,
    paddingMm,
    qrMm: round(Math.min(maxQr, Math.max(10, desiredQr))),
    layout,
    fontSizePt: round(
      clamp(finite(input.fontSizePt ?? NaN, defaultLabelSettings.fontSizePt), limits.fontSizePt),
    ),
    textAlign: input.textAlign === "center" ? "center" : "left",
    showInventory: input.showInventory ?? defaultLabelSettings.showInventory,
    showName: input.showName ?? defaultLabelSettings.showName,
    showArea: input.showArea ?? defaultLabelSettings.showArea,
    showType: input.showType ?? defaultLabelSettings.showType,
    paper,
    positionXmm: round(
      clamp(finite(input.positionXmm ?? NaN, defaultLabelSettings.positionXmm), [
        placement.minX,
        placement.maxX,
      ]),
    ),
    positionYmm: round(
      clamp(finite(input.positionYmm ?? NaN, defaultLabelSettings.positionYmm), [
        placement.minY,
        placement.maxY,
      ]),
    ),
  };
}

export function labelPresetId(settings: LabelSettings) {
  const fullPage = fullPrintablePreset(settings.paper);
  if (fullPage && settings.widthMm === fullPage.widthMm && settings.heightMm === fullPage.heightMm)
    return fullPage.id;
  return (
    labelPresets.find(
      (preset) => preset.widthMm === settings.widthMm && preset.heightMm === settings.heightMm,
    )?.id ?? "custom"
  );
}
