import { t } from "../lib/i18n";
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Dialog({
  title,
  onClose,
  children,
  size = "default",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "wide";
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
      className={size === "wide" ? "dialog dialog-wide" : "dialog"}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          type="button"
          onClick={() => closeRef.current()}
          aria-label={t("Закрыть")}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
