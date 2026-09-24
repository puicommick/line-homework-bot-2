import type { LineMessage } from "./client";
import {
  formatThaiDate, formatThaiDateTime, formatThaiDateTimeShort,
  formatCountdownThai, formatClassName,
} from "../lib/thai-date";
import { computeStatus, STATUS_TEXT, STATUS_COLOR } from "../lib/time";
import type { StudentAssignmentView, AssignmentWithContext } from "../types";

const BRAND = "#2563EB";
const INK = "#0F172A";
const MUTED = "#64748B";
const LINE_COLOR = "#E2E8F0";
const MAX_BUBBLES = 10; // carousel รับได้ 12 เหลือที่ไว้การ์ดสรุป

type FlexBox = Record<string, unknown>;

function txt(text: string, opts: Record<string, unknown> = {}): FlexBox {
  return { type: "text", text: text === "" ? " " : text, wrap: true, ...opts };
}

function sep(margin = "md"): FlexBox {
  return { type: "separator", margin, color: LINE_COLOR };
}

/** แถว "หัวข้อ  ค่า" สองคอลัมน์ */
function row(label: string, value: string, valueColor = INK): FlexBox {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      txt(label, { size: "xs", color: MUTED, flex: 3 }),
      txt(value, { size: "xs", color: valueColor, flex: 7, weight: "bold" }),
    ],
  };
}

function badge(text: string, color: string): FlexBox {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: color,
    cornerRadius: "10px",
    paddingAll: "4px",
    paddingStart: "10px",
    paddingEnd: "10px",
    flex: 0,
    contents: [txt(text, { size: "xxs", color: "#FFFFFF", weight: "bold", align: "center" })],
  };
}

// ─────────────────────────────────────────────── การ์ดงาน 1 ชิ้น (มุมมองนักเรียน)

export function assignmentBubble(view: StudentAssignmentView, nowMs: number): FlexBox {
  const a = view.assignment;
  const status = view.status;
  const color = STATUS_COLOR[status] ?? MUTED;
  const cls = formatClassName(a.class_level, a.class_room);

  const body: FlexBox[] = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        txt(a.course_name, { size: "xs", color: BRAND, weight: "bold", flex: 5 }),
        badge(STATUS_TEXT[status] ?? "-", color),
      ],
    },
    txt(a.title, { size: "md", weight: "bold", color: INK, margin: "sm", maxLines: 2 }),
  ];

  if (a.description) {
    body.push(txt(a.description, { size: "xs", color: MUTED, margin: "xs", maxLines: 3 }));
  }

  body.push(sep("md"));
  body.push({
    type: "box",
    layout: "vertical",
    spacing: "xs",
    margin: "md",
    contents: [
      row("กำหนดส่ง", formatThaiDateTime(a.due_at)),
      row("ห้อง", cls, MUTED),
      ...(view.submitted_at
        ? [row("ส่งเมื่อ", formatThaiDateTimeShort(view.submitted_at), color)]
        : [row("เวลาที่เหลือ", formatCountdownThai(nowMs, Date.parse(a.due_at)), color)]),
      ...(view.score !== null
        ? [row("คะแนน", `${formatScore(view.score)} / ${formatScore(a.max_score)}`, "#16A34A")]
        : [row("คะแนนเต็ม", formatScore(a.max_score), MUTED)]),
      ...(view.note ? [row("หมายเหตุ", view.note, MUTED)] : []),
    ],
  });

  return {
    type: "bubble",
    size: "kilo",
    body: { type: "box", layout: "vertical", paddingAll: "16px", contents: body },
  };
}

export function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ─────────────────────────────────────────────── รายการงานค้างส่ง

