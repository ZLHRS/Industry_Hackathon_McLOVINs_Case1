import { message, t } from "../lib/i18n";
import { local, ruStatus } from "./OrderDetail";
import "./readable-reasons.css";
import { OrderReference } from "../components/OrderReference";
import { useEffect, useRef, useState } from "react";
import type { OrderDetail, SimilarRepair, SimilarRepairs, SimilarRepairsRequest } from "../types";

type Props = {
  input: SimilarRepairsRequest | null;
  requestKey: string;
  onLoad: (input: SimilarRepairsRequest) => Promise<SimilarRepairs>;
  onViewEvidence?: (id: string) => Promise<OrderDetail>;
};

const reasonText = (reason: SimilarRepair["match"]["reason_codes"][number]) =>
  ({
    same_equipment: t("То же оборудование"),
    compatible_equipment_type: t("Совместимый тип оборудования"),
    same_fault_code: t("Тот же шифр неисправности"),
    matching_text: t("Совпадение по описанию"),
  })[reason];

function followupText(item: SimilarRepair) {
  const { status, observed_days: days, window_days: window, repeat_count: repeats } = item.followup;
  if (status === "observed_repeat") return t("Повтор за {0} дн.: {1}", [window, repeats ?? 0]);
  if (status === "none_recorded") return t("За {0} дн. повторов не зафиксировано", [window]);
  if (status === "observing") return t("Наблюдение: {0} из {1} дн.", [days, window]);
  return t("Повтор не оценён");
}

export function SimilarRepairsPanel({ input, requestKey, onLoad, onViewEvidence }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="similar-repairs"
      data-testid="similar-repairs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("Похожие ремонты")}</summary>
      {open && (
        <SimilarRepairsResults
          key={requestKey}
          input={input}
          onLoad={onLoad}
          onViewEvidence={onViewEvidence}
        />
      )}
    </details>
  );
}

function SimilarRepairsResults({ input, onLoad, onViewEvidence }: Omit<Props, "requestKey">) {
  const [data, setData] = useState<SimilarRepairs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState<OrderDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceErrorFor, setSourceErrorFor] = useState("");
  const request = useRef(0);
  const sourceRequest = useRef(0);
  const loadRef = useRef(onLoad);
  const sourceRef = useRef(onViewEvidence);

  useEffect(() => {
    loadRef.current = onLoad;
  }, [onLoad]);
  useEffect(() => {
    sourceRef.current = onViewEvidence;
  }, [onViewEvidence]);
  useEffect(() => {
    if (!input) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void loadRef
        .current(input)
        .then((result) => {
          if (id === request.current) setData(result);
        })
        .catch(() => {
          if (id === request.current) setError(t("Не удалось загрузить похожие ремонты."));
        })
        .finally(() => {
          if (id === request.current) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      request.current += 1;
      sourceRequest.current += 1;
    };
  }, [input, refresh]);

  async function viewSource(orderId: string) {
    if (!sourceRef.current) return;
    if (source?.id === orderId) {
      sourceRequest.current += 1;
      setSource(null);
      setSourceLoading("");
      setSourceError("");
      setSourceErrorFor("");
      return;
    }
    const id = ++sourceRequest.current;
    setSource(null);
    setSourceError("");
    setSourceErrorFor("");
    setSourceLoading(orderId);
    try {
      const result = await sourceRef.current(orderId);
      if (id === sourceRequest.current) setSource(result);
    } catch {
      if (id === sourceRequest.current) {
        setSourceError(t("Не удалось открыть связанный наряд."));
        setSourceErrorFor(orderId);
      }
    } finally {
      if (id === sourceRequest.current) setSourceLoading("");
    }
  }

  return (
    <div className="similar-repairs-content">
      {!input && <p className="muted">{t("Выберите оборудование и заполните описание.")}</p>}
      {input && loading && <p className="muted">{t("Ищем похожие ремонты…")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setError("");
              setRefresh((value) => value + 1);
            }}
          >
            {t("Повторить")}
          </button>
        </p>
      )}
      {data && !loading && data.items.length === 0 && (
        <p className="muted">{t("Подходящих закрытых ремонтов не найдено.")}</p>
      )}
      {data?.items.map((item) => (
        <article
          className="similar-repair"
          data-testid={`similar-repair-${item.order_id}`}
          key={item.order_id}
        >
          <details>
            <summary>
              <OrderReference description={item.description} number={item.number} />
              <span>
                {item.equipment_inventory_number} · {item.equipment_name}
              </span>
            </summary>
            <div className="similar-repair-detail">
              <ul className="similar-repair-reasons readable-reasons">
                {item.match.reason_codes.map((reason) => (
                  <li key={reason}>{reasonText(reason)}</li>
                ))}
              </ul>
              {item.match.matched_terms.length > 0 && (
                <div className="similar-repair-terms">
                  <span className="similar-repair-terms-label">{t("Совпавшие слова")}</span>
                  {item.match.matched_terms.map((term, index) => (
                    <span className="similar-repair-term" key={`${term}-${index}`}>
                      {term}
                    </span>
                  ))}
                </div>
              )}
              <dl>
                <div>
                  <dt>{t("Принят и закрыт мастером")}</dt>
                  <dd>{local(item.closed_at)}</dd>
                </div>
                <div>
                  <dt>{t("Наблюдение")}</dt>
                  <dd>{followupText(item)}</dd>
                </div>
              </dl>
              <section>
                <h4>{t("Описание обращения")}</h4>
                <p>{item.description}</p>
              </section>
              <section>
                <h4>{t("Выполненные работы")}</h4>
                <p>{item.work_description}</p>
              </section>
              <section>
                <h4>{t("Материалы")}</h4>
                {item.materials.length ? (
                  <ul>
                    {item.materials.map((material) => (
                      <li key={material.material_id}>
                        {material.name} — {material.quantity} {material.unit}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t("Материалы не зафиксированы.")}</p>
                )}
              </section>
              {onViewEvidence && (
                <button
                  className="text-button prevention-order-link"
                  type="button"
                  onClick={() => void viewSource(item.order_id)}
                >
                  {sourceLoading === item.order_id ? t("Загрузка…") : t("Открыть наряд {0}", [item.number])}
                </button>
              )}
              {sourceErrorFor === item.order_id && <p className="error">{sourceError}</p>}
              {source?.id === item.order_id && (
                <section
                  className="similar-repair-source"
                  data-testid="similar-repair-source"
                  aria-live="polite"
                >
                  <OrderReference description={source.description} number={source.number} />
                  <span>{ruStatus[source.status] ?? source.status}</span>
                  <p>{source.description}</p>
                </section>
              )}
            </div>
          </details>
        </article>
      ))}
      {data && (data.notes?.length || data.truncated) ? (
        data.notes?.length ? (
          <ul className="muted similar-repairs-note readable-reasons">
            {data.notes.map((note, index) => (
              <li key={index}>{message(note)}</li>
            ))}
          </ul>
        ) : (
          <p className="muted similar-repairs-note">{t("Показаны не все найденные ремонты.")}</p>
        )
      ) : null}
    </div>
  );
}
