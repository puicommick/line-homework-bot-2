import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { readConfig } from "../env";
import { newId } from "../lib/ids";
import { requireTeacher, type AuthVars } from "../auth/middleware";
import { assertTeacherCourseAccess, buildCourseScopeQuery } from "../auth/teacher-scope";
import { generateLinkCode, hashLinkCode } from "../lib/crypto";
import { formatThaiDateTime } from "../lib/thai-date";
import { LineClient } from "../line/client";
import { groupAnnounceMessage } from "../line/flex";

export const teacherApiRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

teacherApiRoutes.use("/*", requireTeacher);

// ---------------------------------------------------------------- ห้องเรียนและวิชา

teacherApiRoutes.get("/classes", async (c) => {
  const teacher = c.get("teacher");
  const scope = buildCourseScopeQuery(teacher, "co");

  const classes = await c.env.DB.prepare(
    `SELECT DISTINCT cl.id, cl.level, cl.room, cl.line_group_id
       FROM classes cl
       JOIN courses co ON co.class_id = cl.id
      WHERE ${scope.sql}
      ORDER BY cl.level ASC, cl.room ASC`,
  )
    .bind(...scope.bind)
    .all<{ id: string; level: number; room: number; line_group_id: string | null }>();

  return c.json({ ok: true, classes: classes.results ?? [] });
});

teacherApiRoutes.get("/courses", async (c) => {
  const teacher = c.get("teacher");
  const scope = buildCourseScopeQuery(teacher, "c");

  const courses = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.code, c.class_id, cl.level, cl.room
       FROM courses c
       JOIN classes cl ON cl.id = c.class_id
      WHERE ${scope.sql}
      ORDER BY cl.level ASC, cl.room ASC, c.name ASC`,
  )
    .bind(...scope.bind)
    .all();

  return c.json({ ok: true, courses: courses.results ?? [] });
});

// ---------------------------------------------------------------- นักเรียน & สร้างรหัสผูกบัญชี

teacherApiRoutes.get("/classes/:class_id/students", async (c) => {
  const teacher = c.get("teacher");
  const classId = c.req.param("class_id");

  if (teacher.role !== "admin") {
    const hasAccess = await c.env.DB.prepare(
      `SELECT c.id FROM courses c WHERE c.class_id = ? AND c.teacher_id = ?`,
    )
      .bind(classId, teacher.id)
      .first();
    if (!hasAccess) return c.json({ ok: false, error: "ไม่มีสิทธิ์เข้าถึงห้องนี้" }, 403);
  }

  const students = await c.env.DB.prepare(
    `SELECT id, student_code, name, "no", line_user_id, linked_at, notify_enabled
       FROM students WHERE class_id = ? ORDER BY "no" ASC, name ASC`,
  )
    .bind(classId)
    .all();

  return c.json({ ok: true, students: students.results ?? [] });
});

teacherApiRoutes.post("/students/:id/regenerate-link", async (c) => {
  const teacher = c.get("teacher");
  const studentId = c.req.param("id");

  const student = await c.env.DB.prepare(`SELECT class_id, student_code FROM students WHERE id = ?`)
    .bind(studentId)
    .first<{ class_id: string; student_code: string }>();

  if (!student) return c.json({ ok: false, error: "ไม่พบนักเรียน" }, 404);

  if (teacher.role !== "admin") {
    const hasAccess = await c.env.DB.prepare(
      `SELECT c.id FROM courses c WHERE c.class_id = ? AND c.teacher_id = ?`,
    )
      .bind(student.class_id, teacher.id)
      .first();
    if (!hasAccess) return c.json({ ok: false, error: "ไม่มีสิทธิ์" }, 403);
  }

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString(); // อายุ 3 วัน
  const hash = await hashLinkCode(c.env.LINK_CODE_PEPPER, student.student_code, code);

  await c.env.DB.prepare(
    `UPDATE students SET link_code_hash = ?, link_code_expires_at = ?, link_attempts = 0 WHERE id = ?`,
  )
    .bind(hash, expiresAt, studentId)
    .run();

  return c.json({ ok: true, link_code: code, expires_at: expiresAt });
});

// ---------------------------------------------------------------- งานและการบ้าน

const assignmentSchema = z.object({
  course_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  max_score: z.number().min(0).max(1000),
  assigned_at: z.string().min(10),
  due_at: z.string().min(10),
  remind_minutes: z.array(z.number()).optional(),
  remind_at: z.string().optional(),
});

teacherApiRoutes.post("/assignments", async (c) => {
  const teacher = c.get("teacher");
  const body = await c.req.json().catch(() => ({}));
  const parsed = assignmentSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลงานไม่ถูกต้อง" }, 400);

  const data = parsed.data;
  const allowed = await assertTeacherCourseAccess(c.env.DB, teacher, data.course_id);
  if (!allowed) return c.json({ ok: false, error: "ไม่มีสิทธิ์สั่งงานในวิชานี้" }, 403);

  const id = newId("as");
  const nowIso = new Date().toISOString();
  const batchId = newId("b");

  await c.env.DB.prepare(
    `INSERT INTO assignments
       (id, course_id, title, description, max_score, assigned_at, due_at, remind_minutes, remind_at, batch_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      data.course_id,
      data.title.trim(),
      (data.description ?? "").trim(),
      data.max_score,
      data.assigned_at,
      data.due_at,
      JSON.stringify(data.remind_minutes ?? [4320, 1440, 360, 60]),
      data.remind_at || null,
      batchId,
      teacher.id,
      nowIso,
      nowIso,
    )
    .run();

  return c.json({ ok: true, assignment_id: id });
});

