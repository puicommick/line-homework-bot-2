import type { Env } from "../env";
import {
  searchAssignmentsByTitle, listAssignmentsDueInRange, listNotSubmitted,
} from "../db/queries";
import { teacherDailySummaryMessage } from "../line/flex";
import { ictDayRangeUtc } from "../lib/thai-date";
import { T } from "../line/text";
import type { LineMessage } from "../line/client";

export async function handleTeacherCommand(
  db: Env["DB"],
  teacherLineId: string,
  text: string,
  sourceType: string,
  sourceId: string | undefined,
  nowMs: number,
): Promise<LineMessage | string> {
  const teacher = await db
    .prepare(`SELECT id, display_name, role FROM teachers WHERE line_user_id = ? AND is_active = 1`)
    .bind(teacherLineId)
    .first<{ id: string; display_name: string; role: string }>();

  if (!teacher) return T.teacherOnly;

  const trimmed = text.trim();

  if (trimmed === "สรุปงานวันนี้") {
    const range = ictDayRangeUtc(nowMs);
    const rows = await listAssignmentsDueInRange(db, range.startIso, range.endIso);
    const mapped = rows.map((r) => ({
      className: `ม.${r.class_level}/${r.class_room}`,
      courseName: r.course_name,
      title: r.title,
      dueAt: r.due_at,
      submitted: r.submitted,
      total: r.total,
    }));
    return teacherDailySummaryMessage(mapped, range.startIso);
  }

  if (trimmed.startsWith("ใครยังไม่ส่ง")) {
    const keyword = trimmed.replace("ใครยังไม่ส่ง", "").trim();
    if (!keyword) return "กรุณาระบุชื่องานด้วยครับ เช่น \"ใครยังไม่ส่ง ผังงาน\"";

    const assignments = await searchAssignmentsByTitle(db, keyword, 1);
    if (assignments.length === 0) return `ไม่พบงานที่ตรงกับ "${keyword}"`;

    const a = assignments[0]!;
    const notSubmitted = await listNotSubmitted(db, a.id, a.class_id);
    if (notSubmitted.length === 0) {
      return `🎉 งาน "${a.title}" (${a.course_name} ม.${a.class_level}/${a.class_room})\nส่งครบทุกคนแล้วครับ!`;
    }

    const listStr = notSubmitted
      .map((s) => `${s.no ? s.no + "." : "-"} ${s.name} (${s.student_code})`)
      .join("\n");

    return `📋 รายชื่อนักเรียนที่ยังไม่ส่ง:\n${a.title} (${a.course_name} ม.${a.class_level}/${a.class_room})\nยังไม่ส่ง ${notSubmitted.length} คน:\n\n${listStr}`;
  }

  if (trimmed.startsWith("ผูกห้อง") && sourceType === "group" && sourceId) {
    const parts = trimmed.split(" ");
    if (parts.length < 2) return T.groupLinkFormat;
    const match = /ม\.([1-6])\/([0-9]+)/.exec(parts[1]!);
    if (!match) return 'รูปแบบห้องไม่ถูกต้อง เช่น "ผูกห้อง ม.4/1"';

    const level = Number(match[1]);
    const room = Number(match[2]);

    const cls = await db
      .prepare(`SELECT id FROM classes WHERE level = ? AND room = ?`)
      .bind(level, room)
      .first<{ id: string }>();

    if (!cls) return `ไม่พบห้อง ม.${level}/${room} ในระบบ`;

    await db.prepare(`UPDATE classes SET line_group_id = ? WHERE id = ?`).bind(sourceId, cls.id).run();
    return T.groupLinked(`ม.${level}/${room}`);
  }

  if (trimmed === "ช่วยเหลือ" || trimmed === "help") {
    return T.helpTeacher;
  }

  return T.teacherLoginHint(process.env["APP_BASE_URL"] ?? "");
}
