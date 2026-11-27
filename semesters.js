// ================= 学期 + 学生课程课时 =================
// 学期：每年上下两学期，管理员创建并指定日期范围；同一时刻仅一个「当前学期」。
// 课时：课程属性 hours（与学期无关）；每名学生每门课一条台账（总课时 / 已上课时，单位小时）。
//       报名审核通过时初始化台账；教师打卡时按该节课时长累加已上课时；管理员/教师可手动修正。
import pool from './db.js';

const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const num = (v) => (v === '' || v == null ? null : Number(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 当前学期：优先取 is_current=1；没有时退回「今天所在且启用」的学期；再没有取最近的一个启用学期
export async function currentSemester() {
  const [rows] = await pool.query(
    `SELECT * FROM semesters WHERE status=1
     ORDER BY is_current DESC,
              CASE WHEN CURDATE() BETWEEN start_date AND end_date THEN 0 ELSE 1 END,
              start_date DESC LIMIT 1`
  );
  return rows[0] || null;
}

// 解析某日期所属学期（排课越界校验用）。
// 指定 semesterId 时：必须存在、启用，且日期落在该学期范围内。
// 未指定时：日期必须落在某个启用学期范围内；没有学期则拒绝排课，需管理员先创建。
export async function resolveSemesterSlot(slotDate, givenId) {
  const [all] = await pool.query('SELECT id,name,start_date,end_date,status FROM semesters ORDER BY start_date');
  const enabled = all.filter((s) => s.status === 1);
  if (!enabled.length) return { ok: false, error: '尚未创建学期，请先在「学期管理」创建学期后再排课' };

  if (givenId != null && givenId !== '') {
    const s = enabled.find((x) => String(x.id) === String(givenId));
    if (!s) return { ok: false, error: '所选学期不存在或已停用' };
    if (!dateOk(slotDate) || slotDate < s.start_date || slotDate > s.end_date) {
      return { ok: false, error: `上课日期需在该学期范围内（${s.start_date} ~ ${s.end_date}）` };
    }
    return { ok: true, semester_id: s.id };
  }

  const hit = enabled.find((s) => dateOk(slotDate) && slotDate >= s.start_date && slotDate <= s.end_date);
  if (!hit) {
    return { ok: false, error: '上课日期超出所有学期范围，请先创建对应学期或调整日期' };
  }
  return { ok: true, semester_id: hit.id };
}

// 报名审核通过时初始化课时台账：总课时取课程 hours，已上课时置 0。
// 已存在台账则只补总课时（若仍为 0），不覆盖老师已经改过的课时。
export async function ensureCourseHours(memberId, courseId) {
  if (!memberId || !courseId) return;
  const [c] = await pool.query('SELECT hours FROM courses WHERE id=?', [courseId]);
  const hours = round2(c[0]?.hours || 0);
  await pool.query(
    `INSERT INTO student_course_hours (member_id,course_id,total_hours,used_hours)
     VALUES (?,?,?,0)
     ON DUPLICATE KEY UPDATE total_hours = CASE WHEN total_hours=0 THEN VALUES(total_hours) ELSE total_hours END`,
    [memberId, courseId, hours]
  );
}

// 打卡 / 撤销打卡时增减已上课时（单位小时）：按该节课的时长累加到每个上课学生的课程台账。
// delta > 0 累加，delta < 0 回滚；返回受影响的学生数。
export async function adjustUsedHoursByLesson(lessonId, direction) {
  const [rows] = await pool.query(
    `SELECT l.id, l.course_id, l.slot_date, l.start_time, l.end_time
     FROM lessons l WHERE l.id=?`, [lessonId]
  );
  if (!rows.length) return 0;
  const l = rows[0];
  if (!l.course_id) return 0; // 没有归属课程，无法归集课时
  const [dur] = await pool.query(
    'SELECT ROUND(TIME_TO_SEC(TIMEDIFF(end_time,start_time))/3600, 2) AS h FROM lessons WHERE id=?', [lessonId]
  );
  const hours = round2(dur[0]?.h || 0);
  if (hours <= 0) return 0;
  const [stu] = await pool.query('SELECT member_id FROM lesson_students WHERE lesson_id=?', [lessonId]);
  const members = stu.map((r) => r.member_id).filter(Boolean);
  if (!members.length) return 0;
  const delta = direction >= 0 ? hours : -hours;
  for (const memberId of members) {
    await pool.query(
      `INSERT INTO student_course_hours (member_id,course_id,total_hours,used_hours)
       VALUES (?,?,0,GREATEST(?,0))
       ON DUPLICATE KEY UPDATE used_hours = GREATEST(ROUND(used_hours + ?, 2), 0)`,
      [memberId, l.course_id, delta, delta]
    );
  }
  return members.length;
}

// 学生端课时视图：已上 / 剩余（小时）
async function hoursView(rows) {
  return rows.map((r) => ({
    ...r,
    total_hours: round2(r.total_hours),
    used_hours: round2(r.used_hours),
    remaining_hours: round2(Math.max(round2(r.total_hours) - round2(r.used_hours), 0)),
    hours_text: `${round2(r.used_hours)} / ${round2(Math.max(round2(r.total_hours) - round2(r.used_hours), 0))} 课时`,
  }));
}

export function mountSemesters(api, { authenticate, requireRole }) {
  const adminOnly = [authenticate, requireRole('admin')];
  const staff = [authenticate, requireRole('admin', 'teacher')];

  // ---- 学期：列表 / 当前学期（学员展示标签用，公开） ----
  api.get('/api/semesters', async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM semesters ORDER BY start_date DESC, id DESC');
    res.json(rows);
  });
  api.get('/api/semesters/current', async (req, res) => {
    res.json(await currentSemester());
  });

  // ---- 学期管理（管理员） ----
  api.get('/api/admin/semesters', ...adminOnly, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM lessons l WHERE l.semester_id=s.id) AS lesson_count
       FROM semesters s ORDER BY s.start_date DESC, s.id DESC`
    );
    res.json(rows);
  });

  api.post('/api/admin/semesters', ...adminOnly, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const term = Number(b.term) === 2 ? 2 : 1;
    if (!name) return res.status(400).json({ error: '请填写学期名称' });
    if (!dateOk(b.start_date) || !dateOk(b.end_date)) return res.status(400).json({ error: '请选择有效的起止日期' });
    if (b.start_date > b.end_date) return res.status(400).json({ error: '结束日期不能早于开始日期' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (b.is_current) await conn.query('UPDATE semesters SET is_current=0');
      const [r] = await conn.query(
        `INSERT INTO semesters (name,term,start_date,end_date,status,is_current,remark)
         VALUES (?,?,?,?,?,?,?)`,
        [name, term, b.start_date, b.end_date, b.status === 0 ? 0 : 1, b.is_current ? 1 : 0, String(b.remark || '').trim() || null]
      );
      await conn.commit();
      res.json({ ok: true, id: r.insertId });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  });

  api.put('/api/admin/semesters/:id', ...adminOnly, async (req, res) => {
    const b = req.body || {};
    const id = Number(req.params.id);
    if (!dateOk(b.start_date) || !dateOk(b.end_date)) return res.status(400).json({ error: '请选择有效的起止日期' });
    if (b.start_date > b.end_date) return res.status(400).json({ error: '结束日期不能早于开始日期' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (b.is_current) await conn.query('UPDATE semesters SET is_current=0');
      await conn.query(
        `UPDATE semesters SET name=?,term=?,start_date=?,end_date=?,status=?,is_current=?,remark=? WHERE id=?`,
        [String(b.name || '').trim(), Number(b.term) === 2 ? 2 : 1, b.start_date, b.end_date,
         b.status === 0 ? 0 : 1, b.is_current ? 1 : 0, String(b.remark || '').trim() || null, id]
      );
      await conn.commit();
      res.json({ ok: true });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  });

  api.post('/api/admin/semesters/:id/current', ...adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE semesters SET is_current=0');
      const [r] = await conn.query('UPDATE semesters SET is_current=1 WHERE id=? AND status=1', [id]);
      await conn.commit();
      if (!r.affectedRows) return res.status(400).json({ error: '学期不存在或已停用' });
      res.json({ ok: true });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  });

  api.delete('/api/admin/semesters/:id', ...adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    const [used] = await pool.query('SELECT COUNT(*) AS c FROM lessons WHERE semester_id=?', [id]);
    if (used[0]?.c) return res.status(400).json({ error: `该学期下已有 ${used[0].c} 节课，不能删除` });
    await pool.query('DELETE FROM semesters WHERE id=?', [id]);
    res.json({ ok: true });
  });

  // ---- 学生课程课时台账（管理员 / 教师） ----
  api.get('/api/admin/course-hours', ...staff, async (req, res) => {
    const where = ['1=1'];
    const p = [];
    if (req.query.memberId) { where.push('h.member_id=?'); p.push(Number(req.query.memberId)); }
    if (req.query.courseId) { where.push('h.course_id=?'); p.push(Number(req.query.courseId)); }
    if (req.user.role === 'teacher') { where.push('c.teacher_id=?'); p.push(req.user.teacherId); }
    const [rows] = await pool.query(
      `SELECT h.*, m.name AS member_name, m.phone AS member_phone,
              c.title AS course_title, c.hours AS course_hours, t.name AS teacher_name
       FROM student_course_hours h
       JOIN members m ON m.id=h.member_id
       JOIN courses c ON c.id=h.course_id
       LEFT JOIN teachers t ON t.id=c.teacher_id
       WHERE ${where.join(' AND ')} ORDER BY m.name, c.title`, p
    );
    res.json(await hoursView(rows));
  });

  api.put('/api/admin/course-hours/:memberId/:courseId', ...staff, async (req, res) => {
    const memberId = Number(req.params.memberId);
    const courseId = Number(req.params.courseId);
    const b = req.body || {};
    if (b.total_hours == null && b.used_hours == null) return res.status(400).json({ error: '请提供总课时或已上课时' });
    if (req.user.role === 'teacher') {
      const [own] = await pool.query('SELECT teacher_id FROM courses WHERE id=?', [courseId]);
      if (!own.length || String(own[0].teacher_id) !== String(req.user.teacherId)) {
        return res.status(403).json({ error: '只能修改自己名下课程的课时' });
      }
    }
    const sets = [];
    const vals = [];
    if (b.total_hours != null) {
      const v = Number(b.total_hours);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: '总课时须为非负数字' });
      sets.push('total_hours=?'); vals.push(round2(v));
    }
    if (b.used_hours != null) {
      const v = Number(b.used_hours);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: '已上课时须为非负数字' });
      sets.push('used_hours=?'); vals.push(round2(v));
    }
    // 台账不存在则先补一条（总课时取课程默认值），再按传入字段更新，避免 INSERT 占位值与 SET 参数错位
    await pool.query(
      `INSERT INTO student_course_hours (member_id,course_id,total_hours,used_hours)
       SELECT ?,?,COALESCE(hours,0),0 FROM courses WHERE id=?
       ON DUPLICATE KEY UPDATE member_id=member_id`,
      [memberId, courseId, courseId]
    );
    await pool.query(
      `UPDATE student_course_hours SET ${sets.join(',')} WHERE member_id=? AND course_id=?`,
      [...vals, memberId, courseId]
    );
    const [rows] = await pool.query(
      `SELECT h.*, m.name AS member_name, c.title AS course_title FROM student_course_hours h
       JOIN members m ON m.id=h.member_id JOIN courses c ON c.id=h.course_id
       WHERE h.member_id=? AND h.course_id=?`, [memberId, courseId]
    );
    res.json((await hoursView(rows))[0]);
  });

  // ---- 学员端：我的课程课时 ----
  api.get('/api/app/my/course-hours', authenticate, requireRole('student'), async (req, res) => {
    const [rows] = await pool.query(
      `SELECT h.*, c.title AS course_title, c.category, t.name AS teacher_name
       FROM student_course_hours h
       JOIN courses c ON c.id=h.course_id
       LEFT JOIN teachers t ON t.id=c.teacher_id
       WHERE h.member_id=? ORDER BY c.title`, [req.user.memberId]
    );
    res.json(await hoursView(rows));
  });
}
