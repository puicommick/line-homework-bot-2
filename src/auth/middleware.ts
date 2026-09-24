import type { Context, Next } from "hono";
import type { Env } from "../env";
import { readConfig } from "../env";
import { resolveSession } from "../lib/session";
import type { TeacherRow } from "../types";

export interface AuthVars {
  teacher: TeacherRow;
  sessionId: string;
  sessionToken: string;
}

export type AppContext = Context<{ Bindings: Env; Variables: AuthVars }>;

export function bearerToken(c: Context): string | null {
  const header = c.req.header("Authorization") || c.req.header("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * ด่านเดียวที่ทุก /api/* ต้องผ่าน
 * ไม่มีทางลัด ไม่มี query param, ไม่รับ userId จาก client เด็ดขาด
 */
export async function requireTeacher(
  c: Context<{ Bindings: Env; Variables: AuthVars }>,
  next: Next,
): Promise<Response | void> {
  const token = bearerToken(c);
  if (!token) {
    return c.json({ ok: false, error: "กรุณาเข้าสู่ระบบก่อนใช้งาน", code: "UNAUTHENTICATED" }, 401);
  }

  const cfg = readConfig(c.env);
  void cfg;
  const now = Date.now();
  const session = await resolveSession(c.env.DB, c.env.LINK_CODE_PEPPER, token, now);
  if (!session) {
    return c.json({ ok: false, error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", code: "SESSION_EXPIRED" }, 401);
  }

  const teacher = await c.env.DB.prepare(
    `SELECT id, line_user_id, display_name, role, is_active, created_at
       FROM teachers WHERE id = ? AND is_active = 1`,
  )
    .bind(session.teacherId)
    .first<TeacherRow>();

  if (!teacher) {
    return c.json({ ok: false, error: "ไม่พบบัญชีครู หรือบัญชีถูกปิดใช้งาน", code: "NO_TEACHER" }, 403);
  }

  c.set("teacher", teacher);
  c.set("sessionId", session.sessionId);
  c.set("sessionToken", token);
  await next();
}

/** เฉพาะผู้ดูแลระบบ: จัดการบัญชีครูคนอื่น ออกรหัสเชิญ */
export async function requireAdmin(
  c: Context<{ Bindings: Env; Variables: AuthVars }>,
  next: Next,
): Promise<Response | void> {
  const teacher = c.get("teacher");
  if (!teacher || teacher.role !== "admin") {
    return c.json({ ok: false, error: "ต้องเป็นผู้ดูแลระบบเท่านั้น", code: "FORBIDDEN" }, 403);
  }
  await next();
}
