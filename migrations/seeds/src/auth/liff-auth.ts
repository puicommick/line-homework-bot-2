import type { Env } from "../env";
import { log } from "../lib/logger";

export interface LiffVerifyResult {
  ok: boolean;
  userId?: string;
  displayName?: string;
  error?: string;
}

interface VerifyResponse {
  scope?: string;
  client_id?: string;
  expires_in?: number;
  error?: string;
}

interface ProfileResponse {
  userId?: string;
  displayName?: string;
}

/**
 * ตรวจ LIFF access token กับ LINE โดยตรง 2 ขั้น
 *  1) /oauth2/v2.1/verify  -> token ยังไม่หมดอายุ และออกให้ channel ของเราเท่านั้น
 *  2) /v2/profile          -> ได้ userId จริงจาก LINE (ห้ามเชื่อ userId ที่ client ส่งมา)
 * เอกสารอ้างอิง: LINE Login API (ควรเช็กเวอร์ชัน endpoint กับเอกสารทางการอีกครั้งก่อน deploy)
 */
export async function verifyLiffAccessToken(
  accessToken: string,
  expectedChannelId: string | null,
): Promise<LiffVerifyResult> {
  if (!accessToken || accessToken.length < 10) {
    return { ok: false, error: "ไม่พบ access token" };
  }

  let verify: VerifyResponse;
  try {
    const res = await fetch(
      "https://api.line.me/oauth2/v2.1/verify?access_token=" + encodeURIComponent(accessToken),
      { method: "GET" },
    );
    if (!res.ok) return { ok: false, error: "โทเคนไม่ถูกต้องหรือหมดอายุ" };
    verify = (await res.json()) as VerifyResponse;
  } catch (err) {
    log.error("liff verify failed", err);
    return { ok: false, error: "ตรวจสอบโทเคนกับ LINE ไม่สำเร็จ" };
  }

  if (verify.error) return { ok: false, error: "โทเคนไม่ถูกต้อง" };
  if (typeof verify.expires_in === "number" && verify.expires_in <= 0) {
    return { ok: false, error: "โทเคนหมดอายุแล้ว" };
  }
  // ป้องกัน token substitution จาก channel อื่น
  if (expectedChannelId && verify.client_id && verify.client_id !== expectedChannelId) {
    return { ok: false, error: "โทเคนไม่ได้ออกให้แอปนี้" };
  }

  let profile: ProfileResponse;
  try {
    const res = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) return { ok: false, error: "อ่านโปรไฟล์ไม่สำเร็จ" };
    profile = (await res.json()) as ProfileResponse;
  } catch (err) {
    log.error("liff profile failed", err);
    return { ok: false, error: "เชื่อมต่อ LINE ไม่สำเร็จ" };
  }

  if (!profile.userId) return { ok: false, error: "ไม่พบผู้ใช้" };
  return { ok: true, userId: profile.userId, displayName: profile.displayName ?? "" };
}

/** ดึง LINE Login channel id จาก LIFF ID ("1234567890-abcdefgh" -> "1234567890") */
export function channelIdFromLiffId(env: Env): string | null {
  const liffId = (env.LIFF_ID || "").trim();
  const idx = liffId.indexOf("-");
  if (idx <= 0) return null;
  return liffId.slice(0, idx);
}
