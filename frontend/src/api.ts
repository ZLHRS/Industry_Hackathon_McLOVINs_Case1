import type {
  ActionRequest,
  Catalog,
  CreateOrder,
  Employee,
  EventPage,
  Mutation,
  OrderDetail,
  OrderPage,
  Token,
  User,
  Workload,
  NotificationPage,
  NotificationItem,
  PushConfig,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}
const prefix = "/api/v1";
const keyPrefix = "naryadai.mutation.";
const pendingKeys = new Map<string, string>();

/** Only request fingerprints and UUIDs are stored here, never payloads or credentials. */
export function clearMutationKeys(): void {
  pendingKeys.clear();
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(keyPrefix)) sessionStorage.removeItem(key);
    }
  } catch {
    /* A disabled browser store still permits memory-only online requests. */
  }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
async function digest(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function mutationKey(fingerprint: string): string {
  let key = pendingKeys.get(fingerprint);
  try {
    key ??= sessionStorage.getItem(fingerprint) ?? undefined;
  } catch {
    /* memory fallback */
  }
  key ??= crypto.randomUUID();
  pendingKeys.set(fingerprint, key);
  try {
    sessionStorage.setItem(fingerprint, key);
  } catch {
    /* memory fallback */
  }
  return key;
}
function forgetMutation(fingerprint: string): void {
  pendingKeys.delete(fingerprint);
  try {
    sessionStorage.removeItem(fingerprint);
  } catch {
    /* memory fallback */
  }
}

export class Api {
  private inFlight = new Map<string, Promise<Mutation>>();
  constructor(
    private getToken: () => string | null,
    private onUnauthorized?: (invalidToken: string) => void | Promise<void>,
  ) {}

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.getToken();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${prefix}${path}`, { ...init, headers, cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401 && token) await this.onUnauthorized?.(token);
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        /* The HTTP status remains useful for a non-JSON proxy error. */
      }
      throw new ApiError(response.status, detail);
    }
    return response;
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init);
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }

  private async mutate(
    path: string,
    init: RequestInit,
    identity: string,
    providedKey?: string,
  ): Promise<Mutation> {
    const fingerprint = keyPrefix + (await digest(`${this.getToken() ?? ""}\n${path}\n${identity}`));
    const coalescingKey = fingerprint + (providedKey ?? "");
    const running = this.inFlight.get(coalescingKey);
    if (running) return running;
    const key = providedKey ?? mutationKey(fingerprint);
    const headers = new Headers(init.headers);
    headers.set("Idempotency-Key", key);
    const task = this.request<Mutation>(path, { ...init, method: "POST", headers })
      .then((result) => {
        if (!providedKey) forgetMutation(fingerprint);
        return result;
      })
      .catch((error: unknown) => {
        // Network loss/5xx may happen after commit. Only a definite rejection releases the key.
        if (
          !providedKey &&
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        )
          forgetMutation(fingerprint);
        throw error;
      });
    this.inFlight.set(coalescingKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(coalescingKey) === task) this.inFlight.delete(coalescingKey);
    }
  }
  login(login: string, secret: string) {
    return this.request<Token>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, secret }),
    });
  }
  me() {
    return this.request<User>("/auth/me");
  }
  logout() {
    return this.request<void>("/auth/logout", { method: "POST" });
  }
  catalog() {
    return this.request<Catalog>("/catalog");
  }
  employees() {
    return this.request<Employee[]>("/catalog/employees?limit=200");
  }
  orders(params: Record<string, string | number | boolean | string[] | undefined> = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) =>
      Array.isArray(value)
        ? value.forEach((entry) => query.append(key, entry))
        : value !== undefined && query.set(key, String(value)),
    );
    return this.request<OrderPage>(`/work-orders${query.size ? `?${query}` : ""}`);
  }
  order(id: string) {
    return this.request<OrderDetail>(`/work-orders/${id}`);
  }
  events(id: string, after = 0) {
    return this.request<EventPage>(`/work-orders/${id}/events?after_sequence=${after}`);
  }
  workload(areaId?: string) {
    return this.request<Workload[]>(`/workload${areaId ? `?area_id=${areaId}` : ""}`);
  }
  equipmentHistory(id: string, offset = 0) {
    return this.request<OrderPage>(`/equipment/${id}/history?offset=${offset}`);
  }
  create(payload: CreateOrder, key?: string) {
    const body = canonical(payload);
    return this.mutate("/work-orders", { headers: { "Content-Type": "application/json" }, body }, body, key);
  }
  action(id: string, payload: ActionRequest, key?: string) {
    const body = canonical(payload);
    return this.mutate(
      `/work-orders/${id}/actions`,
      { headers: { "Content-Type": "application/json" }, body },
      body,
      key,
    );
  }
  async photo(id: string, kind: "before" | "after", version: number, file: File, key?: string) {
    const path = `/work-orders/${id}/photos?kind=${kind}&expected_version=${version}`;
    const identity = file.type + ":" + (await digest(await file.arrayBuffer()));
    return this.mutate(path, { headers: { "Content-Type": file.type }, body: file }, identity, key);
  }
  notifications(offset = 0, unreadOnly = false) {
    return this.request<NotificationPage>(
      `/notifications?offset=${offset}&limit=50&unread_only=${unreadOnly}`,
    );
  }
  markNotificationRead(id: string) {
    return this.request<NotificationItem>(`/notifications/${id}/read`, { method: "POST" });
  }
  acknowledgeNotification(id: string) {
    return this.request<NotificationItem>(`/notifications/${id}/ack`, { method: "POST" });
  }
  pushConfig() {
    return this.request<PushConfig>("/notifications/push-config");
  }
  notification(id: string) {
    return this.request<NotificationItem>("/notifications/" + id);
  }
  subscribePush(subscription: PushSubscriptionJSON) {
    return this.request<{ id: string }>("/notifications/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }),
    });
  }
  removePushSubscription(id: string) {
    return this.request<void>(`/notifications/subscriptions/${id}`, { method: "DELETE" });
  }
  async photoBlob(path: string): Promise<string> {
    if (!/^\/api\/v1\/work-orders\/[0-9a-f-]{36}\/photos\/[0-9a-f-]{36}$/.test(path)) {
      throw new ApiError(400, "invalid_private_photo_path");
    }
    const response = await this.response(path.slice(prefix.length));
    return URL.createObjectURL(await response.blob());
  }
}

// Stage 5 in-app notification contract. No credentials are placed in URLs.
