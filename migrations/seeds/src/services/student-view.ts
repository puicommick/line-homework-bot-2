import type { Env } from "../env";
import { findStudentByLineId, listStudentAssignments, summarizeStudentScores } from "../db/queries";
import { pendingListMessage, scoreSummaryMessage } from "../line/flex";
import { T } from "../line/text";
import type { LineMessage } from "../line/client";

export async function handleStudentCommand(
  db: Env["DB"],
  userId: string,
  text: string,
  nowMs: number,
): Promise<LineMessage | string> {
  const student = await findStudentByLineId(db, userId);
  if (!student) return T.notLinked;

  const cmd = text.trim().toLowerCase();

  if (cmd === "งานค้าง" || cmd === "งาน") {
    const views = await listStudentAssignments(db, student, nowMs, { onlyPending: true });
    if (views.length === 0) return T.noPending;
    return pendingListMessage(views, nowMs);
  }

  if (cmd === "คะแนน" || cmd === "ผลการเรียน") {
    const summaries = await summarizeStudentScores(db, student);
    const cls = await db
      .prepare(`SELECT level, room FROM classes WHERE id = ?`)
      .bind(student.class_id)
      .first<{ level: number; room: number }>();
    const className = cls ? `ม.${cls.level}/${cls.room}` : "";
    return scoreSummaryMessage(student.name, className, summaries);
  }

  if (cmd === "ส่งแล้ว") {
    const views = await listStudentAssignments(db, student, nowMs, { onlySubmitted: true });
    if (views.length === 0) return T.noSubmitted;
    return pendingListMessage(views, nowMs);
  }

  if (cmd === "ปิดแจ้งเตือน") {
    await db.prepare(`UPDATE students SET notify_enabled = 0 WHERE id = ?`).bind(student.id).run();
    return T.notifyOff;
  }

  if (cmd === "เปิดแจ้งเตือน") {
    await db.prepare(`UPDATE students SET notify_enabled = 1 WHERE id = ?`).bind(student.id).run();
    return T.notifyOn;
  }

  if (cmd === "ช่วยเหลือ" || cmd === "help") {
    return T.helpStudent;
  }

  return T.unknownCommand;
}
