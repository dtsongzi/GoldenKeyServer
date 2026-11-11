// 初始化示例数据 + 生成未来 14 天可用时段
import pool from './db.js';

const STUDIO_INTRO = `GoldenKey 钢琴工作室成立于 2018 年，专注于古典与流行钢琴教学。
我们为每位学员定制专属学习路径，从启蒙到考级、演出一站式陪伴。
工作室配备两间专业隔音琴房、三台九尺演奏钢琴，氛围安静专注。`;

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 工作室
    await conn.query(
      `INSERT INTO studio_profile (id, name, intro, address, phone, business_hours)
       VALUES (1, 'GoldenKey 钢琴工作室', ?, '上海市徐汇区复兴中路 1199 号', '021-6666-8888', '周二至周日 10:00 - 21:00')
       ON DUPLICATE KEY UPDATE name=VALUES(name), intro=VALUES(intro), address=VALUES(address)`,
      [STUDIO_INTRO]
    );

    // 教师
    const [t] = await conn.query(
      `INSERT INTO teachers (name, title, bio) VALUES
        ('林晚晴', '主理人 / 资深钢琴教师', '上海音乐学院硕士，12 年教学经验，擅长古典与演奏级辅导。'),
        ('陈牧之', '钢琴教师', '毕业于伯克利音乐学院，流行与即兴伴奏方向。')
       ON DUPLICATE KEY UPDATE id=id`
    );
    const teacherRows = await conn.query('SELECT id FROM teachers ORDER BY id');
    const teacherIds = teacherRows[0].map(r => r.id);

    // 课程
    await conn.query(
      `INSERT INTO courses (title, category, description, price, duration_min, teacher_id, sort) VALUES
        ('一对一钢琴启蒙课', '启蒙', '适合零基础学员，培养兴趣与手型基础。', 280.00, 60, ?, 1),
        ('考级专项辅导', '考级', '针对音协 / 英皇考级的曲目精修与视奏训练。', 380.00, 60, ?, 2),
        ('流行钢琴即兴', '流行', '和弦套路、伴奏织体与即兴演奏，弹你爱听的歌。', 320.00, 60, ?, 3),
        ('成人放松弹奏', '兴趣', '不考级不焦虑，纯粹享受弹琴的放松时光。', 260.00, 60, ?, 4)
       ON DUPLICATE KEY UPDATE id=id`,
      [teacherIds[0], teacherIds[0], teacherIds[1], teacherIds[0]]
    );

    // 会员
    const [m] = await conn.query(
      `INSERT INTO members (name, phone, balance) VALUES
        ('苏小满', '13800000001', 1200.00),
        ('周予安', '13800000002', 600.00),
        ('李慕白', '13800000003', 2400.00)
       ON DUPLICATE KEY UPDATE id=id`
    );
    const memberRows = await conn.query('SELECT id FROM members ORDER BY id');
    const memberIds = memberRows[0].map(r => r.id);
    const courseRows = await conn.query('SELECT id FROM courses ORDER BY id');
    const courseIds = courseRows[0].map(r => r.id);

    // 生成未来 14 天可用时段（10:00 - 21:00，每小时一段，周末全开，工作日 17 点后）
    const slots = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const day = addDays(today, i);
      const dow = day.getDay(); // 0 周日 6 周六
      const isWeekend = dow === 0 || dow === 6;
      for (let h = 10; h < 21; h++) {
        if (!isWeekend && h < 17) continue; // 工作日仅晚间
        const teacherId = ((h + i) % teacherIds.length) + 1;
        slots.push([teacherId, fmtDate(day), `${String(h).padStart(2,'0')}:00:00`, `${String(h+1).padStart(2,'0')}:00:00`, 1]);
      }
    }
    if (slots.length) {
      await conn.query(
        `INSERT INTO availability (teacher_id, slot_date, start_time, end_time, status)
         VALUES ? ON DUPLICATE KEY UPDATE status=VALUES(status)`,
        [slots]
      );
    }

    // 几条历史上课记录 + 预约 + 消息
    const recDate = fmtDate(addDays(today, -7));
    await conn.query(
      `INSERT INTO class_records (member_id, course_id, teacher_id, class_date, start_time, end_time, status) VALUES
        (?, ?, ?, ?, '10:00:00', '11:00:00', 1),
        (?, ?, ?, ?, '14:00:00', '15:00:00', 1)`,
      [memberIds[0], courseIds[0], teacherIds[0], recDate, memberIds[1], courseIds[1], teacherIds[0], recDate]
    );

    await conn.query(
      `INSERT INTO bookings (member_id, course_id, teacher_id, slot_date, start_time, end_time, status) VALUES
        (?, ?, ?, ?, '10:00:00', '11:00:00', 2)`,
      [memberIds[2], courseIds[2], teacherIds[1], fmtDate(addDays(today, 3))]
    );

    await conn.query(
      `INSERT INTO messages (member_id, type, title, content, related_id, is_read) VALUES
        (?, 'booking_success', '预约成功', '您预约的流行钢琴即兴已确认，时间 3 天后 10:00。', 1, 0),
        (?, 'booking_reminder', '约课提醒', '您明天有一节钢琴课，记得准时到课哦~', NULL, 0)`
      ,
      [memberIds[2], memberIds[0]]
    );

    // 后台用户
    await conn.query(
      `INSERT INTO admin_users (username, password) VALUES ('admin', 'admin123')
       ON DUPLICATE KEY UPDATE id=id`
    );

    await conn.commit();
    console.log(`✅ 种子数据完成：教师 ${teacherIds.length} / 课程 ${courseIds.length} / 会员 ${memberIds.length} / 可用时段 ${slots.length}`);
  } catch (e) {
    await conn.rollback();
    console.error('❌ 种子数据失败:', e.message);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

run();
