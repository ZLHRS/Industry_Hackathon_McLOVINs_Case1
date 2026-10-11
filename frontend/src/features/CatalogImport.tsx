import { Api, ApiError } from "../api";
import { Dialog } from "../components/Dialog";
import { message, t } from "../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogImportApplyResult, CatalogImportPreview, CatalogImportRow } from "../types";

const maxBytes = 2 * 1024 * 1024;
const pageSize = 10;

function totalCreate(preview: CatalogImportPreview) {
  return preview.equipment.create + preview.materials.create;
}
function totalErrors(preview: CatalogImportPreview) {
  return preview.equipment.error + preview.materials.error;
}
function rows(preview: CatalogImportPreview) {
  return [...preview.equipment.rows, ...preview.materials.rows];
}
function errorMessage(caught: unknown) {
  if (caught instanceof ApiError && caught.status === 409)
    return t("Справочник изменился. Проверьте файл заново.");
  if (caught instanceof ApiError && caught.status === 403) return t("Импорт доступен только администратору.");
  if (caught instanceof ApiError && caught.status === 413)
    return t("Файл больше 2 МБ. Уменьшите его и проверьте снова.");
  if (caught instanceof ApiError && caught.status === 422) {
    if (["invalid_import_headers", "invalid_import_sheets"].includes(caught.detail))
      return t("Скачайте шаблон и перенесите данные в его листы.");
    if (["unsafe_import_workbook", "import_formulas_not_allowed"].includes(caught.detail))
      return t("Файл содержит формулы или небезопасные элементы. Используйте значения из шаблона.");
    if (
      ["import_row_limit_exceeded", "import_sheet_limit_exceeded", "sheet_limit_exceeded"].includes(
        caught.detail,
      )
    )
      return t("В файле слишком много строк. Оставьте не более 500 строк и проверьте снова.");
    if (["invalid_import_workbook", "invalid_import_file"].includes(caught.detail))
      return t("Не удалось открыть файл. Скачайте шаблон и перенесите данные заново.");
    return t("Файл не прошёл проверку. Исправьте строки в шаблоне и проверьте его снова.");
  }
  return t("Не удалось проверить файл. Повторите попытку.");
}

function sheetName(sheet: string) {
  const normalized = sheet.trim().toLocaleLowerCase();
  if (normalized === "оборудование" || normalized === "equipment") return t("Оборудование");
  if (normalized === "материалы" || normalized === "materials") return t("Материалы");
  return sheet;
}

function fieldName(field: string | null) {
  if (!field) return t("Строка");
  const names: Record<string, string> = {
    area_code: t("Код участка"),
    inventory_number: t("Инвентарный номер"),
    name: t("Название"),
    equipment_type: t("Тип"),
    criticality: t("Критичность"),
    code: t("Код"),
    unit: t("Ед. изм."),
  };
  return names[field] ?? field.replaceAll("_", " ");
}

function rowValues(row: CatalogImportRow) {
  return Object.entries(row.values)
    .map(([field, value]) => [field, value == null ? "" : String(value).trim()] as const)
    .filter(([, value]) => value)
    .map(([field, value]) => `${fieldName(field)}: ${value}`)
    .join(" · ");
}

function statusLabel(status: CatalogImportRow["status"]) {
  if (status === "create") return t("Будет добавлено");
  if (status === "skip") return t("Пропущено как совпадение");
  return t("Требует исправления");
}

