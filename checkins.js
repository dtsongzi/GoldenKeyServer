// ================= 教师课程打卡 =================
// 数据源为排课管理的正式课次 lessons；打卡记录 lesson_checkins（一节课一次，幂等）。
// 打卡只允许对「当天」的课程操作（服务端强校验，防止绕过前端）。
// 教师只能看/打卡自己的课；管理员可指定 teacherId 查看任意教师。
import pool from './db.js';
import { adjustUsedHoursByLesson } from './semesters.js';

const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SELECT_LESSON = `
  SELECT l.id, l.course_id, COALESCE(l.title, c.title) AS title,
         l.teacher_id, t.name AS teacher_name, l.classroom_id, cr.name AS classroom_name,
         l.slot_date, l.start_time, l.end_time, l.lesson_status, l.remark,
         ck.id AS checkin_id, ck.checked_at, ck.note AS checkin_note
  FROM lessons l
  LEFT JOIN courses c ON c.id=l.course_id
  LEFT JOIN teachers t ON t.id=l.teacher_id
  LEFT JOIN classrooms cr ON cr.id=l.classroom_id
  LEFT JOIN lesson_checkins ck ON ck.lesson_id=l.id`;

// 作用教师：教师强制本人；管理员可指定 teacherId（未指定=不限制）
async function scopeTeacher(req, rawId) {
  if (req.user && req.user.role === 'admin') {
    const id = Number(rawId);
    return id ? id : null;
  }
  return req.user ? req.user.teacherId : null;
}

async function studentsOf(lessonIds) {
  const map = {};
  const uniq = [...new Set(lessonIds.map(Number).filter(Boolean))];
  if (!uniq.length) return map;
  const [rows] = await pool.query(
    `SELECT ls.lesson_id, m.id, m.name FROM lesson_students ls
     LEFT JOIN members m ON m.id=ls.member_id WHERE ls.lesson_id IN (?)`,
    [uniq]
  );
  rows.forEach((r) => {
    (map[r.lesson_id] || (map[r.lesson_id] = [])).push({ id: r.id, name: r.name || `学员${r.id}` });
  });
  return map;
}

async function listLessonsWithCheckin(req, { from, to, teacherId }) {
  const tid = await scopeTeacher(req, teacherId);
  let sql = `${SELECT_LESSON} WHERE 1=1`;
  const p = [];
  if (tid) { sql += ' AND l.teacher_id=?'; p.push(tid); }
  if (dateOk(from)) { sql += ' AND l.slot_date>=?'; p.push(from); }
  if (dateOk(to)) { sql += ' AND l.slot_date<=?'; p.push(to); }
  sql += ' ORDER BY l.slot_date, l.start_time, l.id';
  const [rows] = await pool.query(sql, p);
  const sm = await studentsOf(rows.map((r) => r.id));
  const today = todayStr();
  return rows.map((r) => ({
    ...r,
    checked: !!r.checkin_id,
    canCheckin: r.slot_date === today && r.lesson_status === 'normal' && !r.checkin_id,
    students: sm[r.id] || [],
  }));
}

