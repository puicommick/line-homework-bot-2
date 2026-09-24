import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { readConfig } from "../env";
import { newId } from "../lib/ids";
import { log } from "../lib/logger";
import { hashPassword, verifyPassword, checkPasswordStrength, normalizeUsername } from "../lib/password";
import { createSession, revokeSession, revokeAllSessions, hashInviteCode, hashIp } from "../lib/session";
import { verifyLiffAccessToken, channelIdFromLiffId } from "../auth/liff-auth";
import { requireTeacher, requireAdmin, bearerToken, type AuthVars } from "../auth/middleware";
import { formatThaiDateTime } from "../lib/thai-date";
import type { TeacherRow } from "../types";

export const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

interface TeacherAuthRow extends TeacherRow {
  username: string | null;
  password_hash: string | null;
  must_change_password: number;
  failed_logins: number;
  locked_until: string | null;
}

const LOCK_MINUTES = 15;

// ---------------------------------------------------------------- helpers

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") || c.req.header("cf-connecting-ip") || "unknown";
}

async function audit(
  db: D1Database,
  teacherId: string | null,
  action: string,
  detail: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(`INSERT INTO auth_log (id, teacher_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(newId("aud"), teacherId, action, detail.slice(0, 200), new Date(nowMs).toISOString())
    .run();
}

/** throttle รายไอพี — คืน true ถ้าถูกบล็อกอยู่ */
async function isIpBlocked(db: D1Database, ipHash: string, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT blocked_until FROM login_throttle WHERE ip_hash = ?`)
    .bind(ipHash)
    .first<{ blocked_until: string | null }>();
  if (!row || !row.blocked_until) return false;
  return Date.parse(row.blocked_until) > nowMs;
}

async function recordFailedIp(
  db: D1Database,
  ipHash: string,
  nowMs: number,
  maxAttempts: number,
  windowMs: number,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const row = await db
    .prepare(`SELECT attempts, window_start FROM login_throttle WHERE ip_hash = ?`)
    .bind(ipHash)
    .first<{ attempts: number; window_start: string }>();

  if (!row || nowMs - Date.parse(row.window_start) > windowMs) {
    await db
      .prepare(
        `INSERT INTO login_throttle (ip_hash, attempts, window_start, blocked_until)
         VALUES (?, 1, ?, NULL)
         ON CONFLICT(ip_hash) DO UPDATE SET attempts = 1, window_start = ?, blocked_until = NULL`,
      )
      .bind(ipHash, nowIso, nowIso)
      .run();
    return;
  }

  const attempts = row.attempts + 1;
  const blockedUntil = attempts >= maxAttempts ? new Date(nowMs + LOCK_MINUTES * 60_000).toISOString() : null;
  await db
    .prepare(`UPDATE login_throttle SET attempts = ?, blocked_until = ? WHERE ip_hash = ?`)
    .bind(attempts, blockedUntil, ipHash)
    .run();
}

async function clearIpThrottle(db: D1Database, ipHash: string): Promise<void> {
  await db.prepare(`DELETE FROM login_throttle WHERE ip_hash = ?`).bind(ipHash).run();
}

function publicTeacher(t: TeacherAuthRow) {
  return {
    id: t.id,
    display_name: t.display_name,
    username: t.username,
    role: t.role,
    linked_line: Boolean(t.line_user_id),
    must_change_password: t.must_change_password === 1,
  };
}

// ---------------------------------------------------------------- POST /auth/login

const loginSchema = z.object({
  username: z.string().min(1, "กรุณากรอกชื่อผู้ใช้").max(64),
  password: z.string().min(1, "กรุณากรอกรหัสผ่าน").max(128),
});

