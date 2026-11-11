// 课程报名（enrollment）迁移 + 历史数据回填
// 可重复执行：node migrate-enroll.js
//
// enrollments.status: 0 待审核 / 1 已通过 / 2 已拒绝 / 3 已撤销
// 学员对同一门课只能有一条记录（唯一键），被拒绝或撤销后可重新提交报名。
import pool from './db.js';

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程报名与审核'
    `);
    console.log('✓ enrollments 表就绪');

    // 兼容旧库：若表是早期创建的缺列版本，逐列补齐
    const cols = [
      ['teacher_id', 'INT NULL'],
      ['remark', 'VARCHAR(255) NULL'],
      ['review_note', 'VARCHAR(255) NULL'],
      ['reviewed_by', 'INT NULL'],
      ['reviewed_by_role', 'VARCHAR(20) NULL'],
      ['reviewed_at', 'DATETIME NULL'],
      ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ];
    for (const [name, ddl] of cols) {
      const [r] = await conn.query(
        'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME="enrollments" AND COLUMN_NAME=?',
        [name]
      );
      if (r[0].c === 0) {
        await conn.query(`ALTER TABLE enrollments ADD COLUMN ${name} ${ddl}`);
        console.log(`✓ enrollments.${name} 已补齐`);
      }
    }

    // 历史有效预约的学员自动视为「已报名通过」，避免升级后老学员突然无法预约
    const [r] = await conn.query(`
      INSERT INTO enrollments (member_id, course_id, teacher_id, status, remark, review_note, reviewed_by_role, reviewed_at)
      SELECT b.member_id, b.course_id, c.teacher_id, 1, NULL, '历史预约自动通过', 'system', NOW()
      FROM (SELECT DISTINCT member_id, course_id FROM bookings
            WHERE status IN (1,2) AND member_id IS NOT NULL AND course_id IS NOT NULL) b
      JOIN courses c ON c.id = b.course_id
      ON DUPLICATE KEY UPDATE status = IF(enrollments.status = 0, 1, enrollments.status)
    `);
    console.log(`✓ 历史预约回填：新增/命中 ${r.affectedRows} 条`);

    const [stat] = await conn.query(
      'SELECT status, COUNT(*) c FROM enrollments GROUP BY status ORDER BY status'
    );
    console.log('  当前报名状态分布：', stat.length ? stat.map((x) => `${x.status}:${x.c}`).join('  ') : '（空）');
    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
