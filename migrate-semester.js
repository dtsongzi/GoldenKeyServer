// 学期 + 学生课程课时：学期表、课程默认课时、课次所属学期、学生课时台账
// 可重复执行：node migrate-semester.js
import pool from './db.js';

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [table, column]
  );
  return rows.length > 0;
}

async function run() {
  const conn = await pool.getConnection();
  try {
    // 1) 学期表（每年上下两个学期，日期范围由管理员指定）
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学期'
    `);
    console.log('✓ semesters 表就绪');

    // 2) 课程默认课时（与学期无关，单位小时）
    if (!(await hasColumn(conn, 'courses', 'hours'))) {
      await conn.query('ALTER TABLE courses ADD COLUMN hours DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT \'课程默认总课时（小时，与学期无关）\' AFTER duration_min');
      console.log('✓ courses.hours 已添加');
    } else {
      console.log('· courses.hours 已存在');
    }

    // 3) 课次所属学期
    if (!(await hasColumn(conn, 'lessons', 'semester_id'))) {
      await conn.query('ALTER TABLE lessons ADD COLUMN semester_id INT NULL COMMENT \'所属学期 semesters.id\' AFTER source');
      console.log('✓ lessons.semester_id 已添加');
    } else {
      console.log('· lessons.semester_id 已存在');
    }

    // 4) 学生课程课时台账：每个学生每门课一条，与学期无关，单位小时
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生课程课时台账（与学期无关）'
    `);
    console.log('✓ student_course_hours 表就绪');

    // 5) 回填历史：已审核通过的报名补课时台账（总课时取课程默认，已上课时按已有上课记录时长累加）
    const [enrolled] = await conn.query(
      `SELECT e.member_id, e.course_id, COALESCE(c.hours,0) AS hours
       FROM enrollments e JOIN courses c ON c.id=e.course_id
       WHERE e.status=1 AND e.member_id IS NOT NULL AND e.course_id IS NOT NULL
       GROUP BY e.member_id, e.course_id`
    );
    let backfilled = 0;
    for (const e of enrolled) {
      const [used] = await conn.query(
        `SELECT ROUND(COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(end_time,start_time))/3600),0),2) AS h
         FROM class_records WHERE member_id=? AND course_id=? AND status=1`, [e.member_id, e.course_id]
      );
      const usedHours = Number(used[0]?.h || 0);
      const [r] = await conn.query(
        `INSERT IGNORE INTO student_course_hours (member_id,course_id,total_hours,used_hours) VALUES (?,?,?,?)`,
        [e.member_id, e.course_id, Number(e.hours || 0), usedHours]
      );
      if (r.affectedRows) backfilled++;
    }
    console.log(`· 历史报名课时台账回填 ${backfilled} 条`);

    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e.sqlMessage || e.message); process.exit(1); });