authRoutes.post("/login", async (c) => {
  const cfg = readConfig(c.env);
  const now = Date.now();
  const ipHash = await hashIp(c.env.LINK_CODE_PEPPER, clientIp(c));

  if (await isIpBlocked(c.env.DB, ipHash, now)) {
    return c.json(
      { ok: false, error: `พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารออีก ${LOCK_MINUTES} นาที` },
      429,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  const username = normalizeUsername(parsed.data.username);
  const teacher = username
    ? await c.env.DB.prepare(
        `SELECT id, line_user_id, display_name, role, is_active, created_at,
                username, password_hash, must_change_password, failed_logins, locked_until
           FROM teachers WHERE username = ?`,
      )
        .bind(username)
        .first<TeacherAuthRow>()
    : null;

  // บัญชีถูกล็อกชั่วคราว
  if (teacher?.locked_until && Date.parse(teacher.locked_until) > now) {
    await audit(c.env.DB, teacher.id, "login_fail", "locked", now);
    return c.json(
      { ok: false, error: `บัญชีถูกล็อกชั่วคราวถึง ${formatThaiDateTime(teacher.locked_until)}` },
      423,
    );
  }

  // คำนวณ hash เสมอแม้ไม่พบบัญชี เพื่อไม่ให้เวลาตอบบอกใบ้ว่ามี username นี้อยู่จริงไหม
  const passOk = await verifyPassword(parsed.data.password, teacher?.password_hash ?? null);

  if (!teacher || !teacher.is_active || !passOk) {
    await recordFailedIp(c.env.DB, ipHash, now, cfg.loginMaxAttempts, cfg.loginWindowMs);
    if (teacher) {
      const failed = teacher.failed_logins + 1;
      const lockUntil = failed >= cfg.loginMaxAttempts ? new Date(now + LOCK_MINUTES * 60_000).toISOString() : null;
      await c.env.DB.prepare(`UPDATE teachers SET failed_logins = ?, locked_until = ? WHERE id = ?`)
        .bind(failed, lockUntil, teacher.id)
        .run();
      await audit(c.env.DB, teacher.id, "login_fail", "bad_password", now);
    }
    return c.json({ ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);
  }

  await clearIpThrottle(c.env.DB, ipHash);
  await c.env.DB.prepare(
    `UPDATE teachers SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`,
  )
    .bind(new Date(now).toISOString(), teacher.id)
    .run();

  const session = await createSession(c.env.DB, c.env.LINK_CODE_PEPPER, teacher.id, "password", cfg.sessionTtlMs, now);
  await audit(c.env.DB, teacher.id, "login_ok", "password", now);

  return c.json({
    ok: true,
    token: session.token,
    expires_at: session.expiresAt,
    teacher: publicTeacher(teacher),
  });
});

// ---------------------------------------------------------------- POST /auth/liff
// แลก LIFF access token เป็น session ของระบบเรา (ครูที่ผูก LINE ไว้แล้วเท่านั้น)

const liffSchema = z.object({ accessToken: z.string().min(10).max(4096) });

authRoutes.post("/liff", async (c) => {
  const cfg = readConfig(c.env);
  const now = Date.now();

  const body = await c.req.json().catch(() => ({}));
  const parsed = liffSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const verified = await verifyLiffAccessToken(parsed.data.accessToken, channelIdFromLiffId(c.env));
  if (!verified.ok || !verified.userId) {
    return c.json({ ok: false, error: verified.error ?? "ยืนยันตัวตนกับ LINE ไม่สำเร็จ" }, 401);
  }

  const teacher = await c.env.DB.prepare(
    `SELECT id, line_user_id, display_name, role, is_active, created_at,
            username, password_hash, must_change_password, failed_logins, locked_until
       FROM teachers WHERE line_user_id = ? AND is_active = 1`,
  )
    .bind(verified.userId)
    .first<TeacherAuthRow>();

  if (!teacher) {
    return c.json(
      {
        ok: false,
        code: "NOT_LINKED",
        error: "บัญชี LINE นี้ยังไม่ได้ผูกกับบัญชีครู กรุณาเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านก่อน แล้วกดผูกบัญชี LINE",
      },
      403,
    );
  }

  const session = await createSession(c.env.DB, c.env.LINK_CODE_PEPPER, teacher.id, "liff", cfg.sessionTtlMs, now);
  await c.env.DB.prepare(`UPDATE teachers SET last_login_at = ? WHERE id = ?`)
    .bind(new Date(now).toISOString(), teacher.id)
    .run();
  await audit(c.env.DB, teacher.id, "liff_login", "", now);

  return c.json({
    ok: true,
    token: session.token,
    expires_at: session.expiresAt,
    teacher: publicTeacher(teacher),
  });
});

// ---------------------------------------------------------------- POST /auth/register
// เปิดบัญชีครูใหม่ด้วย "รหัสเชิญ"
//  - ครูคนแรกของระบบ ใช้ TEACHER_SETUP_CODE (secret) และได้ role = admin อัตโนมัติ
//  - คนถัดไป ใช้รหัสเชิญที่ผู้ดูแลออกให้จากหน้าเว็บ

const registerSchema = z.object({
  invite_code: z.string().min(4).max(64),
  username: z.string().min(4).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1, "กรุณากรอกชื่อ-นามสกุล").max(80),
});

authRoutes.post("/register", async (c) => {
  const cfg = readConfig(c.env);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const ipHash = await hashIp(c.env.LINK_CODE_PEPPER, clientIp(c));

  if (await isIpBlocked(c.env.DB, ipHash, now)) {
    return c.json({ ok: false, error: "พยายามหลายครั้งเกินไป กรุณารอสักครู่" }, 429);
  }
  if (!cfg.allowSelfRegister) {
    return c.json({ ok: false, error: "ระบบปิดการสมัครด้วยตนเอง กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  const username = normalizeUsername(parsed.data.username);
  if (!username) {
    return c.json(
      { ok: false, error: "ชื่อผู้ใช้ต้องเป็น a-z, 0-9, จุด, ขีดล่าง หรือขีดกลาง ยาว 4-32 ตัว" },
      400,
    );
  }

  const strength = checkPasswordStrength(parsed.data.password);
  if (!strength.ok) return c.json({ ok: false, error: strength.reason }, 400);

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM teachers`).first<{ n: number }>();
  const isFirstTeacher = (countRow?.n ?? 0) === 0;

  let role: "teacher" | "admin" = "teacher";
  let inviteId: string | null = null;

  if (isFirstTeacher) {
    // เทียบกับ secret โดยตรง (constant-time ผ่าน verify ของ hash ไม่จำเป็นที่นี่เพราะเป็นครั้งเดียว
    // แต่ยังใช้ hash เทียบเพื่อความสม่ำเสมอ)
    const given = await hashInviteCode(c.env.LINK_CODE_PEPPER, parsed.data.invite_code);
    const expect = await hashInviteCode(c.env.LINK_CODE_PEPPER, c.env.TEACHER_SETUP_CODE);
    if (given !== expect) {
      await recordFailedIp(c.env.DB, ipHash, now, cfg.loginMaxAttempts, cfg.loginWindowMs);
      return c.json({ ok: false, error: "รหัสเชิญไม่ถูกต้อง" }, 401);
    }
    role = "admin";
  } else {
    const codeHash = await hashInviteCode(c.env.LINK_CODE_PEPPER, parsed.data.invite_code);
    const invite = await c.env.DB.prepare(
      `SELECT id, role, expires_at, used_at FROM teacher_invites WHERE code_hash = ?`,
    )
      .bind(codeHash)
      .first<{ id: string; role: "teacher" | "admin"; expires_at: string; used_at: string | null }>();

    if (!invite || invite.used_at || Date.parse(invite.expires_at) <= now) {
      await recordFailedIp(c.env.DB, ipHash, now, cfg.loginMaxAttempts, cfg.loginWindowMs);
      return c.json({ ok: false, error: "รหัสเชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว" }, 401);
    }
    role = invite.role;
    inviteId = invite.id;
  }

  const dup = await c.env.DB.prepare(`SELECT id FROM teachers WHERE username = ?`)
    .bind(username)
    .first<{ id: string }>();
  if (dup) return c.json({ ok: false, error: "ชื่อผู้ใช้นี้ถูกใช้แล้ว กรุณาเลือกชื่ออื่น" }, 409);

  const teacherId = newId("tc");
  const passwordHash = await hashPassword(parsed.data.password);

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO teachers
         (id, line_user_id, display_name, role, is_active, created_at,
          username, password_hash, password_updated_at, must_change_password,
          failed_logins, locked_until, last_login_at, email)
       VALUES (?, NULL, ?, ?, 1, ?, ?, ?, ?, 0, 0, NULL, ?, NULL)`,
    ).bind(teacherId, parsed.data.display_name.trim(), role, nowIso, username, passwordHash, nowIso, nowIso),
  ];
  if (inviteId) {
    statements.push(
      c.env.DB.prepare(`UPDATE teacher_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`)
        .bind(nowIso, teacherId, inviteId),
    );
  }
  await c.env.DB.batch(statements);

  await clearIpThrottle(c.env.DB, ipHash);
  await audit(c.env.DB, teacherId, "register", role, now);

  const session = await createSession(c.env.DB, c.env.LINK_CODE_PEPPER, teacherId, "password", cfg.sessionTtlMs, now);
  log.info("teacher registered", { role, first: isFirstTeacher });

  return c.json({
    ok: true,
    token: session.token,
    expires_at: session.expiresAt,
    teacher: {
      id: teacherId,
      display_name: parsed.data.display_name.trim(),
      username,
      role,
      linked_line: false,
      must_change_password: false,
    },
  });
});

// ---------------------------------------------------------------- GET /auth/setup-status
// ให้หน้าเว็บรู้ว่าควรแสดง "สร้างบัญชีผู้ดูแลคนแรก" หรือ "เข้าสู่ระบบ"

authRoutes.get("/setup-status", async (c) => {
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM teachers`).first<{ n: number }>();
  const cfg = readConfig(c.env);
  return c.json({
    ok: true,
    needs_setup: (row?.n ?? 0) === 0,
    allow_self_register: cfg.allowSelfRegister,
    liff_id: cfg.liffId,
    school_name: cfg.schoolName,
  });
});

// ---------------------------------------------------------------- endpoints ที่ต้องล็อกอิน

authRoutes.get("/me", requireTeacher, async (c) => {
  const teacher = c.get("teacher");
  const full = await c.env.DB.prepare(
    `SELECT id, line_user_id, display_name, role, is_active, created_at,
            username, password_hash, must_change_password, failed_logins, locked_until
       FROM teachers WHERE id = ?`,
  )
    .bind(teacher.id)
    .first<TeacherAuthRow>();
  if (!full) return c.json({ ok: false, error: "ไม่พบบัญชี" }, 404);
  return c.json({ ok: true, teacher: publicTeacher(full) });
});

authRoutes.post("/logout", requireTeacher, async (c) => {
  const token = bearerToken(c);
  const now = Date.now();
  if (token) await revokeSession(c.env.DB, c.env.LINK_CODE_PEPPER, token, now);
  await audit(c.env.DB, c.get("teacher").id, "logout", "", now);
  return c.json({ ok: true, message: "ออกจากระบบแล้ว" });
});

const changePwSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(8).max(128),
});

authRoutes.post("/change-password", requireTeacher, async (c) => {
  const now = Date.now();
  const teacher = c.get("teacher");

  const body = await c.req.json().catch(() => ({}));
  const parsed = changePwSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  const strength = checkPasswordStrength(parsed.data.new_password);
  if (!strength.ok) return c.json({ ok: false, error: strength.reason }, 400);

  const row = await c.env.DB.prepare(`SELECT password_hash FROM teachers WHERE id = ?`)
    .bind(teacher.id)
    .first<{ password_hash: string | null }>();

  const ok = await verifyPassword(parsed.data.current_password, row?.password_hash ?? null);
  if (!ok) {
    await audit(c.env.DB, teacher.id, "pw_change", "wrong_current", now);
    return c.json({ ok: false, error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, 401);
  }

  const newHash = await hashPassword(parsed.data.new_password);
  await c.env.DB.prepare(
    `UPDATE teachers
        SET password_hash = ?, password_updated_at = ?, must_change_password = 0,
            failed_logins = 0, locked_until = NULL
      WHERE id = ?`,
  )
    .bind(newHash, new Date(now).toISOString(), teacher.id)
    .run();

  // เตะอุปกรณ์อื่นออกทั้งหมด เหลือเครื่องปัจจุบัน
  await revokeAllSessions(c.env.DB, teacher.id, now, c.get("sessionId"));
  await audit(c.env.DB, teacher.id, "pw_change", "ok", now);

  return c.json({ ok: true, message: "เปลี่ยนรหัสผ่านเรียบร้อย ระบบได้ออกจากระบบอุปกรณ์อื่นทั้งหมดแล้ว" });
});

/** ผูกบัญชี LINE เข้ากับบัญชีครูที่ล็อกอินอยู่ (เรียกจากใน LIFF เท่านั้น) */
authRoutes.post("/link-line", requireTeacher, async (c) => {
  const now = Date.now();
  const teacher = c.get("teacher");

  const body = await c.req.json().catch(() => ({}));
  const parsed = liffSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const verified = await verifyLiffAccessToken(parsed.data.accessToken, channelIdFromLiffId(c.env));
  if (!verified.ok || !verified.userId) {
    return c.json({ ok: false, error: verified.error ?? "ยืนยันตัวตนกับ LINE ไม่สำเร็จ" }, 401);
  }

  const taken = await c.env.DB.prepare(`SELECT id FROM teachers WHERE line_user_id = ? AND id <> ?`)
    .bind(verified.userId, teacher.id)
    .first<{ id: string }>();
  if (taken) return c.json({ ok: false, error: "บัญชี LINE นี้ถูกผูกกับครูท่านอื่นแล้ว" }, 409);

  const studentTaken = await c.env.DB.prepare(`SELECT id FROM students WHERE line_user_id = ?`)
    .bind(verified.userId)
    .first<{ id: string }>();
  if (studentTaken) {
    return c.json({ ok: false, error: "บัญชี LINE นี้ถูกใช้เป็นบัญชีนักเรียนแล้ว" }, 409);
  }

  await c.env.DB.prepare(`UPDATE teachers SET line_user_id = ? WHERE id = ?`)
    .bind(verified.userId, teacher.id)
    .run();
  await audit(c.env.DB, teacher.id, "link_line", "", now);

  return c.json({ ok: true, message: "ผูกบัญชี LINE เรียบร้อยแล้ว ครั้งต่อไปเปิดจากเมนูได้เลย" });
});

authRoutes.post("/unlink-line", requireTeacher, async (c) => {
  const teacher = c.get("teacher");
  const row = await c.env.DB.prepare(`SELECT username FROM teachers WHERE id = ?`)
    .bind(teacher.id)
    .first<{ username: string | null }>();
  if (!row?.username) {
    return c.json(
      { ok: false, error: "ต้องตั้งชื่อผู้ใช้และรหัสผ่านก่อน จึงจะยกเลิกการผูก LINE ได้ (ไม่งั้นจะเข้าระบบไม่ได้)" },
      400,
    );
  }
  await c.env.DB.prepare(`UPDATE teachers SET line_user_id = NULL WHERE id = ?`).bind(teacher.id).run();
  return c.json({ ok: true, message: "ยกเลิกการผูกบัญชี LINE แล้ว" });
});

// ---------------------------------------------------------------- จัดการครู (เฉพาะ admin)

authRoutes.get("/teachers", requireTeacher, requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, username, display_name, role, is_active, line_user_id, last_login_at, created_at
       FROM teachers ORDER BY created_at ASC`,
  ).all<{
    id: string; username: string | null; display_name: string; role: string;
    is_active: number; line_user_id: string | null; last_login_at: string | null; created_at: string;
  }>();

  return c.json({
    ok: true,
    teachers: (rows.results ?? []).map((t) => ({
      id: t.id,
      username: t.username,
      display_name: t.display_name,
      role: t.role,
      is_active: t.is_active === 1,
      linked_line: Boolean(t.line_user_id),
      last_login_text: t.last_login_at ? formatThaiDateTime(t.last_login_at) : "ยังไม่เคยเข้าใช้",
    })),
  });
});

const inviteSchema = z.object({
  note: z.string().max(80).optional(),
  role: z.enum(["teacher", "admin"]).optional(),
  valid_days: z.number().int().min(1).max(30).optional(),
});

authRoutes.post("/invites", requireTeacher, requireAdmin, async (c) => {
  const now = Date.now();
  const teacher = c.get("teacher");

  const body = await c.req.json().catch(() => ({}));
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  // รหัสเชิญ 10 ตัว อ่านง่าย ตัดอักษรที่สับสน (0/O, 1/I)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let code = "";
  for (const b of buf) code += alphabet[b % alphabet.length];
  const pretty = code.slice(0, 5) + "-" + code.slice(5);

  const validDays = parsed.data.valid_days ?? 7;
  const expiresAt = new Date(now + validDays * 86_400_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO teacher_invites (id, code_hash, note, role, created_by, created_at, expires_at, used_at, used_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      newId("inv"),
      await hashInviteCode(c.env.LINK_CODE_PEPPER, pretty),
      (parsed.data.note ?? "").trim(),
      parsed.data.role ?? "teacher",
      teacher.id,
      new Date(now).toISOString(),
      expiresAt,
    )
    .run();

  // แสดงรหัสเต็มได้ครั้งเดียวตอนนี้เท่านั้น (DB เก็บแค่ hash)
  return c.json({
    ok: true,
    code: pretty,
    expires_at: expiresAt,
    expires_text: formatThaiDateTime(expiresAt),
    message: "คัดลอกรหัสนี้ให้ครูท่านนั้น ระบบจะไม่แสดงรหัสนี้อีก",
  });
});

const resetPwSchema = z.object({
  teacher_id: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

authRoutes.post("/reset-password", requireTeacher, requireAdmin, async (c) => {
  const now = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const parsed = resetPwSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const strength = checkPasswordStrength(parsed.data.new_password);
  if (!strength.ok) return c.json({ ok: false, error: strength.reason }, 400);

  const target = await c.env.DB.prepare(`SELECT id FROM teachers WHERE id = ?`)
    .bind(parsed.data.teacher_id)
    .first<{ id: string }>();
  if (!target) return c.json({ ok: false, error: "ไม่พบบัญชีครูที่ระบุ" }, 404);

  await c.env.DB.prepare(
    `UPDATE teachers
        SET password_hash = ?, password_updated_at = ?, must_change_password = 1,
            failed_logins = 0, locked_until = NULL
      WHERE id = ?`,
  )
    .bind(await hashPassword(parsed.data.new_password), new Date(now).toISOString(), target.id)
    .run();

  await revokeAllSessions(c.env.DB, target.id, now);
  await audit(c.env.DB, c.get("teacher").id, "reset_password", "admin_reset", now);

  return c.json({ ok: true, message: "ตั้งรหัสผ่านใหม่แล้ว ครูท่านนั้นต้องเปลี่ยนรหัสเมื่อเข้าสู่ระบบครั้งถัดไป" });
});

const toggleSchema = z.object({ teacher_id: z.string().min(1), is_active: z.boolean() });

authRoutes.post("/set-active", requireTeacher, requireAdmin, async (c) => {
  const now = Date.now();
  const me = c.get("teacher");
  const body = await c.req.json().catch(() => ({}));
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "ข้อมูลไม่ถูกต้อง" }, 400);

  if (parsed.data.teacher_id === me.id && !parsed.data.is_active) {
    return c.json({ ok: false, error: "ปิดใช้งานบัญชีตัวเองไม่ได้" }, 400);
  }

  await c.env.DB.prepare(`UPDATE teachers SET is_active = ? WHERE id = ?`)
    .bind(parsed.data.is_active ? 1 : 0, parsed.data.teacher_id)
    .run();

  if (!parsed.data.is_active) {
    await revokeAllSessions(c.env.DB, parsed.data.teacher_id, now);
  }
  return c.json({ ok: true, message: parsed.data.is_active ? "เปิดใช้งานบัญชีแล้ว" : "ปิดใช้งานบัญชีแล้ว" });
});
import { requestPasswordReset, checkResetToken, hashResetToken } from "../services/password-reset";
import { purgeExpiredSessions } from "../lib/session";

// ---------------------------------------------------------------- POST /auth/forgot

const forgotSchema = z.object({ username: z.string().min(1).max(64) });

authRoutes.post("/forgot", async (c) => {
  const cfg = readConfig(c.env);
  const now = Date.now();
  const ipHash = await hashIp(c.env.LINK_CODE_PEPPER, clientIp(c));

  if (await isIpBlocked(c.env.DB, ipHash, now)) {
    return c.json({ ok: false, error: "พยายามหลายครั้งเกินไป กรุณารอสักครู่" }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = forgotSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "กรุณากรอกชื่อผู้ใช้" }, 400);

  const username = normalizeUsername(parsed.data.username);
  if (!username) {
    // รูปแบบผิด = หาไม่เจออยู่แล้ว ตอบข้อความกลางเหมือนกันเพื่อไม่ให้ไล่เดา
    await recordFailedIp(c.env.DB, ipHash, now, cfg.loginMaxAttempts, cfg.loginWindowMs);
    return c.json({
      ok: true,
      message:
        "หากชื่อผู้ใช้นี้มีอยู่ในระบบและผูกบัญชี LINE ไว้แล้ว ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่แชท LINE ของท่านแล้ว",
    });
  }

  const outcome = await requestPasswordReset(c.env, username, now);
  await recordFailedIp(c.env.DB, ipHash, now, cfg.loginMaxAttempts * 2, cfg.loginWindowMs);
  await audit(c.env.DB, null, "forgot_request", outcome.internal, now);

  return c.json({ ok: true, message: outcome.publicMessage });
});

// ---------------------------------------------------------------- GET /auth/reset-info

authRoutes.get("/reset-info", async (c) => {
  const token = c.req.query("token") ?? "";
  const check = await checkResetToken(c.env, token, Date.now());
  if (!check.ok) return c.json({ ok: false, error: check.error }, 400);
  // เปิดเผยแค่ชื่อที่แสดง เพื่อให้ครูมั่นใจว่าเป็นบัญชีตัวเอง
  return c.json({ ok: true, display_name: check.displayName });
});

// ---------------------------------------------------------------- POST /auth/reset-confirm

const resetConfirmSchema = z.object({
  token: z.string().min(20).max(256),
  new_password: z.string().min(8).max(128),
});

authRoutes.post("/reset-confirm", async (c) => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const body = await c.req.json().catch(() => ({}));
  const parsed = resetConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  const strength = checkPasswordStrength(parsed.data.new_password);
  if (!strength.ok) return c.json({ ok: false, error: strength.reason }, 400);

  const check = await checkResetToken(c.env, parsed.data.token, now);
  if (!check.ok || !check.teacherId || !check.resetId) {
    return c.json({ ok: false, error: check.error ?? "ลิงก์ไม่ถูกต้อง" }, 400);
  }

  const tokenHash = await hashResetToken(c.env.LINK_CODE_PEPPER, parsed.data.token);
  const newHash = await hashPassword(parsed.data.new_password);

  // ปิดโทเคนแบบมีเงื่อนไข: ถ้ามีคนกดพร้อมกันสองครั้ง จะมีแค่ครั้งเดียวที่ผ่าน
  const consumed = await c.env.DB.prepare(
    `UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
  )
    .bind(nowIso, tokenHash)
    .run();

  if (!consumed.meta || consumed.meta.changes === 0) {
    return c.json({ ok: false, error: "ลิงก์นี้ถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่" }, 409);
  }

  await c.env.DB.prepare(
    `UPDATE teachers
        SET password_hash = ?, password_updated_at = ?, must_change_password = 0,
            failed_logins = 0, locked_until = NULL
      WHERE id = ?`,
  )
    .bind(newHash, nowIso, check.teacherId)
    .run();

  // ตั้งรหัสใหม่ = เตะทุกอุปกรณ์ออกหมด (รวมเครื่องของผู้บุกรุกถ้ามี)
  await revokeAllSessions(c.env.DB, check.teacherId, now);
  await c.env.DB.prepare(`DELETE FROM reset_throttle WHERE teacher_id = ?`).bind(check.teacherId).run();
  await audit(c.env.DB, check.teacherId, "reset_confirm", "ok", now);

  return c.json({ ok: true, message: "ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบอีกครั้ง" });
});

// ---------------------------------------------------------------- งานทำความสะอาด (เรียกจาก cron)

export async function cleanupAuthTables(db: D1Database, nowMs: number): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  await purgeExpiredSessions(db, nowMs);
  await db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`)
    .bind(new Date(nowMs - 86_400_000).toISOString()).run();
  await db.prepare(`DELETE FROM teacher_invites WHERE expires_at < ? AND used_at IS NULL`)
    .bind(nowIso).run();
  await db.prepare(`DELETE FROM auth_log WHERE created_at < ?`)
    .bind(new Date(nowMs - 90 * 86_400_000).toISOString()).run();
  await db.prepare(`DELETE FROM login_throttle WHERE window_start < ?`)
    .bind(new Date(nowMs - 86_400_000).toISOString()).run();
}
  // ---------- ลืมรหัสผ่าน ----------
  `el("forgotBtn").addEventListener("click", function () {
    clearMsg();
    var user = el("lgUser").value.trim();
    if (!user) {
      show("info", "กรุณากรอกชื่อผู้ใช้ในช่องด้านบนก่อน แล้วกดลืมรหัสผ่านอีกครั้ง");
      el("lgUser").focus();
      return;
    }
    var btn = el("forgotBtn");
    busy(btn, true, "กำลังส่ง…", "ลืมรหัสผ่าน?");
    api("/auth/forgot", { username: user }).then(function (r) {
      busy(btn, false, "", "ลืมรหัสผ่าน?");
      show("info", (r.data && r.data.message) || "ส่งคำขอแล้ว");
    }).catch(function () {
      busy(btn, false, "", "ลืมรหัสผ่าน?");
      show("err", "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่");
    });
  `});
