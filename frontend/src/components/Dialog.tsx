import { t } from "../lib/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      opener.current?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <LanguageSwitcher />
        <button
          className="icon-button"
          type="button"
          onClick={() => closeRef.current()}
          aria-label={t("Закрыть")}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
