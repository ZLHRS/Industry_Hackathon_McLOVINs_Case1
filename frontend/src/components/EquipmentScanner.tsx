import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { t } from "../lib/i18n";
import { scannedEquipmentId } from "../lib/equipmentQr";
import "./equipment-scanner.css";

export function EquipmentScanner({ onOpen }: { onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const closeOnDesktop = () => {
      if (!media.matches) setOpen(false);
    };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  return (
    <>
      <button
        type="button"
        className="app-preferences-toggle equipment-scan-toggle"
        aria-label={t("Сканировать QR оборудования")}
        title={t("Сканировать QR оборудования")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="qr" />
      </button>
      {open && (
        <ScannerDialog
          onClose={() => setOpen(false)}
          onOpen={(id) => {
            setOpen(false);
            onOpen(id);
          }}
        />
      )}
    </>
  );
}

function ScannerDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const [phase, setPhase] = useState<"idle" | "starting" | "scanning" | "reading">("idle");
  const [error, setError] = useState("");
  function stop() {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  useEffect(() => {
    const pause = () => {
      if (document.hidden) {
        stop();
        setPhase("idle");
      }
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", pause);
    };
  }, []);

  function accept(value: string): boolean {
    const id = scannedEquipmentId(value, window.location.origin);
    if (!id) {
      setError(t("Это не QR оборудования ТехНаряда. Наведите камеру на наклейку оборудования."));
      return false;
    }
    stop();
    onOpen(id);
    return true;
  }
  async function startCamera() {
    stop();
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(t("Камера доступна по HTTPS. Откройте защищённый адрес сайта или выберите фото QR."));
      setPhase("idle");
      return;
    }
    const attempt = generation.current;
    setPhase("starting");
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (attempt !== generation.current) {
        camera.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = camera;
      const player = video.current!;
      player.srcObject = camera;
      await player.play();
      const { default: decode } = await import("jsqr");
      if (attempt !== generation.current) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas_unavailable");
      setPhase("scanning");
      const scan = () => {
        if (attempt !== generation.current) return;
        try {
          if (player.readyState >= 2 && player.videoWidth) {
            const scale = Math.min(1, 960 / player.videoWidth);
            canvas.width = Math.round(player.videoWidth * scale);
            canvas.height = Math.round(player.videoHeight * scale);
            context.drawImage(player, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = decode(pixels.data, pixels.width, pixels.height);
            if (result && accept(result.data)) return;
          }
          timer.current = setTimeout(scan, 250);
        } catch {
          stop();
          setPhase("idle");
          setError(t("Не удалось прочитать изображение. Попробуйте другое фото QR."));
        }
      };
      scan();
    } catch (reason) {
      if (attempt !== generation.current) return;
      stop();
      setPhase("idle");
      setError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? t("Доступ к камере запрещён. Разрешите его в настройках браузера или выберите фото QR.")
          : t("Не удалось включить камеру. Закройте другие приложения с камерой или выберите фото QR."),
      );
    }
  }
  async function readPhoto(file: File) {
    stop();
    setError("");
    setPhase("reading");
    const attempt = generation.current;
    if (file.size > 20 * 1024 * 1024) {
      setError(t("Выберите изображение размером до 20 МБ."));
      setPhase("idle");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const { default: decode } = await import("jsqr");
      if (attempt !== generation.current) return;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas_unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = decode(pixels.data, pixels.width, pixels.height);
      if (result) {
        if (accept(result.data)) return;
      } else setError(t("QR-код не найден. Выберите чёткое фото, на котором код виден целиком."));
      setPhase("idle");
    } catch {
      if (attempt === generation.current) {
        setError(t("Не удалось прочитать изображение. Попробуйте другое фото QR."));
        setPhase("idle");
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const busy = phase === "starting" || phase === "reading";
  return (
    <Dialog
      title={t("Сканировать оборудование")}
      subtitle={t("Наведите камеру на QR-код на наклейке.")}
      onClose={onClose}
    >
      <div className="equipment-scanner">
        <div className="equipment-scanner-view" data-active={phase === "scanning"}>
          <video ref={video} muted playsInline aria-label={t("Камера сканера")} />
          <div className="equipment-scanner-frame" aria-hidden="true" />
          {phase !== "scanning" && (
            <div className="equipment-scanner-placeholder">
              <Icon name="qr" />
              <span>
                {phase === "starting"
                  ? t("Включаем камеру…")
                  : phase === "reading"
                    ? t("Читаем QR-код…")
                    : t("QR на оборудовании")}
              </span>
            </div>
          )}
        </div>
        <p className="muted" role="status">
          {phase === "scanning"
            ? t("Держите код в рамке. Карточка откроется автоматически.")
            : t("Откроется карточка оборудования с доступными вам сведениями и действиями.")}
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="equipment-scanner-actions">
          {phase === "scanning" ? (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                stop();
                setPhase("idle");
              }}
            >
              {t("Выключить камеру")}
            </button>
          ) : (
            <button className="primary" type="button" disabled={busy} onClick={() => void startCamera()}>
              <Icon name="camera" />
              {t("Включить камеру")}
            </button>
          )}
          <label className="equipment-scanner-file secondary" aria-disabled={busy}>
            <Icon name="download" />
            {t("Выбрать фото QR")}
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              aria-label={t("Выбрать фото QR")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readPhoto(file);
              }}
            />
          </label>
        </div>
        <small className="muted">
          {t("Изображение обрабатывается на устройстве и не отправляется на сервер.")}
        </small>
      </div>
    </Dialog>
  );
}
