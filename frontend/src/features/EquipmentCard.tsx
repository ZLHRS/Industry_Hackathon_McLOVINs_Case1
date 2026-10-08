import { useState } from "react";
import type { Area, Equipment, Role } from "../types";
import { equipmentLink, isLocalQrOrigin, qrSvgDataUrl } from "../lib/equipmentQr";

type Props = {
  equipment: Equipment | null;
  area: Area | null;
  role: Role;
  onClose: () => void;
  closeLabel: string;
  onCreateOrder: () => void;
  onShowOrders: () => void;
};

export function EquipmentCard({
  equipment,
  area,
  role,
  onClose,
  closeLabel,
  onCreateOrder,
  onShowOrders,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  if (!equipment)
    return (
      <section className="equipment-card workspace">
        <p className="eyebrow">QR-КАРТОЧКА</p>
        <h1>Оборудование недоступно</h1>
        <p className="muted">
          Проверьте QR-код или доступ к участку. Карточка доступна только для оборудования вашего контура.
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
          <p className="eyebrow">QR-КАРТОЧКА ОБОРУДОВАНИЯ</p>
          <h1>
            {equipment.inventory_number} · {equipment.name}
          </h1>
          <p className="muted">{area ? area.code + " · " + area.name : "Участок недоступен"}</p>
        </div>
        <button className="text-button" type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      <dl className="equipment-facts">
        <div>
          <dt>Тип</dt>
          <dd>{equipment.equipment_type}</dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>{active ? "Активно" : "В архиве или участок отключён"}</dd>
        </div>
      </dl>
      {canIssue && (
        <button className="primary" type="button" onClick={onCreateOrder}>
          Выдать наряд
        </button>
      )}
      {canShowOrders && (
        <button className="secondary" type="button" onClick={onShowOrders}>
          {role === "executor" ? "Мои наряды" : "Наряды оборудования"}
        </button>
      )}
      {(role === "master" || role === "admin") && (
        <section className="equipment-qr-panel">
          <div className="equipment-qr-label">
            <h2>QR-код</h2>
            <p>Откройте эту карточку камерой телефона.</p>
          </div>
          <div className="equipment-qr-print-context">
            <strong>
              {equipment.inventory_number} · {equipment.name}
            </strong>
            <span>{area ? area.code + " · " + area.name : "Участок недоступен"}</span>
          </div>
          <img src={qr} alt="QR-код оборудования" />
          <a href={url}>{url}</a>
          <div className="equipment-qr-actions">
            <button className="secondary" type="button" onClick={() => void copy()}>
              Копировать ссылку
            </button>
            <button className="secondary" type="button" onClick={download}>
              Скачать QR-код
            </button>
            <button className="text-button" type="button" onClick={() => window.print()}>
              Печать наклейки
            </button>
          </div>
          {copyState === "copied" && (
            <p className="equipment-qr-feedback" role="status">
              Ссылка скопирована.
            </p>
          )}
          {copyState === "failed" && (
            <p className="equipment-qr-feedback" role="status">
              Не удалось скопировать ссылку. Скопируйте её из строки выше.
            </p>
          )}
          {isLocalQrOrigin(window.location.origin) && (
            <p className="notice">Телефон не откроет localhost. Для проверки используйте адрес туннеля.</p>
          )}
          {temporaryTunnel && (
            <p className="notice">
              Это временный адрес туннеля. После его перезапуска напечатайте новый QR-код.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
