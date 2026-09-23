# 📚 ระบบบอต LINE ตามงานนักเรียน (Cloudflare Workers + D1 + LINE Messaging API)

ระบบแจ้งเตือนการบ้าน งานค้าง และคะแนนนักเรียนอัตโนมัติผ่าน LINE Official Account รองรับการจัดการผ่านหน้าเว็บ (LIFF) บนมือถือสำหรับคุณครู

---

## 🚀 ขั้นตอนการติดตั้งและตั้งค่าระบบ (จากศูนย์)

### 1. เตรียมโปรเจกต์และติดตั้งเครื่องมือ
- ติดตั้ง Node.js (เวอร์ชัน 18 ขึ้นไป)
- โคลนหรือดาวน์โหลดโปรเจกต์นี้ลงในเครื่อง แล้วรันคำสั่งติดตั้งแพ็กเกจ:
  ```bash
  npm install
  ```

### 2. สร้างฐานข้อมูล Cloudflare D1
- ล็อกอินเข้า Cloudflare Wrangler (หากยังไม่ได้ล็อกอิน):
  ```bash
  npx wrangler login
  ```
- สร้างฐานข้อมูล D1 บน Cloudflare:
  ```bash
  npm run db:create
  ```
- นำ `database_id` ที่ได้ไปใส่ไว้ในไฟล์ `wrangler.toml` ในบรรทัด `database_id = "..."`

### 3. รัน Migration เพื่อสร้างตารางในฐานข้อมูล
- รันบน local สำหรับทดสอบ:
  ```bash
  npm run db:migrate:local
  npm run db:seed:local
  ```
- รันบน production (Cloudflare D1 จริง):
  ```bash
  npm run db:migrate:remote
  ```

### 4. ตั้งค่า Secrets และตัวแปรลับ
ตั้งค่าความปลอดภัยผ่านคำสั่ง Wrangler Secret:
```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put TEACHER_SETUP_CODE
npx wrangler secret put LINK_CODE_PEPPER
```
*(ค่า `TEACHER_SETUP_CODE` ใช้สำหรับเปิดบัญชีผู้ดูแลระบบคนแรก)*

### 5. Deploy ขึ้น Cloudflare Workers
```bash
npm run deploy
```
เมื่อ deploy สำเร็จ จะได้ URL ของ Worker มา (เช่น `https://line-homework-bot.your-name.workers.dev`)

### 6. ตั้งค่า LINE Official Account (LIFF & Webhook)
1. ไปที่ [LINE Developers Console](https://developers.line.biz/)
2. ตั้งค่า **Webhook URL** เป็น: `https://<worker-url>/webhook`
3. สร้าง **LIFF App** โดยชี้ Endpoint URL ไปที่: `https://<worker-url>/app`
4. นำ LIFF ID ไปใส่ใน `wrangler.toml` (หัวข้อ `LIFF_ID`) แล้ว Deploy อีกครั้ง
