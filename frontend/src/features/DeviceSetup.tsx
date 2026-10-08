import { t, message as translateMessage } from "../lib/i18n";
import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isAppleMobile() {
  const userAgent = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Honest installation guidance: only offers a browser prompt when one was supplied. */
export function DeviceSetup() {
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
      setMessage(t("Приложение установлено. Уведомления включаются отдельно в журнале уведомлений."));
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
    await prompt.prompt();
    const choice = await prompt.userChoice;
    setPrompt(undefined);
    setMessage(
      choice.outcome === "accepted"
        ? t("Установка подтверждена браузером.")
        : t("Установка отменена. Можно продолжить в браузере."),
    );
  }

  if (installed) return null;
  if (!prompt && !isAppleMobile() && !message) return null;
  return (
    <aside className="device-setup" aria-label={t("Установка приложения")}>
      <div>
        <strong>{t("Работа с телефона")}</strong>
        <p>
          {translateMessage(message) ||
            (isAppleMobile()
              ? t(
                  "Чтобы установить ТехНаряд на iPhone или iPad: откройте меню «Поделиться» в Safari и выберите «На экран Домой».",
                )
              : t(
                  "Установите приложение, чтобы открывать наряды с домашнего экрана и получать фоновые уведомления после отдельного разрешения.",
                ))}
        </p>
      </div>
      {prompt && (
        <button type="button" className="secondary" onClick={() => void install()}>
          {t("Установить приложение")}
        </button>
      )}
    </aside>
  );
}
