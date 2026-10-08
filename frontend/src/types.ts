export type Role = "master" | "executor" | "manager" | "admin";
export type Status =
  | "issued"
  | "accepted"
  | "queued"
  | "rejected"
  | "in_progress"
  | "paused"
  | "completed"
  | "ai_review"
  | "closed"
  | "cancelled"
  | "rework";
export type Priority = "emergency" | "high" | "normal" | "planned";
export type WorkType = "planned" | "unplanned";
export interface User {
  id: string;
  login: string;
  display_name: string;
  role: Role;
  area_ids: string[];
}
export interface Token {
  access_token: string;
  token_type: "bearer";
  expires_at: string;
}
export interface Area {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}
export interface Equipment {
  id: string;
  inventory_number: string;
  name: string;
  area_id: string;
  equipment_type: string;
  criticality: number;
  is_active: boolean;
}
export interface Employee {
  id: string;
  login: string;
  display_name: string;
  role: Role;
  specialty: string;
  grade: number;
  brigade_id: string | null;
  is_active: boolean;
  is_on_shift: boolean;
}
export interface AdminEmployee extends Employee {
  area_ids: string[];
}
export interface CreateEmployee {
  login: string;
  display_name: string;
  role: Role;
  specialty: string;
  grade: number;
  brigade_id: string | null;
  area_ids: string[];
  secret: string;
}
export interface EmployeeAccessUpdate {
  role?: Role;
  area_ids?: string[];
  is_active?: boolean;
  secret?: string;
}
export interface FaultCode {
  id: string;
  code: string;
  name: string;
  specialty: string;
}
export interface Brigade {
  id: string;
  code: string;
  name: string;
}
export interface Material {
  id: string;
  code: string;
  name: string;
  unit: string;
}
export interface TimeNorm {
  id: string;
  fault_code_id: string;
  equipment_type: string;
  minutes: number;
}
export interface Catalog {
  areas: Area[];
  equipment: Equipment[];
  brigades: Brigade[];
  fault_codes: FaultCode[];
  materials: Material[];
  time_norms: TimeNorm[];
}
export interface MasterOption {
  id: string;
  display_name: string;
}
export interface Order {
  id: string;
  number: string;
  work_type: WorkType;
  description: string;
  area_id: string;
  equipment_id: string;
  executor_id: string;
  master_id: string;
  priority: Priority;
  status: Status;
  issued_at: string;
  deadline: string;
  started_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  comment: string | null;
  version: number;
  attempt: number;
  last_submission_version: number | null;
  is_synthetic: boolean;
  overdue: boolean;
}
export interface OrderPage {
  items: Order[];
  total: number;
  counts: Record<Status, number>;
  attention_count?: number;
  offset: number;
  limit: number;
}
export interface MaterialUsage {
  id: string;
  material_id: string;
  name: string;
  unit: string;
  quantity: string;
  submission_version: number | null;
}
export interface Photo {
  id: string;
  kind: "before" | "after";
  attempt: number;
  uploaded_at: string;
  captured_at: string | null;
  author_id: string;
  sha256: string;
  size_bytes: number;
  /** Explicit uploader choice; private storage does not imply external AI sharing. */
  ai_share_allowed: boolean;
  content_url: string;
}
export type ReviewCheckStatus = "pass" | "warning" | "fail" | "unknown";
export interface ReviewCheck {
  code: string;
  title: string;
  status: ReviewCheckStatus;
  detail: string;
}
export interface ReviewReport {
  schema_version?: number;
  source?: "openai" | "rules" | "unavailable";
  confidence?: number | null;
  checks?: ReviewCheck[];
  timing?: {
    active_minutes?: number;
    paused_minutes?: number;
    elapsed_minutes?: number;
    norm_minutes?: number | null;
  };
  limitations?: string[];
  model_assessment?: string | null;
}
export interface AiJob {
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error_code: string | null;
}
export interface Review {
  id: string;
  order_version: number;
  verdict: string | null;
  score: number | null;
  needs_master_review: boolean;
  explanation: string;
  model_name: string;
  created_at: string;
  master_score: number | null;
  is_current: boolean;
  report?: ReviewReport;
}
export interface ExecutorFeedback {
  submission_version: number;
  attempt: number | null;
  verdict: string | null;
  score: number | null;
  master_score: number | null;
  effective_score: number | null;
  needs_master_review: boolean;
  reviewed_at: string;
  is_current: boolean;
  recommendations: Array<{ title: string; detail: string; status: ReviewCheckStatus }>;
  timing: {
    active_minutes: number | null;
    paused_minutes: number | null;
    elapsed_minutes: number | null;
    norm_minutes: number | null;
    difference_minutes: number | null;
    percent_of_norm: number | null;
  };
}
export interface OrderDetail extends Order {
  /** Display names are returned by the detail endpoint when the caller may see the order. */
  master_name?: string | null;
  executor_name?: string | null;
  work_description: string | null;
  fault_code_id: string | null;
  no_materials_reason: string | null;
  materials: MaterialUsage[];
  photos: Photo[];
  reviews: Review[];
  ai_job?: AiJob | null;
  /** Redacted own-order assessment returned only to the assigned executor. */
  executor_feedback?: ExecutorFeedback[];
}
export interface EventItem {
  id: string;
  sequence: number;
  order_version: number | null;
  actor_id: string | null;
  actor_role: string;
  /** Safe human-readable actor returned by the order-history contract when available. */
  actor_name?: string | null;
  actor_display_name?: string | null;
  action: string;
  from_status: string | null;
  to_status: string;
  occurred_at: string;
  reason: string | null;
  details: Record<string, unknown>;
}
export interface EventPage {
  items: EventItem[];
  next_after: number | null;
}
export interface Workload {
  employee_id: string;
  area_ids: string[];
  display_name: string;
  specialty: string;
  grade: number;
  brigade_id: string | null;
  is_on_shift: boolean;
  availability: "free" | "busy" | "queued" | "off_shift";
  current_order_id: string | null;
  current_order_number: string | null;
  current_started_at: string | null;
  queue_length: number;
  paused_count: number;
}
export interface ActionRequest {
  action: string;
  expected_version: number;
  [key: string]: unknown;
}
export interface Mutation {
  order_id: string;
  version: number;
  status: Status;
}
export interface CreateOrder {
  work_type: WorkType;
  description: string;
  area_id: string;
  equipment_id: string;
  executor_id: string;
  priority: Priority;
  deadline: string;
  fault_code_id?: string;
  comment?: string;
}
export interface NotificationItem {
  id: string;
  order_id: string | null;
  kind: string;
  title: string;
  body: string;
  urgent: boolean;
  action_required: boolean;
  created_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
  payload: Record<string, unknown>;
}
export interface NotificationPage {
  items: NotificationItem[];
  total: number;
  unread_count: number;
}
export interface PushConfig {
  enabled: boolean;
  public_key: string | null;
}

