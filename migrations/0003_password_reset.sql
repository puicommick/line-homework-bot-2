-- ============================================================
-- ลืมรหัสผ่าน: ส่งลิงก์รีเซ็ตเข้า LINE ของครู
-- DB เก็บเฉพาะ hash ของโทเคน ตัวโทเคนจริงอยู่ในลิงก์เท่านั้น
-- ============================================================
PRAGMA foreign_keys = ON;

CREATE TABLE password_resets (
  id           TEXT PRIMARY KEY,
  teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256('reset::' || pepper || token)
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_resets_teacher ON password_resets(teacher_id, created_at);
CREATE INDEX idx_resets_expiry ON password_resets(expires_at);

-- จำกัดการขอรีเซ็ตต่อบัญชี กันคนกดรัวจนครูโดนสแปมใน LINE
CREATE TABLE reset_throttle (
  teacher_id     TEXT PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
  attempts       INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT NOT NULL,
  blocked_until  TEXT
);
