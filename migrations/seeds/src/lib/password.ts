import { bytesFromBase64, base64FromBytes, timingSafeEqualBytes } from "./crypto";

const encoder = new TextEncoder();

/** จำนวนรอบ PBKDF2 — Workers มีเพดาน CPU ต่อ request ค่านี้อยู่ในระดับที่รันไหวและยังแข็งแรงพอ */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** รูปแบบที่เก็บ: pbkdf2$sha256$<iterations>$<saltB64>$<hashB64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return [
    "pbkdf2",
    "sha256",
    String(PBKDF2_ITERATIONS),
    base64FromBytes(salt),
    base64FromBytes(hash),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // ถ้าไม่มี hash ก็ยังคำนวณ dummy เพื่อให้เวลาตอบใกล้เคียงกัน ไม่บอกใบ้ว่ามีบัญชีนี้ไหม
  if (!stored) {
    await derive(password, new Uint8Array(SALT_BYTES), PBKDF2_ITERATIONS);
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;

  const iterations = Number.parseInt(parts[2]!, 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1_000_000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = bytesFromBase64(parts[3]!);
    expected = bytesFromBase64(parts[4]!);
  } catch {
    return false;
  }

  const actual = await derive(password, salt, iterations);
  return timingSafeEqualBytes(actual, expected);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export interface PasswordCheck {
  ok: boolean;
  reason: string;
}

/** เกณฑ์รหัสผ่าน: สั้นแต่บังคับให้ไม่เดาง่าย เหมาะกับครูที่พิมพ์บนมือถือ */
export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < 8) return { ok: false, reason: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร" };
  if (password.length > 128) return { ok: false, reason: "รหัสผ่านยาวเกินไป (ไม่เกิน 128 ตัวอักษร)" };
  if (!/[A-Za-zก-๙]/.test(password)) return { ok: false, reason: "รหัสผ่านต้องมีตัวอักษรอย่างน้อย 1 ตัว" };
  if (!/[0-9]/.test(password)) return { ok: false, reason: "รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว" };

  const weak = ["password", "12345678", "11111111", "qwertyui", "abcd1234", "teacher1"];
  if (weak.includes(password.toLowerCase())) {
    return { ok: false, reason: "รหัสผ่านนี้เดาง่ายเกินไป กรุณาตั้งใหม่" };
  }
  return { ok: true, reason: "" };
}

/** username: a-z 0-9 . _ - ยาว 4-32 ตัว เก็บเป็นตัวพิมพ์เล็กเสมอ */
export function normalizeUsername(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  if (!/^[a-z0-9._-]{4,32}$/.test(u)) return null;
  return u;
}
