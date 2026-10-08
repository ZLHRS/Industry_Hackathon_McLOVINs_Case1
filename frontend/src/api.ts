import type {
  ActionRequest,
  AdminEmployee,
  CreateEmployee,
  EmployeeAccessUpdate,
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
import type { AnalyticsOptions, AnalyticsQuery, AnalyticsReport, AnalyticsSummary } from "./types";

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
function exifIso(value: string, timezone: string | undefined): string | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  const offset = timezone?.trim();
  if (!match || !offset || !/^[+-]\d{2}:\d{2}$/.test(offset)) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = [
    year,
    month,
    day,
    hour,
    minute,
    second,
  ].map(Number);
  const [offsetHour, offsetMinute] = offset.slice(1).split(":").map(Number);
  const local = new Date(
    Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber, secondNumber),
  );
  if (
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    local.getUTCFullYear() !== yearNumber ||
    local.getUTCMonth() !== monthNumber - 1 ||
    local.getUTCDate() !== dayNumber ||
    local.getUTCHours() !== hourNumber ||
    local.getUTCMinutes() !== minuteNumber ||
    local.getUTCSeconds() !== secondNumber
  )
    return undefined;
  const capturedAt = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  return Number.isFinite(Date.parse(capturedAt)) ? capturedAt : undefined;
}
function exifCaptureDate(bytes: Uint8Array): string | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let cursor = 2;
  while (cursor + 4 < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    const marker = bytes[cursor + 1];
    const length = (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    if (length < 2 || cursor + 2 + length > bytes.length) return undefined;
    if (marker === 0xe1 && new TextDecoder().decode(bytes.slice(cursor + 4, cursor + 10)) === "Exif\0\0") {
      const tiff = cursor + 10;
      if (tiff + 8 > bytes.length) return undefined;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      if (
        (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) ||
        view.getUint16(tiff + 2, little) !== 42
      )
        return undefined;
      const entry = (
        at: number,
        tag: number,
      ): { type: number; count: number; value: number; position: number } | undefined => {
        if (at < tiff || at + 2 > bytes.length) return undefined;
        const count = view.getUint16(at, little);
        for (let index = 0; index < count; index += 1) {
          const position = at + 2 + index * 12;
          if (position + 12 > bytes.length || view.getUint16(position, little) !== tag) continue;
          return {
            type: view.getUint16(position + 2, little),
            count: view.getUint32(position + 4, little),
            value: view.getUint32(position + 8, little),
            position,
          };
        }
        return undefined;
      };
      const ifd0 = tiff + view.getUint32(tiff + 4, little);
      const exifOffset = entry(ifd0, 0x8769)?.value;
      if (!exifOffset) return undefined;
      const exif = tiff + exifOffset;
      const date = entry(exif, 0x9003);
      if (!date || date.type !== 2 || !date.count) return undefined;
      const readAscii = (item: { count: number; value: number; position: number } | undefined) => {
        if (!item?.count) return undefined;
        const start = item.count <= 4 ? item.position + 8 : tiff + item.value;
        if (start < tiff || start + item.count > bytes.length) return undefined;
        return new TextDecoder().decode(bytes.slice(start, start + item.count)).replace(/\0+$/, "");
      };
      const start = date.count <= 4 ? date.position + 8 : tiff + date.value;
      if (start + date.count > bytes.length) return undefined;
      return exifIso(readAscii(date) ?? "", readAscii(entry(exif, 0x9011)));
    }
    cursor += length + 2;
  }
  return undefined;
}
export async function capturePhotoTime(file: File): Promise<string | undefined> {
  if (file.type !== "image/jpeg") return undefined;
  try {
    return exifCaptureDate(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  } catch {
    return undefined;
  }
}
async function preparePhoto(file: File): Promise<File> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  )
    return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const targetBytes = 600_000;
    if (scale === 1 && file.size <= targetBytes) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return file;
    let best: Blob | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.72, 0.6]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality),
        );
        if (blob && (!best || blob.size < best.size)) best = blob;
        if (best && best.size <= targetBytes) break;
      }
      if (best && best.size <= targetBytes) break;
      canvas.width = Math.max(1, Math.round(canvas.width * 0.8));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.8));
    }
    if (!best || best.size >= file.size) return file;
    return new File([best], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
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
  createArea(input: { code: string; name: string }) {
    return this.request<import("./types").Area>("/catalog/areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateArea(id: string, input: { code: string; name: string }) {
    return this.request<import("./types").Area>(`/catalog/areas/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  setAreaActive(id: string, is_active: boolean) {
    return this.request<import("./types").Area>(`/catalog/areas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
  }
  createEquipment(input: Omit<import("./types").Equipment, "id" | "is_active">) {
    return this.request<import("./types").Equipment>("/catalog/equipment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateEquipment(id: string, input: Omit<import("./types").Equipment, "id" | "is_active">) {
    return this.request<import("./types").Equipment>(`/catalog/equipment/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  setEquipmentActive(id: string, is_active: boolean) {
    return this.request<import("./types").Equipment>(`/catalog/equipment/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
  }
  createBrigade(input: { code: string; name: string }) {
    return this.request<import("./types").Brigade>("/catalog/brigades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateBrigade(id: string, input: { code: string; name: string }) {
    return this.request<import("./types").Brigade>(`/catalog/brigades/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  deleteBrigade(id: string) {
    return this.request<void>(`/catalog/brigades/${id}`, { method: "DELETE" });
  }
  createFaultCode(input: { code: string; name: string; specialty: string }) {
    return this.request<import("./types").FaultCode>("/catalog/fault-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateFaultCode(id: string, input: { code: string; name: string; specialty: string }) {
    return this.request<import("./types").FaultCode>(`/catalog/fault-codes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  deleteFaultCode(id: string) {
    return this.request<void>(`/catalog/fault-codes/${id}`, { method: "DELETE" });
  }
  createMaterial(input: { code: string; name: string; unit: string }) {
    return this.request<import("./types").Material>("/catalog/materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateMaterial(id: string, input: { code: string; name: string; unit: string }) {
    return this.request<import("./types").Material>(`/catalog/materials/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  deleteMaterial(id: string) {
    return this.request<void>(`/catalog/materials/${id}`, { method: "DELETE" });
  }
  createTimeNorm(input: { fault_code_id: string; equipment_type: string; minutes: number }) {
    return this.request<import("./types").TimeNorm>("/catalog/time-norms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateTimeNorm(id: string, input: { fault_code_id: string; equipment_type: string; minutes: number }) {
    return this.request<import("./types").TimeNorm>(`/catalog/time-norms/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  deleteTimeNorm(id: string) {
    return this.request<void>(`/catalog/time-norms/${id}`, { method: "DELETE" });
  }
  async employees(): Promise<Employee[]> {
    const result: Employee[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.request<Employee[]>(`/catalog/employees?limit=200&offset=${offset}`);
      result.push(...page);
      if (page.length < 200) return result;
    }
  }
  employee(id: string) {
    return this.request<AdminEmployee>(`/catalog/employees/${id}`);
  }
  createEmployee(input: CreateEmployee) {
    return this.request<AdminEmployee>("/catalog/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  updateEmployeeAccess(id: string, input: EmployeeAccessUpdate) {
    return this.request<AdminEmployee>(`/catalog/employees/${id}/access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
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
  masters() {
    return this.request<import("./types").MasterOption[]>("/work-orders/masters");
  }
  workload(areaId?: string) {
    return this.request<Workload[]>(`/workload${areaId ? `?area_id=${areaId}` : ""}`);
  }
  equipmentHistory(id: string, offset = 0) {
    return this.request<OrderPage>(`/equipment/${id}/history?offset=${offset}`);
  }
  suggestions(input: {
    area_id: string;
    equipment_id: string;
    description: string;
    fault_code_id?: string | null;
  }) {
    return this.request<import("./types").OrderSuggestions>("/work-orders/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
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
  async photo(
    id: string,
    kind: "before" | "after",
    version: number,
    file: File,
    aiShareAllowed = false,
    key?: string,
    capturedAtOverride?: string,
  ) {
    const [capturedAt, upload] = await Promise.all([
      capturedAtOverride ?? capturePhotoTime(file),
      preparePhoto(file),
    ]);
    const query = new URLSearchParams({ kind, expected_version: String(version) });
    if (capturedAt) query.set("captured_at", capturedAt);
    // Stored work-order evidence stays private unless its uploader explicitly approves
    // this particular image for external AI analysis.
    query.set("ai_share_allowed", String(aiShareAllowed));
    const path = `/work-orders/${id}/photos?${query}`;
    const identity = upload.type + ":" + capturedAt + ":" + (await digest(await upload.arrayBuffer()));
    return this.mutate(path, { headers: { "Content-Type": upload.type }, body: upload }, identity, key);
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
  private analyticsPath(path: string, query: AnalyticsQuery) {
    const params = new URLSearchParams();
    params.set("period", query.period);
    params.set("timezone", query.timezone);
    if (query.shift) params.set("shift", query.shift);
    if (query.date) params.set("date", query.date);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    (["area_id", "equipment_id", "executor_id", "brigade_id"] as const).forEach((key) =>
      query[key].forEach((value) => params.append(key, value)),
    );
    return `${path}?${params}`;
  }
  analyticsOptions() {
    return this.request<AnalyticsOptions>("/analytics/options");
  }
  analyticsReport(query: AnalyticsQuery) {
    return this.request<AnalyticsReport>(this.analyticsPath("/analytics/report", query));
  }
  analyticsSummary(query: AnalyticsQuery) {
    return this.request<AnalyticsSummary>(this.analyticsPath("/analytics/summary", query), {
      method: "POST",
    });
  }
  async analyticsExport(query: AnalyticsQuery) {
    const response = await this.response(this.analyticsPath("/analytics/export", query));
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "tekhnaryad-report.xlsx";
    return { blob: await response.blob(), filename: name.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, "_") };
  }
  downtime(
    id: string,
    payload: {
      expected_version: number;
      started_at?: string | null;
      ended_at?: string | null;
      reason: string;
      void?: boolean;
    },
    key?: string,
  ) {
    const body = canonical(payload);
    return this.mutate(
      `/work-orders/${id}/downtime`,
      { headers: { "Content-Type": "application/json" }, body },
      body,
      key,
    );
  }
  assessRefusal(
    id: string,
    rejectionEventId: string,
    payload: { expected_version: number; justified: boolean; reason: string },
    key?: string,
  ) {
    const body = canonical(payload);
    return this.mutate(
      `/work-orders/${id}/refusals/${rejectionEventId}/assessment`,
      { headers: { "Content-Type": "application/json" }, body },
      body,
      key,
    );
  }
  async orderReport(id: string) {
    const response = await this.response(`/work-orders/${id}/report.xlsx`);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `order-${id}.xlsx`;
    return { blob: await response.blob(), filename: filename.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, "_") };
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
