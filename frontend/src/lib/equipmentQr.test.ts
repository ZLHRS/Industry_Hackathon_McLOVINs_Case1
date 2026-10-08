import { expect, it } from "vitest";
import { equipmentLink, isLocalQrOrigin, qrSvgDataUrl } from "./equipmentQr";

const id = "00112233-4455-6677-8899-aabbccddeeff";

it("equipment links contain only origin and canonical equipment id, never current query or fragment", () => {
  expect(equipmentLink("https://technaryad.online/orders?token=private#secret", id.toUpperCase())).toBe(
    `https://technaryad.online/equipment/${id}`,
  );
  expect(equipmentLink("http://192.168.1.20:5173", id)).toBe(`http://192.168.1.20:5173/equipment/${id}`);
  expect(() => equipmentLink("javascript:alert(1)", id)).toThrow();
  expect(() => equipmentLink("https://user:password@example.org", id)).toThrow();
  expect(() => equipmentLink("https://technaryad.online", "../orders?admin=1")).toThrow();
});

it("QR is self-contained SVG without a remote image request or embedded payload markup", () => {
  const source = qrSvgDataUrl(equipmentLink("https://technaryad.online", id));
  expect(source.startsWith("data:image/svg+xml;")).toBe(true);
  const svg = decodeURIComponent(source.slice(source.indexOf(",") + 1));
  expect(svg).toContain('fill="white"');
  expect(svg).toContain('fill="black"');
  expect(svg).not.toContain("technaryad.online");
  expect(svg).not.toContain("<script");
  expect(svg).not.toContain("href=");
  expect(() => qrSvgDataUrl("javascript:alert(1)")).toThrow();
  expect(() => qrSvgDataUrl("https://user:pass@example.org")).toThrow();
  expect(() => qrSvgDataUrl("https://example.org/" + "x".repeat(2048))).toThrow();
});

it("distinguishes laptop-only addresses from LAN and public addresses", () => {
  for (const origin of [
    "http://localhost:5173",
    "http://dev.localhost",
    "http://127.0.0.1",
    "http://127.1.2.3",
    "http://[::1]",
    "http://0.0.0.0",
  ]) {
    expect(isLocalQrOrigin(origin)).toBe(true);
  }
  for (const origin of [
    "https://technaryad.online",
    "http://192.168.1.20:5173",
    "https://foo.trycloudflare.com",
  ]) {
    expect(isLocalQrOrigin(origin)).toBe(false);
  }
});
