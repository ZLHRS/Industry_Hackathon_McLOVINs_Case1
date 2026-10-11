import { Dialog } from "../components/Dialog";
import { Api, ApiError } from "../api";
import { getLanguage, message, t } from "../lib/i18n";
import { local, ruStatus } from "./OrderDetail";
import { useEffect, useRef, useState } from "react";
import type { Catalog, MasterAssistantAnswer, MasterAssistantTopic } from "../types";

const prompts: Array<{ label: string; topic: MasterAssistantTopic }> = [
  { label: "Что требует внимания?", topic: "attention" },
  { label: "Повторные неисправности", topic: "repeated_faults" },
  { label: "Как ремонтировали раньше?", topic: "accepted_repair_history" },
];

function answerError(caught: unknown) {
  if (caught instanceof ApiError && caught.status === 403) return t("Помощник доступен только мастеру.");
  if (
    caught instanceof ApiError &&
    caught.status === 429 &&
    ["assistant_busy", "assistant_rate_limited"].includes(caught.detail)
  )
    return t("Помощник занят. Повторите через минуту.");
  if (caught instanceof ApiError && caught.status === 422) return t("Уточните вопрос и попробуйте снова.");
  return t("Не удалось получить ответ. Повторите попытку.");
}

function period(answer: MasterAssistantAnswer) {
  if (!answer.period.from) return t("Не указан");
  return `${local(answer.period.from)} — ${local(answer.period.to)}`;
}

export function MasterAssistant({
  api,
  catalog,
  open,
  onClose,
  onOpenOrder,
}: {
  api: Api;
  catalog: Catalog;
  open: boolean;
  onClose: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [topic, setTopic] = useState<MasterAssistantTopic | null>(null);
  const [equipmentId, setEquipmentId] = useState("");
  const [answer, setAnswer] = useState<MasterAssistantAnswer | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const selectedEquipment = catalog.equipment.find((item) => item.id === equipmentId) ?? null;

  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const invalidateAnswer = () => {
    request.current += 1;
    setLoading(false);
    setAnswer(null);
    setError("");
  };
  const close = () => {
    request.current += 1;
    setLoading(false);
    onClose();
  };
  const choosePrompt = (prompt: (typeof prompts)[number]) => {
    invalidateAnswer();
    setQuestion(t(prompt.label));
    setTopic(prompt.topic);
  };
  const changeQuestion = (value: string) => {
    invalidateAnswer();
    setQuestion(value);
    setTopic(null);
  };
  const changeEquipment = (value: string) => {
    invalidateAnswer();
    setEquipmentId(value);
  };
  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError(t("Помощник работает при подключении к сети."));
      return;
    }
    const id = ++request.current;
    setLoading(true);
    setError("");
    setAnswer(null);
    try {
      const next = await api.masterAssistant({
        question: trimmed,
        topic,
        area_id: selectedEquipment?.area_id ?? null,
        equipment_id: selectedEquipment?.id ?? null,
        language: getLanguage(),
      });
      if (id === request.current) setAnswer(next);
    } catch (caught) {
      if (id === request.current) setError(answerError(caught));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const openCitation = (id: string) => {
    request.current += 1;
    setLoading(false);
    onOpenOrder(id);
  };

  if (!open) return null;
  return (
    <Dialog title={t("Помощник мастера")} onClose={close}>
      <section className="master-assistant" data-testid="master-assistant" aria-busy={loading}>
        <p className="muted">{t("Справка по данным нарядов. Решение и действия остаются за мастером.")}</p>
        <div className="master-assistant-prompts" aria-label={t("Варианты вопроса")}>
          {prompts.map((prompt) => (
            <button
              className={topic === prompt.topic ? "secondary is-selected" : "secondary"}
              type="button"
              key={prompt.topic}
              onClick={() => choosePrompt(prompt)}
            >
              {t(prompt.label)}
            </button>
          ))}
        </div>
        <label className="master-assistant-question">
          {t("Вопрос помощнику")}
          <textarea
            value={question}
            maxLength={500}
            rows={3}
            onChange={(event) => changeQuestion(event.target.value)}
            placeholder={t("Например, что сейчас требует внимания?")}
          />
          <small>{t("До 500 символов")}</small>
        </label>
        <label className="master-assistant-equipment">
          {t("Оборудование для ответа")}
          <select value={equipmentId} onChange={(event) => changeEquipment(event.target.value)}>
            <option value="">{t("Всё доступное оборудование")}</option>
            {catalog.equipment.map((equipment) => (
              <option key={equipment.id} value={equipment.id}>
                {equipment.inventory_number} · {equipment.name}
                {equipment.is_active === false ? ` (${t("В архиве")})` : ""}
              </option>
            ))}
          </select>
        </label>
        {topic === "accepted_repair_history" && !selectedEquipment && (
          <p className="muted master-assistant-history-hint">
            {t("Для истории выберите оборудование или уточните неисправность.")}
          </p>
        )}
        <div className="master-assistant-actions">
          <button className="secondary" type="button" disabled={loading} onClick={close}>
            {t("Закрыть")}
          </button>
          <button
            className="primary"
            type="button"
            disabled={!question.trim() || loading}
            onClick={() => void ask()}
          >
            {loading ? t("Ищем…") : t("Спросить")}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loading && (
          <p className="muted" role="status">
            {t("Ищем по доступным нарядам…")}
          </p>
        )}
        {answer && <Answer answer={answer} onOpenOrder={openCitation} />}
      </section>
    </Dialog>
  );
}

function Answer({
  answer,
  onOpenOrder,
}: {
  answer: MasterAssistantAnswer;
  onOpenOrder: (id: string) => void;
}) {
  const hasDataAnswer = answer.answer_source === "data";
  return (
    <section className="master-assistant-answer" data-testid="assistant-answer">
      <p>{answer.answer}</p>
      {hasDataAnswer && answer.no_data && (
        <p className="muted">{t("По выбранному запросу подтверждённых нарядов не найдено.")}</p>
      )}
      {hasDataAnswer && (
        <dl className="master-assistant-facts">
          <div>
            <dt>{t("Найдено нарядов")}</dt>
            <dd>{answer.matching_orders}</dd>
          </div>
          <div>
            <dt>{t("Период данных")}</dt>
            <dd>{period(answer)}</dd>
          </div>
          <div>
            <dt>{t("Данные на")}</dt>
            <dd>{local(answer.measured_at)}</dd>
          </div>
        </dl>
      )}
      {hasDataAnswer &&
        answer.limitations.map((item) => (
          <p className="muted" key={item}>
            {message(item)}
          </p>
        ))}
      {hasDataAnswer && answer.truncated && (
        <p className="muted">{t("Показана часть подходящих нарядов.")}</p>
      )}
      {hasDataAnswer && answer.citations.length > 0 && (
        <section className="master-assistant-citations" aria-label={t("Наряды-основания")}>
          <h3>{t("Наряды-основания")}</h3>
          {answer.citations.map((citation) => (
            <article className="master-assistant-citation" key={citation.order_id}>
              <button type="button" onClick={() => onOpenOrder(citation.order_id)}>
                {t("Открыть наряд {0}", [citation.number])}
              </button>
              <strong>
                {citation.equipment_inventory_number} · {citation.equipment_name}
              </strong>
              <span>{ruStatus[citation.status] ?? citation.status}</span>
              <small>{citation.evidence}</small>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
