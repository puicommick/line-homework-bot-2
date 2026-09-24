/**
 * หัวใจของ idempotency
 * หลักการ: "จองสิทธิ์ก่อนส่ง" ด้วย SQL statement เดียว (atomic)
 *   - แถวยังไม่มี          -> INSERT สำเร็จ = จองได้
 *   - แถวมีอยู่ status='retry' -> UPDATE ผ่าน = จองได้ (ส่งรอบก่อนพลาด)
 *   - นอกนั้น (sent/skipped/claimed/failed) -> ไม่มีแถวคืนกลับ = ห้ามส่ง
 * cron สองรอบทับกันจึงไม่มีทางส่งซ้ำ เพราะมีแค่รอบเดียวที่จองได้
 */

export type ReminderStatus = "claimed" | "sent" | "skipped" | "retry" | "failed";

export interface ClaimTarget {
  assignmentId: string;
  studentId: string;
  reminderKey: string;
  pointAtIso: string;
}

const MAX_ATTEMPTS = 3;
/** ถ้าจองไว้แล้วค้างเกินเวลานี้ ถือว่า worker ตายกลางทาง ให้ปลดล็อกมาลองใหม่ */
const STUCK_CLAIM_MS = 10 * 60_000;

/** ดึงคีย์ที่ "จัดการไปแล้ว" ของงานชิ้นหนึ่ง แยกตามนักเรียน */
export async function loadHandledKeys(
  db: D1Database,
  assignmentId: string,
): Promise<Map<string, Set<string>>> {
  const res = await db
    .prepare(
      `SELECT student_id, reminder_key FROM reminder_log
        WHERE assignment_id = ? AND status IN ('sent','skipped','claimed','failed')`,
    )
    .bind(assignmentId)
    .all<{ student_id: string; reminder_key: string }>();

  const map = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    let set = map.get(r.student_id);
    if (!set) { set = new Set<string>(); map.set(r.student_id, set); }
    set.add(r.reminder_key);
  }
  return map;
}

/**
 * จองสิทธิ์ส่งแบบกลุ่ม คืนเฉพาะ studentId ที่จองสำเร็จ
 * ใช้ db.batch() เพื่อให้เป็น request เดียวไป D1 (เร็วกว่ายิงทีละตัวมาก)
 */
export async function claimReminders(
  db: D1Database,
  targets: ClaimTarget[],
  nowIso: string,
): Promise<Set<string>> {
  if (targets.length === 0) return new Set();

  const stmts = targets.map((t) =>
    db
      .prepare(
        `INSERT INTO reminder_log
           (assignment_id, student_id, reminder_key, status, attempts, point_at, created_at, sent_at)
         VALUES (?, ?, ?, 'claimed', 1, ?, ?, NULL)
         ON CONFLICT(assignment_id, student_id, reminder_key) DO UPDATE SET
           status = 'claimed',
           attempts = reminder_log.attempts + 1,
           created_at = excluded.created_at
         WHERE reminder_log.status = 'retry' AND reminder_log.attempts < ${MAX_ATTEMPTS}
         RETURNING student_id`,
      )
      .bind(t.assignmentId, t.studentId, t.reminderKey, t.pointAtIso, nowIso),
  );

  const results = await db.batch<{ student_id: string }>(stmts);
  const claimed = new Set<string>();
  for (const r of results) {
    for (const row of r.results ?? []) claimed.add(row.student_id);
  }
  return claimed;
}

/** บันทึกว่าส่งสำเร็จแล้ว */
export async function commitSent(
  db: D1Database,
  assignmentId: string,
  reminderKey: string,
  studentIds: string[],
  nowIso: string,
): Promise<void> {
  if (studentIds.length === 0) return;
  const stmts = studentIds.map((sid) =>
    db
      .prepare(
        `UPDATE reminder_log SET status = 'sent', sent_at = ?
          WHERE assignment_id = ? AND student_id = ? AND reminder_key = ?`,
      )
      .bind(nowIso, assignmentId, sid, reminderKey),
  );
  await db.batch(stmts);
}

/**
 * ส่งไม่สำเร็จ: ถ้ายังไม่ครบจำนวนครั้ง -> 'retry' (รอบหน้าจองใหม่ได้)
 * ถ้าครบแล้ว -> 'failed' (เลิกพยายาม ไม่รบกวนนักเรียนเรื่อยๆ)
 */
export async function markFailure(
  db: D1Database,
  assignmentId: string,
  reminderKey: string,
  studentIds: string[],
  permanent: boolean,
): Promise<void> {
  if (studentIds.length === 0) return;
  const stmts = studentIds.map((sid) =>
    db
      .prepare(
        permanent
          ? `UPDATE reminder_log SET status = 'failed'
              WHERE assignment_id = ? AND student_id = ? AND reminder_key = ?`
          : `UPDATE reminder_log
                SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'retry' END
              WHERE assignment_id = ? AND student_id = ? AND reminder_key = ?`,
      )
      .bind(assignmentId, sid, reminderKey),
  );
  await db.batch(stmts);
}

/** บันทึกจุดที่ตกรอบเป็น 'skipped' เพื่อไม่ให้ถูกหยิบมาส่งย้อนหลัง */
export async function markSkipped(
  db: D1Database,
  rows: ClaimTarget[],
  nowIso: string,
): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((t) =>
    db
      .prepare(
        `INSERT INTO reminder_log
           (assignment_id, student_id, reminder_key, status, attempts, point_at, created_at, sent_at)
         VALUES (?, ?, ?, 'skipped', 0, ?, ?, NULL)
         ON CONFLICT(assignment_id, student_id, reminder_key) DO NOTHING`,
      )
      .bind(t.assignmentId, t.studentId, t.reminderKey, t.pointAtIso, nowIso),
  );
  await db.batch(stmts);
}

/** ปลดล็อกงานที่จองค้างเพราะ worker ตายกลางทาง — เรียกต้นรอบ cron ทุกครั้ง */
export async function releaseStuckClaims(db: D1Database, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - STUCK_CLAIM_MS).toISOString();
  const res = await db
    .prepare(
      `UPDATE reminder_log
          SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'retry' END
        WHERE status = 'claimed' AND created_at < ?`,
    )
    .bind(cutoff)
    .run();
  return res.meta?.changes ?? 0;
}

/** เก็บกวาด log เก่ากว่า 180 วัน */
export async function purgeOldReminderLogs(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(`DELETE FROM reminder_log WHERE created_at < ?`)
    .bind(new Date(nowMs - 180 * 86_400_000).toISOString())
    .run();
}
