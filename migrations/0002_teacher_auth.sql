-- ============================================================
-- ระบบล็อกอินครู: username/password + session + รหัสเชิญ
-- ============================================================
PRAGMA foreign_keys = ON;

ALTER TABLE teachers ADD COLUMN username            TEXT;
ALTER TABLE teachers ADD COLUMN password_hash       TEXT;
ALTER TABLE teachers ADD COLUMN password_updated_at TEXT;
ALTER TABLE teachers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teachers ADD COLUMN failed_logins       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teachers ADD COLUMN locked_until        TEXT;
ALTER TABLE teachers ADD COLUMN last_login_at       TEXT;
ALTER TABLE teachers ADD COLUMN email               TEXT;

-- SQLite: UNIQUE index ยอมให้มีหลายแถวที่เป็น NULL ได้ (ครูที่ผูกเฉพาะ LINE ยังไม่มี username)
CREATE UNIQUE INDEX uq_teachers_username ON teachers(username);

-- ---------- session ของครู ----------
CREATE TABLE teacher_sessions (
  id            TEXT PRIMARY KEY,
  teacher_id    TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,   -- sha256('session::' || pepper || token)
  source        TEXT NOT NULL,          -- 'password' | 'liff'
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  revoked_at    TEXT,
  CHECK (source IN ('password','liff'))
);
CREATE INDEX idx_sessions_teacher ON teacher_sessions(teacher_id, expires_at);
CREATE INDEX idx_sessions_expiry ON teacher_sessions(expires_at);

-- ---------- รหัสเชิญสำหรับเปิดบัญชีครูใหม่ ----------
CREATE TABLE teacher_invites (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,     -- sha256('invite::' || pepper || code)
  note        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'teacher',
  created_by  TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  CHECK (role IN ('teacher','admin'))
);

-- ---------- กันยิงรหัสผ่านมั่ว รายไอพี ----------
CREATE TABLE login_throttle (
  ip_hash        TEXT PRIMARY KEY,      -- sha256('ip::' || pepper || ip) ไม่เก็บ IP ตรง ๆ (PDPA)
  attempts       INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT NOT NULL,
  blocked_until  TEXT
);

-- ---------- audit log (ไม่เก็บ PII/รหัสผ่าน) ----------
CREATE TABLE auth_log (
  id          TEXT PRIMARY KEY,
  teacher_id  TEXT,
  action      TEXT NOT NULL,   -- 'login_ok' | 'login_fail' | 'logout' | 'register' | 'pw_change' | 'liff_login'
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_auth_log_time ON auth_log(created_at);
