const SENSITIVE_KEYS = [
  "accessToken", "access_token", "authorization", "channelSecret",
  "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINK_CODE_PEPPER",
  "TEACHER_SETUP_CODE", "link_code", "linkCode", "code", "password",
];

/** ตัดเหลือแค่เค้าโครงพอ debug: U1a2b... -> U1a2b***  */
export function maskId(value: string | null | undefined): string {
  if (!value) return "-";
  if (value.length <= 6) return value.slice(0, 2) + "***";
  return value.slice(0, 5) + "***" + value.slice(-2);
}

function redact(input: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return input.length > 300 ? input.slice(0, 300) + "…" : input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some((s) => s.toLowerCase() === k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (k === "userId" || k === "line_user_id" || k === "groupId") {
      out[k] = maskId(String(v));
    } else if (k === "name" || k === "display_name" || k === "student_code") {
      out[k] = "[pii]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export const log = {
  info(msg: string, data?: unknown) {
    console.log(JSON.stringify({ level: "info", msg, data: redact(data) }));
  },
  warn(msg: string, data?: unknown) {
    console.warn(JSON.stringify({ level: "warn", msg, data: redact(data) }));
  },
  error(msg: string, err?: unknown, data?: unknown) {
    const e = err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
    console.error(JSON.stringify({ level: "error", msg, err: e, data: redact(data) }));
  },
};
