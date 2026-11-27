// ============================================================
// 服务环境前置部署脚本（开发阶段唯一入口）
// 作用：DROP 现有全部表 → 按 schema.sql 重建最新结构 → 建管理员账号。
// 说明：
//   - 开发阶段不需要增量迁移，结构永远以 schema.sql 为准，每次执行得到干净的库。
//   - 不灌任何业务演示数据（教师/课程/学员/时段等由后台自行录入）。
//   - 仅创建 1 个可登录的管理员账号，否则系统无法进入后台。
// 用法：
//   node setup.js                      # 用默认 admin / admin123
//   ADMIN_USERNAME=xx ADMIN_PASSWORD=yy node setup.js
//   MYSQL_DATABASE=xxx node setup.js   # 指定库（须已存在）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 把 schema.sql 拆成一条条语句（无存储过程，按分号拆安全；丢掉整行注释） */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run() {
  const conn = await pool.getConnection();
  try {
    // 1) 关闭外键检查，DROP 全部业务表（按依赖顺序无所谓，FK 检查已关）
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`
    );
    const names = tables.map((r) => r.TABLE_NAME);
    for (const name of names) {
      await conn.query(`DROP TABLE IF EXISTS \`${name}\``);
    }
    console.log(`✓ 已 DROP ${names.length} 张表${names.length ? '：' + names.join(', ') : '（空库）'}`);

    // 2) 按 schema.sql 重建全部表
    const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    console.log(`✓ 已按 schema.sql 重建 ${statements.length} 条建表语句`);

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // 3) 创建管理员账号（系统可登录的最低要求，不属于演示数据）
    const username = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
    const password = String(process.env.ADMIN_PASSWORD || 'admin123');
    await conn.query(
      'INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)',
      [username, password, 'admin']
    );
    if (process.env.ADMIN_PASSWORD) {
      console.log(`✓ 已创建管理员账号 ${username}（密码来自 ADMIN_PASSWORD）`);
    } else {
      console.log(`! 已创建管理员账号 ${username} / ${password}（默认口令，请尽快修改）`);
    }

    // 4) 校验关键表都在
    const [check] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`
    );
    console.log(`✓ 前置部署完成，当前库共 ${check[0].c} 张表（业务数据为空，可在后台录入）`);
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('前置部署失败:', e.code || '', e.sqlMessage || e.message);
  process.exit(1);
});
