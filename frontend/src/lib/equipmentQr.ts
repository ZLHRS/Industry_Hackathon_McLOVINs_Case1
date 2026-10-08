import qrcode from "qrcode-generator";

const equipmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** QR links carry only a stable identifier; access is checked after authentication. */
export function equipmentLink(origin: string, equipmentId: string): string {
  const base = new URL(origin);
  if (
    !equipmentIdPattern.test(equipmentId) ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  ) {
    throw new Error("Некорректный адрес оборудования");
  }
  return new URL(`/equipment/${equipmentId.toLowerCase()}`, base.origin).href;
}

/** A self-contained black/white SVG with four modules of quiet zone on every side. */
export function qrSvgDataUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.length > 2048) {
    throw new Error("Некорректная ссылка для QR-кода");
  }
  const code = qrcode(0, "M");
  code.addData(url.href, "Byte");
  code.make();
  const count = code.getModuleCount();
  const size = count + 8;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) cells.push(`M${column + 4},${row + 4}h1v1h-1z`);
    }
  }
  // No payload, inventory name or user-supplied markup is interpolated into SVG.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 8}" height="${size * 8}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${cells.join("")}" fill="black"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

export function isLocalQrOrigin(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\./.test(host)
  );
}
