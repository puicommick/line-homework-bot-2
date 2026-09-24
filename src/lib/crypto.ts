const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(digest);
}

/** hash รหัสผูกบัญชี: ผูกกับรหัสนักเรียน เพื่อให้รหัสเดียวกันของคนละคนได้ค่าต่างกัน */
export async function hashLinkCode(
  pepper: string,
  studentCode: string,
  linkCode: string,
): Promise<string> {
  return sha256Hex(`${pepper}::${studentCode}::${linkCode.trim()}`);
}

/** เทียบสตริงแบบ constant-time (เทียบทีละไบต์ ไม่ลัดวงจร) */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  return timingSafeEqualBytes(ba, bb);
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** รหัสผูกบัญชี 6 หลัก สุ่มแบบไม่มี modulo bias */
export function generateLinkCode(): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v >= 250) continue; // 250 = 25*10 ตัดส่วนที่ทำให้กระจายไม่เท่ากัน
    out += String(v % 10);
  }
  return out;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
