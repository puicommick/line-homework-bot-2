import type { Env } from "../env";
import { readConfig } from "../env";
import { sha256Hex } from "../lib/crypto";
import { generateSessionToken } from "../lib/session";
import { newId } from "../lib/ids";
import { LineClient } from "../line/client";
import { formatThaiDateTime } from "../lib/thai-date";
import { log } from "../lib/logger";

const RESET_WINDOW_MS = 3_600_000; // 1 ชั่วโมง

export function hashResetToken(pepper: string, token: string): Promise<string> {
  return sha256Hex(`reset::${pepper}::${token}`);
}

export interface RequestResetOutcome {
  /** ตอบกลับผู้ใช้เหมือนกันเสมอ ไม่บอกว่ามีบัญชีนี้จริงไหม */
  publicMessage: string;
  /** ใช้เฉพาะใน log ภายใน */
  internal: "sent" | "no_account" | "no_line" | "throttled" | "push_failed";
}

const GENERIC_MSG =
  "หากชื่อผู้ใช้นี้มีอยู่ในระบบและผูกบัญชี LINE ไว้แล้ว " +
  "ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่แชท LINE ของท่านแล้ว\n" +
  "กรุณาตรวจสอบในแชทกับบอต (ลิงก์มีอายุจำกัด)";

/**
 * ขอลิงก์รีเซ็ตรหัสผ่าน
 * หลักการ: ตอบข้อความเดียวกันทุกกรณี เพื่อไม่ให้คนภายนอกไล่เดาว่ามี username ไหนอยู่จริง
 */
