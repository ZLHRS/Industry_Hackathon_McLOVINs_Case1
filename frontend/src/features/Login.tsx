import { FormEvent, useState } from "react";
import type { ApiError } from "../api";

export function Login({ onLogin }: { onLogin: (login: string, secret: string) => Promise<void> }) {
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin(login, secret);
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
        <div className="mark">
          N<span>•</span>
        </div>
        <p className="eyebrow">СИСТЕМА РЕМОНТА</p>
        <h1>
          НАРЯД<span>AI</span>
        </h1>
        <p>Оперативный контур для участка: наряды, доказательства ремонта и актуальная загрузка смены.</p>
      </section>
      <form className="login-form" onSubmit={submit}>
        <h2>Вход в смену</h2>
        <p className="muted">Используйте выданную учётную запись.</p>
        <label>
          Логин
          <input
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            minLength={3}
            pattern="[a-z0-9][a-z0-9._\\-]{2,63}"
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            minLength={6}
          />
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
