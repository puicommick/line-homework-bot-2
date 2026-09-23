import type {
  AssignmentWithContext, StudentRow, SubmissionRow, StudentAssignmentView,
} from "../types";
import { computeStatus } from "../lib/time";

const ASSIGNMENT_SELECT = `
  SELECT a.*, c.name AS course_name, c.code AS course_code,
         cl.level AS class_level, cl.room AS class_room,
         cl.id AS class_id, cl.line_group_id
    FROM assignments a
    JOIN courses c  ON c.id  = a.course_id
    JOIN classes cl ON cl.id = c.class_id`;

// ───────────────────────────────── นักเรียน

export async function findStudentByLineId(db: D1Database, lineUserId: string): Promise<StudentRow | null> {
  return db.prepare(`SELECT * FROM students WHERE line_user_id = ?`).bind(lineUserId).first<StudentRow>();
}

export async function findStudentByCode(db: D1Database, studentCode: string): Promise<StudentRow | null> {
  return db.prepare(`SELECT * FROM students WHERE student_code = ?`).bind(studentCode.trim()).first<StudentRow>();
}

export async function getClassName(db: D1Database, classId: string): Promise<{ level: number; room: number } | null> {
  return db.prepare(`SELECT level, room FROM classes WHERE id = ?`).bind(classId).first<{ level: number; room: number }>();
}

/** งานทั้งหมดของห้องที่นักเรียนสังกัด พร้อมสถานะการส่งของนักเรียนคนนั้น */
export async function listStudentAssignments(
  db: D1Database,
  student: StudentRow,
  nowMs: number,
  opts: { onlyPending?: boolean; onlySubmitted?: boolean; limit?: number } = {},
): Promise<StudentAssignmentView[]> {
  const rows = await db
    .prepare(
      `${ASSIGNMENT_SELECT}
         LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
        WHERE cl.id = ? AND a.is_archived = 0
        ORDER BY a.due_at ASC
        LIMIT ?`,
    )
    .bind(student.id, student.class_id, opts.limit ?? 200)
    .all<AssignmentWithContext & Record<string, unknown>>();

  // ดึง submission แยก เพื่อให้ type ชัดและไม่ชนชื่อคอลัมน์ id
  const subs = await db
    .prepare(`SELECT * FROM submissions WHERE student_id = ?`)
    .bind(student.id)
    .all<SubmissionRow>();
  const subMap = new Map<string, SubmissionRow>();
  for (const s of subs.results ?? []) subMap.set(s.assignment_id, s);

  const views: StudentAssignmentView[] = [];
  for (const a of rows.results ?? []) {
    const sub = subMap.get(a.id) ?? null;
    const status = computeStatus(a.due_at, sub?.submitted_at ?? null, nowMs);
    if (opts.onlyPending && (status === "on_time" || status === "late")) continue;
    if (opts.onlySubmitted && status !== "on_time" && status !== "late") continue;
    views.push({
      assignment: a as AssignmentWithContext,
      submitted_at: sub?.submitted_at ?? null,
      score: sub?.score ?? null,
      scored_at: sub?.scored_at ?? null,
      note: sub?.note ?? "",
      status,
    });
  }
  return views;
}

/** สรุปคะแนนรายวิชาของนักเรียน (นับเฉพาะงานที่ครูให้คะแนนแล้ว) */
export async function summarizeStudentScores(
  db: D1Database,
  student: StudentRow,
): Promise<{ courseName: string; gained: number; full: number; graded: number; total: number }[]> {
  const res = await db
    .prepare(
      `SELECT c.name AS course_name,
              COALESCE(SUM(CASE WHEN s.score IS NOT NULL THEN s.score END), 0)     AS gained,
              COALESCE(SUM(CASE WHEN s.score IS NOT NULL THEN a.max_score END), 0) AS full,
              SUM(CASE WHEN s.score IS NOT NULL THEN 1 ELSE 0 END)                 AS graded,
              COUNT(a.id)                                                          AS total
         FROM assignments a
         JOIN courses c ON c.id = a.course_id
         LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
        WHERE c.class_id = ? AND a.is_archived = 0
        GROUP BY c.id, c.name
        ORDER BY c.name ASC`,
    )
    .bind(student.id, student.class_id)
    .all<{ course_name: string; gained: number; full: number; graded: number; total: number }>();

  return (res.results ?? []).map((r) => ({
    courseName: r.course_name,
    gained: r.gained ?? 0,
    full: r.full ?? 0,
    graded: r.graded ?? 0,
    total: r.total ?? 0,
  }));
}

export async function setStudentNotify(db: D1Database, studentId: string, on: boolean): Promise<void> {
  await db.prepare(`UPDATE students SET notify_enabled = ? WHERE id = ?`).bind(on ? 1 : 0, studentId).run();
}

// ───────────────────────────────── งาน

export async function getAssignment(db: D1Database, id: string): Promise<AssignmentWithContext | null> {
  return db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).bind(id).first<AssignmentWithContext>();
}

