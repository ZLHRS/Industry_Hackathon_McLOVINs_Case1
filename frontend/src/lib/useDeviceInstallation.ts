import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useDeviceInstallation() {
  const [prompt, setPrompt] = useState<InstallPromptEvent>();
  const [standalone, setStandalone] = useState(() => typeof window !== "undefined" && isStandalone());
  const [installed, setInstalled] = useState(
    () => (typeof window !== "undefined" && isStandalone()) || false,
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const updateDisplayMode = () => setStandalone(isStandalone());
    displayMode.addEventListener("change", updateDisplayMode);
    const deferred = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const complete = () => {
      setPrompt(undefined);
      setInstalled(true);
      setMessage("Приложение установлено. Уведомления включаются отдельно в журнале уведомлений.");
    };
    window.addEventListener("beforeinstallprompt", deferred);
    window.addEventListener("appinstalled", complete);
    return () => {
      displayMode.removeEventListener("change", updateDisplayMode);
      window.removeEventListener("beforeinstallprompt", deferred);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    const activePrompt = prompt;
    // Chromium exposes a beforeinstallprompt event only once. Fall back to the
    // manual path even if opening its native prompt fails.
    setPrompt(undefined);
    try {
      await activePrompt.prompt();
      const choice = await activePrompt.userChoice;
      setMessage(
        choice.outcome === "accepted"
          ? "Установка подтверждена браузером."
          : "Установка отменена. Можно продолжить в браузере.",
      );
    } catch {
      setMessage("Не удалось открыть установку. Попробуйте ещё раз.");
    }
  }

  return { prompt, installed, standalone, message, install };
}
