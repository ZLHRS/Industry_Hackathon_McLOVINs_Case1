import { t, message as translateMessage } from "../lib/i18n";
import type { useDeviceInstallation } from "../lib/useDeviceInstallation";
import { useState } from "react";

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
  const { prompt, installed, standalone, message, install } = installation;
  const [showHelp, setShowHelp] = useState(false);
  if (standalone) return null;
  const canInstall = Boolean(prompt && !installed);
  const manualHelp = installed
    ? t("Открывайте приложение с ярлыка.")
    : isAppleMobile()
      ? t("iPhone/iPad: в Safari выберите «Поделиться» → «На экран Домой».")
      : t("В браузере откройте меню и выберите «Установить приложение».");
  const status = translateMessage(message);
  const description =
    status ||
    (installed
      ? t("Приложение установлено на этом устройстве.")
      : t("На компьютере и телефоне — отдельным приложением. Уведомления включаются отдельно."));

  return (
    <aside className="device-setup" aria-label={t("Установка приложения")} hidden={hidden}>
      <div>
        <strong>{t("Приложение на устройстве")}</strong>
        <p>{description}</p>
        {!canInstall && showHelp && <p>{manualHelp}</p>}
      </div>
      <button
        type="button"
        className="secondary"
        aria-expanded={canInstall ? undefined : showHelp}
        onClick={() => {
          if (canInstall) void install();
          else setShowHelp((value) => !value);
        }}
      >
        {canInstall
          ? t("Установить приложение")
          : installed
            ? t("Приложение установлено")
            : t("Как установить")}
      </button>
    </aside>
  );
}
