import { t } from "../lib/i18n";
import { DeviceSetup } from "../features/DeviceSetup";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useEffect, useRef, useState } from "react";
import type { useDeviceInstallation } from "../lib/useDeviceInstallation";

export function AppPreferences({ installation }: { installation: ReturnType<typeof useDeviceInstallation> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  return (
    <div className="app-preferences" ref={ref}>
      <section
        id="app-preferences-panel"
        className="app-preferences-panel"
        data-testid="app-preferences-panel"
        aria-label={t("Приложение и язык")}
        hidden={!open}
      >
        <h2>{t("Приложение и язык")}</h2>
        <DeviceSetup hidden={!open} installation={installation} />
        <div className="app-preferences-language">
          <span>{t("Язык")}</span>
          <LanguageSwitcher />
        </div>
      </section>
      <button
        type="button"
        className="app-preferences-toggle"
        ref={toggleRef}
        data-testid="app-preferences-toggle"
        aria-expanded={open}
        aria-controls="app-preferences-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {t("Приложение и язык")}
      </button>
    </div>
  );
}
