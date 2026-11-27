-- GoldenKey 钢琴工作室约课系统 - 数据库完整结构
-- 这是唯一的表结构定义源：前置部署脚本 server-setup.sh 会 DROP 全部表后按本文件重建。
-- 字符集 utf8mb4 / 排序 utf8mb4_unicode_ci

SET NAMES utf8mb4;

-- 工作室简介（单条记录，id=1）
CREATE TABLE IF NOT EXISTS studio_profile (
  id INT PRIMARY KEY DEFAULT 1,
  name VARCHAR(100) NOT NULL DEFAULT 'GoldenKey 钢琴工作室',
  intro TEXT,
  address VARCHAR(255),
  phone VARCHAR(32),
  cover_image VARCHAR(512),
  business_hours VARCHAR(128) DEFAULT '周二至周日 10:00 - 21:00',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 教师
CREATE TABLE IF NOT EXISTS teachers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  gender VARCHAR(8) COMMENT '男/女/保密',
  title VARCHAR(50) DEFAULT '钢琴教师',
  bio TEXT,
  resume LONGTEXT COMMENT '个人履历介绍（教师介绍页展示）',
  photos LONGTEXT COMMENT '教师照片，base64 data URL 的 JSON 数组',
  avatar LONGTEXT COMMENT '教师头像，base64 data URL（照片上传）',
  phone VARCHAR(32),
  email VARCHAR(128),
  joined_at DATE COMMENT '入职日期',
  remark VARCHAR(255),
  sort INT DEFAULT 0,
  status TINYINT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 课程（hours = 课程默认总课时，单位小时，与学期无关）
CREATE TABLE IF NOT EXISTS courses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(120) NOT NULL,
  category VARCHAR(50) DEFAULT '钢琴课',
  description TEXT,
  cover_image VARCHAR(512),
  price DECIMAL(10,2) DEFAULT 0,
  duration_min INT DEFAULT 60,
  hours DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '课程默认总课时（小时，与学期无关）',
  teacher_id INT,
  status TINYINT DEFAULT 1 COMMENT '1上架 0下架',
  sort INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
);

-- 会员（学生）
CREATE TABLE IF NOT EXISTS members (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  gender VARCHAR(8) COMMENT '男/女/保密',
  age TINYINT UNSIGNED COMMENT '年龄',
  phone VARCHAR(32),
  avatar VARCHAR(512),
  openid VARCHAR(64) COMMENT '微信 openid（快捷登录用）',
  source VARCHAR(16) NOT NULL DEFAULT 'admin' COMMENT 'admin 后台录入 / self 小程序自助注册',
  balance DECIMAL(10,2) DEFAULT 0 COMMENT '账户余额',
  remark VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_members_openid (openid)
);

-- 教室（琴房）
CREATE TABLE IF NOT EXISTS classrooms (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL COMMENT '教室/琴房名称',
  capacity INT NOT NULL DEFAULT 1 COMMENT '同时容纳人数',
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1可用 0停用',
  sort INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_name (name)
);

-- 可用时段（由排课生成，小程序预约用）
CREATE TABLE IF NOT EXISTS availability (
  id INT PRIMARY KEY AUTO_INCREMENT,
  teacher_id INT,
  course_id INT NULL COMMENT '关联课程；NULL=通用可约时段',
  classroom_id INT NULL COMMENT '排课指定教室',
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1可约 0已约/关闭',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slot (teacher_id, slot_date, start_time),
  KEY idx_avail_course (course_id),
  KEY idx_room_time (classroom_id, slot_date, start_time),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
);

-- 预约
CREATE TABLE IF NOT EXISTS bookings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT,
  course_id INT,
  teacher_id INT,
  classroom_id INT NULL COMMENT '预约教室（随排课带入）',
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1待确认 2已确认 3已取消 4已完成',
  remark VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_room_time (classroom_id, slot_date, start_time),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
);

-- 上课记录
CREATE TABLE IF NOT EXISTS class_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT,
  course_id INT,
  teacher_id INT,
  classroom_id INT NULL COMMENT '上课教室',
  class_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1已上课 0缺勤',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- 课程报名与审核
