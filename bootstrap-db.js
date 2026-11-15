// 部署引导：新库（空库）先把表结构建出来，并确保有一个能登录商家端的账号
// 用法：node bootstrap-db.js
// 可重复执行：表已存在就跳过；管理员已存在就不动密码
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function hasTable(conn, name) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [name]
  );
  return r[0].c > 0;
}

/** 把 schema.sql 拆成一条条语句执行（schema.sql 里没有存储过程，按分号拆是安全的） */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line)) // 整行注释直接丢掉
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run() {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable(conn, 'admin_users'))) {
      const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
      const statements = splitStatements(sql);
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      console.log(`✓ 空库：已按 schema.sql 建表（${statements.length} 条语句）`);
    } else {
      console.log('✓ 表结构已存在，跳过建表');
    }

    // 商家端需要至少一个可登录账号；账号本身的角色/归属由 migrate-admin-roles.js 规范
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const [u] = await conn.query('SELECT id FROM admin_users WHERE username=?', [username]);
    if (u.length) {
      console.log(`✓ 管理员账号 ${username} 已存在，未改动密码`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log('  提示：可用 ADMIN_PASSWORD 环境变量指定初始密码');
      }
    } else {
      await conn.query('INSERT INTO admin_users (username, password) VALUES (?,?)', [username, password]);
      if (process.env.ADMIN_PASSWORD) {
        console.log(`✓ 已创建管理员账号 ${username}（密码来自 ADMIN_PASSWORD）`);
      } else {
        console.log(`! 已创建管理员账号 ${username} / ${password}（默认口令，请尽快修改）`);
      }
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('引导失败:', e.code || '', e.sqlMessage || e.message);
  process.exit(1);
});
