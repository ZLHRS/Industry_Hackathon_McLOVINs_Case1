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
  const [installed, setInstalled] = useState(
    () => (typeof window !== "undefined" && isStandalone()) || false,
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
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
      window.removeEventListener("beforeinstallprompt", deferred);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setPrompt(undefined);
      setMessage(
        choice.outcome === "accepted"
          ? "Установка подтверждена браузером."
          : "Установка отменена. Можно продолжить в браузере.",
      );
    } catch {
      setMessage("Не удалось открыть установку. Попробуйте ещё раз.");
    }
  }

  return { prompt, installed, message, install };
}
