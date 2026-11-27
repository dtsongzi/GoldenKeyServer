// ================= 排课管理：课程实例（lessons） =================
// 网站排课的单一数据源，与 availability/bookings（小程序预约）各自独立、互不同步。
// 一节课 = 一位教师 + 一间教室 + 多位学生；支持循环系列、状态标签、学期约束、冲突预检。
import pool from './db.js';
import { resolveSemesterSlot } from './semesters.js';

const STATUS = { normal: '正常', leave: '请假', suspended: '停课' };
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

const minOf = (t) => {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const normTime = (t) => {
  const s = String(t || '').trim();
  if (!s) return '';
  return s.length === 5 ? `${s}:00` : s.slice(0, 8);
};
const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const validRange = (s, e) => normTime(s) && normTime(e) && minOf(e) > minOf(s);
const numOrNull = (v) => (v === '' || v == null ? null : Number(v) || null);

function weekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `周${WEEK_CN[d.getDay()]}`;
}

// ---------- 学生关联 ----------
async function studentsMap(ids) {
  const map = {};
  const uniq = [...new Set(ids.map(Number).filter(Boolean))];
  if (!uniq.length) return map;
  const rows = await pool.query(
    `SELECT ls.lesson_id, ls.member_id, m.name FROM lesson_students ls
     LEFT JOIN members m ON m.id=ls.member_id WHERE ls.lesson_id IN (?)`,
    [uniq]
  ).then(([r]) => r);
  rows.forEach((r) => {
    (map[r.lesson_id] ||= []).push({ id: r.member_id, name: r.name || `学员${r.member_id}` });
  });
  return map;
}

async function setStudents(conn, lessonId, ids) {
  await conn.query('DELETE FROM lesson_students WHERE lesson_id=?', [lessonId]);
  const uniq = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (uniq.length) {
    await conn.query('INSERT INTO lesson_students (lesson_id, member_id) VALUES ?',
      [uniq.map((id) => [lessonId, id])]);
  }
}

// ---------- 查询 ----------
const SELECT_LESSON = `
  SELECT l.id, l.series_id, l.source, l.semester_id, s.name AS semester_name,
         l.course_id, COALESCE(l.title, c.title) AS title,
         l.teacher_id, t.name AS teacher_name, l.classroom_id, cr.name AS classroom_name,
         l.slot_date, l.start_time, l.end_time, l.remark, l.lesson_status
  FROM lessons l
  LEFT JOIN courses c ON c.id=l.course_id
  LEFT JOIN teachers t ON t.id=l.teacher_id
  LEFT JOIN classrooms cr ON cr.id=l.classroom_id
  LEFT JOIN semesters s ON s.id=l.semester_id`;

async function listLessons(req, { from, to, teacherId, classroomId, studentId, status, semesterId }) {
  let sql = `${SELECT_LESSON} WHERE 1=1`;
  const p = [];
  if (dateOk(from)) { sql += ' AND l.slot_date >= ?'; p.push(from); }
  if (dateOk(to)) { sql += ' AND l.slot_date <= ?'; p.push(to); }
  if (semesterId) { sql += ' AND l.semester_id = ?'; p.push(Number(semesterId)); }
  if (req.user.role === 'teacher') { sql += ' AND l.teacher_id = ?'; p.push(req.user.teacherId); }
  else if (teacherId) { sql += ' AND l.teacher_id = ?'; p.push(Number(teacherId)); }
  if (classroomId) { sql += ' AND l.classroom_id = ?'; p.push(Number(classroomId)); }
  if (studentId) {
    sql += ' AND EXISTS (SELECT 1 FROM lesson_students ls WHERE ls.lesson_id=l.id AND ls.member_id=?)';
    p.push(Number(studentId));
  }
  if (status) { sql += ' AND l.lesson_status = ?'; p.push(status); }
  sql += ' ORDER BY l.slot_date, l.start_time, l.id';
  const rows = await pool.query(sql, p).then(([r]) => r);
  const sm = await studentsMap(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, students: sm[r.id] || [] }));
}

