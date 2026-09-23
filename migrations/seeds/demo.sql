INSERT INTO teachers (id, line_user_id, display_name, role, is_active, created_at)
VALUES ('tc_demo', NULL, 'ครูตัวอย่าง', 'admin', 1, '2026-05-01T00:00:00.000Z');

INSERT INTO classes (id, level, room, line_group_id, created_at) VALUES
  ('cl_m4_1', 4, 1, NULL, '2026-05-01T00:00:00.000Z'),
  ('cl_m4_2', 4, 2, NULL, '2026-05-01T00:00:00.000Z');

INSERT INTO courses (id, class_id, name, code, teacher_id, created_at) VALUES
  ('co_1', 'cl_m4_1', 'วิทยาการคำนวณ', 'ว31103', 'tc_demo', '2026-05-01T00:00:00.000Z'),
  ('co_2', 'cl_m4_2', 'วิทยาการคำนวณ', 'ว31103', 'tc_demo', '2026-05-01T00:00:00.000Z');

INSERT INTO students (id, student_code, name, "no", class_id, notify_enabled, quiet_hours_enabled, created_at) VALUES
  ('st_1', '40001', 'สมชาย ใจดี',    1, 'cl_m4_1', 1, 1, '2026-05-01T00:00:00.000Z'),
  ('st_2', '40002', 'สมหญิง ตั้งใจ', 2, 'cl_m4_1', 1, 1, '2026-05-01T00:00:00.000Z'),
  ('st_3', '40003', 'ปิติ รักเรียน',  3, 'cl_m4_2', 1, 1, '2026-05-01T00:00:00.000Z');

-- งานตัวอย่าง: กำหนดส่ง ศ. 26 ก.ย. 2569 เวลา 16:00 น. (ICT) = 09:00Z
INSERT INTO assignments
  (id, course_id, title, description, max_score, assigned_at, due_at,
   remind_minutes, remind_at, notify_overdue, batch_id, created_by, is_archived, created_at, updated_at)
VALUES
  ('as_1', 'co_1', 'ใบงานที่ 3 ผังงาน', 'ทำในสมุด ถ่ายรูปส่งในชั้นเรียน', 10,
   '2026-09-21T02:00:00.000Z', '2026-09-26T09:00:00.000Z',
   '[4320,1440,360,60]', NULL, 1, 'b_1', 'tc_demo', 0,
   '2026-09-21T02:00:00.000Z', '2026-09-21T02:00:00.000Z');
