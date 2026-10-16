import type { Token, User } from "../types";

// One atomic record shared by same-origin tabs and retained after a PWA is unloaded.
// Passwords are never stored. The server remains authoritative for expiry/revocation.
export const sessionKey = "naryadai.session.v1";
const legacyKeys = ["naryadai.session.token", "naryadai.session.expires", "naryadai.session.user"];
export type Session = { token: string; expiresAt: string; user: User | null };
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSession: Session | null = null;
let memoryOnlyRaw: string | undefined;
let initialization: Promise<void> | undefined;
let lockingUnavailable = false;

function sharedStorageAvailable(): boolean {
  return !lockingUnavailable && typeof navigator !== "undefined" && Boolean(navigator.locks);
}

async function withSessionLock<T>(action: () => T): Promise<T> {
  if (sharedStorageAvailable()) {
    let entered = false;
    try {
      return await navigator.locks.request(sessionKey, () => {
        entered = true;
        return action();
      });
    } catch (error) {
      // Never retry an action which already ran. A denied lock API must not block
      // startup or sign-in; preserve this tab's session in memory instead.
      if (entered) throw error;
      memoryOnlyRaw = readRaw() ?? "null";
      lockingUnavailable = true;
    }
  }
  // Older/insecure browsers keep an online, memory-only session rather than making
  // unsafe cross-tab writes. Supported HTTPS PWA browsers provide Web Locks.
  return action();
}

function readRaw(): string | null {
  if (!sharedStorageAvailable()) return memoryOnlyRaw ?? null;
  try {
    return memoryOnlyRaw ?? localStorage.getItem(sessionKey);
  } catch {
    return memoryOnlyRaw ?? null;
  }
}

function parseUser(value: unknown): User | null {
  if (!value || typeof value !== "object") return null;
  const user = value as User;
  return typeof user.id === "string" &&
    typeof user.login === "string" &&
    typeof user.display_name === "string" &&
    ["master", "executor", "manager", "admin"].includes(user.role) &&
    Array.isArray(user.area_ids) &&
    user.area_ids.every((id) => typeof id === "string")
    ? user
    : null;
}

function parse(raw: string | null): Session | null {
  try {
    const value = JSON.parse(raw ?? "null") as Session | null;
    if (
      !value ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      return null;
    return { token: value.token, expiresAt: value.expiresAt, user: parseUser(value.user) };
  } catch {
    return null;
  }
}

function removeLegacy(): void {
  try {
    for (const key of legacyKeys) sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in restricted browser modes.
  }
}

function persist(session: Session | null): void {
  const raw = JSON.stringify(session);
  try {
    if (!sharedStorageAvailable()) throw new Error("Shared storage unavailable");
    // Keep a null tombstone on logout so an old tab cannot migrate a stale token back.
    localStorage.setItem(sessionKey, raw);
    memoryOnlyRaw = undefined;
  } catch {
    memoryOnlyRaw = raw;
  }
  cachedRaw = raw;
  cachedSession = session;
  removeLegacy();
}

export function initializeSession(): Promise<void> {
  return (initialization ??= withSessionLock(() => {
    if (readRaw() === null) {
      try {
        const token = sessionStorage.getItem(legacyKeys[0]);
        const expiresAt = sessionStorage.getItem(legacyKeys[1]);
        const user = JSON.parse(sessionStorage.getItem(legacyKeys[2]) ?? "null") as unknown;
        const legacy = parse(JSON.stringify({ token, expiresAt, user }));
        if (legacy) {
          persist(legacy);
          return;
        }
      } catch {
        // An incomplete legacy session must not prevent a normal sign-in.
      }
    }
    removeLegacy();
  }));
}

export function readSession(): Session | null {
  const raw = readRaw();
  // Stable snapshots are required by useSyncExternalStore.
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSession = parse(raw);
  }
  return cachedSession;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export async function saveSession(response: Token): Promise<void> {
  await withSessionLock(() => {
    persist({ token: response.access_token, expiresAt: response.expires_at, user: null });
    notify();
  });
}

export async function saveSessionUser(token: string, user: User): Promise<boolean> {
  return withSessionLock(() => {
    const current = readSession();
    if (current?.token !== token) return false;
    const next = { ...current, user };
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      persist(next);
      notify();
    }
    return true;
  });
}

export async function clearSession(expectedToken: string | null): Promise<boolean> {
  return withSessionLock(() => {
    if ((readSession()?.token ?? null) !== expectedToken) return false;
    persist(null);
    notify();
    return true;
  });
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === sessionKey || event.key === null) listener();
  };
  // Reconcile on resume as mobile browsers may suspend delivery of storage events.
  const visible = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener("pageshow", listener);
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", visible);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
    window.removeEventListener("pageshow", listener);
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", visible);
  };
}

export function watchSessionExpiry(expiresAt: string, onExpire: () => void): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    clearTimeout(timeout);
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      stopped = true;
      onExpire();
    } else {
      // Never overflow the browser's signed 32-bit timer when longer TTLs are configured.
      timeout = setTimeout(check, Math.min(remaining, 86_400_000));
    }
  };
  const visible = () => {
    if (document.visibilityState === "visible") check();
  };
  window.addEventListener("pageshow", check);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", visible);
  check();
  return () => {
    stopped = true;
    clearTimeout(timeout);
    window.removeEventListener("pageshow", check);
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", visible);
  };
}
