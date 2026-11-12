// 教室（琴房）迁移：新增 classrooms 表，并给排课/预约/上课记录增加 classroom_id
// 可重复执行：node migrate-classroom.js
import pool from './db.js';

async function ensureColumn(conn, table, name, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, name]
  );
  if (r[0].c === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    console.log(`✓ ${table}.${name} 已补齐`);
  }
}

async function ensureIndex(conn, table, indexName, ddl) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
    [table, indexName]
  );
  if (r[0].c === 0) {
    await conn.query(`ALTER TABLE ${table} ADD ${ddl}`);
    console.log(`✓ ${table} 索引 ${indexName} 已补齐`);
  }
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS classrooms (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL COMMENT '教室/琴房名称',
        capacity INT NOT NULL DEFAULT 1 COMMENT '同时容纳人数',
        status TINYINT NOT NULL DEFAULT 1 COMMENT '1可用 0停用',
        sort INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教室/琴房'
    `);
    console.log('✓ classrooms 表就绪');

    const [c] = await conn.query('SELECT COUNT(*) c FROM classrooms');
    if (c[0].c === 0) {
      await conn.query('INSERT INTO classrooms (name, capacity, status, sort) VALUES ?', [[
        ['琴房 A', 1, 1, 1],
        ['琴房 B', 1, 1, 2],
        ['琴房 C', 1, 1, 3],
      ]]);
      console.log('✓ 已写入默认教室：琴房 A / B / C');
    }

    await ensureColumn(conn, 'availability', 'classroom_id', 'INT NULL COMMENT \'排课指定教室\'');
    await ensureColumn(conn, 'bookings', 'classroom_id', 'INT NULL COMMENT \'预约教室（随排课带入）\'');
    await ensureColumn(conn, 'class_records', 'classroom_id', 'INT NULL COMMENT \'上课教室\'');

    await ensureIndex(conn, 'availability', 'idx_room_time', 'KEY idx_room_time (classroom_id, slot_date, start_time)');
    await ensureIndex(conn, 'bookings', 'idx_room_time', 'KEY idx_room_time (classroom_id, slot_date, start_time)');

    const [rooms] = await conn.query('SELECT id,name,capacity,status FROM classrooms ORDER BY sort,id');
    console.log('  当前教室：', rooms.map((r) => `${r.id}:${r.name}`).join('  '));
    console.log('\n迁移完成。');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
