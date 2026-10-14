import type { CSSProperties } from "react";
import { t } from "../lib/i18n";
import "./skeleton.css";

type SkeletonVariant =
  | "cards"
  | "catalog"
  | "list"
  | "detail"
  | "report"
  | "insights"
  | "summary"
  | "board"
  | "people"
  | "table"
  | "fault-reports"
  | "notifications"
  | "notification-events";

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
  // Only non-empty columns are rendered after loading; their count is not known yet.
  const columns = count;
  return (
    <div className="kanban loading-skeleton-board" aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <div className="loading-skeleton-column" key={column}>
          <div className="loading-skeleton-column-head">
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-dot" />
          </div>
          {Array.from({ length: 1 }, (_, index) => (
            <Card key={index} index={column * 3 + index} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Report({ count }: { count: number }) {
  const peopleReport = count === 10;
  const table = (rows: number, offset = 0) =>
    Array.from({ length: rows }, (_, index) => (
      <div className="loading-skeleton-table-row" key={index}>
        <Bone style={{ width: width(index, offset) }} />
        <Bone style={{ width: "70%" }} />
        <Bone style={{ width: "40%" }} />
      </div>
    ));
  const heading = (titleWidth: string) => (
    <div className="loading-skeleton-section-heading">
      <Bone className="loading-skeleton-icon" />
      <div className="loading-skeleton-stack">
        <Bone className="loading-skeleton-kicker" />
        <Bone className="loading-skeleton-title" style={{ width: titleWidth }} />
      </div>
    </div>
  );
  return (
    <div className="loading-skeleton-report" aria-hidden="true">
      <div className="loading-skeleton-caption">
        <Bone className="loading-skeleton-line" style={{ width: "55%" }} />
      </div>
      <div className="loading-skeleton-warning">
        <Bone className="loading-skeleton-line" style={{ width: "35%" }} />
      </div>
      <div className="metric-grid loading-skeleton-grid loading-skeleton-kpis">
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
      <div className="loading-skeleton-section">
        {heading("42%")}
        <div
          className={
            peopleReport ? "loading-skeleton-rating-grid" : "loading-skeleton-rating-grid is-private"
          }
        >
          {!peopleReport ? (
            <div className="loading-skeleton-personal-rating">
              <div className="loading-skeleton-personal-overview">
                <Bone className="loading-skeleton-value" />
                <Bone className="loading-skeleton-title" />
              </div>
              <div className="loading-skeleton-personal-metrics">
                {Array.from({ length: 5 }, (_, index) => (
                  <div key={index} className="loading-skeleton-card">
                    <Bone className="loading-skeleton-title" />
                    <Bone className="loading-skeleton-line" />
                    <Bone className="loading-skeleton-short" />
                  </div>
                ))}
              </div>
              <Bone className="loading-skeleton-title" />
            </div>
          ) : (
            <div className="loading-skeleton-rating-table">
              <Bone className="loading-skeleton-title" style={{ width: "44%" }} />
              {Array.from({ length: 3 }, (_, index) => (
                <RatingPlaceholder key={index} />
              ))}
            </div>
          )}
          {peopleReport && (
            <div className="loading-skeleton-rating-table">
              <Bone className="loading-skeleton-title" style={{ width: "38%" }} />
              {Array.from({ length: 3 }, (_, index) => (
                <RatingPlaceholder key={index} />
              ))}
            </div>
          )}
        </div>
      </div>
      {peopleReport && (
        <div className="loading-skeleton-section loading-skeleton-report-split">
          <div>
            {heading("48%")}
            <div className="loading-skeleton-table">{table(4)}</div>
          </div>
          <div>
            {heading("54%")}
            <div className="loading-skeleton-resource-times">
              {[0, 1].map((index) => (
                <div className="loading-skeleton-card" key={index}>
                  <Bone className="loading-skeleton-short" />
                  <Bone className="loading-skeleton-title" />
                </div>
              ))}
            </div>
            <div className="loading-skeleton-table">{table(4, 3)}</div>
          </div>
        </div>
      )}
      <div className="loading-skeleton-section">
        {heading("40%")}
        <div className="loading-skeleton-table">{table(4, 1)}</div>
      </div>
    </div>
  );
}

function Insights() {
  return (
    <div className="loading-skeleton-report" aria-hidden="true">
      <div className="loading-skeleton-grid loading-skeleton-kpis">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            className="loading-skeleton-card loading-skeleton-kpi"
            key={index}
            style={{ "--sk-index": index } as CSSProperties}
          >
            <div className="loading-skeleton-top">
              <Bone className="loading-skeleton-dot" />
              <Bone className="loading-skeleton-kicker" />
            </div>
            <Bone className="loading-skeleton-value" />
          </div>
        ))}
      </div>
      <div className="loading-skeleton-panels">
        {[0, 1].map((panel) => (
          <div className="loading-skeleton-card" key={panel}>
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-title" style={{ width: panel ? "56%" : "64%" }} />
            {Array.from({ length: 5 }, (_, index) => (
              <div className="loading-skeleton-table-row" key={index}>
                <Bone style={{ width: width(index, panel) }} />
                <Bone style={{ width: "25%" }} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="loading-skeleton-chart loading-skeleton-block" />
      <div className="loading-skeleton-report-panel loading-skeleton-card">
        <Bone className="loading-skeleton-kicker" />
        <Bone className="loading-skeleton-title" style={{ width: "42%" }} />
        {Array.from({ length: 3 }, (_, index) => (
          <div className="loading-skeleton-table-row" key={index}>
            <Bone className="loading-skeleton-dot" />
            <Bone style={{ width: width(index, 2) }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Summary() {
  return (
    <div className="loading-skeleton-summary" aria-hidden="true">
      <div className="loading-skeleton-top">
        <Bone className="loading-skeleton-badge" />
        <Bone className="loading-skeleton-line" style={{ width: "28%" }} />
      </div>
      <div className="loading-skeleton-summary-highlights">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="loading-skeleton-summary-actions" key={index}>
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-title" style={{ width: "65%" }} />
            <Bone className="loading-skeleton-line" />
            <Bone className="loading-skeleton-short" />
            <Bone className="loading-skeleton-line" />
            <Bone className="loading-skeleton-line" style={{ width: "80%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Catalog({ count }: { count: number }) {
  return (
    <div className="reference-overview loading-skeleton-grid loading-skeleton-catalog" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="loading-skeleton-card loading-skeleton-catalog-card" key={index}>
          <div className="loading-skeleton-top">
            <Bone className="loading-skeleton-count" />
            <Bone className="loading-skeleton-icon" />
          </div>
          <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
          <Bone className="loading-skeleton-line" style={{ width: width(index, 3) }} />
          <div className="loading-skeleton-footer">
            <Bone className="loading-skeleton-line" style={{ width: "42%" }} />
            <Bone className="loading-skeleton-chevron" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FaultReport({ index }: { index: number }) {
  return (
    <div
      className="loading-skeleton-card loading-skeleton-fault-report"
      style={{ "--sk-index": index } as CSSProperties}
    >
      <div className="loading-skeleton-top">
        <div className="loading-skeleton-stack">
          <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
          <Bone className="loading-skeleton-line" style={{ width: "48%" }} />
        </div>
        <Bone className="loading-skeleton-badge" />
      </div>
      <Bone className="loading-skeleton-line" style={{ width: "94%" }} />
      <Bone className="loading-skeleton-line" style={{ width: "68%" }} />
      <div className="loading-skeleton-facts loading-skeleton-fault-facts">
        {Array.from({ length: 3 }, (_, fact) => (
          <div className="loading-skeleton-fact" key={fact}>
            <Bone className="loading-skeleton-kicker" />
            <Bone className="loading-skeleton-line" style={{ width: width(fact, index) }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Notifications({ count }: { count: number }) {
  return (
    <div className="loading-skeleton-notifications" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="loading-skeleton-notification" key={index}>
          <Bone className="loading-skeleton-notification-icon" />
          <div className="loading-skeleton-stack">
            <Bone className="loading-skeleton-title" style={{ width: width(index) }} />
            <Bone className="loading-skeleton-line" style={{ width: width(index, 2) }} />
            <Bone className="loading-skeleton-notification-meta" />
          </div>
          <div className="loading-skeleton-notification-end">
            <Bone className="loading-skeleton-count" />
            <Bone className="loading-skeleton-chevron" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NotificationEvents({ count }: { count: number }) {
  return (
    <div className="loading-skeleton-notification-events" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="loading-skeleton-notification-event" key={index}>
          <div className="loading-skeleton-top">
            <div className="loading-skeleton-event-meta">
              <Bone className="loading-skeleton-notification-meta" />
              <Bone className="loading-skeleton-badge" />
            </div>
            <Bone className="loading-skeleton-notification-meta" />
          </div>
          <Bone className="loading-skeleton-title" style={{ width: width(index, 1) }} />
          <Bone className="loading-skeleton-line" style={{ width: "94%" }} />
          <Bone className="loading-skeleton-line" style={{ width: width(index, 4) }} />
          <div className="loading-skeleton-event-actions">
            <Bone className="loading-skeleton-button" />
            <Bone className="loading-skeleton-button is-ghost" />
          </div>
        </div>
      ))}
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
        {Array.from({ length: 7 }, (_, index) => (
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
      ) : variant === "insights" ? (
        <Insights />
      ) : variant === "summary" ? (
        <Summary />
      ) : variant === "catalog" ? (
        <Catalog count={count} />
      ) : variant === "detail" ? (
        <Detail />
      ) : variant === "notifications" ? (
        <Notifications count={count} />
      ) : variant === "notification-events" ? (
        <NotificationEvents count={count} />
      ) : (
        <div className="loading-skeleton-grid" aria-hidden="true">
          {Array.from({ length: count }, (_, index) =>
            variant === "list" || variant === "table" ? (
              <Row key={index} index={index} />
            ) : variant === "fault-reports" ? (
              <FaultReport key={index} index={index} />
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

function RatingPlaceholder() {
  return (
    <div className="loading-skeleton-leader">
      <div className="loading-skeleton-top">
        <Bone className="loading-skeleton-icon" />
        <Bone style={{ width: "50%" }} />
        <Bone className="loading-skeleton-count" />
      </div>
      <Bone className="loading-skeleton-line" />
      <div className="loading-skeleton-leader-metrics">
        {[0, 1, 2].map((key) => (
          <Bone key={key} className="loading-skeleton-block" />
        ))}
      </div>
      <Bone className="loading-skeleton-short" />
    </div>
  );
}
