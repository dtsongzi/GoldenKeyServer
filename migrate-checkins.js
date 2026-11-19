// 教师课程打卡：打卡记录表 + 教师头像扩容（base64）
// 可重复执行：node migrate-checkins.js
import pool from './db.js';

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lesson_checkins (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        lesson_id INT NOT NULL COMMENT '关联 lessons.id',
        teacher_id INT NULL COMMENT '打卡教师（冗余便于统计）',
        slot_date DATE NOT NULL COMMENT '课程日期',
        note VARCHAR(255) NULL COMMENT '打卡备注',
        checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_lesson (lesson_id),
        KEY idx_teacher_date (teacher_id, slot_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教师课程打卡记录'
    `);
    console.log('✓ lesson_checkins 表就绪');

    // 头像改为照片上传后存 base64 data URL，VARCHAR(512) 不够，扩容为 LONGTEXT
    const [cols] = await conn.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='teachers' AND COLUMN_NAME='avatar'`
    );
    if (cols.length && String(cols[0].DATA_TYPE).toLowerCase() !== 'longtext') {
      await conn.query('ALTER TABLE teachers MODIFY COLUMN avatar LONGTEXT NULL');
      console.log('✓ teachers.avatar 已扩容为 LONGTEXT（支持 base64 头像）');
    } else {
      console.log('· teachers.avatar 已是 LONGTEXT');
    }

    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e.sqlMessage || e.message); process.exit(1); });
