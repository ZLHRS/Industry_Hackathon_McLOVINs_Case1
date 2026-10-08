import { useSyncExternalStore } from "react";
import { translations } from "./translations";

export type Language = "ru" | "kk" | "en";
export const languageStorageKey = "technaryad.language";
const locales: Record<Language, string> = { ru: "ru-RU", kk: "kk-KZ", en: "en-GB" };
const listeners = new Set<() => void>();
export const isLanguage = (value: unknown): value is Language =>
  value === "ru" || value === "kk" || value === "en";

function readLanguage(): Language {
  try {
    const stored = localStorage.getItem(languageStorageKey);
    if (isLanguage(stored)) return stored;
  } catch {
    /* Preferences must never prevent signing in or working offline. */
  }
  return "ru";
}
let language: Language = readLanguage();
export const getLanguage = () => language;
export const getLocale = () => locales[language];

function updateDocument() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
    document.title = language === "en" ? "TechNaryad" : "ТехНаряд";
  }
}
updateDocument();

export function setLanguage(next: Language) {
  if (!isLanguage(next)) return;
  language = next;
  try {
    localStorage.setItem(languageStorageKey, next);
  } catch {
    /* In-memory preference still works. */
  }
  updateDocument();
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === languageStorageKey) {
      language = isLanguage(event.newValue) ? event.newValue : "ru";
      updateDocument();
      listeners.forEach((listener) => listener());
    }
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, () => "ru" as Language);
}

/** Translate application-owned copy only, never arbitrary user or API data. */
export function t(source: string, values: readonly unknown[] = []): string {
  const translated = language === "ru" ? source : (translations[source]?.[language] ?? source);
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder,
  );
}

/** Re-localize application messages already held in component/offline state. */
export function message(value: string): string {
  if (translations[value]) return t(value);
  for (const [source, labels] of Object.entries(translations)) {
    if (labels.kk === value || labels.en === value) return t(source);
  }
  return value;
}
