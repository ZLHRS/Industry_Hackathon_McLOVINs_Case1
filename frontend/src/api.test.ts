import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, clearMutationKeys } from "./api";
import type { CreateOrder } from "./types";

class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const input: CreateOrder = {
  work_type: "unplanned",
  priority: "high",
  description: "Проверить насос",
  area_id: "area",
  equipment_id: "equipment",
  executor_id: "executor",
  deadline: "2026-10-08T00:00:00Z",
};
const success = () =>
  new Response(JSON.stringify({ order_id: "order", version: 2, status: "issued" }), { status: 200 });
beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearMutationKeys();
});
afterEach(() => {
  clearMutationKeys();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mutation recovery after a committed response is lost", () => {
  for (const kind of ["create", "action", "photo"] as const) {
    it(`preserves the ${kind} key across Api recreation and permits a new confirmed intention`, async () => {
      const received: string[] = [];
      let lost = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          received.push(new Headers(init.headers).get("Idempotency-Key")!);
          if (lost) {
            lost = false;
            throw new TypeError("committed response was lost");
          }
          return success();
        }),
      );
      const send = (api: Api) =>
        kind === "create"
          ? api.create(input)
          : kind === "action"
            ? api.action("order", { action: "comment", expected_version: 1, comment: "test" })
            : api.photo("order", "before", 1, new File(["same-image"], "proof.png", { type: "image/png" }));
      await expect(send(new Api(() => "session-a"))).rejects.toThrow();
      await send(new Api(() => "session-a"));
      expect(received[0]).toBe(received[1]);
      await send(new Api(() => "session-a"));
      expect(received[2]).not.toBe(received[1]);
      expect(sessionStorage.length).toBe(0);
    });
  }

  it("does not reuse a key for a changed body, another resource, or another session", async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push(new Headers(init.headers).get("Idempotency-Key")!);
        throw new TypeError("offline");
      }),
    );
    const api = new Api(() => "alice-token");
    await api.create(input).catch(() => undefined);
    await api.create({ ...input, description: "Другое намерение" }).catch(() => undefined);
    await new Api(() => "bob-token").create(input).catch(() => undefined);
    const command = { action: "accept", expected_version: 1 };
    await api.action("first", command).catch(() => undefined);
    await api.action("second", command).catch(() => undefined);
    expect(new Set(keys).size).toBe(5);
    const stored = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));
    expect(stored.join("")).not.toMatch(/alice-token|bob-token|насос/);
  });

  it("coalesces double submission while the first request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      await gate;
      return success();
    });
    vi.stubGlobal("fetch", fetcher);
    const api = new Api(() => "session");
    const first = api.create(input);
    const second = api.create(input);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("central authentication and private photo boundaries", () => {
  it("invalidates on every authenticated 401, including image downloads", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"detail":"session_revoked"}', { status: 401 })),
    );
    const api = new Api(() => "revoked-token", onUnauthorized);
    const path =
      "/api/v1/work-orders/11111111-1111-1111-1111-111111111111/photos/22222222-2222-2222-2222-222222222222";
    for (const call of [
      () => api.order("order"),
      () => api.action("order", { action: "cancel", expected_version: 1, reason: "test" }),
      () => api.photo("order", "before", 1, new File(["x"], "a.png", { type: "image/png" })),
      () => api.photoBlob(path),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ApiError);
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(4);
    expect(onUnauthorized).toHaveBeenLastCalledWith("revoked-token");
  });

  it("does not treat a failed unauthenticated login as session revocation", async () => {
    const revoke = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(new Api(() => null, revoke).login("worker", "wrong-secret")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it("never sends bearer credentials to an arbitrary photo URL", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(new Api(() => "private-token").photoBlob("https://example.com/leak")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("sends only endpoint and keys from a browser subscription JSON", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "subscription" }), { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  await new Api(() => "session-a").subscribePush({
    endpoint: "https://fcm.googleapis.com/send/example",
    expirationTime: null,
    keys: { p256dh: "receiver", auth: "auth-secret" },
  });
  const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toEqual({
    endpoint: "https://fcm.googleapis.com/send/example",
    keys: { p256dh: "receiver", auth: "auth-secret" },
  });
});

describe("analytics requests preserve privacy boundaries", () => {
  const query = {
    period: "shift" as const,
    shift: "night" as const,
    date: "2026-10-06",
    timezone: "Asia/Qostanay",
    area_id: ["area-id"],
    equipment_id: [],
    executor_id: ["executor-id"],
    brigade_id: [],
  };

  it("uses authenticated query parameters for reports, summaries, and XLSX without token URLs", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.includes("/export")) {
          return new Response(new Blob(["xlsx"]), {
            status: 200,
            headers: { "Content-Disposition": 'attachment; filename="report.xlsx"' },
          });
        }
        return new Response(
          JSON.stringify(
            url.includes("/summary")
              ? { source: "rules", model: null, text: "factual", limitations: [], evidence_ids: [] }
              : {},
          ),
          { status: 200 },
        );
      }),
    );
    const api = new Api(() => "private-token");
    await api.analyticsReport(query);
    await api.analyticsSummary(query);
    const file = await api.analyticsExport(query);
    expect(file.filename).toBe("report.xlsx");
    expect(calls).toHaveLength(3);
    for (const [url, init] of calls) {
      expect(url).toContain("period=shift");
      expect(url).toContain("executor_id=executor-id");
      expect(url).not.toContain("private-token");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer private-token");
    }
  });
});