export function CatalogImport({
  api,
  onClose,
  onImported,
}: {
  api: Api;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [result, setResult] = useState<CatalogImportApplyResult | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [page, setPage] = useState(0);
  const request = useRef(0);
  const visibleRows = useMemo(
    () => (preview ? rows(preview).slice(page * pageSize, (page + 1) * pageSize) : []),
    [page, preview],
  );

  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const close = () => {
    if (applying) return;
    request.current += 1;
    onClose();
  };
  const downloadTemplate = async () => {
    setError("");
    try {
      const blob = await api.catalogImportTemplate();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "tekhnaryad-import.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 403
          ? errorMessage(caught)
          : t("Не удалось скачать шаблон."),
      );
    }
  };
  const selectFile = async (next: File | null) => {
    const id = ++request.current;
    setBytes(null);
    setPreview(null);
    setResult(null);
    setError("");
    setPage(0);
    setReading(false);
    setChecking(false);
    if (!next) return;
    if (!next.name.toLocaleLowerCase().endsWith(".xlsx")) {
      setError(t("Выберите файл Excel в формате .xlsx."));
      return;
    }
    if (next.size > maxBytes) {
      setError(t("Файл больше 2 МБ. Выберите другой файл."));
      return;
    }
    setReading(true);
    try {
      const content = await next.arrayBuffer();
      if (id === request.current) setBytes(content);
    } catch {
      if (id === request.current) setError(t("Не удалось прочитать файл."));
    } finally {
      if (id === request.current) setReading(false);
    }
  };
  const checkFile = async () => {
    if (!bytes || checking) return;
    const id = ++request.current;
    setChecking(true);
    setError("");
    setResult(null);
    setPreview(null);
    setPage(0);
    try {
      const next = await api.catalogImportPreview(bytes);
      if (id === request.current) {
        setPreview(next);
        setPage(0);
      }
    } catch (caught) {
      if (id === request.current) setError(errorMessage(caught));
    } finally {
      if (id === request.current) setChecking(false);
    }
  };
  const apply = async () => {
    if (!bytes || !preview || applying || totalErrors(preview) || totalCreate(preview) === 0) return;
    setApplying(true);
    setError("");
    try {
      const next = await api.catalogImportApply(bytes, preview.fingerprint);
      setResult(next);
      try {
        await onImported();
      } catch {
        setError(t("Записи добавлены, но список не обновился. Закройте окно и обновите справочник."));
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setPreview(null);
      setError(errorMessage(caught));
    } finally {
      setApplying(false);
    }
  };
  return (
    <Dialog title={t("Импорт Excel")} onClose={close}>
      <div
        className="catalog-import"
        data-testid="catalog-import"
        aria-busy={reading || checking || applying}
      >
        <ol className="catalog-import-steps">
          <li>
            <strong>{t("Скачать шаблон")}</strong>
            <p>{t("Один файл: листы «Оборудование» и «Материалы». Лист участков — только для справки.")}</p>
            <button
              className="secondary"
              type="button"
              onClick={() => void downloadTemplate()}
              disabled={applying}
            >
              {t("Скачать шаблон")}
            </button>
          </li>
          <li>
            <strong>{t("Выберите файл .xlsx")}</strong>
            <p>{t("Не более 500 строк и 2 МБ. Импорт только добавляет новые записи.")}</p>
            <input
              aria-label={t("Файл Excel")}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={applying}
              type="file"
              onChange={(event) => void selectFile(event.currentTarget.files?.[0] ?? null)}
            />
          </li>
          <li>
            <strong>{t("Проверить файл")}</strong>
            <p>{t("Проверка не меняет справочник. Записи будут добавлены только после подтверждения.")}</p>
            <button
              className="secondary"
              type="button"
              disabled={!bytes || reading || checking || applying}
              onClick={() => void checkFile()}
            >
              {checking ? t("Проверяем…") : t("Проверить файл")}
            </button>
          </li>
        </ol>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {preview && !result && <Preview preview={preview} page={page} rows={visibleRows} onPage={setPage} />}
        {result && (
          <p className="notice" role="status">
            {t("Добавлено: оборудование — {0}, материалы — {1}.", [
              result.created_equipment,
              result.created_materials,
            ])}
          </p>
        )}
        {preview && !result && (
          <div className="catalog-import-actions">
            <button className="secondary" type="button" disabled={applying} onClick={close}>
              {t("Отмена")}
            </button>
            <button
              className="primary"
              type="button"
              disabled={applying || checking || totalErrors(preview) > 0 || totalCreate(preview) === 0}
              onClick={() => void apply()}
            >
              {applying ? t("Добавляем…") : t("Добавить записи · {0}", [totalCreate(preview)])}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Preview({
  preview,
  page,
  rows,
  onPage,
}: {
  preview: CatalogImportPreview;
  page: number;
  rows: CatalogImportRow[];
  onPage: (page: number) => void;
}) {
  const count = totalCreate(preview);
  const errors = totalErrors(preview);
  const totalRows = preview.equipment.rows.length + preview.materials.rows.length;
  const lastPage = Math.max(0, Math.ceil(totalRows / pageSize) - 1);
  return (
    <section className="catalog-import-preview" aria-label={t("Результат проверки")}>
      <div className="catalog-import-counts">
        <span>{t("К добавлению: {0}", [count])}</span>
        <span>{t("Пропущено: {0}", [preview.equipment.skip + preview.materials.skip])}</span>
        <span className={errors ? "catalog-import-errors" : ""}>{t("Ошибки: {0}", [errors])}</span>
      </div>
      {preview.notes.map((note) => (
        <p className="muted" key={note}>
          {message(note)}
        </p>
      ))}
      {errors > 0 && <p className="error">{t("Исправьте ошибки: пока они есть, импорт не выполняется.")}</p>}
      <div className="catalog-import-rows">
        {rows.map((row) => (
          <article
            className={`catalog-import-row import-${row.status}`}
            data-testid={`catalog-import-row-${row.sheet}-${row.row}`}
            key={`${row.sheet}-${row.row}`}
          >
            <strong>
              {sheetName(row.sheet)} · {t("строка {0}", [row.row])}
            </strong>
            <span>{rowValues(row) || row.key}</span>
            <span className="catalog-import-row-status">{statusLabel(row.status)}</span>
            {row.errors.map((item) => (
              <small key={`${item.field}-${item.code}`}>
                {fieldName(item.field)}: {message(item.message)}
              </small>
            ))}
          </article>
        ))}
      </div>
      {totalRows > pageSize && (
        <div className="catalog-import-pages">
          <button
            className="text-button"
            type="button"
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
          >
            {t("Назад")}
          </button>
          <span>
            {page + 1} / {lastPage + 1}
          </span>
          <button
            className="text-button"
            type="button"
            disabled={page === lastPage}
            onClick={() => onPage(page + 1)}
          >
            {t("Вперёд")}
          </button>
        </div>
      )}
    </section>
  );
}
