import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { useEffect, useRef, useState } from "react";

/** Phone-only account card: the sidebar profile is hidden there, the bottom bar keeps navigation. */
export function ProfileMenu({
  name,
  initials,
  role,
  onOwnOrders,
  onSignOut,
}: {
  name: string;
  initials: string;
  role: string;
  onOwnOrders?: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
    <div className="profile-menu" ref={ref}>
      <button
        type="button"
        className="profile-toggle"
        ref={toggleRef}
        aria-expanded={open}
        aria-controls="profile-menu-panel"
        aria-label={t("Профиль: {0}", [name])}
        title={name}
        onClick={() => setOpen((value) => !value)}
      >
        {initials}
      </button>
      <section
        id="profile-menu-panel"
        className="profile-menu-panel"
        aria-label={t("Профиль")}
        hidden={!open}
      >
        <div className="profile-menu-head">
          <span className="profile-menu-avatar" aria-hidden="true">
            {initials}
          </span>
          <div>
            <strong>{name}</strong>
            <small>{role}</small>
          </div>
        </div>
        {onOwnOrders && (
          <button
            type="button"
            className="profile-menu-item"
            onClick={() => {
              setOpen(false);
              onOwnOrders();
            }}
          >
            <Icon name="orders" />
            {t("Мои наряды")}
          </button>
        )}
        <button type="button" className="profile-menu-item is-danger" onClick={onSignOut}>
          <Icon name="logout" />
          {t("Выйти")}
        </button>
      </section>
    </div>
  );
}