// ---------- 冲突检测 ----------
// 资源互斥：同日期、时间重叠、(教师相同 或 教室相同) 视为冲突；学生不参与强约束。
function conflictKind(a, b) {
  if (a.slot_date !== b.slot_date) return null;
  if (!(minOf(a.start_time) < minOf(b.end_time) && minOf(b.start_time) < minOf(a.end_time))) return null;
  const sameTeacher = a.teacher_id != null && String(a.teacher_id) === String(b.teacher_id);
  const sameRoom = a.classroom_id != null && String(a.classroom_id) === String(b.classroom_id);
  if (sameTeacher && sameRoom) return 'both';
  if (sameTeacher) return 'teacher';
  if (sameRoom) return 'room';
  return null;
}

function describeConflict(kind, c, b) {
  const who = kind === 'teacher' ? `教师「${b.teacher_name || '未指定'}」` : `教室「${b.classroom_name || '未指定'}」`;
  return {
    date: c.slot_date, week: weekOf(c.slot_date),
    time: `${normTime(c.start_time).slice(0, 5)}-${normTime(c.end_time).slice(0, 5)}`,
    kind, typeText: kind === 'teacher' ? '教师时间冲突' : kind === 'room' ? '教室时间冲突' : '教师与教室均冲突',
    detail: `${who}在 ${normTime(b.start_time).slice(0, 5)}-${normTime(b.end_time).slice(0, 5)} 已有「${b.title || '课程'}」`,
    withId: b.id, withTitle: b.title || '', withTeacher: b.teacher_name || '', withRoom: b.classroom_name || '',
    withTeacherId: b.teacher_id, candidateTeacherId: c.teacher_id,
    classroomId: c.classroom_id, classroomName: c.classroom_name || '',
  };
}

// candidates 与「库内已有 + 彼此之间」比对，返回带明细的冲突列表
function detectConflicts(candidates, existing, excludeIds = new Set()) {
  const out = [];
  const poolRows = existing.filter((r) => !excludeIds.has(Number(r.id)));
  candidates.forEach((c, idx) => {
    poolRows.forEach((b) => {
      const kind = conflictKind(c, b);
      if (kind) out.push({ index: idx, ...describeConflict(kind, c, b) });
    });
    // 同一批次内部互相冲突（跳过自身、跳过已判定与外部冲突的重复描述）
    for (let j = 0; j < idx; j++) {
      const kind = conflictKind(c, candidates[j]);
      if (kind) out.push({ index: idx, ...describeConflict(kind, c, { ...candidates[j], id: null, title: '同批次课程' }) });
    }
  });
  return out;
}

async function existingInRange(from, to) {
  return pool.query(
    `SELECT l.id, l.slot_date, l.start_time, l.end_time, l.teacher_id, l.classroom_id,
            COALESCE(l.title,c.title) AS title, t.name AS teacher_name, cr.name AS classroom_name
     FROM lessons l LEFT JOIN courses c ON c.id=l.course_id
     LEFT JOIN teachers t ON t.id=l.teacher_id LEFT JOIN classrooms cr ON cr.id=l.classroom_id
     WHERE l.slot_date BETWEEN ? AND ?`,
    [from, to]
  ).then(([r]) => r);
}

// 仅返回「与他人冲突」的部分：同教师时段重叠视为本人冲突（可覆盖），
// 其余（教室被其他教师占用、与其他教师时间重叠）只能提示，不可覆盖。
async function otherTeacherConflicts(candidate, excludeId) {
  const existing = await existingInRange(candidate.slot_date, candidate.slot_date);
  const excl = new Set([Number(excludeId)].filter(Boolean));
  return detectConflicts([candidate], existing, excl)
    .filter((c) => String(c.withTeacherId) !== String(candidate.teacher_id));
}

