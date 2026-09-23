import { Hono } from "hono";
import type { Env } from "./env";
import { assertSecrets, readConfig } from "./env";
import { log } from "./lib/logger";
import { webhookRoutes } from "./routes/webhook";
import { authRoutes } from "./routes/auth";
import { teacherApiRoutes } from "./routes/api-teacher";
import { runReminderCycle, runDailyMaintenance } from "./services/reminder";
import { cleanupAuthTables } from "./routes/auth";

// นำเข้าไฟล์ HTML หน้า LIFF / Login เป็น Text module ตาม rule ใน wrangler.toml
import loginHtml from "./liff/login.html";
import resetHtml from "./liff/reset.html";
import liffSpaHtml from "./liff/index.html";

const app = new Hono<{ Bindings: Env }>();

// ตรวจสอบ secret ทุก request
app.use("*", async (c, next) => {
  try {
    assertSecrets(c.env);
  } catch (err: any) {
    return c.text(err.message ?? "Server configuration error", 500);
  }
  await next();
});

// เส้นทางหลัก
app.route("/webhook", webhookRoutes);
app.route("/auth", authRoutes);
app.route("/api", teacherApiRoutes);

// เสิร์ฟหน้า HTML
app.get("/login", (c) => c.html(loginHtml));
app.get("/reset", (c) => c.html(resetHtml));
app.get("/app", (c) => c.html(liffSpaHtml));
app.get("/", (c) => c.redirect("/login"));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowMs = Date.now();
    try {
      const stats = await runReminderCycle(env, nowMs);
      log.info("cron reminder cycle completed", stats);

      // รันงานทำความสะอาดทุกวันช่วงตี 3 ตามเวลา UTC (เทียบเท่า 10:00 ICT)
      const hourUtc = new Date(nowMs).getUTCHours();
      if (hourUtc === 3) {
        await runDailyMaintenance(env, nowMs);
        await cleanupAuthTables(env.DB, nowMs);
        log.info("daily maintenance completed");
      }
    } catch (err) {
      log.error("cron execution failed", err);
    }
  },
};
