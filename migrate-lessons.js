// 课程实例（lessons）迁移：排课管理页的正式课次数据
// 独立于 availability（小程序可约时段），互不影响；可重复执行。
// 首次执行会把已有 availability / bookings 导入为单次课，避免历史排课丢失。
import pool from './db.js';

async function ensureColumn(conn, table, name, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, name]
  );
  if (r[0].c === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    console.log(`✓ ${table}.${name} 已补齐`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        series_id VARCHAR(40) NULL COMMENT '批量循环排课的系列ID，NULL=单次独立课',
        source VARCHAR(12) NOT NULL DEFAULT 'single' COMMENT 'single 单次 / series 循环系列',
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排课课程实例'
    `);
    console.log('✓ lessons 表就绪');

    await ensureColumn(conn, 'lessons', 'lesson_status', "VARCHAR(16) NOT NULL DEFAULT 'normal'");
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lesson_students (
        lesson_id INT NOT NULL,
        member_id INT NOT NULL,
        PRIMARY KEY (lesson_id, member_id),
        KEY idx_member (member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程-学生（一节课多学生）'
    `);
    console.log('✓ lesson_students 表就绪');

    // 历史数据导入：可约时段 → 单次课
    // 已被有效预约占用的时段不再导入，避免同一时段出现「时段」+「预约」两条课造成假冲突
    const [a] = await conn.query(`
      INSERT INTO lessons (origin_kind, origin_id, source, course_id, title, teacher_id,
                           classroom_id, slot_date, start_time, end_time, lesson_status)
      SELECT 'availability', a.id, 'single', a.course_id, COALESCE(c.title, '可约时段'), a.teacher_id,
             a.classroom_id, a.slot_date, a.start_time, a.end_time, 'normal'
      FROM availability a LEFT JOIN courses c ON c.id = a.course_id
      WHERE NOT EXISTS (SELECT 1 FROM lessons l WHERE l.origin_kind='availability' AND l.origin_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.status != 3
          AND bk.teacher_id = a.teacher_id AND bk.slot_date = a.slot_date
          AND bk.start_time = a.start_time AND bk.end_time = a.end_time)
    `);
    if (a.affectedRows) console.log(`✓ 已从 availability 导入 ${a.affectedRows} 节课`);

    // 已迁移过的库：清掉「被预约时段」重复导入的那一条（幂等，只影响自动迁移数据）
    const [dupStu] = await conn.query(`
      DELETE ls FROM lesson_students ls
      JOIN lessons la ON la.id = ls.lesson_id AND la.origin_kind='availability'
      JOIN lessons lb ON lb.origin_kind='booking'
        AND lb.teacher_id=la.teacher_id AND lb.slot_date=la.slot_date
        AND lb.start_time=la.start_time AND lb.end_time=la.end_time
    `);
    const [dup] = await conn.query(`
      DELETE la FROM lessons la
      JOIN lessons lb ON lb.origin_kind='booking'
        AND lb.teacher_id=la.teacher_id AND lb.slot_date=la.slot_date
        AND lb.start_time=la.start_time AND lb.end_time=la.end_time
      WHERE la.origin_kind='availability'
    `);
    if (dup.affectedRows) console.log(`✓ 清理重复导入时段 ${dup.affectedRows} 条（关联学生 ${dupStu.affectedRows} 条）`);

    // 历史时段没有课程名时给一个明确标识，避免课表上出现一片「未命名课程」
    const [named] = await conn.query(`
      UPDATE lessons SET title='可约时段'
      WHERE origin_kind='availability' AND (title IS NULL OR title='')
    `);
    if (named.affectedRows) console.log(`✓ 回填 ${named.affectedRows} 条历史时段名称`);

    // 历史数据导入：有效预约 → 单次课（带学生）
    const [b] = await conn.query(`
      INSERT INTO lessons (origin_kind, origin_id, source, course_id, title, teacher_id,
                           classroom_id, slot_date, start_time, end_time, lesson_status, remark)
      SELECT 'booking', b.id, 'single', b.course_id, c.title, b.teacher_id,
             b.classroom_id, b.slot_date, b.start_time, b.end_time, 'normal', b.remark
      FROM bookings b LEFT JOIN courses c ON c.id = b.course_id
      WHERE b.status != 3
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.origin_kind='booking' AND l.origin_id=b.id)
    `);
    if (b.affectedRows) console.log(`✓ 已从 bookings 导入 ${b.affectedRows} 节课`);

    // 补齐历史导入课程的学生
    await conn.query(`
      INSERT IGNORE INTO lesson_students (lesson_id, member_id)
      SELECT l.id, b.member_id FROM lessons l
      JOIN bookings b ON b.id = l.origin_id AND l.origin_kind='booking'
      WHERE b.member_id IS NOT NULL
    `);

    const [c] = await conn.query('SELECT COUNT(*) n FROM lessons');
    console.log(`  当前课程数：${c[0].n}\n迁移完成。`);
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
