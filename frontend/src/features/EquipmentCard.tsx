import { useState } from "react";
import type { Area, Equipment, Role } from "../types";
import { equipmentLink, isLocalQrOrigin, qrSvgDataUrl } from "../lib/equipmentQr";
import { t } from "../lib/i18n";
import { EquipmentLabelEditor } from "./EquipmentLabelEditor";

type Props = {
  equipment: Equipment | null;
  area: Area | null;
  role: Role;
  onClose: () => void;
  closeLabel: string;
  onCreateOrder: () => void;
  onShowOrders: () => void;
  onFaultReport?: () => void;
};

export function EquipmentCard({
  equipment,
  area,
  role,
  onClose,
  closeLabel,
  onCreateOrder,
  onShowOrders,
  onFaultReport,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [labelEditorOpen, setLabelEditorOpen] = useState(false);
  if (!equipment)
    return (
      <section className="equipment-card workspace">
        <p className="eyebrow">{t("QR-КАРТОЧКА")}</p>
        <h1>{t("Оборудование недоступно")}</h1>
        <p className="muted">
          {t(
            "Проверьте QR-код или доступ к участку. Карточка доступна только для оборудования вашего контура.",
          )}
        </p>
        <button className="secondary" type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </section>
    );

  const url = equipmentLink(window.location.origin, equipment.id);
  const qr = qrSvgDataUrl(url);
  const active = equipment.is_active !== false && area?.is_active !== false && Boolean(area);
  const temporaryTunnel = new URL(url).hostname.endsWith(".trycloudflare.com");
  const canIssue = role === "master" && active;
  const canShowOrders = role === "executor" || role === "manager";
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = qr;
    link.download = equipment.inventory_number + "-qr.svg";
    link.click();
  };
  return (
    <section className="equipment-card workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">{t("QR-КАРТОЧКА ОБОРУДОВАНИЯ")}</p>
          <h1>
            {equipment.inventory_number} · {equipment.name}
          </h1>
          <p className="muted">{area ? area.code + " · " + area.name : t("Участок недоступен")}</p>
        </div>
        <button className="text-button" type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      <dl className="equipment-facts">
        <div>
          <dt>{t("Тип")}</dt>
          <dd>{equipment.equipment_type}</dd>
        </div>
        <div>
          <dt>{t("Статус")}</dt>
          <dd>{active ? t("Активно") : t("В архиве или участок отключён")}</dd>
        </div>
      </dl>
      {canIssue && (
        <button className="primary" type="button" onClick={onCreateOrder}>
          {t("Выдать наряд")}
        </button>
      )}
      {canShowOrders && (
        <button className="secondary" type="button" onClick={onShowOrders}>
          {role === "executor" ? t("Мои наряды") : t("Наряды оборудования")}
        </button>
      )}
      {role === "executor" && onFaultReport && active && (
        <button className="secondary" type="button" onClick={onFaultReport}>
          {t("Сообщить о поломке")}
        </button>
      )}
      {(role === "master" || role === "admin") && (
        <section className="equipment-qr-panel">
          <div className="equipment-qr-label">
            <h2>{t("QR-код")}</h2>
            <p>{t("Откройте эту карточку камерой телефона.")}</p>
          </div>
          <div className="equipment-qr-preview">
            <img src={qr} alt={t("QR-код оборудования")} />
            <div className="equipment-qr-preview-copy">
              <p className="equipment-qr-preview-label">{t("Оборудование")}</p>
              <div className="equipment-qr-print-context">
                <strong>
                  {equipment.inventory_number} · {equipment.name}
                </strong>
                <span>{area ? area.code + " · " + area.name : t("Участок недоступен")}</span>
              </div>
              <a className="equipment-qr-link" href={url}>
                {url}
              </a>
            </div>
          </div>
          <div className="equipment-qr-actions">
            <button className="secondary" type="button" onClick={() => void copy()}>
              {t("Копировать ссылку")}
            </button>
            <button className="secondary" type="button" onClick={download}>
              {t("Скачать QR-код")}
            </button>
            <button className="text-button" type="button" onClick={() => setLabelEditorOpen(true)}>
              {t("Печать наклейки")}
            </button>
          </div>
          {copyState === "copied" && (
            <p className="equipment-qr-feedback" role="status">
              {t("Ссылка скопирована.")}
            </p>
          )}
          {copyState === "failed" && (
            <p className="equipment-qr-feedback" role="status">
              {t("Не удалось скопировать ссылку. Скопируйте её из строки выше.")}
            </p>
          )}
          {isLocalQrOrigin(window.location.origin) && (
            <p className="notice">
              {t("Телефон не откроет localhost. Для проверки используйте адрес туннеля.")}
            </p>
          )}
          {temporaryTunnel && (
            <p className="notice">
              {t("Это временный адрес туннеля. После его перезапуска напечатайте новый QR-код.")}
            </p>
          )}
        </section>
      )}
      {labelEditorOpen && (
        <EquipmentLabelEditor
          equipment={equipment}
          area={area}
          qr={qr}
          onClose={() => setLabelEditorOpen(false)}
        />
      )}
    </section>
  );
}
