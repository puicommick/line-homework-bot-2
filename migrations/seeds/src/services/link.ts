import type { Env } from "../env";
import { readConfig } from "../env";
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

  // ตรวจสอบว่าผูกแล้วหรือยัง
  const existing = await db.prepare(`SELECT * FROM students WHERE line_user_id = ?`).bind(userId).first<{ name: string }>();
  if (existing) {
    return `คุณ ${existing.name} ผูกบัญชีกับระบบเรียบร้อยแล้วครับ\nกดเมนูด้านล่างเพื่อดูงานหรือคะแนนได้เลย`;
  }

  // ---- Throttle รายผู้ใช้ LINE ----
  let throttle = await db
    .prepare(`SELECT attempts, window_start, blocked_until FROM link_throttle WHERE line_user_id = ?`)
    .bind(userId)
    .first<{ attempts: number; window_start: string; blocked_until: string | null }>();

  if (throttle?.blocked_until && Date.parse(throttle.blocked_until) > nowMs) {
    return T.tooManyAttempts;
  }

  // ดึง state ปัจจุบัน
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

  // State 1: รอรับรหัสนักเรียน
  if (state === "idle" || state === "await_student_code") {
    if (state === "idle" && trimmed !== "ลงทะเบียน") {
      return T.unknownCommand;
    }
    if (state === "idle") {
      await db.prepare(
        `INSERT INTO chat_states (line_user_id, state, payload, expires_at, updated_at)
         VALUES (?, 'await_student_code', '{}', ?, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET state='await_student_code', payload='{}', expires_at=?, updated_at=?`,
      )
        .bind(userId, new Date(nowMs + 600_000).toISOString(), nowIso, new Date(nowMs + 600_000).toISOString(), nowIso)
        .run();
      return T.askStudentCode;
    }

    // ผู้ใช้พิมพ์รหัสนักเรียนมาแล้ว
    const studentCode = trimmed;
    const student = await db
      .prepare(`SELECT id, name, class_id, link_code_hash, link_code_expires_at, link_attempts FROM students WHERE student_code = ?`)
      .bind(studentCode)
      .first<{ id: string; name: string; class_id: string; link_code_hash: string | null; link_code_expires_at: string | null; link_attempts: number }>();

    if (!student) {
      return T.notFoundStudent;
    }

    // บันทึก student_id ไว้ใน state แล้วขอรหัส 6 หลัก
    await db.prepare(
      `UPDATE chat_states SET state = 'await_link_code', payload = ?, expires_at = ?, updated_at = ? WHERE line_user_id = ?`,
    )
      .bind(JSON.stringify({ student_id: student.id }), new Date(nowMs + 600_000).toISOString(), nowIso, userId)
      .run();

    return T.askLinkCode(student.name);
  }

  // State 2: รอรับรหัสผูกบัญชี 6 หลัก
  if (state === "await_link_code") {
    const studentId = payload["student_id"];
    if (!studentId) {
      await db.prepare(`DELETE FROM chat_states WHERE line_user_id = ?`).bind(userId).run();
      return "เกิดข้อผิดพลาด กรุณาพิมพ์ \"ลงทะเบียน\" ใหม่ครับ";
    }

    const student = await db
      .prepare(`SELECT id, student_code, name, class_id, link_code_hash, link_code_expires_at, link_attempts FROM students WHERE id = ?`)
      .bind(studentId)
      .first<{ id: string; student_code: string; name: string; class_id: string; link_code_hash: string | null;