export function pendingListMessage(views: StudentAssignmentView[], nowMs: number): LineMessage {
  const sorted = [...views].sort((a, b) => Date.parse(a.assignment.due_at) - Date.parse(b.assignment.due_at));
  const shown = sorted.slice(0, MAX_BUBBLES);
  const overdue = sorted.filter((v) => v.status === "overdue").length;

  const bubbles: FlexBox[] = shown.map((v) => assignmentBubble(v, nowMs));

  if (sorted.length > MAX_BUBBLES) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        justifyContent: "center",
        contents: [
          txt("และอีก", { size: "sm", color: MUTED, align: "center" }),
          txt(`${sorted.length - MAX_BUBBLES} งาน`, {
            size: "xxl", weight: "bold", color: BRAND, align: "center", margin: "sm",
          }),
          txt("รีบเคลียร์งานเก่าก่อนนะครับ", { size: "xs", color: MUTED, align: "center", margin: "md" }),
        ],
      },
    });
  }

  const alt =
    overdue > 0
      ? `มีงานค้าง ${sorted.length} ชิ้น (เลยกำหนด ${overdue})`
      : `มีงานค้าง ${sorted.length} ชิ้น`;

  return { type: "flex", altText: alt, contents: { type: "carousel", contents: bubbles } };
}

// ─────────────────────────────────────────────── การ์ดแจ้งเตือน (push)

export function reminderMessage(
  a: AssignmentWithContext,
  label: string,
  kind: "before" | "custom" | "overdue",
  nowMs: number,
): LineMessage {
  const dueMs = Date.parse(a.due_at);
  const isOverdue = kind === "overdue";
  const headColor = isOverdue ? "#DC2626" : kind === "custom" ? "#7C3AED" : BRAND;
  const icon = isOverdue ? "⚠️" : "⏰";

  const bubble: FlexBox = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: headColor,
      paddingAll: "14px",
      contents: [
        txt(`${icon} ${label}`, { color: "#FFFFFF", weight: "bold", size: "sm" }),
        txt(a.course_name, { color: "#FFFFFF", size: "xxs", margin: "xs" }),
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      contents: [
        txt(a.title, { size: "md", weight: "bold", color: INK, maxLines: 3 }),
        ...(a.description ? [txt(a.description, { size: "xs", color: MUTED, margin: "sm", maxLines: 4 })] : []),
        sep("md"),
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          margin: "md",
          contents: [
            row("กำหนดส่ง", formatThaiDateTime(a.due_at)),
            row(
              isOverdue ? "สถานะ" : "เหลือเวลา",
              isOverdue ? formatCountdownThai(nowMs, dueMs) : formatCountdownThai(nowMs, dueMs),
              isOverdue ? "#DC2626" : "#EA580C",
            ),
            row("คะแนนเต็ม", formatScore(a.max_score), MUTED),
          ],
        },
        txt(
          isOverdue
            ? "หากส่งแล้วแต่ยังขึ้นแบบนี้ กรุณาแจ้งคุณครูเพื่อบันทึกการส่งนะครับ"
            : "ส่งงานให้ทันเวลานะครับ",
          { size: "xxs", color: MUTED, margin: "md" },
        ),
      ],
    },
  };

  return {
    type: "flex",
    altText: `${icon} ${a.title} • ${a.course_name} • กำหนดส่ง ${formatThaiDateTimeShort(a.due_at)}`,
    contents: bubble,
  };
}

// ─────────────────────────────────────────────── แจ้งเมื่อครูให้คะแนน

