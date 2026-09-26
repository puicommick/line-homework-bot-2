-- migrations/0001_init.sql
-- Schema สำหรับระบบทวงการบ้าน LINE Homework Bot
-- หมายเหตุ: เวลาทั้งหมดเก็บเป็น TEXT รูปแบบ ISO8601 UTC เช่น '2026-01-31T13:00:00Z'

-- ============ 1) ครู / ผู้ดูแล ============
CREATE TABLE IF NOT EXISTS teachers (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'teacher',   -- 'owner' | 'teacher'
  line_user_id   TEXT UNIQUE,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_teachers_email   ON teachers(email);
CREATE INDEX IF NOT EXISTS idx_teachers_line    ON teachers(line_user_id);

-- ============ 2) ห้องเรียน ============
CREATE TABLE IF NOT EXISTS classes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,              -- รหัสให้นักเรียนเข้าห้อง
  teacher_id    TEXT NOT NULL,
  school_year   TEXT,
  line_group_id TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_classes_group   ON classes(line_group_id);

-- ============ 3) นักเรียน ============
CREATE TABLE IF NOT EXISTS students (
  id                    TEXT PRIMARY KEY,
  class_id              TEXT,
  student_code          TEXT,                      -- เลขประจำตัวนักเรียน
  display_name          TEXT NOT NULL,
  nickname              TEXT,
  line_user_id          TEXT UNIQUE,
  guardian_line_user_id TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_line  ON students(line_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_class_code
  ON students(class_id, student_code)
  WHERE student_code IS NOT NULL;

-- ============ 4) การบ้าน ============
CREATE TABLE IF NOT EXISTS homeworks (
  id                    TEXT PRIMARY KEY,
  class_id              TEXT NOT NULL,
  teacher_id            TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  subject               TEXT,
  due_at                TEXT,                      -- กำหนดส่ง (ISO8601 UTC)
  remind_before_minutes INTEGER NOT NULL DEFAULT 1440,
  status                TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' | 'archived'
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (class_id)   REFERENCES classes(id)  ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_homeworks_class   ON homeworks(class_id);
CREATE INDEX IF NOT EXISTS idx_homeworks_due     ON homeworks(due_at);
CREATE INDEX IF NOT EXISTS idx_homeworks_status  ON homeworks(status, due_at);

-- ============ 5) การส่งงาน ============
CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,
  homework_id  TEXT NOT NULL,
  student_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'submitted' | 'late' | 'excused'
  submitted_at TEXT,
  checked_by   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (homework_id) REFERENCES homeworks(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id)  REFERENCES students(id)  ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_hw_student
  ON submissions(homework_id, student_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_status  ON submissions(status);

-- ============ 6) เซสชันล็อกอินเว็บ ============
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,                   -- เก็บเป็น hash ของ session token
  teacher_id   TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============ 7) รหัสผูกบัญชี LINE ============
CREATE TABLE IF NOT EXISTS link_codes (
  id           TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL UNIQUE,               -- HMAC(code, LINK_CODE_PEPPER)
  purpose      TEXT NOT NULL DEFAULT 'link',       -- 'link' | 'teacher_setup'
  role         TEXT NOT NULL DEFAULT 'student',    -- 'teacher' | 'student' | 'guardian'
  line_user_id TEXT,
  target_id    TEXT,                               -- teacher_id หรือ student_id (ถ้ารู้แล้ว)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_link_codes_line    ON link_codes(line_user_id);

-- ============ 8) ผู้ใช้ LINE ============
CREATE TABLE IF NOT EXISTS line_users (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  picture_url  TEXT,
  role         TEXT NOT NULL DEFAULT 'guest',      -- 'guest' | 'teacher' | 'student' | 'guardian'
  teacher_id   TEXT,
  student_id   TEXT,
  state        TEXT,                               -- JSON เก็บสถานะบทสนทนา
  is_blocked   INTEGER NOT NULL DEFAULT 0,
  followed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at TEXT,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_line_users_role    ON line_users(role);
CREATE INDEX IF NOT EXISTS idx_line_users_student ON line_users(student_id);

-- ============ 9) บันทึกการแจ้งเตือน (กันส่งซ้ำ) ============
CREATE TABLE IF NOT EXISTS reminders_log (
  id           TEXT PRIMARY KEY,
  homework_id  TEXT NOT NULL,
  student_id   TEXT,
  line_user_id TEXT,
  kind         TEXT NOT NULL,                      -- 'before_due' | 'due' | 'overdue' | 'summary'
  sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  status       TEXT NOT NULL DEFAULT 'sent',       -- 'sent' | 'failed' | 'skipped_quiet_hours'
  error        TEXT,
  FOREIGN KEY (homework_id) REFERENCES homeworks(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reminders_once
  ON reminders_log(homework_id, student_id, kind);
CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders_log(sent_at);