export async function requestPasswordReset(
  env: Env,
  username: string,
  nowMs: number,
): Promise<RequestResetOutcome> {
  const cfg = readConfig(env);
  const nowIso = new Date(nowMs).toISOString();

  const teacher = await env.DB.prepare(
    `SELECT id, display_name, line_user_id, is_active
       FROM teachers WHERE username = ?`,
  )
    .bind(username)
    .first<{ id: string; display_name: string; line_user_id: string | null; is_active: number }>();

  if (!teacher || teacher.is_active !== 1) {
    return { publicMessage: GENERIC_MSG, internal: "no_account" };
  }
  if (!teacher.line_user_id) {
    return { publicMessage: GENERIC_MSG, internal: "no_line" };
  }

  // ---- throttle ต่อบัญชี ----
  const th = await env.DB.prepare(
    `SELECT attempts, window_start, blocked_until FROM reset_throttle WHERE teacher_id = ?`,
  )
    .bind(teacher.id)
    .first<{ attempts: number; window_start: string; blocked_until: string | null }>();

  if (th?.blocked_until && Date.parse(th.blocked_until) > nowMs) {
    return { publicMessage: GENERIC_MSG, internal: "throttled" };
  }

  const windowExpired = !th || nowMs - Date.parse(th.window_start) > RESET_WINDOW_MS;
  const attempts = windowExpired ? 1 : th!.attempts + 1;
  const blockedUntil =
    attempts > cfg.resetMaxPerHour ? new Date(nowMs + RESET_WINDOW_MS).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO reset_throttle (teacher_id, attempts, window_start, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(teacher_id) DO UPDATE SET
       attempts = excluded.attempts,
       window_start = CASE WHEN ? THEN excluded.window_start ELSE reset_throttle.window_start END,
       blocked_until = excluded.blocked_until`,
  )
    .bind(teacher.id, attempts, windowExpired ? nowIso : (th?.window_start ?? nowIso), blockedUntil, windowExpired ? 1 : 0)
    .run();

  if (blockedUntil) {
    return { publicMessage: GENERIC_MSG, internal: "throttled" };
  }

  // ---- ยกเลิกลิงก์เก่าที่ยังไม่ได้ใช้ ให้เหลือใบล่าสุดใบเดียว ----
  await env.DB.prepare(
    `UPDATE password_resets SET used_at = ? WHERE teacher_id = ? AND used_at IS NULL`,
  )
    .bind(nowIso, teacher.id)
    .run();

  const token = generateSessionToken();
  const expiresAt = new Date(nowMs + cfg.resetTtlMs).toISOString();

  await env.DB.prepare(
    `INSERT INTO password_resets (id, teacher_id, token_hash, created_at, expires_at, used_at, attempts)
     VALUES (?, ?, ?, ?, ?, NULL, 0)`,
  )
    .bind(newId("rst"), teacher.id, await hashResetToken(env.LINK_CODE_PEPPER, token), nowIso, expiresAt)
    .run();

  const url = `${cfg.appBaseUrl}/reset?token=${encodeURIComponent(token)}`;
  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

  const result = await line.push(teacher.line_user_id, [
    {
      type: "flex",
      altText: "ลิงก์ตั้งรหัสผ่านใหม่",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#1D4ED8",
          paddingAll: "14px",
          contents: [
            { type: "text", text: "🔐 ตั้งรหัสผ่านใหม่", color: "#FFFFFF", weight: "bold", size: "md" },
          ],
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          paddingAll: "16px",
          contents: [
            { type: "text", text: `เรียน ${teacher.display_name}`, size: "sm", wrap: true, color: "#0F172A" },
            {
              type: "text",
              text: "มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชีครูของท่าน กดปุ่มด้านล่างเพื่อดำเนินการ",
              size: "xs",
              wrap: true,
              color: "#64748B",
            },
            {
              type: "text",
              text: `ลิงก์หมดอายุ ${formatThaiDateTime(expiresAt)}`,
              size: "xs",
              color: "#DC2626",
              wrap: true,
              margin: "sm",
            },
            {
              type: "text",
              text: "หากท่านไม่ได้เป็นผู้ขอ ให้ละเว้นข้อความนี้ รหัสผ่านเดิมจะยังใช้ได้ตามปกติ",
              size: "xxs",
              wrap: true,
              color: "#94A3B8",
              margin: "md",
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          paddingAll: "12px",
          contents: [
            {
              type: "button",
              style: "primary",
              color: "#2563EB",
              height: "sm",
              action: { type: "uri", label: "ตั้งรหัสผ่านใหม่", uri: url },
            },
          ],
        },
      },
    },
  ]);

  if (!result.ok) {
    log.warn("reset push failed", { status: result.status });
    return { publicMessage: GENERIC_MSG, internal: "push_failed" };
  }
  return { publicMessage: GENERIC_MSG, internal: "sent" };
}

export interface ResetTokenCheck {
  ok: boolean;
  teacherId?: string;
  resetId?: string;
  displayName?: string;
  error?: string;
}

export async function checkResetToken(
  env: Env,
  token: string,
  nowMs: number,
): Promise<ResetTokenCheck> {
  if (!token || token.length < 20) return { ok: false, error: "ลิงก์ไม่ถูกต้อง" };

  const row = await env.DB.prepare(
    `SELECT r.id, r.teacher_id, r.expires_at, r.used_at, t.display_name, t.is_active
       FROM password_resets r
       JOIN teachers t ON t.id = r.teacher_id
      WHERE r.token_hash = ?`,
  )
    .bind(await hashResetToken(env.LINK_CODE_PEPPER, token))
    .first<{
      id: string; teacher_id: string; expires_at: string;
      used_at: string | null; display_name: string; is_active: number;
    }>();

  if (!row) return { ok: false, error: "ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว" };
  if (row.used_at) return { ok: false, error: "ลิงก์นี้ถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่" };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, error: "ลิงก์หมดอายุแล้ว กรุณาขอลิงก์ใหม่" };
  if (row.is_active !== 1) return { ok: false, error: "บัญชีนี้ถูกปิดใช้งาน" };

  return { ok: true, teacherId: row.teacher_id, resetId: row.id, displayName: row.display_name };
}