/** งานที่อาจมีจุดแจ้งเตือนอยู่ในช่วงเวลานี้ — กรองด้วย due_at เพื่อไม่สแกนทั้งตาราง */
export async function listAssignmentsForReminder(
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<AssignmentWithContext[]> {
  const res = await db
    .prepare(`${ASSIGNMENT_SELECT} WHERE a.is_archived = 0 AND a.due_at >= ? AND a.due_at <= ? ORDER BY a.due_at ASC`)
    .bind(fromIso, toIso)
    .all<AssignmentWithContext>();
  return res.results ?? [];
}

/**
 * นักเรียนที่ "ควรได้รับแจ้งเตือน" ของงานชิ้นนี้
 * เงื่อนไข: ผูก LINE แล้ว + เปิดแจ้งเตือน + ยังไม่ส่งงาน
 */
export async function listNotifiableStudents(
  db: D1Database,
  assignment: AssignmentWithContext,
): Promise<{ id: string; line_user_id: string; quiet_hours_enabled: number }[]> {
  const res = await db
    .prepare(
      `SELECT st.id, st.line_user_id, st.quiet_hours_enabled
         FROM students st
         LEFT JOIN submissions s ON s.assignment_id = ? AND s.student_id = st.id
        WHERE st.class_id = ?
          AND st.line_user_id IS NOT NULL
          AND st.notify_enabled = 1
          AND (s.submitted_at IS NULL)`,
    )
    .bind(assignment.id, assignment.class_id)
    .all<{ id: string; line_user_id: string; quiet_hours_enabled: number }>();
  return res.results ?? [];
}

/** รายชื่อผู้ที่ยังไม่ส่ง (ใช้ตอบคำสั่งครู) — เรียงตามเลขที่ */
export async function listNotSubmitted(
  db: D1Database,
  assignmentId: string,
  classId: string,
): Promise<{ no: number | null; name: string; student_code: string }[]> {
  const res = await db
    .prepare(
      `SELECT st."no" AS no, st.name, st.student_code
         FROM students st
         LEFT JOIN submissions s ON s.assignment_id = ? AND s.student_id = st.id
        WHERE st.class_id = ? AND s.submitted_at IS NULL
        ORDER BY st."no" ASC, st.name ASC`,
    )
    .bind(assignmentId, classId)
    .all<{ no: number | null; name: string; student_code: string }>();
  return res.results ?? [];
}

/** ค้นงานจากชื่อ (บางส่วน) เฉพาะที่ยังไม่ archive — ใช้กับคำสั่ง "ใครยังไม่ส่ง ..." */
export async function searchAssignmentsByTitle(
  db: D1Database,
  keyword: string,
  limit = 5,
): Promise<AssignmentWithContext[]> {
  const like = `%${keyword.trim().replace(/[%_]/g, "")}%`;
  const res = await db
    .prepare(`${ASSIGNMENT_SELECT} WHERE a.is_archived = 0 AND a.title LIKE ? ORDER BY a.due_at DESC LIMIT ?`)
    .bind(like, limit)
    .all<AssignmentWithContext>();
  return res.results ?? [];
}

/** งานที่ถึงกำหนดส่ง "วันนี้ตามเวลาไทย" พร้อมยอดคนส่ง */
export async function listAssignmentsDueInRange(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<
  { title: string; due_at: string; course_name: string; class_level: number; class_room: number;
    submitted: number; total: number }[]
> {
  const res = await db
    .prepare(
      `SELECT a.title, a.due_at, c.name AS course_name, cl.level AS class_level, cl.room AS class_room,
              (SELECT COUNT(*) FROM submissions s
                WHERE s.assignment_id = a.id AND s.submitted_at IS NOT NULL) AS submitted,
              (SELECT COUNT(*) FROM students st WHERE st.class_id = cl.id)   AS total
         FROM assignments a
         JOIN courses c  ON c.id  = a.course_id
         JOIN classes cl ON cl.id = c.class_id
        WHERE a.is_archived = 0 AND a.due_at >= ? AND a.due_at < ?
        ORDER BY a.due_at ASC`,
    )
    .bind(startIso, endIso)
    .all<{
      title: string; due_at: string; course_name: string;
      class_level: number; class_room: number; submitted: number; total: number;
    }>();
  return res.results ?? [];
}

// ───────────────────────────────── การแจ้งคะแนน

export async function listPendingScoreNotifications(
  db: D1Database,
  limit = 200,
): Promise<
  { submission_id: string; assignment_id: string; student_id: string; line_user_id: string;
    score: number; scored_at: string; note: string }[]
> {
  const res = await db
    .prepare(
      `SELECT s.id AS submission_id, s.assignment_id, s.student_id,
              st.line_user_id, s.score, s.scored_at, s.note
         FROM submissions s
         JOIN students st ON st.id = s.student_id
        WHERE s.score IS NOT NULL
          AND s.scored_at IS NOT NULL
          AND s.score_notified_at IS NULL
          AND st.line_user_id IS NOT NULL
          AND st.notify_enabled = 1
        ORDER BY s.scored_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{
      submission_id: string; assignment_id: string; student_id: string;
      line_user_id: string; score: number; scored_at: string; note: string;
    }>();
  return res.results ?? [];
}

export async function markScoreNotified(db: D1Database, submissionIds: string[], nowIso: string): Promise<void> {
  if (submissionIds.length === 0) return;
  const stmts = submissionIds.map((id) =>
    db.prepare(`UPDATE submissions SET score_notified_at = ? WHERE id = ? AND score_notified_at IS NULL`).bind(nowIso, id),
  );
  await db.batch(stmts);
}

// ───────────────────────────────── กัน webhook ซ้ำ

/** คืน true ถ้าเป็นอีเวนต์ใหม่ (ยังไม่เคยประมวลผล) */
export async function claimLineEvent(db: D1Database, eventId: string, nowIso: string): Promise<boolean> {
  const res = await db
    .prepare(`INSERT INTO line_events (event_id, received_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING`)
    .bind(eventId, nowIso)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function purgeOldLineEvents(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(`DELETE FROM line_events WHERE received_at < ?`)
    .bind(new Date(nowMs - 3 * 86_400_000).toISOString())
    .run();
}
