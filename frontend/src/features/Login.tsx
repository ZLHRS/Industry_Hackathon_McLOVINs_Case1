import { FormEvent, useState } from "react";
import type { ApiError } from "../api";

export function Login({ onLogin }: { onLogin: (login: string, secret: string) => Promise<void> }) {
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin(login.trim(), secret);
    } catch (caught) {
      const failure = caught as ApiError;
      setError(
        failure.status === 401
          ? "Неверный логин или пароль."
          : failure.status === 429
            ? "Слишком много попыток. Повторите позже."
            : "Не удалось войти. Проверьте подключение.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="login-brand-top">
          <div className="mark">
            Т<span>•</span>
          </div>
          <span>Костанайские минералы</span>
        </div>
        <p className="eyebrow">СИСТЕМА РЕМОНТА</p>
        <h1>
          Тех<span>Наряд</span>
        </h1>
        <p>Рабочий контур смены: наряды, ремонт и загрузка участка.</p>
        <div className="login-points" aria-label="Возможности системы">
          <span>Наряды</span>
          <span>Ремонт</span>
          <span>Смена</span>
        </div>
      </section>
      <form className="login-form" onSubmit={submit}>
        <h2>Вход в смену</h2>
        <p className="muted">Введите данные учётной записи для начала смены.</p>
        <label>
          Логин
          <input
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value.trim())}
            onBlur={() => setLogin((value) => value.trim())}
            required
            minLength={3}
            pattern="[a-z0-9][a-z0-9._\\-]{2,63}"
          />
        </label>
        <label className="password-field">
          Пароль
          <input
            type={showSecret ? "text" : "password"}
            aria-label="Пароль"
            autoComplete="current-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            minLength={6}
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowSecret((value) => !value)}
            aria-label={showSecret ? "Скрыть пароль" : "Показать пароль"}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              {showSecret ? (
                <>
                  <path d="m3 3 18 18" />
                  <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c5.2 0 8.8 4.2 9.7 6.8a1 1 0 0 1 0 .5 11.7 11.7 0 0 1-3.3 4.5M6.2 6.2A11.7 11.7 0 0 0 2.3 11.8a1 1 0 0 0 0 .5C3.2 14.8 6.8 19 12 19c1 0 2-.2 2.9-.6" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </>
              ) : (
                <>
                  <path d="M2.3 12C3.2 9.3 6.8 5 12 5s8.8 4.3 9.7 7c-.9 2.7-4.5 7-9.7 7S3.2 14.7 2.3 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Проверяем…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
