import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// 轻量 .env 加载（零依赖，避免新增 dotenv）
// 本地开发把数据库口令放进同目录 .env（已被 .gitignore 忽略，不会进仓库）
const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// 数据库连接参数支持两套变量名：
//   标准名（部署脚本/CI 用）：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
//   旧名（历史 .env 用）    ：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
// 标准名优先，都缺省时用下面代码里的默认值。
function pick(names, fallback) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return fallback;
}

const pool = mysql.createPool({
  host: pick(['MYSQL_HOST', 'DB_HOST'], '127.0.0.1'),
  port: Number(pick(['MYSQL_PORT', 'DB_PORT'], '3306')),
  user: pick(['MYSQL_USER', 'DB_USER'], 'root'),
  password: pick(['MYSQL_PASSWORD', 'DB_PASSWORD'], ''),
  database: pick(['MYSQL_DATABASE', 'DB_NAME'], 'goldenkey'),
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  dateStrings: true,
});

export default pool;
export { pool };
