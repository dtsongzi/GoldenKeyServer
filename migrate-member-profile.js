// 会员（学员）资料扩展：年龄 / 性别 / 微信 openid，支持小程序自助注册与微信快捷登录
// 可重复执行：node migrate-member-profile.js
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

async function ensureIndex(conn, table, indexName, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
    [table, indexName]
  );
  if (r[0].c === 0) {
    await conn.query(ddl);
    console.log(`✓ ${table}.${indexName} 索引已创建`);
  } else {
    console.log(`· ${table}.${indexName} 已存在`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await ensureColumn(conn, 'members', 'age', 'TINYINT UNSIGNED NULL COMMENT \'年龄\'');
    await ensureColumn(conn, 'members', 'gender', "VARCHAR(8) NULL COMMENT '男/女/保密'");
    await ensureColumn(conn, 'members', 'openid', "VARCHAR(64) NULL COMMENT '微信 openid（快捷登录用）'");
    await ensureColumn(conn, 'members', 'source', "VARCHAR(16) NOT NULL DEFAULT 'admin' COMMENT 'admin 后台录入 / self 小程序自助注册'");

    // openid 唯一（NULL 允许多行，MySQL 下唯一索引即可）
    await ensureIndex(conn, 'members', 'uk_members_openid', 'CREATE UNIQUE INDEX uk_members_openid ON members(openid)');

    const [rows] = await conn.query('SELECT COUNT(*) n FROM members');
    console.log(`  当前学员数：${rows[0].n}`);
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
