import { afterEach, describe, expect, it, vi } from "vitest";
import { getLanguage, getLocale, languageStorageKey, message, setLanguage, t } from "./i18n";
import { translations } from "./translations";
import { navigation, permittedView, roleLabels } from "./roleAccess";
import { masterDecisionPayload, validateMasterDecision } from "../features/aiReview";

afterEach(() => {
  setLanguage("ru");
  vi.unstubAllGlobals();
});

describe("language preferences and translation boundaries", () => {
  it("keeps Russian as the default and works with unavailable storage", () => {
    expect(getLanguage()).toBe("ru");
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => setLanguage("kk")).not.toThrow();
    expect(getLocale()).toBe("kk-KZ");
    expect(t("Войти")).toBe("Кіру");
  });
  it("persists only the language preference", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    setLanguage("en");
    expect(setItem).toHaveBeenCalledExactlyOnceWith(languageStorageKey, "en");
    expect(getLocale()).toBe("en-GB");
  });
  it("updates imported labels without changing navigation or permissions", () => {
    const routes = navigation.master.map(([route]) => route);
    setLanguage("en");
    expect(roleLabels.master).toBe("Supervisor");
    expect(navigation.master.map(([route]) => route)).toEqual(routes);
    expect(navigation.master[0][1]).toBe("Work orders");
    expect(permittedView("executor", "employees")).toBe("orders");
    setLanguage("kk");
    expect(navigation.master[0][1]).toBe("Нарядтар");
  });
  it("preserves interpolated user content and unknown text verbatim", () => {
    setLanguage("en");
    const userText = "<script>Тест {1} & $&</script>";
    expect(t("История {0}", [userText])).toBe("History of " + userText);
    expect(t("Насос №12: заменить уплотнение")).toBe("Насос №12: заменить уплотнение");
    expect(t("История {0}")).toBe("History of {0}");
  });
  it("re-localizes existing application errors without changing unknown server text", () => {
    setLanguage("en");
    const error = t("Неверный логин или пароль.");
    setLanguage("kk");
    expect(message(error)).toBe("Логин немесе пароль қате.");
    expect(message("Текст мастера: Неверный логин или пароль.")).toBe(
      "Текст мастера: Неверный логин или пароль.",
    );
  });
  it.each(["ru", "kk", "en"] as const)(
    "keeps decision payload and validation semantics in %s",
    (language) => {
      setLanguage(language);
      expect(masterDecisionPayload("override_close", " Насос тексерілді ", "4")).toEqual({
        reason: "Насос тексерілді",
        master_score: 4,
      });
      expect(validateMasterDecision({ action: "close", reason: "OK", score: "9" })).toBeTruthy();
      expect(validateMasterDecision({ action: "close", reason: "OK", score: "" })).toBeNull();
    },
  );
});

describe("complete interface catalogs", () => {
  it("includes both languages with all original placeholders preserved", () => {
    expect(Object.keys(translations).length).toBeGreaterThan(750);
    const parameters = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
    for (const [source, entry] of Object.entries(translations)) {
      for (const language of ["kk", "en"] as const) {
        expect(entry[language].trim(), source).not.toBe("");
        expect(parameters(entry[language]), source + ":" + language).toEqual(parameters(source));
      }
    }
  });
});
