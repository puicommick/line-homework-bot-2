-- ============================================================
-- LINE Homework Bot - schema เริ่มต้น
-- เวลาทุกคอลัมน์ที่ลงท้ายด้วย _at เก็บเป็น UTC ISO-8601
-- รูปแบบ: 2026-09-26T09:00:00.000Z
-- ============================================================
PRAGMA foreign_keys = ON;

-- ---------- ครู ----------
CREATE TABLE teachers (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'teacher',   -- 'teacher' | 'admin'
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  CHECK (role IN ('teacher','admin'))
);

-- ---------- ห้องเรียน ----------
CREATE TABLE classes (
  id             TEXT PRIMARY KEY,
  level          INTEGER NOT NULL,                 -- 1..6 = ม.1..ม.6
  room           INTEGER NOT NULL,                 -- เลขห้อง
  line_group_id  TEXT,                             -- groupId ของกลุ่ม LINE ห้องนี้
  created_at     TEXT NOT NULL,
  UNIQUE (level, room),
  CHECK (level BETWEEN 1 AND 6),
  CHECK (room BETWEEN 1 AND 99)
);
CREATE INDEX idx_classes_group ON classes(line_group_id);

-- ---------- วิชา (ผูกกับห้อง 1 ห้อง) ----------
CREATE TABLE courses (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',
  teacher_id  TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_courses_class ON courses(class_id);
CREATE UNIQUE INDEX uq_courses_class_name ON courses(class_id, name);

-- ---------- นักเรียน ----------
CREATE TABLE students (
  id                    TEXT PRIMARY KEY,
  student_code          TEXT NOT NULL UNIQUE,      -- รหัสประจำตัวนักเรียน
  name                  TEXT NOT NULL,
  "no"                  INTEGER,                   -- เลขที่ในห้อง
  class_id              TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  link_code_hash        TEXT,                      -- SHA-256(pepper + student_code + code)
  link_code_expires_at  TEXT,
  link_attempts         INTEGER NOT NULL DEFAULT 0,
  line_user_id          TEXT UNIQUE,
  linked_at             TEXT,
  notify_enabled        INTEGER NOT NULL DEFAULT 1,
  quiet_hours_enabled   INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_students_class ON students(class_id, "no");
CREATE INDEX idx_students_line ON students(line_user_id);

-- ---------- งาน ----------
CREATE TABLE assignments (
  id              TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  max_score       REAL NOT NULL DEFAULT 10,
  assigned_at     TEXT NOT NULL,
  due_at          TEXT NOT NULL,
  remind_minutes  TEXT NOT NULL DEFAULT '[4320,1440,360,180,60]',  -- JSON array นาทีก่อนกำหนด
  remind_at       TEXT,                                            -- เตือนเพิ่ม ณ เวลาที่ระบุ
  notify_overdue  INTEGER NOT NULL DEFAULT 1,                      -- เตือนซ้ำเมื่อเลยกำหนด
  batch_id        TEXT,                                            -- งานชุดเดียวกันที่สั่งหลายห้องพร้อมกัน
  created_by      TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (max_score >= 0)
);
CREATE INDEX idx_assignments_course ON assignments(course_id, due_at);
CREATE INDEX idx_assignments_due ON assignments(due_at) WHERE is_archived = 0;
CREATE INDEX idx_assignments_batch ON assignments(batch_id);

-- ---------- การส่งงาน / คะแนน ----------
CREATE TABLE submissions (
  id                 TEXT PRIMARY KEY,
  assignment_id      TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  submitted_at       TEXT,          -- NULL = ยังไม่ส่ง
  score              REAL,          -- NULL = ยังไม่ให้คะแนน
  scored_at          TEXT,
  score_notified_at  TEXT,          -- เวลาที่แจ้งนักเรียนว่าได้คะแนนแล้ว
  note               TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX idx_submissions_student ON submissions(student_id);
CREATE INDEX idx_submissions_pending_notify
  ON submissions(scored_at) WHERE score IS NOT NULL AND score_notified_at IS NULL;

-- ---------- log การแจ้งเตือน (หัวใจของ idempotency) ----------
CREATE TABLE reminder_log (
  assignment_id  TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  reminder_key   TEXT NOT NULL,     -- 'before:1440' | 'custom:<iso>' | 'overdue' | 'scored'
  status         TEXT NOT NULL,     -- 'claimed' | 'sent' | 'skipped' | 'retry' | 'failed'
  attempts       INTEGER NOT NULL DEFAULT 0,
  point_at       TEXT,              -- เวลาของจุดเตือนนั้น (UTC ISO) ไว้ตรวจย้อนหลัง
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  PRIMARY KEY (assignment_id, student_id, reminder_key)
);
CREATE INDEX idx_reminder_log_status ON reminder_log(status, created_at);

-- ---------- กัน webhook ซ้ำ ----------
CREATE TABLE line_events (
  event_id     TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL
);
CREATE INDEX idx_line_events_time ON line_events(received_at);

-- ---------- สถานะบทสนทนา (flow ลงทะเบียน) ----------
CREATE TABLE chat_states (
  line_user_id  TEXT PRIMARY KEY,
  state         TEXT NOT NULL,       -- 'idle' | 'await_student_code' | 'await_link_code' | 'await_teacher_code'
  payload       TEXT NOT NULL DEFAULT '{}',
  expires_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------- throttle การพยายามผูกบัญชีรายผู้ใช้ LINE ----------
CREATE TABLE link_throttle (
  line_user_id   TEXT PRIMARY KEY,
  attempts       INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT NOT NULL,
  blocked_until  TEXT
);
