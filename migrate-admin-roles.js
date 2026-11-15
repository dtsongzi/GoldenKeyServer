// admin_users 角色迁移：补齐 role / teacher_id / member_id，并规范化演示账号
// 可重复执行：node migrate-admin-roles.js
//
// 背景：这三列早期是手工 ALTER 的，没进迁移脚本，导致新建库（Docker/新环境）跑不起来：
//   SELECT id,username,role,teacher_id FROM admin_users -> Unknown column 'role'
import pool from './db.js';

async function ensureColumn(conn, name, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME="admin_users" AND COLUMN_NAME=?',
    [name]
  );
  if (r[0].c === 0) {
    await conn.query(`ALTER TABLE admin_users ADD COLUMN ${name} ${ddl}`);
    console.log(`✓ admin_users.${name} 已补齐`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await ensureColumn(conn, 'role', "VARCHAR(20) NOT NULL DEFAULT 'admin'");
    await ensureColumn(conn, 'teacher_id', 'INT NULL');
    await ensureColumn(conn, 'member_id', 'INT NULL');

    // 教师 / 学员 id 以真实数据为准，找不到就置空，避免写死 id
    const pick = async (table, name) => {
      // 注意：conn.query 返回 [rows, fields]，必须再取 rows[0]；
      // 若只解构一层，拿到的是整个数组（空数组也是 truthy），会把 id 误判成 undefined
      const [rows] = await conn.query(`SELECT id FROM ${table} WHERE name=? LIMIT 1`, [name]);
      return rows.length ? rows[0].id : null;
    };
    const linId = await pick('teachers', '林晚晴');
    const chenId = await pick('teachers', '陈牧之');
    const m1 = await pick('members', '苏小满');
    const m2 = await pick('members', '周予安');
    const m3 = await pick('members', '李慕白');

    const accounts = [
      ['admin', 'admin123', 'admin', null, null],
      ['lin', 'teacher123', 'teacher', linId, null],
      ['chen', 'teacher123', 'teacher', chenId, null],
      ['student1', '123456', 'student', null, m1],
      ['student2', '123456', 'student', null, m2],
      ['student3', '123456', 'student', null, m3],
    ];

    for (const [username, password, role, teacherId, memberId] of accounts) {
      // 已存在的账号只修正角色与归属，不覆盖密码
      await conn.query(
        `INSERT INTO admin_users (username, password, role, teacher_id, member_id)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE role=VALUES(role), teacher_id=VALUES(teacher_id), member_id=VALUES(member_id)`,
        [username, password, role, teacherId, memberId]
      );
    }
    console.log('✓ 演示账号角色已规范（admin / lin / chen / student1-3）');

    const [rows] = await conn.query('SELECT id,username,role,teacher_id,member_id FROM admin_users ORDER BY id');
    console.log('  当前账号：');
    for (const r of rows) {
      console.log(`    ${r.username.padEnd(10)} role=${String(r.role).padEnd(8)} teacher_id=${r.teacher_id ?? '-'} member_id=${r.member_id ?? '-'}`);
    }
    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
