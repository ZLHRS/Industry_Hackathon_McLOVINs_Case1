import {
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { Dialog } from "../components/Dialog";
import { useLanguage } from "../lib/i18n";
import type { Area, Equipment } from "../types";
import {
  centeredPlacement,
  defaultLabelSettings,
  fullPrintablePreset,
  labelPresetId,
  labelPresets,
  labelPapers,
  labelSizeLimits,
  maxQrMm,
  paddingLimits,
  parseLabelNumber,
  roundLabelNumber,
  paperDimensions,
  placementLimits,
  sanitizeLabelSettings,
  type LabelLayout,
  type LabelSettings,
} from "./equipmentLabel";
import { labelText } from "./equipmentLabelTranslations";
import "./equipment-label-editor.css";

type Props = { equipment: Equipment; area: Area | null; qr: string; onClose: () => void };

export function EquipmentLabelEditor({ equipment, area, qr, onClose }: Props) {
  const language = useLanguage();
  const tr = (source: string) => labelText(source, language);
  const [settings, setSettings] = useState<LabelSettings>(defaultLabelSettings);
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState({ width: 0, height: 0, scale: 1 });
  const [hasOverflow, setHasOverflow] = useState(false);
  const [formResetKey, setFormResetKey] = useState(0);
  const [placementResetKey, setPlacementResetKey] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const dragRef = useRef<{ pointerId: number; grabX: number; grabY: number } | null>(null);
  const paper = paperDimensions(settings);
  const limits = placementLimits(settings);
  const sizeLimits = labelSizeLimits(settings.paper);
  const padding = paddingLimits(settings);
  const fullPagePreset = fullPrintablePreset(settings.paper);
  const presets = fullPagePreset ? [...labelPresets, fullPagePreset] : labelPresets;
  const maxQr = maxQrMm(settings);
  const labelPageCss = useMemo(
    () =>
      settings.paper === "label"
        ? `@page equipment-label { size: ${settings.widthMm}mm ${settings.heightMm}mm; margin: 0; }`
        : "",
    [settings.heightMm, settings.paper, settings.widthMm],
  );
  const update = (next: Partial<LabelSettings>) =>
    setSettings((current) => sanitizeLabelSettings({ ...current, ...next }));
  const style = useMemo(
    () =>
      ({
        "--paper-width": `${paper.widthMm}mm`,
        "--paper-height": `${paper.heightMm}mm`,
        "--label-width": `${settings.widthMm}mm`,
        "--label-height": `${settings.heightMm}mm`,
        "--label-x": `${settings.positionXmm}mm`,
        "--label-y": `${settings.positionYmm}mm`,
        "--label-padding": `${settings.paddingMm}mm`,
        "--label-qr-size": `${settings.qrMm}mm`,
        "--label-font-size": `${settings.fontSizePt}pt`,
      }) as CSSProperties,
    [paper, settings],
  );
  const lines = [
    settings.showInventory && <strong key="inventory">{equipment.inventory_number}</strong>,
    settings.showName && <span key="name">{equipment.name}</span>,
    settings.showArea && <small key="area">{area ? `${area.code} · ${area.name}` : "—"}</small>,
    settings.showType && <small key="type">{equipment.equipment_type}</small>,
  ].filter(Boolean);

  useLayoutEffect(() => {
    const viewport = viewportRef.current,
      sheet = sheetRef.current;
    if (!viewport || !sheet) return;
    let frame = 0;
    const measure = () => {
      const surface = getComputedStyle(viewport);
      const available =
        viewport.clientWidth - parseFloat(surface.paddingLeft) - parseFloat(surface.paddingRight);
      const width = sheet.offsetWidth,
        height = sheet.offsetHeight;
      const scale = width ? Math.min(1, Math.max(0.08, available / width)) * zoom : 1;
      const label = sheet.querySelector<HTMLElement>(".equipment-label-print"),
        copy = copyRef.current,
        qr = sheet.querySelector<HTMLElement>(".equipment-label-qr");
      const pageBox = sheet.getBoundingClientRect(),
        labelBox = label?.getBoundingClientRect(),
        copyBox = copy?.getBoundingClientRect(),
        qrBox = qr?.getBoundingClientRect();
      const outside =
        labelBox &&
        (labelBox.left < pageBox.left - 1 ||
          labelBox.top < pageBox.top - 1 ||
          labelBox.right > pageBox.right + 1 ||
          labelBox.bottom > pageBox.bottom + 1);
      const outsideLabel =
        labelBox &&
        [copyBox, qrBox].some(
          (box) =>
            box &&
            (box.left < labelBox.left - 1 ||
              box.top < labelBox.top - 1 ||
              box.right > labelBox.right + 1 ||
              box.bottom > labelBox.bottom + 1),
        );
      const overlap =
        copyBox &&
        qrBox &&
        copyBox.left < qrBox.right - 1 &&
        copyBox.right > qrBox.left + 1 &&
        copyBox.top < qrBox.bottom - 1 &&
        copyBox.bottom > qrBox.top + 1;
      const descendants = copy ? Array.from(copy.children) : [];
      setPreview((current) =>
        current.width === width && current.height === height && current.scale === scale
          ? current
          : { width, height, scale },
      );
      setHasOverflow(
        Boolean(
          outside ||
          outsideLabel ||
          overlap ||
          (copy && (copy.scrollWidth > copy.clientWidth + 1 || copy.scrollHeight > copy.clientHeight + 1)) ||
          descendants.some(
            (item) => item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1,
          ),
        ),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    observer.observe(sheet);
    if (copyRef.current) observer.observe(copyRef.current);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [settings, zoom, lines.length]);

  // The browser menu/keyboard can print without blurring an edited field first.
  useEffect(() => {
    const commitFocusedField = () => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && formRef.current?.contains(active)) {
        flushSync(() => active.blur());
      }
    };
    window.addEventListener("beforeprint", commitFocusedField);
    return () => window.removeEventListener("beforeprint", commitFocusedField);
  }, []);
  const move = (x: number, y: number) => {
    update({ positionXmm: x, positionYmm: y });
    setPlacementResetKey((current) => current + 1);
  };
  const print = () => {
    if (!formRef.current?.reportValidity()) return;
    window.print();
  };
  const drag = (event: PointerEvent<HTMLElement>) => {
    const dragState = dragRef.current;
    if (settings.paper === "label" || dragState?.pointerId !== event.pointerId) return;
    const box = sheetRef.current?.getBoundingClientRect();
    if (!box) return;
    move(
      ((event.clientX - box.left) / box.width) * paper.widthMm - dragState.grabX,
      ((event.clientY - box.top) / box.height) * paper.heightMm - dragState.grabY,
    );
  };
  const nudge = (event: KeyboardEvent<HTMLElement>) => {
    const amount = event.shiftKey ? 10 : 1;
    const delta =
      event.key === "ArrowLeft"
        ? [-amount, 0]
        : event.key === "ArrowRight"
          ? [amount, 0]
          : event.key === "ArrowUp"
            ? [0, -amount]
            : event.key === "ArrowDown"
              ? [0, amount]
              : null;
    if (!delta || settings.paper === "label") return;
    event.preventDefault();
    move(settings.positionXmm + delta[0], settings.positionYmm + delta[1]);
  };

  return (
    <Dialog
      title={tr("Редактор наклейки")}
      subtitle={tr("Настройте размер, бумагу и положение перед печатью.")}
      onClose={onClose}
      size="wide"
    >
      {labelPageCss && <style>{labelPageCss}</style>}
      <section className="equipment-label-editor" data-testid="equipment-label-editor">
        <p className="equipment-label-print-error">
          {tr("Наклейка не напечатана. Исправьте значения или размер содержимого в редакторе.")}
        </p>
        <div className="equipment-label-editor-body">
          <form
            key={formResetKey}
            ref={formRef}
            className="equipment-label-controls"
            onSubmit={(event) => event.preventDefault()}
          >
            <p className="equipment-label-field-note">
              {tr("Можно вводить точку или запятую. Точность — 0,1 мм / пт.")}
            </p>
            <fieldset>
              <legend>{tr("Наклейка")}</legend>
              <label>
                <span>{tr("Формат")}</span>
                <select
                  value={labelPresetId(settings)}
                  onChange={(event) => {
                    const preset = presets.find((item) => item.id === event.target.value);
                    if (preset) {
                      setFormResetKey((current) => current + 1);
                      const next = sanitizeLabelSettings({
                        ...settings,
                        widthMm: preset.widthMm,
                        heightMm: preset.heightMm,
                      });
                      update({
                        widthMm: preset.widthMm,
                        heightMm: preset.heightMm,
                        ...centeredPlacement(next),
                      });
                    }
                  }}
                >
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">{tr("Свой размер")}</option>
                </select>
              </label>
              <div className="equipment-label-number-pair">
                <NumberField
                  label={tr("Ширина, мм")}
                  value={settings.widthMm}
                  min={sizeLimits.minWidthMm}
                  max={sizeLimits.maxWidthMm}
                  onCommit={(widthMm) => update({ widthMm })}
                  rangeMessage={`${tr("Допустимо")}: ${sizeLimits.minWidthMm}–${sizeLimits.maxWidthMm} мм`}
                  validationMessage={tr("Введите число в допустимом диапазоне.")}
                />
                <NumberField
                  label={tr("Высота, мм")}
                  value={settings.heightMm}
                  min={sizeLimits.minHeightMm}
                  max={sizeLimits.maxHeightMm}
                  onCommit={(heightMm) => update({ heightMm })}
                  rangeMessage={`${tr("Допустимо")}: ${sizeLimits.minHeightMm}–${sizeLimits.maxHeightMm} мм`}
                  validationMessage={tr("Введите число в допустимом диапазоне.")}
                />
              </div>
              <div className="equipment-label-number-pair">
                <NumberField
                  label={tr("QR-код, мм")}
                  value={settings.qrMm}
                  min={10}
                  max={maxQr}
                  onCommit={(qrMm) => update({ qrMm })}
                  rangeMessage={`${tr("Допустимо")}: 10–${maxQr} мм`}
                  validationMessage={tr("Введите число в допустимом диапазоне.")}
                />
                <NumberField
                  label={tr("Отступ, мм")}
                  value={settings.paddingMm}
                  min={1.5}
                  max={padding.maxMm}
                  onCommit={(paddingMm) => update({ paddingMm })}
                  rangeMessage={`${tr("Допустимо")}: ${padding.minMm}–${padding.maxMm} мм`}
                  validationMessage={tr("Введите число в допустимом диапазоне.")}
                />
              </div>
            </fieldset>
            <fieldset>
              <legend>{tr("Бумага и положение")}</legend>
              <label>
                <span>{tr("Бумага")}</span>
                <select
                  value={settings.paper}
                  onChange={(event) => {
                    const paper = event.target.value as LabelSettings["paper"];
                    setFormResetKey((current) => current + 1);
                    const next = sanitizeLabelSettings({ ...settings, paper });
                    update({ paper, ...centeredPlacement(next) });
                  }}
                >
                  {labelPapers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {tr(item.label)}
                    </option>
                  ))}
                </select>
              </label>
              {settings.paper !== "label" && (
                <>
                  <div className="equipment-label-number-pair">
                    <NumberField
                      resetKey={placementResetKey}
                      label={tr("Слева, мм")}
                      value={settings.positionXmm}
                      min={limits.minX}
                      max={limits.maxX}
                      onCommit={(positionXmm) => update({ positionXmm })}
                      rangeMessage={`${tr("Допустимо")}: ${limits.minX}–${limits.maxX} мм`}
                      validationMessage={tr("Введите число в допустимом диапазоне.")}
                    />
                    <NumberField
                      resetKey={placementResetKey}
                      label={tr("Сверху, мм")}
                      value={settings.positionYmm}
                      min={limits.minY}
                      max={limits.maxY}
                      onCommit={(positionYmm) => update({ positionYmm })}
                      rangeMessage={`${tr("Допустимо")}: ${limits.minY}–${limits.maxY} мм`}
                      validationMessage={tr("Введите число в допустимом диапазоне.")}
                    />
                  </div>
                  <div className="equipment-label-position-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const placement = centeredPlacement(settings);
                        move(placement.positionXmm, placement.positionYmm);
                      }}
                    >
                      {tr("По центру листа")}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => move(limits.minX, limits.minY)}
                    >
                      {tr("В верхний левый угол")}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => move(limits.maxX, limits.maxY)}
                    >
                      {tr("В нижний правый угол")}
                    </button>
                  </div>
                </>
              )}
              <p className="equipment-label-field-note">
                {tr("На A4 доступная область начинается в 8 мм от края листа.")}
              </p>
            </fieldset>
            <fieldset>
              <legend>{tr("Макет и текст")}</legend>
              <label>
                <span>{tr("Макет")}</span>
                <select
                  value={settings.layout}
                  onChange={(event) => update({ layout: event.target.value as LabelLayout })}
                >
                  <option value="left">{tr("QR слева")}</option>
                  <option value="right">{tr("QR справа")}</option>
                  <option value="top">{tr("Текст сверху")}</option>
                </select>
              </label>
              <div className="equipment-label-toggles">
                <Toggle
                  label={tr("Инвентарный номер")}
                  checked={settings.showInventory}
                  onChange={(showInventory) => update({ showInventory })}
                />
                <Toggle
                  label={tr("Название")}
                  checked={settings.showName}
                  onChange={(showName) => update({ showName })}
                />
                <Toggle
                  label={tr("Участок")}
                  checked={settings.showArea}
                  onChange={(showArea) => update({ showArea })}
                />
                <Toggle
                  label={tr("Тип")}
                  checked={settings.showType}
                  onChange={(showType) => update({ showType })}
                />
              </div>
              <div className="equipment-label-number-pair">
                <NumberField
                  label={tr("Размер шрифта, пт")}
                  value={settings.fontSizePt}
                  min={6}
                  max={96}
                  onCommit={(fontSizePt) => update({ fontSizePt })}
                  rangeMessage={`${tr("Допустимо")}: 6–96 пт`}
                  validationMessage={tr("Введите число в допустимом диапазоне.")}
                />
                <label>
                  <span>{tr("Выравнивание")}</span>
                  <select
                    value={settings.textAlign}
                    onChange={(event) =>
                      update({ textAlign: event.target.value === "center" ? "center" : "left" })
                    }
                  >
                    <option value="left">{tr("По левому краю")}</option>
                    <option value="center">{tr("По центру")}</option>
                  </select>
                </label>
              </div>
            </fieldset>
          </form>
          <div className="equipment-label-preview-wrap">
            <div className="equipment-label-preview-toolbar">
              <p className="equipment-label-preview-title">{tr("Предпросмотр листа")}</p>
              <label>
                <span>{tr("Масштаб экрана")}</span>
                <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                  <option value={0.75}>75%</option>
                  <option value={1}>100%</option>
                  <option value={1.25}>125%</option>
                  <option value={2}>200%</option>
                  <option value={3}>300%</option>
                </select>
              </label>
            </div>
            <div className="equipment-label-preview-surface" ref={viewportRef}>
              <div
                className="equipment-label-preview-canvas"
                style={
                  preview.width
                    ? { width: preview.width * preview.scale, height: preview.height * preview.scale }
                    : undefined
                }
              >
                <div
                  className="equipment-label-preview-scale"
                  style={{ transform: `scale(${preview.scale})` }}
                >
                  <article
                    ref={sheetRef}
                    className={`equipment-label-sheet equipment-label-sheet--${settings.paper}`}
                    style={style}
                  >
                    <div
                      className={`equipment-label-print equipment-label-print--${settings.layout}${lines.length ? "" : " equipment-label-print--qr-only"}`}
                      tabIndex={0}
                      role="group"
                      aria-label={tr("Наклейка: перетащите мышью или двигайте стрелками")}
                      onPointerDown={(event) => {
                        if (settings.paper !== "label" && event.button === 0) {
                          const labelBox = event.currentTarget.getBoundingClientRect();
                          dragRef.current = {
                            pointerId: event.pointerId,
                            grabX: ((event.clientX - labelBox.left) / labelBox.width) * settings.widthMm,
                            grabY: ((event.clientY - labelBox.top) / labelBox.height) * settings.heightMm,
                          };
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }
                      }}
                      onPointerMove={drag}
                      onPointerUp={() => {
                        dragRef.current = null;
                      }}
                      onPointerCancel={() => {
                        dragRef.current = null;
                      }}
                      onLostPointerCapture={() => {
                        dragRef.current = null;
                      }}
                      onKeyDown={nudge}
                    >
                      <div className="equipment-label-qr">
                        <img src={qr} alt="" draggable={false} />
                      </div>
                      {lines.length > 0 && (
                        <div
                          className="equipment-label-copy"
                          ref={copyRef}
                          style={{ textAlign: settings.textAlign }}
                        >
                          {lines}
                        </div>
                      )}
                    </div>
                  </article>
                </div>
              </div>
            </div>
            {hasOverflow && (
              <div className="equipment-label-overflow-warning" role="status">
                <strong>{tr("Печать недоступна: часть текста не помещается на наклейке.")}</strong>
                <span>{tr("Уменьшите шрифт или QR-код, увеличьте формат либо скройте часть текста.")}</span>
              </div>
            )}
            <p className="equipment-label-print-hint">
              {tr(
                "Предпросмотр повторяет миллиметры и положение при печати. Выберите фактический размер в диалоге принтера.",
              )}
            </p>
            <div className="equipment-label-editor-actions">
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setSettings(defaultLabelSettings);
                  setZoom(1);
                  setFormResetKey((current) => current + 1);
                }}
              >
                {tr("Сбросить")}
              </button>
              <button className="primary" type="button" disabled={hasOverflow} onClick={print}>
                {tr("Печать")}
              </button>
            </div>
          </div>
        </div>
      </section>
    </Dialog>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  rangeMessage,
  validationMessage,
  resetKey = 0,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  rangeMessage?: string;
  validationMessage: string;
  resetKey?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [previousValue, setPreviousValue] = useState(value);
  const [previousResetKey, setPreviousResetKey] = useState(resetKey);
  // Keep the input mounted so committing on blur does not lose the next click or Tab target.
  if (previousValue !== value || previousResetKey !== resetKey) {
    setPreviousResetKey(resetKey);
    setPreviousValue(value);
    setDraft(String(value));
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const rangeId = useId();
  const errorId = useId();
  const parsed = parseLabelNumber(draft);
  const invalid = parsed === null || parsed < min || parsed > max;
  const describedBy = [rangeMessage && rangeId, invalid && errorId].filter(Boolean).join(" ") || undefined;
  useLayoutEffect(() => {
    inputRef.current?.setCustomValidity(invalid ? validationMessage : "");
  }, [invalid, validationMessage]);
  const commit = () => {
    if (invalid) return;
    const next = roundLabelNumber(parsed);
    setDraft(String(next));
    onCommit(next);
  };
  return (
    <label>
      <span>{label}</span>
      <input
        ref={inputRef}
        type="text"
        role="spinbutton"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={draft}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={parsed ?? undefined}
        required
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-errormessage={invalid ? errorId : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const next = roundLabelNumber(
              Math.min(max, Math.max(min, (parsed ?? value) + (event.key === "ArrowUp" ? 0.1 : -0.1))),
            );
            setDraft(String(next));
            onCommit(next);
          }
        }}
      />
      {rangeMessage && (
        <small className="equipment-label-range" id={rangeId}>
          {rangeMessage}
        </small>
      )}
      {invalid && <small id={errorId}>{validationMessage}</small>}
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="equipment-label-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