export interface AnalyticsQuery {
  period: "shift" | "day" | "week" | "month" | "custom";
  shift?: "day" | "night";
  date?: string;
  from?: string;
  to?: string;
  timezone: string;
  area_id: string[];
  equipment_id: string[];
  executor_id: string[];
  brigade_id: string[];
}
export interface AnalyticsOption {
  id: string;
  name: string;
  code?: string | null;
}
export interface AnalyticsOptions {
  areas: AnalyticsOption[];
  equipment: AnalyticsOption[];
  executors: AnalyticsOption[];
  brigades: AnalyticsOption[];
}
export interface AnalyticsRatingComponent {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  detail: string;
}
export interface AnalyticsRating {
  subject_id: string;
  subject_name: string;
  score: number | null;
  sample_size: number;
  components: Record<string, AnalyticsRatingComponent>;
  unavailable_components: string[];
}
export interface AnalyticsReport {
  period: {
    kind: AnalyticsQuery["period"];
    shift: "day" | "night" | null;
    timezone: string;
    from: string;
    to: string;
    label: string;
  };
  filters: Record<string, string[]>;
  scope: { role: Role; area_ids: string[] };
  orders: {
    issued: number;
    completed: number;
    closed: number;
    overdue: number;
    rejected: number;
    backlog: number;
  };
  durations: {
    response_seconds: number | null;
    work_seconds: number | null;
    pause_seconds: number | null;
    sample_sizes: Record<string, number>;
  };
  activity: {
    active_order_count: number;
    active_seconds: number;
    by_employee: Array<{
      employee_id: string;
      employee_name: string;
      active_seconds: number;
      paused_seconds: number;
      order_count: number;
    }>;
  };
  downtime: {
    known_seconds: number;
    planned_seconds: number;
    unplanned_seconds: number;
    by_fault: Record<string, number>;
    unknown_order_count: number;
    by_equipment: Array<{
      equipment_id: string;
      equipment_name: string;
      known_seconds: number;
      order_ids: string[];
      unknown_order_count: number;
    }>;
  };
  ratings: { employees: AnalyticsRating[]; brigades: AnalyticsRating[]; limitations: string[] };
  materials: {
    usage: Array<{
      material_id: string;
      material_name: string;
      unit: string;
      quantity: number;
      order_count: number;
    }>;
    by_area: unknown[];
    by_equipment: unknown[];
    by_executor: unknown[];
  };
  leaders: {
    machines: Array<{
      id: string;
      name: string;
      order_count: number;
      overdue_count: number;
      downtime_seconds: number;
    }>;
    areas: Array<{
      id: string;
      name: string;
      order_count: number;
      overdue_count: number;
      downtime_seconds: number;
    }>;
  };
  anomalies: Array<{
    family: string;
    severity: "low" | "medium" | "high";
    title: string;
    evidence: Record<string, unknown>;
    formula: string;
  }>;
  meta: {
    as_of: string;
    row_count: number;
    synthetic_count: number;
    formula_descriptions: Record<string, string>;
    warnings: string[];
  };
}
export interface AnalyticsSummary {
  source: "openai" | "rules";
  model: string | null;
  text: string;
  limitations: string[];
  evidence_ids: string[];
}
