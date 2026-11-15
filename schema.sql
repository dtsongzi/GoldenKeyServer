-- GoldenKey 钢琴工作室约课系统 - 数据库结构
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
  avatar VARCHAR(512),
  phone VARCHAR(32),
  email VARCHAR(128),
  joined_at DATE COMMENT '入职日期',
  remark VARCHAR(255),
  sort INT DEFAULT 0,
  status TINYINT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 课程
CREATE TABLE IF NOT EXISTS courses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(120) NOT NULL,
  category VARCHAR(50) DEFAULT '钢琴课',
  description TEXT,
  cover_image VARCHAR(512),
  price DECIMAL(10,2) DEFAULT 0,
  duration_min INT DEFAULT 60,
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
  phone VARCHAR(32),
  avatar VARCHAR(512),
  balance DECIMAL(10,2) DEFAULT 0 COMMENT '账户余额',
  remark VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 可用时段（由排课生成）
CREATE TABLE IF NOT EXISTS availability (
  id INT PRIMARY KEY AUTO_INCREMENT,
  teacher_id INT,
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1可约 0已约/关闭',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slot (teacher_id, slot_date, start_time),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
);

-- 预约
CREATE TABLE IF NOT EXISTS bookings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT,
  course_id INT,
  teacher_id INT,
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1待确认 2已确认 3已取消 4已完成',
  remark VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
  class_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '1已上课 0缺勤',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);

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

-- 简单后台用户（商家端登录用，演示用，明文仅示例）
CREATE TABLE IF NOT EXISTS admin_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(128) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
