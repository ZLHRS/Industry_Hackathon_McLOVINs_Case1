import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api";

export type PushStatus = "checking" | "enabled" | "off" | "blocked" | "unavailable" | "error";
export function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}
function decodeKey(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
async function registration() {
  // Do not leave the UI checking forever when the worker is unavailable.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("worker_timeout")), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Enabled means both browser permission and a confirmed server binding for this session. */
export function usePushStatus(api: Api, actorId: string | null) {
  const [snapshot, setSnapshot] = useState<{ api: Api; status: PushStatus; subscriptionId: string | null }>({
    api,
    status: "checking",
    subscriptionId: null,
  });
  const generation = useRef(0);
  const pending = useRef(false);
  const check = useCallback(
    async (requestPermission = false) => {
      if (pending.current) return;
      const current = ++generation.current;
      pending.current = true;
      const publish = (status: PushStatus, subscriptionId: string | null = null) => {
        if (generation.current === current) setSnapshot({ api, status, subscriptionId });
      };
      try {
        if (!actorId || !supportsPush()) {
          publish("unavailable");
          return;
        }
        if (Notification.permission === "denied") {
          publish("blocked");
          return;
        }
        if (Notification.permission !== "granted" && !requestPermission) {
          publish("off");
          return;
        }
        publish("checking");
        // Prompt immediately from the user's click, before network calls (Safari user activation).
        const permission =
          requestPermission && Notification.permission !== "granted"
            ? await Notification.requestPermission()
            : Notification.permission;
        if (permission !== "granted") {
          publish(permission === "denied" ? "blocked" : "off");
          return;
        }
        const config = await api.pushConfig();
        if (!config.enabled || !config.public_key) {
          publish("unavailable");
          return;
        }
        const worker = await registration();
        let subscription = await worker.pushManager.getSubscription();
        if (!subscription && requestPermission)
          subscription = await worker.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeKey(config.public_key),
          });
        if (!subscription) {
          publish("off");
          return;
        }
        if (generation.current !== current) return;
        const bound = await api.subscribePush(subscription.toJSON());
        publish("enabled", bound.id);
      } catch {
        publish("error");
      } finally {
        if (generation.current === current) pending.current = false;
      }
    },
    [api, actorId],
  );
  const cancel = useCallback(() => {
    generation.current++;
    pending.current = false;
  }, []);
  useEffect(() => {
    void check();
    const recheck = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancel();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [check, cancel]);
  return {
    status: snapshot.api === api ? snapshot.status : ("checking" as PushStatus),
    subscriptionId: snapshot.api === api ? snapshot.subscriptionId : null,
    enable: () => check(true),
  };
}
