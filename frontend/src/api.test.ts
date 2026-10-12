import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, clearMutationKeys } from "./api";
import type { CreateOrder, PreventionSource, SimilarRepairsRequest } from "./types";

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

function jpegWithExifDate(date: string, timezone: string) {
  const dateBytes = new TextEncoder().encode(`${date}\0`);
  const timezoneBytes = new TextEncoder().encode(`${timezone}\0`);
  const tiff = new Uint8Array(56 + dateBytes.length + timezoneBytes.length);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint16(26, 2, true);
  view.setUint16(28, 0x9003, true);
  view.setUint16(30, 2, true);
  view.setUint32(32, dateBytes.length, true);
  view.setUint32(36, 56, true);
  view.setUint16(40, 0x9011, true);
  view.setUint16(42, 2, true);
  view.setUint32(44, timezoneBytes.length, true);
  view.setUint32(48, 56 + dateBytes.length, true);
  tiff.set(dateBytes, 56);
  tiff.set(timezoneBytes, 56 + dateBytes.length);
  const app1Length = tiff.length + 8;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    app1Length >> 8,
    app1Length & 0xff,
    0x45,
    0x78,
    0x69,
    0x66,
    0,
    0,
    ...tiff,
  ]);
}
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

describe("work order listing", () => {
  it("serializes history pagination, sorting, and executor master scope in one request", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, counts: {} })));
    vi.stubGlobal("fetch", fetcher);
    await new Api(() => "session").orders({
      status: ["closed", "cancelled"],
      executor_id: "executor",
      master_id: "master",
      sort: "deadline",
      offset: 24,
      limit: 24,
    });
    const [url] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const query = new URL(url, "https://technaryad.invalid").searchParams;
    expect(query.getAll("status")).toEqual(["closed", "cancelled"]);
    expect(query.get("master_id")).toBe("master");
    expect(query.get("sort")).toBe("deadline");
    expect(query.get("offset")).toBe("24");
    expect(query.get("limit")).toBe("24");
  });
});

describe("preventive draft", () => {
  it("posts the frozen report source without turning it into an order", async () => {
    const source: PreventionSource = {
      query: {
        period: "custom",
        from: "2026-10-01T00:00:00+05:00",
        to: "2026-10-02T00:00:00+05:00",
        timezone: "Asia/Qostanay",
        area_ids: ["area"],
        equipment_ids: ["equipment"],
        executor_ids: [],
        brigade_ids: [],
      },
      family: "recurring_fault",
      equipment_id: "equipment",
      order_ids: ["order-a", "order-b"],
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            area_id: "area",
            equipment_id: "equipment",
            description: "Плановая проверка",
            fault_code_id: null,
            title: "Повторяемость",
            source,
            evidence_orders: [],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);

    await new Api(() => "session").preventiveDraft(source);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/analytics/preventive-draft");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(source);
  });
});

