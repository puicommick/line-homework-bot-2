/**
 * ทุกฟังก์ชันในไฟล์นี้เป็น pure function
 * ประเทศไทยใช้ UTC+7 คงที่ ไม่มี DST จึงคำนวณด้วย offset ตายตัวได้แม่นยำ
 * และทดสอบได้โดยไม่พึ่ง Intl/ICU ของ runtime
 */
export const ICT_OFFSET_MINUTES = 420;
export const ICT_OFFSET_MS = ICT_OFFSET_MINUTES * 60_000;

const THAI_MONTH_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

const THAI_MONTH_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

const THAI_WEEKDAY_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const THAI_WEEKDAY_FULL = [
  "วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ",
  "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์",
];

export interface IctParts {
  year: number;        // ค.ศ.
  yearBE: number;      // พ.ศ.
  month: number;       // 1-12
  day: number;         // 1-31
  hour: number;        // 0-23
  minute: number;
  second: number;
  weekday: number;     // 0=อาทิตย์
}

function toMs(input: string | number | Date): number {
  if (typeof input === "number") return input;
  if (input instanceof Date) return input.getTime();
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) throw new RangeError("รูปแบบวันเวลาไม่ถูกต้อง: " + input);
  return ms;
}

/** แตกเวลา UTC ออกเป็นส่วนประกอบตามเวลาไทย */
export function ictParts(input: string | number | Date): IctParts {
  const shifted = new Date(toMs(input) + ICT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    yearBE: shifted.getUTCFullYear() + 543,
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** "16:00 น." */
export function formatThaiTime(input: string | number | Date): string {
  const p = ictParts(input);
  return `${pad2(p.hour)}:${pad2(p.minute)} น.`;
}

/** "ศ. 26 ก.ย. 2569" */
export function formatThaiDate(input: string | number | Date): string {
  const p = ictParts(input);
  return `${THAI_WEEKDAY_SHORT[p.weekday]} ${p.day} ${THAI_MONTH_SHORT[p.month - 1]} ${p.yearBE}`;
}

/** "วันศุกร์ที่ 26 กันยายน 2569" */
export function formatThaiDateFull(input: string | number | Date): string {
  const p = ictParts(input);
  return `${THAI_WEEKDAY_FULL[p.weekday]}ที่ ${p.day} ${THAI_MONTH_FULL[p.month - 1]} ${p.yearBE}`;
}

/** "ศ. 26 ก.ย. 2569 เวลา 16:00 น." */
export function formatThaiDateTime(input: string | number | Date): string {
  return `${formatThaiDate(input)} เวลา ${formatThaiTime(input)}`;
}

/** "26 ก.ย. 16:00 น." สำหรับพื้นที่แคบใน Flex */
export function formatThaiDateTimeShort(input: string | number | Date): string {
  const p = ictParts(input);
  return `${p.day} ${THAI_MONTH_SHORT[p.month - 1]} ${pad2(p.hour)}:${pad2(p.minute)} น.`;
}

/** คีย์วันแบบไทย ใช้จัดกลุ่ม/เทียบ "วันนี้" -> "2026-09-26" (ตามปฏิทินไทย) */
export function ictDateKey(input: string | number | Date): string {
  const p = ictParts(input);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** ช่วงเวลา UTC ของ "วันนั้นตามเวลาไทย" [00:00, 24:00) */
export function ictDayRangeUtc(input: string | number | Date): { startIso: string; endIso: string } {
  const p = ictParts(input);
  const startUtcMs = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0) - ICT_OFFSET_MS;
  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(startUtcMs + 86_400_000).toISOString(),
  };
}

/** แปลง input จากฟอร์ม (เวลาไทย) เป็น UTC ISO — "2026-09-26" + "16:00" */
export function ictLocalToUtcIso(dateStr: string, timeStr: string): string {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!dm || !tm) throw new RangeError("รูปแบบวันที่หรือเวลาไม่ถูกต้อง");
  const [, y, mo, d] = dm;
  const [, h, mi] = tm;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new RangeError("ค่าวันที่หรือเวลาอยู่นอกช่วง");
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - ICT_OFFSET_MS;
  return new Date(ms).toISOString();
}

/** แปลง UTC ISO กลับเป็นค่าสำหรับ <input type="date"> / <input type="time"> ตามเวลาไทย */
export function utcIsoToIctInputs(iso: string): { date: string; time: string } {
  const p = ictParts(iso);
  return {
    date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`,
  };
}

/** "เหลือ 2 วัน 3 ชม." / "เลยกำหนด 5 ชม. 10 นาที" / "ถึงกำหนดแล้ว" */
export function formatCountdownThai(fromMs: number, toMs2: number): string {
  const diff = toMs2 - fromMs;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "ถึงกำหนดแล้ว";

  const totalMinutes = Math.floor(abs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} วัน`);
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (days === 0 && minutes > 0) parts.push(`${minutes} นาที`);
  const body = parts.join(" ");
  return diff >= 0 ? `เหลือ ${body}` : `เลยกำหนด ${body}`;
}

/** ป้ายจุดแจ้งเตือน เช่น 1440 -> "ก่อนกำหนด 1 วัน" */
export function formatLeadTimeThai(minutes: number): string {
  if (minutes <= 0) return "ถึงกำหนดส่ง";
  if (minutes % 1440 === 0) return `ก่อนกำหนด ${minutes / 1440} วัน`;
  if (minutes % 60 === 0) return `ก่อนกำหนด ${minutes / 60} ชม.`;
  return `ก่อนกำหนด ${minutes} นาที`;
}

/** "ม.4/1" */
export function formatClassName(level: number, room: number): string {
  return `ม.${level}/${room}`;
}

/** ชั่วโมงปัจจุบันตามเวลาไทย ใช้ตรวจช่วงงดรบกวน */
export function isWithinQuietHours(nowMs: number, startHour: number, endHour: number): boolean {
  const h = ictParts(nowMs).hour;
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // ข้ามเที่ยงคืน เช่น 22 -> 6
}