export function mountCheckins(api, { authenticate, requireRole }) {
  const base = '/api/checkins';

  const teacherOnly = [authenticate, requireRole('teacher', 'admin')];

  // 打卡模块：区间内教师课程（含打卡状态、是否可打卡、学生）
  api.get(`${base}/lessons`, ...teacherOnly, async (req, res) => {
    res.json(await listLessonsWithCheckin(req, req.query));
  });

  // 执行打卡：只能对当天、本人（或管理员指定）的正常课次打卡；幂等
  api.post(base, ...teacherOnly, async (req, res) => {
    const b = req.body || {};
    const lessonId = Number(b.lessonId);
    if (!lessonId) return res.status(400).json({ error: '缺少课程 ID' });
    const [lesson] = await pool.query(
      'SELECT id, teacher_id, slot_date, lesson_status FROM lessons WHERE id=?', [lessonId]
    );
    if (!lesson.length) return res.status(404).json({ error: '课程不存在' });
    const l = lesson[0];
    // 权限：教师只能打自己的课；管理员不限
    if (req.user.role !== 'admin' && String(l.teacher_id) !== String(req.user.teacherId)) {
      return res.status(403).json({ error: '只能打卡本人的课程' });
    }
    if (l.slot_date !== todayStr()) return res.status(400).json({ error: '只能对当天的课程打卡' });
    if (l.lesson_status !== 'normal') return res.status(400).json({ error: '请假 / 停课的课程不能打卡' });

    // 幂等：UNIQUE(lesson_id)，重复提交直接返回已打卡
    const note = String(b.note || '').trim().slice(0, 255);
    try {
      const [r] = await pool.query(
        'INSERT INTO lesson_checkins (lesson_id, teacher_id, slot_date, note) VALUES (?,?,?,?)',
        [lessonId, l.teacher_id, l.slot_date, note || null]
      );
      // 打卡成功 = 这节课实际上了：按课时时长（结束-开始，小时）累加到每个上课学生的课程台账
      await adjustUsedHoursByLesson(lessonId, +1);
      res.json({ ok: true, id: r.insertId, already: false });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.json({ ok: true, already: true });
      throw e;
    }
  });

  // 撤销打卡（误操作兜底，教师本人或管理员）
  api.delete(`${base}/:lessonId`, ...teacherOnly, async (req, res) => {
    const lessonId = Number(req.params.lessonId);
    const rows = await pool.query(
      `SELECT ck.id, l.teacher_id FROM lesson_checkins ck
       JOIN lessons l ON l.id=ck.lesson_id WHERE ck.lesson_id=?`, [lessonId]
    );
    if (!rows[0].length) return res.json({ ok: true, removed: false });
    if (req.user.role !== 'admin' && String(rows[0][0].teacher_id) !== String(req.user.teacherId)) {
      return res.status(403).json({ error: '只能撤销本人的打卡' });
    }
    await pool.query('DELETE FROM lesson_checkins WHERE lesson_id=?', [lessonId]);
    // 撤销打卡：回滚刚才累加的课时
    await adjustUsedHoursByLesson(lessonId, -1);
    res.json({ ok: true, removed: true });
  });

  // 打卡统计：月份汇总 + 每日分布 + 打卡明细（天视图按 date 过滤 details）
  api.get(`${base}/stats`, ...teacherOnly, async (req, res) => {
    const month = String(req.query.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '请提供有效的月份 YYYY-MM' });
    const tid = await scopeTeacher(req, req.query.teacherId);
    const from = `${month}-01`;
    // 月份最后一天：不能写死 31（如 11 月只有 30 天，MySQL 会直接报错）
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${month}-${String(lastDay).padStart(2, '0')}`;
    const rows = await listLessonsWithCheckin(req, { from, to, teacherId: req.query.teacherId });

    const byDay = {};
    let total = 0, checked = 0;
    rows.forEach((r) => {
      total += 1;
      if (r.checked) checked += 1;
      const d = r.slot_date;
      if (!byDay[d]) byDay[d] = { date: d, total: 0, checked: 0 };
      byDay[d].total += 1;
      if (r.checked) byDay[d].checked += 1;
    });
    const detailDate = dateOk(req.query.date) ? req.query.date : '';
    // 明细列出所选日期（或整月）的全部课程，逐节标注打卡/未打卡状态（不再只返回已打卡）
    const details = rows
      .filter((r) => !detailDate || r.slot_date === detailDate)
      .map((r) => ({
        lessonId: r.id, date: r.slot_date, start_time: r.start_time, end_time: r.end_time,
        title: r.title, teacher_name: r.teacher_name, classroom_name: r.classroom_name,
        checked: !!r.checked, canCheckin: !!r.canCheckin, lesson_status: r.lesson_status,
        checked_at: r.checked_at, note: r.checkin_note,
        students: r.students,
      }));

    res.json({
      month,
      summary: { total, checked, unchecked: total - checked, rate: total ? Math.round(checked * 100 / total) : 0 },
      days: Object.keys(byDay).sort().map((k) => byDay[k]),
      details,
    });
  });
}
