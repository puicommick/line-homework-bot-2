import { log } from "../lib/logger";

export interface LineMessage {
  type: string;
  [key: string]: unknown;
}

export interface SendResult {
  ok: boolean;
  status: number;
  error?: string;
  /** true = ผู้ใช้บล็อกบอท/เลิกเป็นเพื่อน ควรเลิกส่งให้คนนี้ */
  blocked?: boolean;
}

const API = "https://api.line.me/v2/bot";
const MAX_ATTEMPTS = 3;
const MULTICAST_CHUNK = 150;   // LINE จำกัด 500 แต่ใช้ 150 เพื่อลดความเสี่ยง timeout ใน Worker
const MAX_MESSAGES_PER_REQUEST = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** backoff แบบ exponential + jitter กัน thundering herd ตอน cron ยิงพร้อมกัน */
function backoffMs(attempt: number): number {
  const base = Math.min(400 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 250);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class LineClient {
  private readonly token: string;

  constructor(accessToken: string) {
    this.token = accessToken;
  }

  private async request(
    path: string,
    body: unknown,
    retryKey?: string,
  ): Promise<SendResult> {
    let lastStatus = 0;
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.token,
        };
        // X-Line-Retry-Key ทำให้ retry ตัวเดียวกันไม่ถูกส่งซ้ำฝั่ง LINE
        if (retryKey) headers["X-Line-Retry-Key"] = retryKey;

        res = await fetch(API + path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastStatus = 0;
        lastError = "network error";
        log.warn("line network error", { path, attempt });
        if (attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
        break;
      }

      lastStatus = res.status;

      if (res.ok) return { ok: true, status: res.status };

      // 409 = retry key ซ้ำ แปลว่าครั้งก่อนส่งสำเร็จแล้ว ถือว่าสำเร็จ
      if (res.status === 409) return { ok: true, status: 409 };

      const text = await res.text().catch(() => "");
      lastError = text.slice(0, 200);

      // 403 มักเกิดจากผู้ใช้บล็อกบอท — ไม่ต้อง retry
      if (res.status === 403) {
        return { ok: false, status: 403, error: "ผู้ใช้ไม่ได้เป็นเพื่อนกับบอท", blocked: true };
      }
      // 400 = ข้อความผิดรูปแบบ retry ไปก็ไม่ผ่าน
      if (res.status === 400 || res.status === 401 || res.status === 404) {
        log.warn("line client error", { path, status: res.status });
        return { ok: false, status: res.status, error: lastError };
      }

      if (res.status === 429) {
        const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : backoffMs(attempt);
        log.warn("line rate limited", { path, attempt, waitMs });
        if (attempt < MAX_ATTEMPTS) { await sleep(waitMs); continue; }
        return { ok: false, status: 429, error: "rate limited" };
      }

      // 5xx -> retry
      if (attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
    }

    return { ok: false, status: lastStatus, error: lastError || "ส่งข้อความไม่สำเร็จ" };
  }

  /** ตอบกลับในบทสนทนา ฟรีไม่นับโควตา — ใช้ทุกครั้งที่มี replyToken */
  async reply(replyToken: string, messages: LineMessage[]): Promise<SendResult> {
    if (messages.length === 0) return { ok: true, status: 200 };
    return this.request("/message/reply", {
      replyToken,
      messages: messages.slice(0, MAX_MESSAGES_PER_REQUEST),
    });
  }

  /** ส่งหาคนเดียว (นับโควตา) retryKey ควรเป็นค่าคงที่ต่อการแจ้งเตือน 1 ครั้ง */
  async push(to: string, messages: LineMessage[], retryKey?: string): Promise<SendResult> {
    if (messages.length === 0) return { ok: true, status: 200 };
    return this.request(
      "/message/push",
      { to, messages: messages.slice(0, MAX_MESSAGES_PER_REQUEST) },
      retryKey,
    );
  }

  /**
   * ส่งข้อความ "เนื้อหาเดียวกัน" ให้หลายคน ประหยัดจำนวน request มาก
   * หมายเหตุ: โควตาข้อความยังนับตามจำนวนผู้รับ ไม่ได้ถูกลง
   */
  async multicast(userIds: string[], messages: LineMessage[], retryKeyPrefix?: string): Promise<SendResult[]> {
    const results: SendResult[] = [];
    const unique = [...new Set(userIds.filter((id) => typeof id === "string" && id.length > 0))];

    for (const [i, group] of chunk(unique, MULTICAST_CHUNK).entries()) {
      const key = retryKeyPrefix ? `${retryKeyPrefix}-${i}` : undefined;
      const r = await this.request(
        "/message/multicast",
        { to: group, messages: messages.slice(0, MAX_MESSAGES_PER_REQUEST) },
        key ? toUuidLike(key) : undefined,
      );
      results.push(r);
      if (!r.ok && r.status === 429) break; // โดน rate limit แล้วหยุดรอบนี้ ให้ cron รอบหน้าทำต่อ
    }
    return results;
  }

  async getProfile(userId: string): Promise<{ displayName: string } | null> {
    try {
      const res = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, {
        headers: { Authorization: "Bearer " + this.token },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { displayName?: string };
      return { displayName: data.displayName ?? "" };
    } catch {
      return null;
    }
  }

  /** โควตาข้อความฟรีคงเหลือของเดือนนี้ ใช้เตือนครูก่อนโควตาหมด */
  async getQuotaConsumption(): Promise<{ limit: number | null; used: number | null }> {
    try {
      const [quotaRes, usedRes] = await Promise.all([
        fetch(`${API}/message/quota`, { headers: { Authorization: "Bearer " + this.token } }),
        fetch(`${API}/message/quota/consumption`, { headers: { Authorization: "Bearer " + this.token } }),
      ]);
      const quota = quotaRes.ok ? ((await quotaRes.json()) as { type?: string; value?: number }) : null;
      const used = usedRes.ok ? ((await usedRes.json()) as { totalUsage?: number }) : null;
      return {
        limit: quota && typeof quota.value === "number" ? quota.value : null,
        used: used && typeof used.totalUsage === "number" ? used.totalUsage : null,
      };
    } catch {
      return { limit: null, used: null };
    }
  }
}

/** X-Line-Retry-Key ต้องเป็นรูปแบบ UUID — แปลงคีย์ของเราให้เข้ารูปแบบแบบ deterministic */
export function toUuidLike(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ (c + i), 3266489917) >>> 0;
    h4 = Math.imul(h4 + (c * (i + 1)), 668265263) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  const raw = hex(h1) + hex(h2) + hex(h3) + hex(h4);
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    "4" + raw.slice(13, 16),          // version 4
    ((parseInt(raw[16]!, 16) & 0x3 | 0x8).toString(16)) + raw.slice(17, 20),  // variant
    raw.slice(20, 32),
  ].join("-");
}
