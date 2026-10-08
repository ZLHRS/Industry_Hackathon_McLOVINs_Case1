import { isLanguage, setLanguage, useLanguage } from "../lib/i18n";

export function LanguageSwitcher() {
  const language = useLanguage();
  return (
    <label className="language-switcher">
      <select
        aria-label="Язык / Тіл / Language"
        value={language}
        onChange={(event) => {
          if (isLanguage(event.target.value)) setLanguage(event.target.value);
        }}
      >
        <option value="ru" lang="ru">
          Русский
        </option>
        <option value="kk" lang="kk">
          Қазақша
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