export function scoredMessage(
  a: AssignmentWithContext,
  score: number,
  note: string,
  scoredAt: string,
): LineMessage {
  const pct = a.max_score > 0 ? Math.round((score / a.max_score) * 100) : 0;
  const color = pct >= 80 ? "#16A34A" : pct >= 50 ? "#EA580C" : "#DC2626";

  return {
    type: "flex",
    altText: `ครูให้คะแนนแล้ว: ${a.title} ได้ ${formatScore(score)}/${formatScore(a.max_score)}`,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#16A34A",
        paddingAll: "14px",
        contents: [txt("✅ ครูให้คะแนนแล้ว", { color: "#FFFFFF", weight: "bold", size: "sm" })],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          txt(a.course_name, { size: "xs", color: BRAND, weight: "bold" }),
          txt(a.title, { size: "sm", weight: "bold", color: INK, margin: "xs", maxLines: 2 }),
          {
            type: "box",
            layout: "baseline",
            margin: "lg",
            contents: [
              txt(formatScore(score), { size: "xxl", weight: "bold", color, flex: 0 }),
              txt(` / ${formatScore(a.max_score)}`, { size: "sm", color: MUTED, flex: 0, margin: "sm" }),
              txt(`${pct}%`, { size: "sm", color, align: "end", weight: "bold" }),
            ],
          },
          sep("md"),
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: [
              row("ให้คะแนนเมื่อ", formatThaiDateTimeShort(scoredAt), MUTED),
              ...(note ? [row("หมายเหตุ", note, MUTED)] : []),
            ],
          },
        ],
      },
    },
  };
}

// ─────────────────────────────────────────────── สรุปคะแนนของนักเรียน

export interface ScoreSummaryItem {
  courseName: string;
  gained: number;
  full: number;
  graded: number;
  total: number;
}

export function scoreSummaryMessage(
  studentName: string,
  className: string,
  items: ScoreSummaryItem[],
): LineMessage {
  if (items.length === 0) {
    return { type: "text", text: "ยังไม่มีคะแนนที่ครูบันทึกไว้ครับ" };
  }

  const totalGained = items.reduce((s, i) => s + i.gained, 0);
  const totalFull = items.reduce((s, i) => s + i.full, 0);
  const pct = totalFull > 0 ? Math.round((totalGained / totalFull) * 100) : 0;

  const rows: FlexBox[] = [];
  for (const it of items) {
    const p = it.full > 0 ? Math.round((it.gained / it.full) * 100) : 0;
    rows.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        {
          type: "box",
          layout: "baseline",
          contents: [
            txt(it.courseName, { size: "xs", color: INK, weight: "bold", flex: 6 }),
            txt(`${formatScore(it.gained)}/${formatScore(it.full)}`, {
              size: "xs", color: BRAND, align: "end", flex: 4, weight: "bold",
            }),
          ],
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: "#E2E8F0",
          height: "6px",
          cornerRadius: "3px",
          contents: [
            {
              type: "box",
              layout: "vertical",
              backgroundColor: p >= 80 ? "#16A34A" : p >= 50 ? "#F59E0B" : "#DC2626",
              width: `${Math.max(p, 2)}%`,
              height: "6px",
              cornerRadius: "3px",
              contents: [txt(" ", { size: "xxs" })],
            },
          ],
        },
        txt(`ให้คะแนนแล้ว ${it.graded} จาก ${it.total} ชิ้น`, { size: "xxs", color: MUTED }),
      ],
    });
  }

  return {
    type: "flex",
    altText: `คะแนนรวม ${formatScore(totalGained)}/${formatScore(totalFull)} (${pct}%)`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND,
        paddingAll: "16px",
        contents: [
          txt("📊 คะแนนของฉัน", { color: "#FFFFFF", weight: "bold", size: "md" }),
          txt(`${studentName} • ${className}`, { color: "#DBEAFE", size: "xxs", margin: "xs" }),
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "baseline",
            contents: [
              txt("คะแนนรวม", { size: "sm", color: MUTED, flex: 0 }),
              txt(`${formatScore(totalGained)} / ${formatScore(totalFull)}`, {
                size: "lg", weight: "bold", color: INK, align: "end",
              }),
            ],
          },
          txt(`คิดเป็น ${pct}%`, { size: "xs", color: MUTED, align: "end" }),
          sep("md"),
          ...rows,
        ],
      },
    },
  };
}

// ─────────────────────────────────────────────── ประกาศงานเข้ากลุ่มห้อง