-- status: 0 待审核 / 1 已通过 / 2 已拒绝 / 3 已撤销
CREATE TABLE IF NOT EXISTS enrollments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '报名学员',
  course_id INT NOT NULL COMMENT '报名课程',
  teacher_id INT NULL COMMENT '课程归属教师（冗余，便于按教师筛选）',
  status TINYINT NOT NULL DEFAULT 0 COMMENT '0待审核 1已通过 2已拒绝 3已撤销',
  remark VARCHAR(255) NULL COMMENT '学员报名留言',
  review_note VARCHAR(255) NULL COMMENT '审核备注',
  reviewed_by INT NULL COMMENT 'admin_users.id',
  reviewed_by_role VARCHAR(20) NULL COMMENT 'admin / teacher / system',
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_member_course (member_id, course_id),
  KEY idx_course_status (course_id, status),
  KEY idx_teacher_status (teacher_id, status),
  KEY idx_member_status (member_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程报名与审核';

-- 排课课程实例（与 availability 独立）
CREATE TABLE IF NOT EXISTS lessons (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  series_id VARCHAR(40) NULL COMMENT '批量循环排课的系列ID，NULL=单次独立课',
  source VARCHAR(12) NOT NULL DEFAULT 'single' COMMENT 'single 单次 / series 循环系列',
  semester_id INT NULL COMMENT '所属学期 semesters.id',
  course_id INT NULL COMMENT '课程',
  title VARCHAR(120) NULL COMMENT '课程名称快照',
  teacher_id INT NULL COMMENT '授课教师（一节课一位）',
  classroom_id INT NULL COMMENT '教室（一节课一间）',
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  remark VARCHAR(500) NULL,
  lesson_status VARCHAR(16) NOT NULL DEFAULT 'normal' COMMENT 'normal 正常 / leave 请假 / suspended 停课',
  origin_kind VARCHAR(16) NULL COMMENT '历史数据迁移来源 availability / booking',
  origin_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_date (slot_date),
  KEY idx_series (series_id),
  KEY idx_teacher_time (teacher_id, slot_date, start_time),
  KEY idx_room_time (classroom_id, slot_date, start_time),
  UNIQUE KEY uk_origin (origin_kind, origin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排课课程实例';

-- 课程-学生（一节课多学生）
CREATE TABLE IF NOT EXISTS lesson_students (
  lesson_id INT NOT NULL,
  member_id INT NOT NULL,
  PRIMARY KEY (lesson_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程-学生（一节课多学生）';

-- 教师课程打卡记录（一节课一次，幂等）
CREATE TABLE IF NOT EXISTS lesson_checkins (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lesson_id INT NOT NULL COMMENT '关联 lessons.id',
  teacher_id INT NULL COMMENT '打卡教师（冗余便于统计）',
  slot_date DATE NOT NULL COMMENT '课程日期',
  note VARCHAR(255) NULL COMMENT '打卡备注',
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_lesson (lesson_id),
  KEY idx_teacher_date (teacher_id, slot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教师课程打卡记录';

-- 学期（每年上下两学期，日期范围由管理员指定）
CREATE TABLE IF NOT EXISTS semesters (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL COMMENT '学期名称，如 2026-2027学年上学期',
  term TINYINT NOT NULL DEFAULT 1 COMMENT '1上学期 2下学期',
  start_date DATE NOT NULL COMMENT '学期开始日期',
  end_date DATE NOT NULL COMMENT '学期结束日期',
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  is_current TINYINT NOT NULL DEFAULT 0 COMMENT '1当前学期（同一时刻仅一个）',
  remark VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dates (start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学期';

-- 学生课程课时台账（每学生每门课一条，与学期无关，单位小时）
CREATE TABLE IF NOT EXISTS student_course_hours (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL COMMENT '学员',
  course_id INT NOT NULL COMMENT '课程',
  total_hours DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '总课时（小时）',
  used_hours DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '已上课时（小时）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_member_course (member_id, course_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生课程课时台账（与学期无关）';

-- 会员消息
CREATE TABLE IF NOT EXISTS messages (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT,
  type VARCHAR(32) COMMENT 'booking_reminder/booking_success/booking_cancel',
  title VARCHAR(120),
  content TEXT,
  is_read TINYINT DEFAULT 0,
  related_id INT COMMENT '关联 booking id',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- 后台账号（商家端 / 教师 / 学员登录）
CREATE TABLE IF NOT EXISTS admin_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(128) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin' COMMENT 'admin 管理员 / teacher 教师 / student 学员',
  teacher_id INT NULL COMMENT '教师账号关联的教师ID',
  member_id INT NULL COMMENT '学员账号关联的会员ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
