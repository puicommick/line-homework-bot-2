import { sha256Hex, base64FromBytes } from "./crypto";
import { newId } from "./ids";

/** สร้าง token สุ่ม 32 ไบต์ แบบ base64url (ไม่มีอักขระที่ต้อง escape ใน header) */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** domain separation: ใช้ pepper ตัวเดียวกับระบบอื่นได้อย่างปลอดภัยเพราะ prefix ต่างกัน */
export function hashSessionToken(pepper: string, token: string): Promise<string> {
  return sha256Hex(`session::${pepper}::${token}`);
}

export function hashInviteCode(pepper: string, code: string): Promise<string> {
  return sha256Hex(`invite::${pepper}::${code.trim().toUpperCase()}`);
}

export function hashIp(pepper: string, ip: string): Promise<string> {
  return sha256Hex(`ip::${pepper}::${ip}`);
}

export interface SessionRecord {
  id: string;
  teacher_id: string;
  source: "password" | "liff";
  expires_at: string;
}

export async function createSession(
  db: D1Database,
  pepper: string,
  teacherId: string,
  source: "password" | "liff",
  ttlMs: number,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(pepper, token);
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  await db
    .prepare(
      `INSERT INTO teacher_sessions
         (id, teacher_id, token_hash, source, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(newId("ses"), teacherId, tokenHash, source, nowIso, expiresAt, nowIso)
    .run();

  return { token, expiresAt };
}

/** คืนแถวครูถ้า session ใช้ได้ พร้อมต่ออายุ last_seen_at */
export async function resolveSession(
  db: D1Database,
  pepper: string,
  token: string,
  nowMs: number,
): Promise<{ teacherId: string; sessionId: string; source: string } | null> {
  if (!token || token.length < 20) return null;
  const tokenHash = await hashSessionToken(pepper, token);
  const nowIso = new Date(nowMs).toISOString();

  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.teacher_id, s.source
         FROM teacher_sessions s
         JOIN teachers t ON t.id = s.teacher_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND t.is_active = 1`,
    )
    .bind(tokenHash, nowIso)
    .first<{ session_id: string; teacher_id: string; source: string }>();

  if (!row) return null;

  await db
    .prepare(`UPDATE teacher_sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(nowIso, row.session_id)
    .run();

  return { teacherId: row.teacher_id, sessionId: row.session_id, source: row.source };
}

export async function revokeSession(
  db: D1Database,
  pepper: string,
  token: string,
  nowMs: number,
): Promise<void> {
  const tokenHash = await hashSessionToken(pepper, token);
  await db
    .prepare(`UPDATE teacher_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .bind(new Date(nowMs).toISOString(), tokenHash)
    .run();
}

/** ใช้ตอนเปลี่ยนรหัสผ่าน: เตะทุกอุปกรณ์ออก เหลือเฉพาะเครื่องปัจจุบัน */
export async function revokeAllSessions(
  db: D1Database,
  teacherId: string,
  nowMs: number,
  exceptSessionId?: string,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  if (exceptSessionId) {
    await db
      .prepare(
        `UPDATE teacher_sessions SET revoked_at = ?
          WHERE teacher_id = ? AND revoked_at IS NULL AND id <> ?`,
      )
      .bind(nowIso, teacherId, exceptSessionId)
      .run();
  } else {
    await db
      .prepare(`UPDATE teacher_sessions SET revoked_at = ? WHERE teacher_id = ? AND revoked_at IS NULL`)
      .bind(nowIso, teacherId)
      .run();
  }
}

/** เก็บกวาด session หมดอายุ เรียกจาก cron วันละครั้ง */
export async function purgeExpiredSessions(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = new Date(nowMs - 7 * 86_400_000).toISOString();
  await db.prepare(`DELETE FROM teacher_sessions WHERE expires_at < ?`).bind(cutoff).run();
}