export function groupAnnounceMessage(a: AssignmentWithContext, teacherName: string): LineMessage {
  return {
    type: "flex",
    altText: `📢 งานใหม่: ${a.title} • กำหนดส่ง ${formatThaiDateTimeShort(a.due_at)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#7C3AED",
        paddingAll: "16px",
        contents: [
          txt("📢 มอบหมายงานใหม่", { color: "#FFFFFF", weight: "bold", size: "md" }),
          txt(`${a.course_name} • ${formatClassName(a.class_level, a.class_room)}`, {
            color: "#EDE9FE", size: "xxs", margin: "xs",
          }),
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          txt(a.title, { size: "lg", weight: "bold", color: INK, maxLines: 3 }),
          ...(a.description ? [txt(a.description, { size: "sm", color: MUTED, margin: "sm", maxLines: 6 })] : []),
          sep("md"),
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: [
              row("กำหนดส่ง", formatThaiDateTime(a.due_at), "#DC2626"),
              row("คะแนนเต็ม", formatScore(a.max_score)),
              row("มอบหมายโดย", teacherName, MUTED),
            ],
          },
          txt("นักเรียนที่ผูกบัญชีกับบอตแล้ว จะได้รับการแจ้งเตือนส่วนตัวอัตโนมัติ", {
            size: "xxs", color: MUTED, margin: "md",
          }),
        ],
      },
    },
  };
}

// ─────────────────────────────────────────────── สรุปงานวันนี้ (ครู)

export interface TeacherSummaryRow {
  className: string;
  courseName: string;
  title: string;
  dueAt: string;
  submitted: number;
  total: number;
}

export function teacherDailySummaryMessage(rows: TeacherSummaryRow[], dayIso: string): LineMessage {
  if (rows.length === 0) {
    return { type: "text", text: `📅 ${formatThaiDate(dayIso)}\nวันนี้ไม่มีงานที่ถึงกำหนดส่งครับ` };
  }

  const blocks: FlexBox[] = [];
  for (const r of rows.slice(0, 15)) {
    const pct = r.total > 0 ? Math.round((r.submitted / r.total) * 100) : 0;
    blocks.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        txt(`${r.className} • ${r.courseName}`, { size: "xxs", color: BRAND, weight: "bold" }),
        txt(r.title, { size: "sm", color: INK, weight: "bold", maxLines: 2 }),
        {
          type: "box",
          layout: "baseline",
          contents: [
            txt(`ส่งแล้ว ${r.submitted}/${r.total} คน`, {
              size: "xs", color: pct >= 80 ? "#16A34A" : pct >= 50 ? "#EA580C" : "#DC2626", flex: 6,
            }),
            txt(formatThaiDateTimeShort(r.dueAt), { size: "xxs", color: MUTED, align: "end", flex: 4 }),
          ],
        },
        sep("sm"),
      ],
    });
  }

  return {
    type: "flex",
    altText: `สรุปงานวันนี้ ${rows.length} รายการ`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND,
        paddingAll: "16px",
        contents: [
          txt("📅 สรุปงานวันนี้", { color: "#FFFFFF", weight: "bold", size: "md" }),
          txt(formatThaiDate(dayIso), { color: "#DBEAFE", size: "xxs", margin: "xs" }),
        ],
      },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: blocks },
    },
  };
}

// ─────────────────────────────────────────────── ปุ่มลัดเข้าหน้าจัดการ (ครู)

export function teacherHomeMessage(liffUrl: string, displayName: string): LineMessage {
  return {
    type: "flex",
    altText: "เมนูสำหรับคุณครู",
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          txt(`สวัสดีครับ ${displayName}`, { size: "sm", weight: "bold", color: INK }),
          txt("เลือกเมนูที่ต้องการใช้งาน", { size: "xs", color: MUTED, margin: "xs" }),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND,
            height: "sm",
            action: { type: "uri", label: "เปิดหน้าจัดการ", uri: liffUrl },
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "message", label: "สรุปงานวันนี้", text: "สรุปงานวันนี้" },
          },
        ],
      },
    },
  };
}
