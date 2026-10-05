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
}
export interface Equipment {
  id: string;
  inventory_number: string;
  name: string;
  area_id: string;
  equipment_type: string;
  criticality: number;
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
export interface FaultCode {
  id: string;
  code: string;
  name: string;
  specialty: string;
}
export interface Material {
  id: string;
  code: string;
  name: string;
  unit: string;
}
export interface Catalog {
  areas: Area[];
  equipment: Equipment[];
  brigades: Array<Area>;
  fault_codes: FaultCode[];
  materials: Material[];
  time_norms: unknown[];
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
export interface OrderDetail extends Order {
  work_description: string | null;
  fault_code_id: string | null;
  no_materials_reason: string | null;
  materials: MaterialUsage[];
  photos: Photo[];
  reviews: Review[];
  ai_job?: AiJob | null;
}
export interface EventItem {
  id: string;
  sequence: number;
  order_version: number | null;
  actor_id: string | null;
  actor_role: string;
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
