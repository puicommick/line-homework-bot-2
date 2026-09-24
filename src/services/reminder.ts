import type { Env } from "../env";

export async function runReminderCycle(env: Env): Promise<void> {
  // TODO: ดึงงานที่ใกล้ถึงกำหนด แล้วส่งแจ้งเตือนเข้า LINE
}

export async function runDailyMaintenance(env: Env): Promise<void> {
  // TODO: งานประจำวัน เช่น ล้างเซสชันหมดอายุ
}