// ---------- 写入 ----------
async function insertLesson(conn, body, extra = {}) {
  const [r] = await conn.query(
    `INSERT INTO lessons
      (series_id, source, semester_id, course_id, title, teacher_id, classroom_id, slot_date,
       start_time, end_time, remark, lesson_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      extra.series_id ?? null, extra.source || 'single',
      numOrNull(body.semester_id ?? body.semesterId),
      numOrNull(body.course_id), body.title || null,
      numOrNull(body.teacher_id), numOrNull(body.classroom_id),
      body.slot_date, normTime(body.start_time), normTime(body.end_time),
      body.remark || null, body.lesson_status || 'normal',
    ]
  );
  await setStudents(conn, r.insertId, body.studentIds ?? body.student_ids);
  return r.insertId;
}

// 学期越界校验：排课日期必须落在指定/自动匹配的学期范围内
async function checkSemester(body) {
  const r = await resolveSemesterSlot(body.slot_date, body.semester_id ?? body.semesterId);
  if (!r.ok) return r.error;
  body.semester_id = r.semester_id;
  return null;
}

function validateLesson(body, { requireTeacher = true } = {}) {
  if (!dateOk(body.slot_date)) return '请选择有效的上课日期';
  if (!validRange(body.start_time, body.end_time)) return '结束时间需晚于开始时间';
  if (requireTeacher && !numOrNull(body.teacher_id)) return '请选择上课教师';
  if (body.lesson_status && !STATUS[body.lesson_status]) return '无效的课程状态';
  return null;
}

function checkOwner(req, row) {
  return req.user.role === 'admin' || String(row.teacher_id) === String(req.user.teacherId);
}

// ================= 路由挂载 =================
export function mountLessons(app, { q, authenticate }) {
  const base = '/api/admin/lessons';

  // 列表（筛选：教师 / 教室 / 学生 / 状态 / 日期区间）
  app.get(base, authenticate, async (req, res) => {
    res.json(await listLessons(req, req.query));
  });

  // 单节保存前的冲突预检（编辑弹窗 / 拖拽落位用）
  app.post(`${base}/conflicts`, authenticate, async (req, res) => {
    const b = req.body || {};
    if (!dateOk(b.slot_date)) return res.status(400).json({ error: '无效日期' });
    const candidate = {
      slot_date: b.slot_date, start_time: normTime(b.start_time), end_time: normTime(b.end_time),
      teacher_id: numOrNull(b.teacher_id), classroom_id: numOrNull(b.classroom_id),
      title: b.title || '当前课程',
    };
    const existing = await existingInRange(b.slot_date, b.slot_date);
    const exclude = new Set([Number(b.excludeId)].filter(Boolean));
    const conflicts = detectConflicts([candidate], existing, exclude);
    res.json({ conflicts });
  });

  // 撤销 / 重做：把一批课程恢复到指定快照（含显式 id 与学生关联）
  app.post(`${base}/restore`, authenticate, async (req, res) => {
    const { ids = [], lessons = [] } = req.body || {};
    if (req.user.role === 'teacher' && lessons.some((l) => String(l.teacher_id) !== String(req.user.teacherId))) {
      return res.status(403).json({ error: '只能恢复自己名下的课程' });
    }
    const cleanIds = [...new Set(ids.map(Number).filter(Boolean))];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (cleanIds.length) {
        await conn.query('DELETE FROM lesson_students WHERE lesson_id IN (?)', [cleanIds]);
        await conn.query('DELETE FROM lessons WHERE id IN (?)', [cleanIds]);
      }
      for (const l of lessons) {
        const id = Number(l.id);
        if (!id || !dateOk(l.slot_date)) continue;
        await conn.query(
          `INSERT INTO lessons
            (id, series_id, source, semester_id, course_id, title, teacher_id, classroom_id, slot_date,
             start_time, end_time, remark, lesson_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             series_id=VALUES(series_id), source=VALUES(source), semester_id=VALUES(semester_id),
             course_id=VALUES(course_id), title=VALUES(title), teacher_id=VALUES(teacher_id),
             classroom_id=VALUES(classroom_id), slot_date=VALUES(slot_date),
             start_time=VALUES(start_time), end_time=VALUES(end_time),
             remark=VALUES(remark), lesson_status=VALUES(lesson_status)`,
          [id, l.series_id || null, l.source || 'single', numOrNull(l.semester_id), numOrNull(l.course_id), l.title || null,
            numOrNull(l.teacher_id), numOrNull(l.classroom_id), l.slot_date,
            normTime(l.start_time), normTime(l.end_time), l.remark || null, l.lesson_status || 'normal']
        );
        await setStudents(conn, id, l.studentIds ?? l.student_ids ?? (l.students || []).map((s) => s.id));
      }
      await conn.commit();
      res.json({ ok: true, restored: lessons.length });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }
  });

  // 新建单节
  app.post(base, authenticate, async (req, res) => {
    const b = req.body || {};
    const tid = req.user.role === 'admin' ? numOrNull(b.teacher_id) : req.user.teacherId;
    const body = { ...b, teacher_id: tid };
    const err = validateLesson(body);
    if (err) return res.status(400).json({ error: err });
    const semErr = await checkSemester(body);
    if (semErr) return res.status(400).json({ error: semErr });
    if (!b.title && b.course_id) {
      const [c] = await q('SELECT title FROM courses WHERE id=?', [numOrNull(b.course_id)]);
      if (c) body.title = c.title;
    }
    const conn = await pool.getConnection();
    let id;
    try {
      await conn.beginTransaction();
      // 他人冲突不可覆盖：直接拒绝，由前端提示更换教室或时间
      const other = await otherTeacherConflicts({
        slot_date: body.slot_date, start_time: normTime(body.start_time), end_time: normTime(body.end_time),
        teacher_id: tid, classroom_id: numOrNull(body.classroom_id),
      }, null);
      if (other.length) {
        await conn.rollback();
        return res.status(409).json({
          error: '该时段与其他教师的课程冲突，无法覆盖：' + other.map((c) => c.detail).join('；'),
          conflicts: other,
        });
      }
      id = await insertLesson(conn, body);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true, id });
  });

  // 导出 Excel（UTF-8 BOM CSV，Excel 直接打开）：日期/星期/时段/教师/教室/学生/课程/状态/备注
  app.get(`${base}/export`, authenticate, async (req, res) => {
    const rows = await listLessons(req, req.query);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['日期', '星期', '时段', '教师', '教室', '学生', '课程名称', '状态', '备注'].map(esc).join(',')];
    rows.forEach((r) => lines.push([
      r.slot_date, weekOf(r.slot_date),
      `${String(r.start_time).slice(0, 5)}-${String(r.end_time).slice(0, 5)}`,
      r.teacher_name || '', r.classroom_name || '',
      (r.students || []).map((s) => s.name).join('、'),
      r.title || '', STATUS[r.lesson_status] || r.lesson_status, r.remark || '',
    ].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lessons.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  // 修改整个系列（统一改字段；只允许修改传入的字段）
  app.put(`${base}/series/:seriesId`, authenticate, async (req, res) => {
    const { seriesId } = req.params;
    const b = req.body || {};
    const rows = await q('SELECT * FROM lessons WHERE series_id=?', [seriesId]);
    if (!rows.length) return res.status(404).json({ error: '该系列没有课程' });
    if (!rows.every((r) => checkOwner(req, r))) return res.status(403).json({ error: '只能修改自己名下的课程' });
    if ((b.start_time || b.end_time) && !validRange(b.start_time || rows[0].start_time, b.end_time || rows[0].end_time)) {
      return res.status(400).json({ error: '结束时间需晚于开始时间' });
    }
    if (req.user.role === 'teacher') delete b.teacher_id;
    const sets = [], p = [];
    const map = {
      course_id: 'course_id', title: 'title', teacher_id: 'teacher_id', classroom_id: 'classroom_id',
      start_time: 'start_time', end_time: 'end_time', remark: 'remark', lesson_status: 'lesson_status',
    };
    Object.keys(map).forEach((k) => {
      if (b[k] === undefined) return;
      sets.push(`${map[k]}=?`);
      p.push(['start_time', 'end_time'].includes(k) ? normTime(b[k])
        : ['course_id', 'teacher_id', 'classroom_id'].includes(k) ? numOrNull(b[k]) : b[k]);
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (sets.length) await conn.query(`UPDATE lessons SET ${sets.join(',')} WHERE series_id=?`, [...p, seriesId]);
      if (b.studentIds ?? b.student_ids) {
        const sids = b.studentIds ?? b.student_ids;
        for (const r of rows) await setStudents(conn, r.id, sids);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true, updated: rows.length, ids: rows.map((r) => r.id) });
  });

  // 删除整个系列
  app.delete(`${base}/series/:seriesId`, authenticate, async (req, res) => {
    const rows = await q('SELECT id,teacher_id FROM lessons WHERE series_id=?', [req.params.seriesId]);
    if (!rows.length) return res.json({ ok: true, deleted: 0 });
    if (!rows.every((r) => checkOwner(req, r))) return res.status(403).json({ error: '只能删除自己名下的课程' });
    const ids = rows.map((r) => r.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM lesson_students WHERE lesson_id IN (?)', [ids]);
      await conn.query('DELETE FROM lessons WHERE id IN (?)', [ids]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true, deleted: ids.length, ids });
  });

  // 复制单节（右键菜单）
  app.post(`${base}/:id/duplicate`, authenticate, async (req, res) => {
    const [row] = await q('SELECT * FROM lessons WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '课程不存在' });
    if (!checkOwner(req, row)) return res.status(403).json({ error: '无权复制该课程' });
    const sm = await studentsMap([row.id]);
    const conn = await pool.getConnection();
    let id;
    try {
      await conn.beginTransaction();
      id = await insertLesson(conn, { ...row, student_ids: (sm[row.id] || []).map((s) => s.id) });
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true, id });
  });

  // 修改单节；属于系列时默认脱离系列变成独立单次课（scope=series 走上面的系列接口）
  app.put(`${base}/:id`, authenticate, async (req, res) => {
    const [row] = await q('SELECT * FROM lessons WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '课程不存在' });
    if (!checkOwner(req, row)) return res.status(403).json({ error: '只能修改自己名下的课程' });
    const b = req.body || {};
    // 教师端不允许把课程改派给别的教师
    if (req.user.role === 'teacher') delete b.teacher_id;
    const merged = {
      slot_date: b.slot_date || row.slot_date,
      start_time: b.start_time || row.start_time,
      end_time: b.end_time || row.end_time,
      teacher_id: b.teacher_id !== undefined ? b.teacher_id : row.teacher_id,
    };
    const effClassroom = b.classroom_id !== undefined ? numOrNull(b.classroom_id) : numOrNull(row.classroom_id);
    const other = await otherTeacherConflicts({
      slot_date: merged.slot_date, start_time: normTime(merged.start_time), end_time: normTime(merged.end_time),
      teacher_id: merged.teacher_id, classroom_id: effClassroom,
    }, row.id);
    if (other.length) {
      return res.status(409).json({
        error: '该时段与其他教师的课程冲突，无法覆盖：' + other.map((c) => c.detail).join('；'),
        conflicts: other,
      });
    }
    const err = validateLesson(merged);
    if (err) return res.status(400).json({ error: err });
    // 日期可能被拖动修改：重新校验学期范围，并固定 semester_id
    merged.semester_id = b.semester_id ?? b.semesterId ?? row.semester_id;
    const semErr = await checkSemester(merged);
    if (semErr) return res.status(400).json({ error: semErr });
    if (b.lesson_status && !STATUS[b.lesson_status]) return res.status(400).json({ error: '无效的课程状态' });

    const sets = [], p = [];
    const map = {
      course_id: 'course_id', title: 'title', teacher_id: 'teacher_id', classroom_id: 'classroom_id',
      slot_date: 'slot_date', start_time: 'start_time', end_time: 'end_time',
      remark: 'remark', lesson_status: 'lesson_status',
    };
    Object.keys(map).forEach((k) => {
      if (b[k] === undefined) return;
      sets.push(`${map[k]}=?`);
      p.push(['start_time', 'end_time'].includes(k) ? normTime(b[k])
        : ['course_id', 'teacher_id', 'classroom_id'].includes(k) ? numOrNull(b[k]) : b[k]);
    });
    // 学期归属始终写入（拖动改日期后可能变化）
    sets.push('semester_id=?');
    p.push(merged.semester_id);
    // 关键：单节修改后脱离循环系列
    if (row.series_id && b.detach !== false) {
      sets.push('series_id=NULL', "source='single'");
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (sets.length) await conn.query(`UPDATE lessons SET ${sets.join(',')} WHERE id=?`, [...p, row.id]);
      if (b.studentIds ?? b.student_ids) await setStudents(conn, row.id, b.studentIds ?? b.student_ids);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true, detached: !!row.series_id && b.detach !== false });
  });

  // 删除单节
  app.delete(`${base}/:id`, authenticate, async (req, res) => {
    const [row] = await q('SELECT id,teacher_id FROM lessons WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '课程不存在' });
    if (!checkOwner(req, row)) return res.status(403).json({ error: '只能删除自己名下的课程' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM lesson_students WHERE lesson_id=?', [row.id]);
      await conn.query('DELETE FROM lessons WHERE id=?', [row.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    res.json({ ok: true });
  });
}

export default mountLessons;
