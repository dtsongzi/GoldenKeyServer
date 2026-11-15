// ================= 小程序数据 → 排课管理「课程实例」实时同步 =================
// 背景：排课管理页读的是 lessons 表，而小程序教师端开放的「可约时段」在 availability、
// 学员预约在 bookings，三张表原本只在首次迁移时导入过一次，之后小程序里的新增/修改/删除
// 都不会反映到网站课表，导致两边「时间段和数量对不上」。
//
// 这里把 availability / bookings 幂等地镜像进 lessons：
//   · 只处理 origin_kind in ('availability','booking') 的镜像记录
//   · 网站自己排的课（origin_kind IS NULL）完全不受影响
//   · 可重复调用，并发调用安全（uk_origin 唯一键兜底）
import pool from './db.js';

// 有效预约：1 待上课 / 2 已确认 / 4 已完成；3 = 已取消
const ACTIVE_BOOKING = 'b.status <> 3';

export async function syncLessonsFromApp() {
  const conn = await pool.getConnection();
  const stat = {
    addedSlots: 0, updatedSlots: 0, removedSlots: 0,
    addedBookings: 0, removedBookings: 0, deduped: 0,
  };
  try {
    // 1) 可约时段 → 课程实例
    //    已被有效预约覆盖的时段先跳过，交给第 2 步生成「带学生的课」，避免同一时段两条记录
    const [ins1] = await conn.query(`
      INSERT INTO lessons (origin_kind, origin_id, source, course_id, title, teacher_id,
                           classroom_id, slot_date, start_time, end_time, lesson_status)
      SELECT 'availability', a.id, 'single', a.course_id, COALESCE(c.title, '可约时段'), a.teacher_id,
             a.classroom_id, a.slot_date, a.start_time, a.end_time, 'normal'
      FROM availability a LEFT JOIN courses c ON c.id = a.course_id
      WHERE NOT EXISTS (SELECT 1 FROM lessons l WHERE l.origin_kind='availability' AND l.origin_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE ${ACTIVE_BOOKING}
          AND b.teacher_id=a.teacher_id AND b.slot_date=a.slot_date
          AND b.start_time=a.start_time AND b.end_time=a.end_time)
    `);
    stat.addedSlots = ins1.affectedRows || 0;

    // 2) 有效预约 → 课程实例
    const [ins2] = await conn.query(`
      INSERT INTO lessons (origin_kind, origin_id, source, course_id, title, teacher_id,
                           classroom_id, slot_date, start_time, end_time, lesson_status, remark)
      SELECT 'booking', b.id, 'single', b.course_id, c.title, b.teacher_id,
             b.classroom_id, b.slot_date, b.start_time, b.end_time, 'normal', b.remark
      FROM bookings b LEFT JOIN courses c ON c.id = b.course_id
      WHERE ${ACTIVE_BOOKING}
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.origin_kind='booking' AND l.origin_id=b.id)
    `);
    stat.addedBookings = ins2.affectedRows || 0;

    // 3) 补齐预约课的学生：**只补不删**
    //    网站上人工给某节课加的学生（比如旁听、补课）不能被同步清掉，
    //    否则「在网站改了学生、保存后刷新又变回去」。
    //    · 小程序里换人（teacher/assign）由那边负责把旧学生从镜像课移除
    //    · 取消预约时镜像课会整个删掉，不依赖这里清理
    await conn.query(`
      INSERT IGNORE INTO lesson_students (lesson_id, member_id)
      SELECT l.id, b.member_id FROM lessons l
      JOIN bookings b ON b.id=l.origin_id AND l.origin_kind='booking'
      WHERE ${ACTIVE_BOOKING} AND b.member_id IS NOT NULL
    `);

    // 4) 时段被删除、预约被取消 → 删掉镜像课程
    const [del1] = await conn.query(`
      DELETE l FROM lessons l
      LEFT JOIN availability a ON l.origin_kind='availability' AND a.id=l.origin_id
      WHERE l.origin_kind='availability' AND a.id IS NULL
    `);
    const [del2] = await conn.query(`
      DELETE l FROM lessons l
      LEFT JOIN bookings b ON l.origin_kind='booking' AND b.id=l.origin_id
      WHERE l.origin_kind='booking' AND (b.id IS NULL OR b.status = 3)
    `);
    stat.removedSlots = del1.affectedRows || 0;
    stat.removedBookings = del2.affectedRows || 0;

    // 5) 时段字段被改过（小程序里拖动改时间 = 删旧插新，但教室/课程可能原地改）→ 以 availability 为准
    const [upd] = await conn.query(`
      UPDATE lessons l
      JOIN availability a ON l.origin_kind='availability' AND a.id=l.origin_id
      LEFT JOIN courses c ON c.id = a.course_id
      SET l.slot_date=a.slot_date, l.start_time=a.start_time, l.end_time=a.end_time,
          l.course_id=a.course_id, l.classroom_id=a.classroom_id, l.teacher_id=a.teacher_id,
          l.title=COALESCE(c.title, l.title, '可约时段')
      WHERE l.slot_date<>a.slot_date OR l.start_time<>a.start_time OR l.end_time<>a.end_time
         OR NOT (l.course_id <=> a.course_id) OR NOT (l.classroom_id <=> a.classroom_id)
         OR NOT (l.teacher_id <=> a.teacher_id)
    `);
    stat.updatedSlots = upd.affectedRows || 0;

    // 6) 同一时段既有「时段镜像」又有「预约课」→ 只保留带学生的那条
    const [dup] = await conn.query(`
      DELETE la FROM lessons la
      JOIN lessons lb ON lb.origin_kind='booking'
        AND lb.teacher_id=la.teacher_id AND lb.slot_date=la.slot_date
        AND lb.start_time=la.start_time AND lb.end_time=la.end_time
      WHERE la.origin_kind='availability'
    `);
    stat.deduped = dup.affectedRows || 0;

    return stat;
  } finally {
    conn.release();
  }
}

// 供写接口用：失败了也不能影响主流程，只打日志
export function syncLessonsQuietly(tag = '') {
  return syncLessonsFromApp()
    .then((s) => {
      const changed = Object.values(s).some((n) => n > 0);
      if (changed) console.log(`[sync:lessons${tag ? ' ' + tag : ''}]`, JSON.stringify(s));
    })
    .catch((e) => console.warn('[sync:lessons] 跳过：', e.message));
}
