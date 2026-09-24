import { Hono } from "hono";
import type { Env } from "../env";
import { readConfig } from "../env";
import { verifyLineSignature } from "../lib/signature";
import { log } from "../lib/logger";
import { LineClient } from "../line/client";
import { claimLineEvent } from "../db/queries";
import { handleLinkFlow } from "../services/link";
import { handleStudentCommand } from "../services/student-view";
import { handleTeacherCommand } from "../services/teacher-cmd";
import { T } from "../line/text";
import type { LineWebhookEvent } from "../types";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/", async (c) => {
  const signature = c.req.header("X-Line-Signature") || c.req.header("x-line-signature");
  const rawBody = await c.req.text();

  const valid = await verifyLineSignature(c.env.LINE_CHANNEL_SECRET, rawBody, signature);
  if (!valid) {
    return c.text("Unauthorized", 401);
  }

  let body: { events?: LineWebhookEvent[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.text("Bad Request", 400);
  }

  const events = body.events ?? [];
  const line = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  for (const ev of events) {
    try {
      const eventId = ev.webhookEventId || `${ev.timestamp}:${ev.source?.userId}`;
      const isNew = await claimLineEvent(c.env.DB, eventId, nowIso);
      if (!isNew) continue; // ป้องกันประมวลผลซ้ำกรณี LINE ส่ง webhook ซ้ำ

      if (ev.type === "message" && ev.message?.type === "text" && ev.message.text) {
        const text = ev.message.text.trim();
        const userId = ev.source?.userId;
        const replyToken = ev.replyToken;
        const sourceType = ev.source?.type ?? "user";
        const sourceId = sourceType === "group" ? ev.source?.groupId : sourceType === "room" ? ev.source?.roomId : undefined;

        if (!replyToken) continue;

        let replyContent: any = null;

        if (text === "ลงทะเบียน" || text.startsWith("รหัส")) {
          if (userId) {
            replyContent = await handleLinkFlow(c.env.DB, c.env.LINK_CODE_PEPPER, userId, text, nowMs);
          }
        } else if (sourceType === "group" || sourceType === "room") {
          // คำสั่งในกลุ่ม (ส่วนใหญ่เป็นครูสั่ง)
          if (userId) {
            replyContent = await handleTeacherCommand(c.env.DB, userId, text, sourceType, sourceId, nowMs);
          }
        } else {
          // แชทส่วนตัวกับนักเรียนหรือครู
          const isTeacherCmd = text === "สรุปงานวันนี้" || text.startsWith("ใครยังไม่ส่ง");
          if (isTeacherCmd && userId) {
            replyContent = await handleTeacherCommand(c.env.DB, userId, text, sourceType, sourceId, nowMs);
          } else if (userId) {
            replyContent = await handleStudentCommand(c.env.DB, userId, text, nowMs);
          }
        }

        if (replyContent) {
          const msgObj = typeof replyContent === "string" ? { type: "text", text: replyContent } : replyContent;
          await line.reply(replyToken, [msgObj]);
        }
      }
    } catch (err) {
      log.error("webhook event error", err);
    }
  }

  return c.text("OK", 200);
});
