import { base64FromBytes, timingSafeEqualStr } from "./crypto";

const encoder = new TextEncoder();

/** สร้างลายเซ็น HMAC-SHA256 แบบ base64 ตามสเปก X-Line-Signature */
export async function computeLineSignature(
  channelSecret: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return base64FromBytes(new Uint8Array(sig));
}

/** ตรวจลายเซ็น webhook — ต้องผ่านก่อนแตะ body เสมอ */
export async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  headerSignature: string | null | undefined,
): Promise<boolean> {
  if (!channelSecret) return false;
  if (!headerSignature || headerSignature.length === 0) return false;
  const expected = await computeLineSignature(channelSecret, rawBody);
  return timingSafeEqualStr(expected, headerSignature.trim());
}
