import type { TeacherRow } from "../types";

/**
 * ตรวจว่าครูมีสิทธิ์จัดการวิชา/ห้องนี้หรือไม่
 * - แอดมิน (admin) ผ่านทุกกรณี
 * - ครูทั่วไป (teacher) ต้องสอนวิชานั้นจริง ๆ (`courses.teacher_id = teacher.id`)
 */
export async function assertTeacherCourseAccess(
  db: D1Database,
  teacher: TeacherRow,
  courseId: string,
): Promise<boolean> {
  if (teacher.role === "admin") return true;
  const row = await db
    .prepare(`SELECT id FROM courses WHERE id = ? AND teacher_id = ?`)
    .bind(courseId, teacher.id)
    .first<{ id: string }>();
  return Boolean(row);
}

/** กรองรายชื่อวิชาตามสิทธิ์ของครู */
export function buildCourseScopeQuery(teacher: TeacherRow, alias = "c"): { sql: string; bind: string[] } {
  if (teacher.role === "admin") {
    return { sql: "1=1", bind: [] };
  }
  return { sql: `${alias}.teacher_id = ?`, bind: [teacher.id] };
}