describe("fault reports", () => {
  it("creates a report through the idempotent mutation path", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "report",
            equipment_id: "equipment",
            equipment_inventory_number: "P-1",
            equipment_name: "Насос",
            area_id: "area",
            area_name: "Участок",
            reporter_id: "executor",
            reporter_name: "Исполнитель",
            master_id: "master",
            master_name: "Мастер",
            description: "Течь у уплотнения",
            status: "open",
            version: 1,
            created_at: "2026-10-12T00:00:00Z",
            resolved_at: null,
            dismissal_reason: null,
            work_order_number: null,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);

    await new Api(() => "session").createFaultReport({
      equipment_id: "equipment",
      master_id: "master",
      description: "Течь у уплотнения",
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/fault-reports");
    expect(JSON.parse(String(init.body))).toEqual({
      equipment_id: "equipment",
      master_id: "master",
      description: "Течь у уплотнения",
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
  });
});

describe("similar repairs", () => {
  it("sends the current issue context only when the caller requests it", async () => {
    const input: SimilarRepairsRequest = {
      area_id: "area",
      equipment_id: "equipment",
      description: "Проверить уплотнение насоса",
      fault_code_id: null,
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            history_days: 365,
            truncated: false,
            measured_at: "2026-10-11T08:00:00Z",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);

    await new Api(() => "session").similarRepairs(input);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/work-orders/similar-repairs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
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

  it("keeps a photo upload available when a JPEG contains truncated EXIF metadata", async () => {
    const fetcher = vi.fn(async () => success());
    vi.stubGlobal("fetch", fetcher);
    const corruptedExif = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])],
      "camera.jpg",
      { type: "image/jpeg" },
    );
    await new Api(() => "session").photo("order", "before", 1, corruptedExif);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "/api/v1/work-orders/order/photos?kind=before&expected_version=1&ai_share_allowed=false",
    );
    expect(init.body).toBe(corruptedExif);
  });

  it("keeps only a valid EXIF timestamp with a declared offset", async () => {
    const fetcher = vi.fn(async () => success());
    vi.stubGlobal("fetch", fetcher);
    const valid = new File([jpegWithExifDate("2026:10:07 14:05:06", "+06:00")], "valid.jpg", {
      type: "image/jpeg",
    });
    const malformed = new File([jpegWithExifDate("2026:99:07 14:05:06", "+99:99")], "bad.jpg", {
      type: "image/jpeg",
    });
    const api = new Api(() => "session");
    await api.photo("valid", "before", 1, valid);
    await api.photo("malformed", "before", 1, malformed);
    const [validUrl] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const [malformedUrl] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(validUrl, "https://example.test").searchParams.get("captured_at")).toBe(
      "2026-10-07T14:05:06+06:00",
    );
    expect(new URL(malformedUrl, "https://example.test").searchParams.has("captured_at")).toBe(false);
  });

  it("keeps external AI image sharing opt-in for each upload", async () => {
    const fetcher = vi.fn(async () => success());
    vi.stubGlobal("fetch", fetcher);
    const photo = new File([new Uint8Array([1, 2, 3])], "checked.jpg", { type: "image/jpeg" });
    await new Api(() => "session").photo("order", "after", 3, photo, true);
    const [url] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url, "https://example.test").searchParams.get("ai_share_allowed")).toBe("true");
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

  it("uses the applied analytics filters and bounded pagination for preventive outcomes", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ items: [], total: 0, offset: 5, limit: 5 })),
    );
    vi.stubGlobal("fetch", fetcher);

    await new Api(() => "private-token").preventionOutcomes(query, 5, 5);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URL(url, "https://technaryad.invalid").searchParams;
    expect(new URL(url, "https://technaryad.invalid").pathname).toBe("/api/v1/analytics/prevention-outcomes");
    expect(params.get("period")).toBe("shift");
    expect(params.getAll("executor_id")).toEqual(["executor-id"]);
    expect(params.get("offset")).toBe("5");
    expect(params.get("limit")).toBe("5");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer private-token");
  });
});

describe("catalog import", () => {
  it("sends XLSX bytes and reuses the validated fingerprint only for the apply request", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetcher);
    const bytes = new Uint8Array([80, 75, 3, 4]).buffer;
    const api = new Api(() => "admin-token");

    await api.catalogImportPreview(bytes);
    await api.catalogImportApply(bytes, "validated-fingerprint");

    const [previewUrl, previewInit] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const [applyUrl, applyInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(previewUrl).toBe("/api/v1/catalog/import/preview");
    expect(applyUrl).toBe("/api/v1/catalog/import/apply");
    expect(previewInit.body).toBe(bytes);
    expect(applyInit.body).toBe(bytes);
    expect(new Headers(previewInit.headers).get("Content-Type")).toContain("spreadsheetml.sheet");
    expect(new Headers(previewInit.headers).get("X-Import-Fingerprint")).toBeNull();
    expect(new Headers(applyInit.headers).get("X-Import-Fingerprint")).toBe("validated-fingerprint");
    expect(new Headers(applyInit.headers).get("Authorization")).toBe("Bearer admin-token");
  });
});

describe("master assistant", () => {
  it("sends an explicit question, topic, scope, and selected language", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answer: "data" })));
    vi.stubGlobal("fetch", fetcher);

    await new Api(() => "master-token").masterAssistant({
      question: "Что требует внимания?",
      topic: "attention",
      area_id: "area-id",
      equipment_id: "equipment-id",
      language: "ru",
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/master-assistant/answer");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      question: "Что требует внимания?",
      topic: "attention",
      area_id: "area-id",
      equipment_id: "equipment-id",
      language: "ru",
    });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer master-token");
  });
});

describe("employee administration", () => {
  it("sends secrets only in authenticated request bodies without mutation storage or retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "employee" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new Api(() => "admin-token");
    await api.updateEmployeeAccess("employee", { secret: "test-new-password" });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/catalog/employees/employee/access");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ secret: "test-new-password" });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(sessionStorage.length).toBe(0);
    fetcher.mockRejectedValue(new TypeError("offline"));
    await expect(api.updateEmployeeAccess("employee", { is_active: false })).rejects.toThrow("offline");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sessionStorage.length).toBe(0);
  });
  it("loads employees beyond the first page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: String(i) })))),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "last" }])));
    vi.stubGlobal("fetch", fetcher);
    const employees = await new Api(() => "admin-token").employees();
    expect(employees).toHaveLength(201);
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/catalog/employees?limit=200&offset=200");
  });
});
