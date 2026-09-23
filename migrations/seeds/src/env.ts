export interface Env {
  DB: D1Database;

  // secrets
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  TEACHER_SETUP_CODE: string;
  LINK_CODE_PEPPER: string;

  // vars
  LIFF_ID: string;
  APP_BASE_URL: string;
  SCHOOL_NAME: string;
  QUIET_HOURS_START: string;
  QUIET_HOURS_END: string;
  REMINDER_MAX_AGE_MINUTES: string;
  OVERDUE_NOTICE_MINUTES: string;
}

export interface AppConfig {
  quietStartHourIct: number;
  quietEndHourIct: number;
  reminderMaxAgeMs: number;
  overdueNoticeMs: number;
  schoolName: string;
  liffId: string;
  appBaseUrl: string;
}

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function readConfig(env: Env): AppConfig {
  return {
    quietStartHourIct: intOr(env.QUIET_HOURS_START, 22),
    quietEndHourIct: intOr(env.QUIET_HOURS_END, 6),
    reminderMaxAgeMs: intOr(env.REMINDER_MAX_AGE_MINUTES, 720) * 60_000,
    overdueNoticeMs: intOr(env.OVERDUE_NOTICE_MINUTES, 60) * 60_000,
    schoolName: env.SCHOOL_NAME || "โรงเรียน",
    liffId: env.LIFF_ID || "",
    appBaseUrl: (env.APP_BASE_URL || "").replace(/\/+$/, ""),
  };
}

/** ตรวจว่า secret ที่จำเป็นถูกตั้งครบ เรียกตอน bootstrap ของทุก request */
export function assertSecrets(env: Env): void {
  const missing: string[] = [];
  if (!env.LINE_CHANNEL_SECRET) missing.push("LINE_CHANNEL_SECRET");
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) missing.push("LINE_CHANNEL_ACCESS_TOKEN");
  if (!env.TEACHER_SETUP_CODE) missing.push("TEACHER_SETUP_CODE");
  if (!env.LINK_CODE_PEPPER) missing.push("LINK_CODE_PEPPER");
  if (missing.length > 0) {
    throw new Error("ยังไม่ได้ตั้งค่า secret: " + missing.join(", "));
  }
}
