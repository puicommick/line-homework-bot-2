import { formatLeadTimeThai } from "./thai-date";

export type ReminderKind = "before" | "custom" | "overdue";

export interface ReminderPoint {
  key: string;         // ใช้เป็น reminder_key ใน DB
  at: number;          // epoch ms
  kind: ReminderKind;
  minutesBefore: number | null;
  label: string;       // ข้อความหัวเรื่องภาษาไทย
}

export interface ReminderSource {
  assigned_at: string;
  due_at: string;
  remind_minutes: number[];
  remind_at: string | null;
  notify_overdue: boolean;
}

export interface SelectResult {
  send: ReminderPoint | null;   // ส่งจริงได้ไม่เกิน 1 จุดต่องานต่อนักเรียน
  skip: ReminderPoint[];        // จุดที่ตกรอบ ให้บันทึกเป็น skipped กันย้อนมายิงซ้ำ
}

/** แปลง JSON string ของ remind_minutes ให้ปลอดภัย */
export function parseRemindMinutes(raw: string | null | undefined): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const nums = parsed
    .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 60); // ไม่เกิน 60 วัน
  return [...new Set(nums)].sort((a, b) => b - a);
}

/**
 * สร้างจุดแจ้งเตือนทั้งหมดของงาน 1 ชิ้น
 * กฎ: ตัดจุดที่อยู่ก่อนเวลามอบหมายทิ้ง (เช่น ตั้งเตือนล่วงหน้า 3 วัน แต่สั่งงานก่อนกำหนดแค่ 1 วัน)
 */
export function buildReminderPoints(
  src: ReminderSource,
  opts: { overdueNoticeMs: number },
): ReminderPoint[] {
  const dueMs = Date.parse(src.due_at);
  const assignedMs = Date.parse(src.assigned_at);
  if (!Number.isFinite(dueMs) || !Number.isFinite(assignedMs)) return [];

  const points: ReminderPoint[] = [];

  for (const m of parseRemindMinutes(JSON.stringify(src.remind_minutes))) {
    const at = dueMs - m * 60_000;
    if (at < assignedMs) continue;
    points.push({
      key: `before:${m}`,
      at,
      kind: "before",
      minutesBefore: m,
      label: formatLeadTimeThai(m),
    });
  }

  if (src.remind_at) {
    const at = Date.parse(src.remind_at);
    if (Number.isFinite(at)) {
      points.push({
        key: `custom:${new Date(at).toISOString()}`,
        at,
        kind: "custom",
        minutesBefore: null,
        label: "แจ้งเตือนจากครู",
      });
    }
  }

  if (src.notify_overdue) {
    points.push({
      key: "overdue",
      at: dueMs + opts.overdueNoticeMs,
      kind: "overdue",
      minutesBefore: null,
      label: "เลยกำหนดส่งแล้ว",
    });
  }

  // กันคีย์ชนกัน (เช่น custom ตรงกับ before พอดี) โดยยึดอันแรกที่เจอ
  const seen = new Set<string>();
  const unique = points.filter((p) => {
    if (seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });

  return unique.sort((a, b) => a.at - b.at);
}

/**
 * เลือกจุดที่ต้องส่ง ณ เวลา nowMs
 * - พิจารณาเฉพาะจุดที่ถึงเวลาแล้ว และยังไม่เคยถูกจัดการ
 * - ส่งเฉพาะจุด "ใหม่ที่สุด" หนึ่งจุด ที่เหลือ skip ทั้งหมด
 * - ถ้าจุดใหม่ที่สุดยังเก่ากว่า maxAgeMs (เช่น ระบบดับข้ามคืน) ให้ skip ทั้งหมด ไม่ส่งย้อนหลัง
 */
export function selectDueReminder(
  points: ReminderPoint[],
  nowMs: number,
  handledKeys: ReadonlySet<string>,
  opts: { maxAgeMs: number },
): SelectResult {
  const due = points
    .filter((p) => p.at <= nowMs && !handledKeys.has(p.key))
    .sort((a, b) => a.at - b.at);

  if (due.length === 0) return { send: null, skip: [] };

  const latest = due[due.length - 1]!;
  const fresh = nowMs - latest.at <= opts.maxAgeMs;

  if (!fresh) return { send: null, skip: due };
  return { send: latest, skip: due.slice(0, due.length - 1) };
}

/** คำนวณสถานะการส่งงาน — ใช้ทั้งฝั่งนักเรียนและฝั่งครู ให้ผลตรงกันเสมอ */
export function computeStatus(
  dueAtIso: string,
  submittedAtIso: string | null,
  nowMs: number,
): "pending" | "overdue" | "on_time" | "late" {
  const dueMs = Date.parse(dueAtIso);
  if (submittedAtIso) {
    const subMs = Date.parse(submittedAtIso);
    return subMs <= dueMs ? "on_time" : "late";
  }
  return nowMs > dueMs ? "overdue" : "pending";
}

export const STATUS_TEXT: Record<string, string> = {
  pending: "ยังไม่ส่ง",
  overdue: "เลยกำหนด",
  on_time: "ส่งแล้ว (ตรงเวลา)",
  late: "ส่งแล้ว (ช้า)",
};

export const STATUS_COLOR: Record<string, string> = {
  pending: "#F59E0B",
  overdue: "#DC2626",
  on_time: "#16A34A",
  late: "#EA580C",
};
