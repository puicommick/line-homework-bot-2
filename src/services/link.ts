import type { Env } from "../env";
import { hashLinkCode, timingSafeEqualStr } from "../lib/crypto";
import { T } from "../line/text";
import { formatClassName } from "../lib/thai-date";

export async function handleLinkFlow(
  db: D1Database,
  pepper: string,
  userId: string,
  text: string,
  nowMs: number,
): Promise<string> {
  const nowIso = new Date(nowMs).toISOString();
  const trimmed = text.trim();

  const existing = await db
    .prepare(`SELECT * FROM students WHERE line_user_id = ?`)
    .bind(userId)
    .first<{ name: string }>();
  if (existing) {
    return `คุณ ${existing.name} ผูกบัญชีกับระบบเรียบร้อยแล้วครับ\nกดเมนูด้านล่างเพื่อดูงานหรือคะแนนได้เลย`;
  }

  let throttle = await db
    .prepare(`SELECT attempts, window_start, blocked_until FROM link_throttle WHERE line_user_id = ?`)
    .bind(userId)
    .first<{ attempts: number; window_start: string; blocked_until: string | null }>();

  if (throttle?.blocked_until && Date.parse(throttle.blocked_until) > nowMs) {
    return T.tooManyAttempts;
  }

  let stateRow = await db
    .prepare(`SELECT state, payload FROM chat_states WHERE line_user_id = ? AND expires_at > ?`)
    .bind(userId, nowIso)
    .first<{ state: string; payload: string }>();

  const state = stateRow?.state ?? "idle";
  let payload: Record<string, string> = {};
  try {
    payload = JSON.parse(stateRow?.payload ?? "{}");
  } catch {
    payload = {};
  }

  if (trimmed === "ยกเลิก") {
    await db.prepare(`DELETE FROM chat_states WHERE line_user_id = ?`).bind(userId).run();
    return T.cancelled;
  }

  if (state === "idle" || state === "await_student_code") {
    if (state === "idle" && trimmed !== "ลงทะเบียน") {
      return T.unknownCommand;
    }
    if (state === "idle") {
      await db
        .prepare(
          `INSERT INTO chat_states (line_user_id, state, payload, expires_at, updated_at)
           VALUES (?, 'await_student_code', '{}', ?, ?)
           ON CONFLICT(line_user_id) DO UPDATE SET state='await_student_code', payload='{}', expires_at=?, updated_at=?`,
        )
        .bind(
          userId,
          new Date(nowMs + 600_000).toISOString(),
          nowIso,
          new Date(nowMs + 600_000).toISOString(),
          nowIso,
        )
        .run();
      return T.askStudentCode;
    }

    const studentCode = trimmed;
    const student = await db
      .prepare(
        `SELECT id, name, class_id, link_code_hash, link_code_expires_at, link_attempts FROM students WHERE student_code = ?`,
      )
      .bind(studentCode)
      .first<{
        id: string;
        name: string;
        class_id: string;
        link_code_hash: string | null;
        link_code_expires_at: string | null;
        link_attempts: number;
      }>();

    if (!student) {
      return T.notFoundStudent;
    }

    await db
      .prepare(
        `UPDATE chat_states SET state = 'await_link_code', payload = ?, expires_at = ?, updated_at = ? WHERE line_user_id = ?`,
      )
      .bind(
        JSON.stringify({ student_id: student.id }),
        new Date(nowMs + 600_000).toISOString(),
        nowIso,
        userId,
      )
      .run();

    return T.askLinkCode(student.name);
  }

  if (state === "await_link_code") {
    const studentId = payload["student_id"];
    if (!studentId) {
      await db.prepare(`DELETE FROM chat_states WHERE line_user_id = ?`).bind(userId).run();
      return 'เกิดข้อผิดพลาด กรุณาพิมพ์ "ลงทะเบียน" ใหม่ครับ';
    }

    const student = await db
      .prepare(
        `SELECT id, student_code, name, class_id, link_code_hash, link_code_expires_at, link_attempts FROM students WHERE id = ?`,
      )
      .bind(studentId)
      .first<{
        id: string;
        student_code: string;
        name: string;
        class_id: string;
        link_code_hash: string | null;
        link_code_expires_at: string | null;
        link_attempts: number;
      }>();

    if (!student) {
      await db.prepare(`DELETE FROM chat_states WHERE line_user_id = ?`).bind(userId).run();
      return 'ไม่พบข้อมูลนักเรียน กรุณาพิมพ์ "ลงทะเบียน" ใหม่';
    }

    if (!student.link_code_hash || !student.link_code_expires_at) {
      return T.linkCodeUsed;
    }

    if (Date.parse(student.link_code_expires_at) <= nowMs) {
      return T.linkCodeExpired;
    }

    if (student.link_attempts >= 5) {
      return "รหัสถูกระงับชั่วคราวเนื่องจากใส่ผิดเกินกำหนด กรุณาติดต่อคุณครูเพื่อขอรหัสใหม่";
    }

    const givenHash = await hashLinkCode(pepper, student.student_code, trimmed);
    const ok = timingSafeEqualStr(givenHash, student.link_code_hash);

    if (!ok) {
      const nextAttempts = student.link_attempts + 1;
      await db
        .prepare(`UPDATE students SET link_attempts = ? WHERE id = ?`)
        .bind(nextAttempts, student.id)
        .run();

      const left = Math.max(0, 5 - nextAttempts);
      return T.wrongLinkCode(left);
    }

    const lineTaken = await db
      .prepare(`SELECT id FROM students WHERE line_user_id = ?`)
      .bind(userId)
      .first<{ id: string }>();

    if (lineTaken) {
      return T.alreadyLinked;
    }

    const cls = await db
      .prepare(`SELECT level, room FROM classes WHERE id = ?`)
      .bind(student.class_id)
      .first<{ level: number; room: number }>();

    await db.batch([
      db.prepare(
        `UPDATE students SET line_user_id = ?, linked_at = ?, link_code_hash = NULL, link_code_expires_at = NULL, link_attempts = 0 WHERE id = ?`,
      ).bind(userId, nowIso, student.id),
      db.prepare(`DELETE FROM chat_states WHERE line_user_id = ?`).bind(userId),
    ]);

    const className = cls ? formatClassName(cls.level, cls.room) : "";
    return T.linkSuccess(student.name, className);
  }

  return T.unknownCommand;
}
