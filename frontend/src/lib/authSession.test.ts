import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Token, User } from "../types";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}
const user: User = {
  id: "master-1",
  login: "master.test",
  display_name: "Мастер",
  role: "master",
  area_ids: [],
};
const now = Date.parse("2026-10-16T08:00:00Z");
const login: Token = {
  access_token: "test-session-a",
  token_type: "bearer",
  expires_at: new Date(now + 8 * 3600_000).toISOString(),
};
let local: MemoryStorage;
let tab: MemoryStorage;
let browser: EventTarget;
let documentEvents: EventTarget;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  local = new MemoryStorage();
  tab = new MemoryStorage();
  browser = new EventTarget();
  documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let queue: Promise<unknown> = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: vi.fn((_name: string, action: () => unknown) => {
        const result = queue.then(action);
        queue = result.catch(() => undefined);
        return result;
      }),
    },
  });
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", tab);
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", documentEvents);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persistent browser/PWA sessions", () => {
  it("restores the login and actor in a fresh tab/PWA runtime without sessionStorage", async () => {
    let auth = await import("./authSession");
    await auth.saveSession(login);
    await auth.saveSessionUser(login.access_token, user);
    tab.clear();
    vi.resetModules();
    auth = await import("./authSession");
    expect(auth.readSession()).toEqual({ token: login.access_token, expiresAt: login.expires_at, user });
    expect(local.getItem(auth.sessionKey)).not.toContain("secret");
    expect(auth.readSession()).toBe(auth.readSession());
  });

  it("migrates a still-open legacy tab without requiring another sign-in", async () => {
    tab.setItem("naryadai.session.token", login.access_token);
    tab.setItem("naryadai.session.expires", login.expires_at);
    tab.setItem("naryadai.session.user", JSON.stringify(user));
    const auth = await import("./authSession");
    await auth.initializeSession();
    expect(auth.readSession()?.token).toBe(login.access_token);
    expect(local.getItem(auth.sessionKey)).toContain(login.access_token);
    expect(tab.getItem("naryadai.session.token")).toBeNull();
  });

  it("does not resurrect a stale legacy tab after another tab logged out", async () => {
    const auth = await import("./authSession");
    await auth.saveSession(login);
    expect(await auth.clearSession(login.access_token)).toBe(true);
    tab.setItem("naryadai.session.token", login.access_token);
    tab.setItem("naryadai.session.expires", login.expires_at);
    vi.resetModules();
    const reopened = await import("./authSession");
    await reopened.initializeSession();
    expect(reopened.readSession()).toBeNull();
    expect(tab.getItem("naryadai.session.token")).toBeNull();
  });

  it("prefers a newer shared account to the old tab-local account", async () => {
    const auth = await import("./authSession");
    await auth.saveSession({ ...login, access_token: "new-account-token" });
    tab.setItem("naryadai.session.token", login.access_token);
    tab.setItem("naryadai.session.expires", login.expires_at);
    vi.resetModules();
    const reopened = await import("./authSession");
    await reopened.initializeSession();
    expect(reopened.readSession()?.token).toBe("new-account-token");
    expect(reopened.readSession()?.user).toBeNull();
  });

  it("ignores delayed 401/logout and profile results from a previous account", async () => {
    const auth = await import("./authSession");
    await auth.saveSession(login);
    await auth.saveSession({ ...login, access_token: "new-account-token" });
    expect(await auth.clearSession(login.access_token)).toBe(false);
    expect(await auth.saveSessionUser(login.access_token, user)).toBe(false);
    expect(auth.readSession()?.token).toBe("new-account-token");
    expect(auth.readSession()?.user).toBeNull();
  });

  it("serializes competing tabs so queued stale responses cannot replace a newer login", async () => {
    const oldTab = await import("./authSession");
    await oldTab.saveSession(login);
    vi.resetModules();
    const newTab = await import("./authSession");
    const replacement = newTab.saveSession({ ...login, access_token: "new-account-token" });
    const staleProfile = oldTab.saveSessionUser(login.access_token, user);
    const staleLogout = oldTab.clearSession(login.access_token);
    await replacement;
    expect(await staleProfile).toBe(false);
    expect(await staleLogout).toBe(false);
    expect(oldTab.readSession()?.token).toBe("new-account-token");
    expect(newTab.readSession()?.user).toBeNull();
    expect(navigator.locks.request).toHaveBeenCalledWith(oldTab.sessionKey, expect.any(Function));
  });

  it("recovers startup and sign-in when the browser denies lock acquisition", async () => {
    vi.stubGlobal("navigator", { locks: { request: vi.fn().mockRejectedValue(new Error("denied")) } });
    local.setItem(
      "naryadai.session.v1",
      JSON.stringify({ token: login.access_token, expiresAt: login.expires_at, user }),
    );
    const auth = await import("./authSession");
    await expect(auth.initializeSession()).resolves.toBeUndefined();
    expect(auth.readSession()?.token).toBe(login.access_token);
    await auth.clearSession(login.access_token);
    expect(auth.readSession()).toBeNull();
    await auth.saveSession({ ...login, access_token: "memory-login" });
    expect(auth.readSession()?.token).toBe("memory-login");
    expect(navigator.locks.request).toHaveBeenCalledTimes(1);
  });

  it("keeps a usable memory session when shared locking is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const auth = await import("./authSession");
    await auth.initializeSession();
    await auth.saveSession(login);
    expect(auth.readSession()?.token).toBe(login.access_token);
    expect(local.getItem(auth.sessionKey)).toBeNull();
    await auth.clearSession(login.access_token);
    expect(auth.readSession()).toBeNull();
  });

  it("notifies this tab and other-tab changes and reconciles after suspension", async () => {
    const auth = await import("./authSession");
    const changed = vi.fn(() => auth.readSession());
    const unsubscribe = auth.subscribeSession(changed);
    await auth.saveSession(login);
    expect(changed).toHaveBeenCalledTimes(1);
    local.setItem(auth.sessionKey, "null");
    browser.dispatchEvent(Object.assign(new Event("storage"), { key: auth.sessionKey }));
    expect(changed).toHaveLastReturnedWith(null);
    browser.dispatchEvent(new Event("pageshow"));
    browser.dispatchEvent(new Event("focus"));
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenCalledTimes(5);
    unsubscribe();
    browser.dispatchEvent(new Event("focus"));
    expect(changed).toHaveBeenCalledTimes(5);
  });

  it.each(["{broken", "null", "{}", '{"token":"x","expiresAt":"bad-date"}'])(
    "treats damaged storage as signed out: %s",
    async (raw) => {
      local.setItem("naryadai.session.v1", raw);
      const auth = await import("./authSession");
      expect(auth.readSession()).toBeNull();
    },
  );

  it("does not crash if persistent storage is blocked, and can still sign out", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    const auth = await import("./authSession");
    expect(auth.readSession()).toBeNull();
    await auth.saveSession(login);
    expect(auth.readSession()?.token).toBe(login.access_token);
    await auth.clearSession(login.access_token);
    expect(auth.readSession()).toBeNull();
  });
});

