import type { CSSProperties } from "react";
import { t } from "../lib/i18n";
import "./skeleton.css";

type SkeletonVariant = "cards" | "list" | "detail" | "report" | "board" | "people" | "table";

type SkeletonProps = {
  variant?: SkeletonVariant;
  label?: string;
  count?: number;
};

// Fixed width rhythm: rows look like real content without random reflow between renders.
const widths = [78, 64, 86, 58, 72, 92, 68, 81];
const width = (index: number, offset = 0) => `${widths[(index + offset) % widths.length]}%`;

function Bone({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span className={`loading-skeleton-block ${className}`} style={style} />;
}

function Card({ index }: { index: number }) {
  return (
    <div className="loading-skeleton-card" style={{ "--sk-index": index } as CSSProperties}>
      <div className="loading-skeleton-top">
        <Bone className="loading-skeleton-kicker" />
        <Bone className="loading-skeleton-badge" />
      </div>
      <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
      <Bone className="loading-skeleton-line" style={{ width: width(index, 3) }} />
      <Bone className="loading-skeleton-short" />
      <div className="loading-skeleton-footer">
        <Bone className="loading-skeleton-meta" />
        <Bone className="loading-skeleton-meta" />
      </div>
    </div>
  );
}

function Row({ index }: { index: number }) {
  return (
    <div className="loading-skeleton-row" style={{ "--sk-index": index } as CSSProperties}>
      <Bone className="loading-skeleton-number" />
      <div className="loading-skeleton-stack">
        <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
        <Bone className="loading-skeleton-line" style={{ width: width(index, 4) }} />
      </div>
      <Bone className="loading-skeleton-badge" />
      <Bone className="loading-skeleton-meta" />
    </div>
  );
}

function Person({ index }: { index: number }) {
  return (
    <div
      className="loading-skeleton-card loading-skeleton-person"
      style={{ "--sk-index": index } as CSSProperties}
    >
      <div className="loading-skeleton-person-head">
        <Bone className="loading-skeleton-avatar" />
        <div className="loading-skeleton-stack">
          <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
          <Bone className="loading-skeleton-line" style={{ width: width(index, 2) }} />
        </div>
      </div>
      <div className="loading-skeleton-footer">
        <Bone className="loading-skeleton-badge" />
        <Bone className="loading-skeleton-meta" />
      </div>
    </div>
  );
}

function Board({ count }: { count: number }) {
  const columns = Math.max(3, Math.min(4, count));
  return (
    <div className="loading-skeleton-board" aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <div className="loading-skeleton-column" key={column}>
          <div className="loading-skeleton-column-head">
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-dot" />
          </div>
          {Array.from({ length: 3 - (column % 2) }, (_, index) => (
            <Card key={index} index={column * 3 + index} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Report({ count }: { count: number }) {
  return (
    <div className="loading-skeleton-report" aria-hidden="true">
      <div className="loading-skeleton-grid loading-skeleton-kpis">
        {Array.from({ length: Math.max(4, count) }, (_, index) => (
          <div
            className="loading-skeleton-card loading-skeleton-kpi"
            key={index}
            style={{ "--sk-index": index } as CSSProperties}
          >
            <div className="loading-skeleton-top">
              <Bone className="loading-skeleton-kicker" />
              <Bone className="loading-skeleton-dot" />
            </div>
            <Bone className="loading-skeleton-value" />
            <Bone className="loading-skeleton-short" />
          </div>
        ))}
      </div>
      <div className="loading-skeleton-panels">
        <div className="loading-skeleton-card">
          <Bone className="loading-skeleton-title" style={{ width: "40%" }} />
          <div className="loading-skeleton-bars">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="loading-skeleton-bar-row" key={index}>
                <Bone className="loading-skeleton-line" style={{ width: "100%" }} />
                <Bone className="loading-skeleton-bar" style={{ width: width(index, 1) }} />
              </div>
            ))}
          </div>
        </div>
        <div className="loading-skeleton-card">
          <Bone className="loading-skeleton-title" style={{ width: "48%" }} />
          {Array.from({ length: 5 }, (_, index) => (
            <div className="loading-skeleton-table-row" key={index}>
              <Bone style={{ width: width(index) }} />
              <Bone style={{ width: "70%" }} />
              <Bone style={{ width: "40%" }} />
            </div>
          ))}
        </div>
      </div>
      <div className="loading-skeleton-chart loading-skeleton-block" />
    </div>
  );
}

function Detail() {
  return (
    <div className="loading-skeleton-detail" aria-hidden="true">
      <div className="loading-skeleton-top">
        <Bone className="loading-skeleton-kicker" />
        <Bone className="loading-skeleton-badge" />
      </div>
      <Bone className="loading-skeleton-heading" />
      <Bone className="loading-skeleton-line" style={{ width: "88%" }} />
      <Bone className="loading-skeleton-line" style={{ width: "64%" }} />
      <div className="loading-skeleton-facts">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="loading-skeleton-fact" key={index}>
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-line" style={{ width: width(index) }} />
          </div>
        ))}
      </div>
      <div className="loading-skeleton-actions">
        <Bone className="loading-skeleton-button" />
        <Bone className="loading-skeleton-button is-ghost" />
      </div>
      <div className="loading-skeleton-timeline">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="loading-skeleton-event" key={index}>
            <Bone className="loading-skeleton-dot" />
            <div className="loading-skeleton-stack">
              <Bone className="loading-skeleton-line" style={{ width: width(index, 2) }} />
              <Bone className="loading-skeleton-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Decorative placeholders never expose invented values or actions to assistive technology. */
export function Skeleton({ variant = "cards", label = t("Загрузка…"), count = 6 }: SkeletonProps) {
  return (
    <div className={`loading-skeleton loading-skeleton--${variant}`} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {variant === "board" ? (
        <Board count={count} />
      ) : variant === "report" ? (
        <Report count={count} />
      ) : variant === "detail" ? (
        <Detail />
      ) : (
        <div className="loading-skeleton-grid" aria-hidden="true">
          {Array.from({ length: count }, (_, index) =>
            variant === "list" || variant === "table" ? (
              <Row key={index} index={index} />
            ) : variant === "people" ? (
              <Person key={index} index={index} />
            ) : (
              <Card key={index} index={index} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
