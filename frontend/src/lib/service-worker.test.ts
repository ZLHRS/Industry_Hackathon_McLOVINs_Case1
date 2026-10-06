import workerSource from "../../service-worker.js?raw";
import { describe, expect, it, vi } from "vitest";

const origin = "https://app.example.test";
const id = "12345678-1234-1234-1234-123456789abc";
const path = "/?notification=" + id;
const destination = origin + path;
const source = workerSource.replace("__ASSETS__", "[]");

function client(url = origin + "/", frameType = "top-level") {
  const value = {
    url,
    frameType,
    focus: vi.fn<() => Promise<unknown>>(),
    navigate: vi.fn<(url: string) => Promise<unknown>>(),
  };
  value.focus.mockResolvedValue(value);
  value.navigate.mockResolvedValue(value);
  return value;
}

function setup(windows: ReturnType<typeof client>[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened = client();
  const clients = {
    matchAll: vi.fn().mockResolvedValue(windows),
    openWindow: vi.fn().mockResolvedValue(opened),
  };
  const showNotification = vi.fn().mockResolvedValue(undefined);
  // Execute the actual classic worker source with browser interfaces under test.
  new Function("self", "clients", "URL", source)(
    {
      location: { origin },
      registration: { showNotification },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
    clients,
    URL,
  );
  async function click(url: unknown = path) {
    const close = vi.fn();
    const waitUntil = vi.fn();
    listeners.get("notificationclick")!({ notification: { data: { url }, close }, waitUntil });
    expect(close).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
  }
  return { clients, opened, click, listeners, showNotification };
}

describe("notification click in the shipped service worker", () => {
  it("focuses a suspended app before navigation and uses the focused client", async () => {
    const old = client();
    const focused = client();
    old.focus.mockResolvedValue(focused);
    const app = setup([old]);
    await app.click();
    expect(old.focus).toHaveBeenCalledOnce();
    expect(focused.navigate).toHaveBeenCalledWith(destination);
    expect(old.navigate).not.toHaveBeenCalled();
    expect(app.clients.openWindow).not.toHaveBeenCalled();
  });
  it.each(["focus", "navigate"] as const)("opens a window when %s rejects", async (method) => {
    const existing = client();
    existing[method].mockRejectedValue(new Error("inactive client"));
    const app = setup([existing]);
    await app.click();
    expect(app.clients.openWindow).toHaveBeenCalledWith(destination);
    expect(app.opened.focus).toHaveBeenCalledOnce();
  });
  it("opens a new window when navigation returns null", async () => {
    const existing = client();
    existing.navigate.mockResolvedValue(null);
    const app = setup([existing]);
    await app.click();
    expect(app.clients.openWindow).toHaveBeenCalledWith(destination);
  });
  it("opens a closed app and keeps the notification ID for login/deep linking", async () => {
    const app = setup();
    await app.click();
    expect(app.clients.openWindow).toHaveBeenCalledWith(destination);
  });
  it("does not navigate unrelated origins or embedded frames", async () => {
    const other = client("https://other.example/");
    const frame = client(origin + "/", "nested");
    const app = setup([other, frame]);
    await app.click();
    expect(other.focus).not.toHaveBeenCalled();
    expect(frame.focus).not.toHaveBeenCalled();
    expect(app.clients.openWindow).toHaveBeenCalledWith(destination);
  });
  it("falls back when window enumeration fails", async () => {
    const app = setup();
    app.clients.matchAll.mockRejectedValue(new Error("unavailable"));
    await app.click();
    expect(app.clients.openWindow).toHaveBeenCalledWith(destination);
  });
  it.each([null, "https://evil.test/", "//evil.test/", "/?notification=invalid"])(
    "keeps an invalid destination on the application origin: %s",
    async (url) => {
      const app = setup();
      await app.click(url);
      expect(app.clients.openWindow).toHaveBeenCalledWith(origin + "/");
    },
  );
  it("tolerates null openWindow and a redundant focus rejection", async () => {
    const app = setup();
    app.clients.openWindow.mockResolvedValueOnce(null);
    await expect(app.click()).resolves.toBeUndefined();
    app.opened.focus.mockRejectedValue(new Error("already opened"));
    await expect(app.click()).resolves.toBeUndefined();
  });
  it("includes local icon/badge and preserves notification identity", async () => {
    const app = setup();
    const waitUntil = vi.fn();
    app.listeners.get("push")!({
      data: { json: () => ({ notification_id: id, url: path, urgent: true }) },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(app.showNotification).toHaveBeenCalledWith(
      "НАРЯДAI",
      expect.objectContaining({
        icon: "/icon-192.png",
        badge: "/notification-badge.png",
        tag: id,
        data: { url: path },
        requireInteraction: true,
      }),
    );
  });
});
