import { readFileSync } from "node:fs";

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("กรุณากำหนด LINE_CHANNEL_ACCESS_TOKEN ใน environment ก่อนรันสคริปต์");
  process.exit(1);
}

const menuData = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: "Menu นักเรียน",
  chatBarText: "เมนูนักเรียน / ตรวจงาน",
  areas: [
    {
      bounds: { x: 0, y: 0, width: 625, height: 843 },
      action: { type: "message", text: "งานค้าง" }
    },
    {
      bounds: { x: 625, y: 0, width: 625, height: 843 },
      action: { type: "message", text: "คะแนน" }
    },
    {
      bounds: { x: 1250, y: 0, width: 625, height: 843 },
      action: { type: "message", text: "ส่งแล้ว" }
    },
    {
      bounds: { x: 1875, y: 0, width: 625, height: 843 },
      action: { type: "message", text: "ลงทะเบียน" }
    }
  ]
};

async function createRichMenu() {
  console.log("กำลังสร้าง Rich Menu...");
  const res = await fetch("https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(menuData)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("สร้างไม่สำเร็จ:", data);
    process.exit(1);
  }
  console.log("สร้างสำเร็จ! Rich Menu ID:", data.richMenuId);
  console.log("คำแนะนำ: ให้นำรูปภาพขนาด 2500x843 px ไปอัปโหลดเข้าสู่เมนูนัดหมายนี้ผ่าน LINE Bot Manager หรือเขียนโค้ดอัปโหลดต่อได้ทันที");
}

createRichMenu();
