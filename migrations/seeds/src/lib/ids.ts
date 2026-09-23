const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** id สั้น อ่านออก ไม่ชนกัน: <prefix>_<time36><rand> */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let r = "";
  for (const b of bytes) r += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${t}${r}`;
}
