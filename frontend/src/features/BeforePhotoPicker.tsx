import { useEffect, useId, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { t } from "../lib/i18n";

export const maxBeforePhotos = 5;
const accepted = ["image/jpeg", "image/png", "image/webp"];

/** Optional fault photos for the issue form (case §5.1: camera or gallery, up to 5). */
export function BeforePhotoPicker({
  files,
  aiShareAllowed,
  disabled,
  onFiles,
  onAiShareAllowed,
}: {
  files: File[];
  aiShareAllowed: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onAiShareAllowed: (value: boolean) => void;
}) {
  const inputId = useId();
  const [notice, setNotice] = useState("");
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  const add = (selected: FileList | null) => {
    const images = [...(selected ?? [])].filter((file) => accepted.includes(file.type));
    const room = maxBeforePhotos - files.length;
    setNotice(
      images.length > room
        ? t("Можно приложить до 5 фото.")
        : images.length < (selected?.length ?? 0)
          ? t("Подходят фото JPEG, PNG или WebP.")
          : "",
    );
    if (images.length && room > 0) onFiles([...files, ...images.slice(0, room)]);
  };
  return (
    <section className="before-photo-picker" aria-label={t("Фото неисправности")}>
      <div className="before-photo-row">
        {files.length < maxBeforePhotos && (
          <label className="secondary with-icon before-photo-add" htmlFor={inputId}>
            <Icon name="camera" />
            {files.length ? t("Ещё фото") : t("Фото неисправности")}
            <input
              id={inputId}
              className="sr-only"
              type="file"
              accept={accepted.join(",")}
              multiple
              disabled={disabled}
              onChange={(event) => {
                add(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        )}
        <small className="muted">
          {files.length
            ? t("Фото: {0} из {1}", [files.length, maxBeforePhotos])
            : t("Необязательно, до 5 фото")}
        </small>
      </div>
      {files.length > 0 && (
        <ul className="before-photo-list">
          {files.map((file, index) => (
            <li key={file.name + file.lastModified + index}>
              <img src={previews[index]} alt={t("Фото неисправности {0}", [index + 1])} />
              <button
                type="button"
                className="before-photo-remove"
                disabled={disabled}
                onClick={() => onFiles(files.filter((_, position) => position !== index))}
                aria-label={t("Убрать фото {0}", [index + 1])}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <label className="check before-photo-consent">
          <input
            type="checkbox"
            checked={aiShareAllowed}
            disabled={disabled}
            onChange={(event) => onAiShareAllowed(event.target.checked)}
          />
          {t("На фото только оборудование, личные и конфиденциальные данные скрыты. Разрешить анализ ИИ.")}
        </label>
      )}
      {notice && (
        <p className="muted before-photo-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
