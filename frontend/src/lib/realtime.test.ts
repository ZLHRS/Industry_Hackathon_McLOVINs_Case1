import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeConnection } from "./realtime";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.onclose?.({ code: 1000 } as CloseEvent);
  }
}

const original = {
  window: globalThis.window,
  navigator: globalThis.navigator,
  location: globalThis.location,
};

function setup() {
  const listeners = new Map<string, EventListener>();
  Object.defineProperty(globalThis, "window", {
    value: {
      setTimeout,
      clearTimeout,
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "https:", host: "example.test" },
    configurable: true,
  });
  FakeSocket.instances = [];
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "window", { value: original.window, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: original.navigator, configurable: true });
  Object.defineProperty(globalThis, "location", { value: original.location, configurable: true });
});

describe("RealtimeConnection", () => {
  it("authenticates in its first frame without token in URL and refreshes on ready", () => {
    setup();
    const refresh = vi.fn();
    const live = vi.fn();
    const connection = new RealtimeConnection({
      token: "secret",
      onState: live,
      onRefresh: refresh,
      onUnauthorized: vi.fn(),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });

    connection.start();
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe("wss://example.test/api/v1/realtime");
    expect(socket.url).not.toContain("secret");
    socket.onopen?.();
    expect(socket.sent).toEqual([JSON.stringify({ type: "authenticate", token: "secret" })]);
    socket.onmessage?.({ data: JSON.stringify({ type: "ready", revision: 1 }) } as MessageEvent);
    expect(live).toHaveBeenLastCalledWith("live");
    expect(refresh).toHaveBeenCalledWith(1);
    connection.stop();
  });

  it("reconnects once and ignores messages from the stale socket", () => {
    vi.useFakeTimers();
    setup();
    const refresh = vi.fn();
    const connection = new RealtimeConnection({
      token: "t",
      onState: vi.fn(),
      onRefresh: refresh,
      onUnauthorized: vi.fn(),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0,
    });
    connection.start();
    const first = FakeSocket.instances[0];
    first.onclose?.({ code: 1006 } as CloseEvent);
    vi.advanceTimersByTime(800);
    expect(FakeSocket.instances).toHaveLength(2);
    first.onmessage?.({ data: JSON.stringify({ type: "refresh", revision: 9 }) } as MessageEvent);
    expect(refresh).not.toHaveBeenCalled();
    connection.stop();
  });

  it("invalidates an auth close and does not reconnect after cleanup", () => {
    vi.useFakeTimers();
    setup();
    const unauthorized = vi.fn();
    const connection = new RealtimeConnection({
      token: "t",
      onState: vi.fn(),
      onRefresh: vi.fn(),
      onUnauthorized: unauthorized,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0,
    });
    connection.start();
    FakeSocket.instances[0].onclose?.({ code: 4401 } as CloseEvent);
    expect(unauthorized).toHaveBeenCalledOnce();
    connection.stop();
    vi.advanceTimersByTime(30000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
