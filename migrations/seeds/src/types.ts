export interface TeacherRow {
  id: string;
  line_user_id: string | null;
  display_name: string;
  role: "teacher" | "admin";
  is_active: number;
  created_at: string;
}

export interface ClassRow {
  id: string;
  level: number;
  room: number;
  line_group_id: string | null;
  created_at: string;
}

export interface CourseRow {
  id: string;
  class_id: string;
  name: string;
  code: string;
  teacher_id: string | null;
  created_at: string;
}

export interface StudentRow {
  id: string;
  student_code: string;
  name: string;
  no: number | null;
  class_id: string;
  link_code_hash: string | null;
  link_code_expires_at: string | null;
  link_attempts: number;
  line_user_id: string | null;
  linked_at: string | null;
  notify_enabled: number;
  quiet_hours_enabled: number;
  created_at: string;
}

export interface AssignmentRow {
  id: string;
  course_id: string;
  title: string;
  description: string;
  max_score: number;
  assigned_at: string;
  due_at: string;
  remind_minutes: string;
  remind_at: string | null;
  notify_overdue: number;
  batch_id: string | null;
  created_by: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

export interface SubmissionRow {
  id: string;
  assignment_id: string;
  student_id: string;
  submitted_at: string | null;
  score: number | null;
  scored_at: string | null;
  score_notified_at: string | null;
  note: string;
  updated_at: string;
}

/** งาน + บริบทวิชา/ห้อง ที่ใช้ตอน render */
export interface AssignmentWithContext extends AssignmentRow {
  course_name: string;
  course_code: string;
  class_level: number;
  class_room: number;
  class_id: string;
  line_group_id: string | null;
}

/** มุมมองของนักเรียนต่องาน 1 ชิ้น */
export interface StudentAssignmentView {
  assignment: AssignmentWithContext;
  submitted_at: string | null;
  score: number | null;
  scored_at: string | null;
  note: string;
  status: SubmissionStatus;
}

export type SubmissionStatus =
  | "pending"    // ยังไม่ส่ง ยังไม่เลยกำหนด
  | "overdue"    // ยังไม่ส่ง เลยกำหนดแล้ว
  | "on_time"    // ส่งแล้ว ตรงเวลา
  | "late";      // ส่งแล้ว แต่ช้ากว่ากำหนด

export interface LineEventSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineWebhookEvent {
  type: string;
  webhookEventId?: string;
  timestamp?: number;
  mode?: string;
  replyToken?: string;
  source?: LineEventSource;
  message?: { id: string; type: string; text?: string };
  postback?: { data: string; params?: Record<string, string> };
}
