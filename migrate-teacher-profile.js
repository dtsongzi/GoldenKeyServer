// 教师档案扩展：性别 / 手机 / 邮箱 / 入职日期 / 备注
// 可重复执行：node migrate-teacher-profile.js
import pool from './db.js';

async function ensureColumn(conn, table, name, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, name]
  );
  if (r[0].c === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    console.log(`✓ ${table}.${name} 已补齐`);
  } else {
    console.log(`· ${table}.${name} 已存在`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await ensureColumn(conn, 'teachers', 'gender', "VARCHAR(8) NULL COMMENT '性别：男/女/保密'");
    await ensureColumn(conn, 'teachers', 'phone', 'VARCHAR(32) NULL');
    await ensureColumn(conn, 'teachers', 'email', 'VARCHAR(128) NULL');
    await ensureColumn(conn, 'teachers', 'joined_at', 'DATE NULL COMMENT \'入职日期\'');
    await ensureColumn(conn, 'teachers', 'remark', 'VARCHAR(255) NULL');

    const [rows] = await conn.query('SELECT COUNT(*) n FROM teachers');
    console.log(`  当前教师数：${rows[0].n}`);

    // 历史教师账号（admin_users.role=teacher）补齐 teacher_id 的兜底：按同名匹配一次
    const [fixed] = await conn.query(`
      UPDATE admin_users au
      JOIN teachers t ON t.name = au.username
      SET au.teacher_id = t.id
      WHERE au.role='teacher' AND (au.teacher_id IS NULL OR au.teacher_id = 0)
    `);
    if (fixed.affectedRows) console.log(`✓ 按用户名补齐 ${fixed.affectedRows} 个教师账号的 teacher_id`);

    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e.sqlMessage || e.message);
  process.exit(1);
});
