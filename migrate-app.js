// 小程序端（教师 / 学生双角色）数据库迁移 + 演示账号种子
// 可重复执行：node migrate-app.js
import pool from './db.js';

async function addColumn(conn, table, column, ddl) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, column]
  );
  if (rows[0].c === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`✓ ${table}.${column} 已添加`);
  } else {
    console.log(`· ${table}.${column} 已存在，跳过`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    // 1) admin_users：学生账号需要关联 members
    await addColumn(conn, 'admin_users', 'member_id', 'INT NULL COMMENT \'小程序学生账号关联的会员ID\'');

    // 2) availability：教师为某门课程设置的可约时段
    await addColumn(conn, 'availability', 'course_id', 'INT NULL COMMENT \'关联课程；NULL=通用可约时段\'');
    const [idx] = await conn.query(
      "SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='availability' AND INDEX_NAME='idx_avail_course'"
    );
    if (idx[0].c === 0) {
      await conn.query('CREATE INDEX idx_avail_course ON availability(course_id)');
      console.log('✓ availability.idx_avail_course 索引已创建');
    }

    // 3) 教师账号（复用商家端已有的 lin / chen，保证 teacher_id 正确）
    const [teacherAccounts] = await conn.query(
      "SELECT id, username, teacher_id FROM admin_users WHERE username IN ('lin','chen')"
    );
    for (const t of teacherAccounts) {
      await conn.query("UPDATE admin_users SET role='teacher' WHERE id=?", [t.id]);
      console.log(`· 教师账号 ${t.username} (teacher_id=${t.teacher_id})`);
    }
    if (teacherAccounts.length < 2) {
      console.log('! 未找到完整的教师账号，请先执行 node seed.js 或手动创建');
    }

    // 4) 学生账号：关联 members 表前三位会员
    const [members] = await conn.query('SELECT id, name FROM members ORDER BY id LIMIT 3');
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const username = `student${i + 1}`;
      await conn.query(
        `INSERT INTO admin_users (username, password, role, member_id)
         VALUES (?, '123456', 'student', ?)
         ON DUPLICATE KEY UPDATE role='student', member_id=VALUES(member_id), password='123456'`,
        [username, m.id]
      );
      console.log(`✓ 学生账号 ${username} / 123456 → ${m.name} (member_id=${m.id})`);
    }

    // 5) 教师账号不应残留 member_id
    await conn.query("UPDATE admin_users SET member_id=NULL WHERE role IN ('admin','teacher')");

    console.log('\n迁移完成。');
    console.log('小程序登录账号：教师 lin/teacher123、chen/teacher123；学生 student1~3/123456');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
