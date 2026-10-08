import { t, message as translateMessage } from "../lib/i18n";
import type { useDeviceInstallation } from "../lib/useDeviceInstallation";

function isAppleMobile() {
  const userAgent = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function DeviceSetup({
  hidden = false,
  installation,
}: {
  hidden?: boolean;
  installation: ReturnType<typeof useDeviceInstallation>;
}) {
  const { prompt, installed, message, install } = installation;
  if (installed) return null;
  return (
    <aside className="device-setup" aria-label={t("Установка приложения")} hidden={hidden}>
      <div>
        <strong>{t("Приложение на устройстве")}</strong>
        <p>
          {translateMessage(message) ||
            (isAppleMobile()
              ? t("iPhone/iPad: в Safari выберите «Поделиться» → «На экран Домой».")
              : prompt
                ? t("На компьютере и телефоне — отдельным приложением. Уведомления включаются отдельно.")
                : t(
                    "На компьютере и телефоне — отдельным приложением. Уведомления включаются отдельно. В браузере откройте меню и выберите «Установить приложение».",
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
