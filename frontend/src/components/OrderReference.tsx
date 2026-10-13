import { t } from "../lib/i18n";
import "./order-reference.css";

type Props = {
  description?: string | null;
  number?: string | null;
  className?: string;
};

/** A compact, consistent order label: task first, traceable number second. */
export function OrderReference({ description, number, className = "" }: Props) {
  const title = description?.trim();
  return (
    <span className={`order-reference ${className}`.trim()}>
      <span className="order-reference-title" title={title || undefined}>
        {title || t("Наряд")}
      </span>
      {number && <small className="order-reference-number">№ {number}</small>}
    </span>
  );
}