// ---------------------------------------------------------------- ประกาศงานเข้ากลุ่ม LINE ห้อง

teacherApiRoutes.post("/assignments/:id/announce", async (c) => {
  const teacher = c.get("teacher");
  const id = c.req.param("id");

  const a = await c.env.DB.prepare(
    `SELECT a.*, c.name AS course_name, cl.level, cl.room, cl.line_group_id
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       JOIN classes cl ON cl.id = c.class_id
      WHERE a.id = ?`,
  )
    .bind(id)
    .first<any>();

  if (!a) return c.json({ ok: false, error: "ไม่พบงาน" }, 404);

  const allowed = await assertTeacherCourseAccess(c.env.DB, teacher, a.course_id);
  if (!allowed) return c.json({ ok: false, error: "ไม่มีสิทธิ์" }, 403);

  if (!a.line_group_id) {
    return c.json({ ok: false, error: "ห้องนี้ยังไม่ได้ผูกกลุ่ม LINE กรุณาพิมพ์คำสั่งผูกห้องในกลุ่ม LINE ก่อน" }, 400);
  }

  const line = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
  const msg = groupAnnounceMessage(a, teacher.display_name);
  const res = await line.push(a.line_group_id, [msg]);

  if (!res.ok) {
    return c.json({ ok: false, error: "ส่งประกาศเข้ากลุ่มไม่สำเร็จ (บอตอาจไม่ได้อยู่ในกลุ่ม)" }, 500);
  }

  return c.json({ ok: true, message: "ประกาศเข้ากลุ่ม LINE เรียบร้อยแล้ว" });
});

// ---------------------------------------------------------------- ตารางคะแนนและการส่งงาน

teacherApiRoutes.get("/courses/:course_id/submissions", async (c) => {
  const teacher = c.get("teacher");
  const courseId = c.req.param("course_id");

  const allowed = await assertTeacherCourseAccess(c.env.DB, teacher, courseId);
  if (!allowed) return c.json({ ok: false, error: "ไม่มีสิทธิ์" }, 403);

  const assignments = await c.env.DB.prepare(
    `SELECT id, title, max_score, due_at FROM assignments WHERE course_id = ? AND is_archived = 0 ORDER BY due_at ASC`,
  )
    .bind(courseId)
    .all();

  const course = await c.env.DB.prepare(`SELECT class_id FROM courses WHERE id = ?`).bind(courseId).first<{ class_id: string }>();
  const students = course
    ? await c.env.DB.prepare(`SELECT id, student_code, name, "no" FROM students WHERE class_id = ? ORDER BY "no" ASC`).bind(course.class_id).all()
    : { results: [] };

  const subs = await c.env.DB.prepare(
    `SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE a.course_id = ?`,
  )
    .bind(courseId)
    .all();

  return c.json({
    ok: true,
    assignments: assignments.results ?? [],
    students: students.results ?? [],
    submissions: subs.results ?? [],
  });
});

const gradeSchema = z.object({
  assignment_id: z.string().min(1),
  student_id: z.string().min(1),
  score: z.number().min(0).nullable(),
  note: z.string().max(500).optional(),
  mark_submitted: z.boolean().optional(),
});

teacherApiRoutes.post("/grade", async (c) => {
  const teacher = c.get("teacher");
  const body = await c.req.json().catch(() => ({}));
  const parsed = gradeSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const { assignment_id, student_id, score, note, mark_submitted } = parsed.data;

  const a = await c.env.DB.prepare(`SELECT course_id, max_score FROM assignments WHERE id = ?`)
    .bind(assignment_id)
    .first<{ course_id: string; max_score: number }>();

  if (!a) return c.json({ ok: false, error: "ไม่พบงาน" }, 404);

  const allowed = await assertTeacherCourseAccess(c.env.DB, teacher, a.course_id);
  if (!allowed) return c.json({ ok: false, error: "ไม่มีสิทธิ์" }, 403);

  if (score !== null && score > a.max_score) {
    return c.json({ ok: false, error: `คะแนนต้องไม่เกินคะแนนเต็ม (${a.max_score})` }, 400);
  }

  const nowIso = new Date().toISOString();
  const subId = newId("sub");

  // ถ้าให้คะแนน ให้ถือว่าส่งงานแล้วอัตโนมัติหากยังไม่ได้ส่ง
  const submittedAtVal = mark_submitted || score !== null ? nowIso : null;
  const scoredAtVal = score !== null ? nowIso : null;

  await c.env.DB.prepare(
    `INSERT INTO submissions
       (id, assignment_id, student_id, submitted_at, score, scored_at, note, updated_at)
     VALUES (?, ?, ?, COALESCE((SELECT submitted_at FROM submissions WHERE assignment_id=? AND student_id=?), ?), ?, ?, ?, ?)
     ON CONFLICT(assignment_id, student_id) DO UPDATE SET
       submitted_at = COALESCE(submissions.submitted_at, excluded.submitted_at),
       score = excluded.score,
       scored_at = excluded.scored_at,
       score_notified_at = CASE WHEN excluded.score <> COALESCE(submissions.score, -1) THEN NULL ELSE submissions.score_notified_at END,
       note = COALESCE(?, submissions.note),
       updated_at = excluded.updated_at`,
  )
    .bind(
      subId,
      assignment_id,
      student_id,
      assignment_id,
      student_id,
      submittedAtVal,
      score,
      scoredAtVal,
      note ?? "",
      nowIso,
    )
    .run();

  return c.json({ ok: true });
});