describe("absolute session expiry", () => {
  it("does not expire after a minute; expires exactly at the server deadline", async () => {
    const auth = await import("./authSession");
    const expired = vi.fn();
    const stop = auth.watchSessionExpiry(login.expires_at, expired);
    vi.advanceTimersByTime(60_000);
    browser.dispatchEvent(new Event("pageshow"));
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8 * 3600_000 - 60_000);
    expect(expired).toHaveBeenCalledTimes(1);
    browser.dispatchEvent(new Event("focus"));
    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks the real deadline after a suspended PWA resumes", async () => {
    const auth = await import("./authSession");
    const expired = vi.fn();
    const stop = auth.watchSessionExpiry(login.expires_at, expired);
    vi.setSystemTime(now + 9 * 3600_000);
    browser.dispatchEvent(new Event("pageshow"));
    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not overflow the browser timer for long sessions", async () => {
    const auth = await import("./authSession");
    const expired = vi.fn();
    const stop = auth.watchSessionExpiry(new Date(now + 30 * 86400_000).toISOString(), expired);
    vi.advanceTimersByTime(29 * 86400_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(86400_000);
    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it("cancels the old expiry when an account changes", async () => {
    const auth = await import("./authSession");
    const expired = vi.fn();
    const stop = auth.watchSessionExpiry(new Date(now + 60_000).toISOString(), expired);
    stop();
    vi.advanceTimersByTime(60_000);
    browser.dispatchEvent(new Event("focus"));
    expect(expired).not.toHaveBeenCalled();
  });
});
