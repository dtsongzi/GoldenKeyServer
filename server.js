import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pool from './db.js';
import { mountLessons } from './lessons.js';
import { mountAdminTeachers } from './admin-teachers.js';
import { syncLessonsQuietly } from './sync-lessons.js';

const app = express();
app.use(cors());
app.use(express.json());

// 所有接口统一挂在 /goldenkey 前缀下（/goldenkey/api/*）：
// 同一台服务器/同一个域名上还跑着别的应用（如 ReviewMaster），加前缀避免路径互相覆盖。
const API_PREFIX = '/goldenkey';
// 业务路由统一注册在这个 router 上，最后整体挂到 API_PREFIX
const api = express.Router();

/** 去掉 /goldenkey 前缀后的业务路径（/api/...），日志与同步规则都按它判断 */
const barePath = (p) =>
  p === API_PREFIX ? '/' : p.startsWith(API_PREFIX + '/') ? p.slice(API_PREFIX.length) : p;

// 小程序侧的「可约时段 / 预约」一旦有写操作，就把结果镜像进排课管理页的 lessons，
// 保证「网站课表」和「小程序可约时段」的时间段与数量始终一致（幂等、异步、失败不影响主流程）
const SYNC_PATHS = /^\/api\/(app\/)?bookings(\/|$)|^\/api\/app\/teacher\/(slots|assign|members)(\/|$)/;
app.use((req, res, next) => {
  const path = barePath(req.path);
  if (req.method === 'GET' || !SYNC_PATHS.test(path)) return next();
  res.on('finish', () => {
    if (res.statusCode < 400) syncLessonsQuietly(req.method + ' ' + path);
  });
  next();
});

// 接口访问日志（终端/服务器日志可见）：排查「小程序 404 / 401」这类问题全靠它
app.use((req, res, next) => {
  if (!barePath(req.path).startsWith('/api')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`[api] ${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

const q = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

// ---------------- 轻量 JWT 风格 token（HMAC 签名，无需第三方依赖） ----------------
// token 签名密钥：AUTH_SECRET（标准名，与部署脚本/CI 一致）优先，兼容旧的 JWT_SECRET；
// 两者都没有时用开发默认值（默认值保留以兼容既有 token）
const SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET || 'goldenkey-dev-secret';
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

// ---------------- 鉴权中间件 ----------------
function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: '未登录或登录已失效' });
  req.user = user;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: '无权限执行该操作' });
    next();
  };
}

// 教师侧接口的「作用教师」：教师账号强制本人；管理员可通过 teacherId 指定（小程序代排课）
async function teacherScope(req, rawId) {
  if (req.user && req.user.role === 'admin') {
    const id = Number(rawId);
    if (id) return id;
    const [t] = await q('SELECT id FROM teachers WHERE status=1 ORDER BY id LIMIT 1');
    return t ? t.id : null;
  }
  return req.user ? req.user.teacherId : null;
}

// 最近 N 天日期数组
function lastNDates(n) {
  const out = [];
  const t = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(t.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ================= 公开接口（会员端 / 工作室） =================
api.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

api.get('/api/studio', async (req, res) => {
  const [studio] = await q('SELECT * FROM studio_profile WHERE id=1');
  const teachers = await q('SELECT id,name,gender,title,bio,avatar,sort FROM teachers WHERE status=1 ORDER BY sort');
  res.json({ ...studio, teachers });
});

api.get('/api/teachers', async (req, res) => {
  const rows = await q('SELECT id,name,gender,title,bio,avatar FROM teachers WHERE status=1 ORDER BY sort');
  res.json(rows);
});

api.get('/api/courses', async (req, res) => {
  const rows = await q(
    `SELECT c.*, t.name AS teacher_name
     FROM courses c LEFT JOIN teachers t ON c.teacher_id=t.id
     WHERE c.status=1 ORDER BY c.sort`
  );
  res.json(rows);
});
api.get('/api/courses/:id', async (req, res) => {
  const [row] = await q(
    `SELECT c.*, t.name AS teacher_name, t.bio AS teacher_bio
     FROM courses c LEFT JOIN teachers t ON c.teacher_id=t.id WHERE c.id=?`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

api.get('/api/availability', async (req, res) => {
  const { from, to, teacherId } = req.query;
  let sql = 'SELECT id,teacher_id,slot_date,start_time,end_time,status FROM availability WHERE status=1';
  const p = [];
  if (from) { sql += ' AND slot_date >= ?'; p.push(from); }
  if (to) { sql += ' AND slot_date <= ?'; p.push(to); }
  if (teacherId) { sql += ' AND teacher_id = ?'; p.push(teacherId); }
  sql += ' ORDER BY slot_date, start_time';
  const rows = await q(sql, p);
  const byDate = {};
  for (const r of rows) {
    const d = r.slot_date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ id: r.id, start: r.start_time, end: r.end_time, teacherId: r.teacher_id });
  }
  res.json(byDate);
});

// 会员档案 / 记录 / 消息（去掉 balance 不外泄）
api.get('/api/members/:id/profile', async (req, res) => {
  const [m] = await q('SELECT id,name,phone,avatar FROM members WHERE id=?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'not found' });
  const [courseCount] = await q('SELECT COUNT(*) c FROM bookings WHERE member_id=? AND status!=3', [req.params.id]);
  const [recordCount] = await q('SELECT COUNT(*) c FROM class_records WHERE member_id=? AND status=1', [req.params.id]);
  res.json({ ...m, courseCount: courseCount.c, recordCount: recordCount.c });
});
api.get('/api/members/:id/bookings', async (req, res) => {
  const rows = await q(
    `SELECT b.*, c.title AS course_title, t.name AS teacher_name
     FROM bookings b LEFT JOIN courses c ON b.course_id=c.id
     LEFT JOIN teachers t ON b.teacher_id=t.id
     WHERE b.member_id=? ORDER BY b.slot_date DESC, b.start_time DESC`,
    [req.params.id]
  );
  res.json(rows);
});
api.get('/api/members/:id/records', async (req, res) => {
  const rows = await q(
    `SELECT r.*, c.title AS course_title, t.name AS teacher_name
     FROM class_records r LEFT JOIN courses c ON r.course_id=c.id
     LEFT JOIN teachers t ON r.teacher_id=t.id
     WHERE r.member_id=? ORDER BY r.class_date DESC`,
    [req.params.id]
  );
  res.json(rows);
});
api.get('/api/members/:id/messages', async (req, res) => {
  const rows = await q('SELECT * FROM messages WHERE member_id=? ORDER BY created_at DESC', [req.params.id]);
  res.json(rows);
});
api.post('/api/messages/:id/read', async (req, res) => {
  await q('UPDATE messages SET is_read=1 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// 预约（会员端）
api.post('/api/bookings', async (req, res) => {
  const { memberId, courseId, teacherId, slotDate, startTime, endTime } = req.body;
  if (!memberId || !slotDate || !startTime) return res.status(400).json({ error: '缺少必要参数' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [slot] = await conn.query(
      'SELECT id,status FROM availability WHERE teacher_id<=>(?) AND slot_date=? AND start_time=? FOR UPDATE',
      [teacherId || null, slotDate, startTime]
    );
    if (!slot.length || slot[0].status !== 1)
      return res.status(409).json({ error: '该时段不可预约或已被占用' });
    await conn.query('UPDATE availability SET status=0 WHERE id=?', [slot[0].id]);
    const [r] = await conn.query(
      `INSERT INTO bookings (member_id, course_id, teacher_id, slot_date, start_time, end_time, status, remark)
       VALUES (?,?,?,?,?,?,2,?)`,
      [memberId, courseId || null, teacherId || null, slotDate, startTime, endTime || null, req.body.remark || null]
    );
    await conn.query(
      `INSERT INTO messages (member_id, type, title, content, related_id) VALUES (?, 'booking_success', '预约成功', ?, ?)`,
      [memberId, `您预约的课程已确认（${slotDate} ${startTime}），请准时到课。`, r.insertId]
    );
    await conn.commit();
    res.json({ ok: true, bookingId: r.insertId });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});
api.post('/api/bookings/:id/cancel', async (req, res) => {
  const id = req.params.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [b] = await conn.query('SELECT * FROM bookings WHERE id=?', [id]);
    if (!b.length) return res.status(404).json({ error: 'not found' });
    await conn.query('UPDATE bookings SET status=3 WHERE id=?', [id]);
    await conn.query(
      'UPDATE availability SET status=1 WHERE teacher_id<=>(?) AND slot_date=? AND start_time=?',
      [b[0].teacher_id, b[0].slot_date, b[0].start_time]
    );
    await conn.query(
      `INSERT INTO messages (member_id, type, title, content, related_id) VALUES (?, 'booking_cancel', '预约已取消', ?, ?)`,
      [b[0].member_id, `您 ${b[0].slot_date} ${b[0].start_time} 的预约已取消。`, id]
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ================= 鉴权 =================
api.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const [u] = await q(
    'SELECT id,username,role,teacher_id FROM admin_users WHERE username=? AND password=?',
    [username, password]
  );
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  // 学生账号属于小程序端，不允许登录商家管理后台
  if (u.role === 'student') return res.status(403).json({ error: '该账号为学员账号，请在小程序端登录' });
  const token = signToken({ uid: u.id, username: u.username, role: u.role, teacherId: u.teacher_id || null });
  res.json({ ok: true, token, role: u.role, username: u.username, teacherId: u.teacher_id || null });
});

api.get('/api/me', authenticate, (req, res) => res.json(req.user));

// ================= 课程 =================
// 管理员：全部课程
api.get('/api/admin/courses', authenticate, requireRole('admin'), async (req, res) => {
  const rows = await q('SELECT * FROM courses ORDER BY sort');
  res.json(rows);
});
// 管理员：新建
api.post('/api/admin/courses', authenticate, requireRole('admin'), async (req, res) => {
  const { title, category, description, cover_image, price, duration_min, teacher_id, status, sort } = req.body;
  const r = await q(
    `INSERT INTO courses (title,category,description,cover_image,price,duration_min,teacher_id,status,sort)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [title, category, description, cover_image, price || 0, duration_min || 60, teacher_id || null, status ?? 1, sort || 0]
  );
  res.json({ ok: true, id: r.insertId });
});
// 管理员：更新
api.put('/api/admin/courses/:id', authenticate, requireRole('admin'), async (req, res) => {
  const b = req.body;
  await q(
    `UPDATE courses SET title=?,category=?,description=?,cover_image=?,price=?,duration_min=?,teacher_id=?,status=?,sort=? WHERE id=?`,
    [b.title, b.category, b.description, b.cover_image, b.price, b.duration_min, b.teacher_id, b.status, b.sort, req.params.id]
  );
  res.json({ ok: true });
});
// 管理员：删除
api.delete('/api/admin/courses/:id', authenticate, requireRole('admin'), async (req, res) => {
  await q('DELETE FROM courses WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});
// 管理员：审核待审课程（教师提交的申请）
api.put('/api/admin/courses/:id/review', authenticate, requireRole('admin'), async (req, res) => {
  const { action } = req.body; // 'approve' | 'reject'
  const status = action === 'approve' ? 1 : 0;
  await q('UPDATE courses SET status=? WHERE id=?', [status, req.params.id]);
  res.json({ ok: true });
});

// 教师：仅看自己的课程
api.get('/api/teacher/courses', authenticate, requireRole('teacher'), async (req, res) => {
  const rows = await q('SELECT * FROM courses WHERE teacher_id=? ORDER BY sort', [req.user.teacherId]);
  res.json(rows);
});
// 教师：提交新课申请（status=2 待审核）
api.post('/api/teacher/courses', authenticate, requireRole('teacher'), async (req, res) => {
  const { title, category, description, cover_image, price, duration_min, sort } = req.body;
  const r = await q(
    `INSERT INTO courses (title,category,description,cover_image,price,duration_min,teacher_id,status,sort)
     VALUES (?,?,?,?,?,?,?,2,?)`,
    [title, category, description, cover_image, price || 0, duration_min || 60, req.user.teacherId, sort || 0]
  );
  res.json({ ok: true, id: r.insertId });
});

// 课程明细：在读学员 + 已完成课时 + 按日课时分布（管理员 & 本人教师可看）
async function courseDetail(courseId, user) {
  const [course] = await q(
    `SELECT c.*, t.name AS teacher_name FROM courses c LEFT JOIN teachers t ON c.teacher_id=t.id WHERE c.id=?`,
    [courseId]
  );
  if (!course) return null;
  if (user.role === 'teacher' && course.teacher_id !== user.teacherId) return { forbidden: true };
  const students = await q(
    `SELECT m.id, m.name, m.phone,
            COUNT(DISTINCT b.id) AS bookings,
            COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(r.end_time,r.start_time))/3600),0) AS completed_hours
     FROM bookings b JOIN members m ON b.member_id=m.id
     LEFT JOIN class_records r ON r.member_id=m.id AND r.course_id=b.course_id AND r.status=1
     WHERE b.course_id=? AND b.status!=3
     GROUP BY m.id, m.name, m.phone
     ORDER BY completed_hours DESC`,
    [courseId]
  );
  const dist = await q(
    `SELECT class_date AS date, COUNT(*) AS count FROM class_records WHERE course_id=? GROUP BY class_date ORDER BY class_date`,
    [courseId]
  );
  return { course, students, distribution: dist };
}
api.get('/api/admin/courses/:id/detail', authenticate, requireRole('admin'), async (req, res) => {
  const d = await courseDetail(req.params.id, req.user);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.forbidden) return res.status(403).json({ error: '无权限' });
  res.json(d);
});
api.get('/api/teacher/courses/:id/detail', authenticate, requireRole('teacher'), async (req, res) => {
  const d = await courseDetail(req.params.id, req.user);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.forbidden) return res.status(403).json({ error: '无权限' });
  res.json(d);
});

// ================= 学生（会员） =================
// 管理员：全部学生（不含 balance）
api.get('/api/admin/members', authenticate, requireRole('admin'), async (req, res) => {
  const rows = await q(
    `SELECT m.id, m.name, m.gender, m.age, m.phone, m.avatar, m.remark, m.source, m.created_at,
            (SELECT au.username FROM admin_users au WHERE au.member_id=m.id AND au.role='student' LIMIT 1) AS username,
            (SELECT COUNT(*) FROM bookings b WHERE b.member_id=m.id AND b.status!=3) AS booking_count,
            (SELECT COUNT(*) FROM class_records r WHERE r.member_id=m.id AND r.status=1) AS record_count,
            (SELECT COUNT(*) FROM class_records r WHERE r.member_id=m.id AND r.status=1) AS done_hours,
            (SELECT COUNT(*) FROM bookings b WHERE b.member_id=m.id AND b.status IN (1,2)
               AND b.slot_date>=CURDATE()) AS upcoming_hours
     FROM members m ORDER BY m.created_at DESC`
  );
  res.json(rows);
});
// 教师：仅看自己学生（有预约/上课记录的）
api.get('/api/teacher/students', authenticate, requireRole('teacher'), async (req, res) => {
  const rows = await q(
    `SELECT DISTINCT m.id, m.name, m.phone, m.avatar, m.remark, m.created_at
     FROM members m
     JOIN bookings b ON b.member_id=m.id AND b.teacher_id=? AND b.status!=3
     UNION
     SELECT DISTINCT m.id, m.name, m.phone, m.avatar, m.remark, m.created_at
     FROM members m
     JOIN class_records r ON r.member_id=m.id AND r.teacher_id=?
     ORDER BY created_at DESC`,
    [req.user.teacherId, req.user.teacherId]
  );
  // 统计
  for (const m of rows) {
    const [bk] = await q('SELECT COUNT(*) c FROM bookings WHERE member_id=? AND teacher_id=? AND status!=3', [m.id, req.user.teacherId]);
    const [rc] = await q('SELECT COUNT(*) c FROM class_records WHERE member_id=? AND teacher_id=? AND status=1', [m.id, req.user.teacherId]);
    const [up] = await q(
      'SELECT COUNT(*) c FROM bookings WHERE member_id=? AND teacher_id=? AND status IN (1,2) AND slot_date>=CURDATE()',
      [m.id, req.user.teacherId]
    );
    m.booking_count = bk.c;
    m.record_count = rc.c;
    m.done_hours = rc.c;          // 已上课时（节）
    m.upcoming_hours = up.c;      // 未上课时（已约未上）
  }
  res.json(rows);
});

// 学生明细：课程列表 + 预约次数 + 已完成课时 + 出勤 + 按日分布
async function studentDetail(memberId, user) {
  let scopeSql = '', scopeP = [];
  if (user.role === 'teacher') {
    scopeSql = 'AND b.teacher_id=?';
    scopeP = [user.teacherId];
  }
  const courses = await q(
    `SELECT c.id, c.title, c.category,
            COUNT(DISTINCT b.id) AS bookings,
            COUNT(DISTINCT r.id) AS completed,
            COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(r.end_time,r.start_time))/3600),0) AS completed_hours
     FROM bookings b JOIN courses c ON b.course_id=c.id
     LEFT JOIN class_records r ON r.member_id=b.member_id AND r.course_id=b.course_id AND r.status=1
     WHERE b.member_id=? ${scopeSql}
     GROUP BY c.id, c.title, c.category
     ORDER BY completed DESC`,
    [memberId, ...scopeP]
  );
  const [agg] = await q(
    `SELECT COUNT(DISTINCT b.id) AS booking_count,
            COUNT(DISTINCT r.id) AS record_count,
            COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(r.end_time,r.start_time))/3600),0) AS completed_hours,
            SUM(CASE WHEN r.status=0 THEN 1 ELSE 0 END) AS absent
     FROM bookings b
     LEFT JOIN class_records r ON r.member_id=b.member_id AND r.course_id=b.course_id
     WHERE b.member_id=? ${scopeSql}`,
    [memberId, ...scopeP]
  );
  const dist = await q(
    `SELECT class_date AS date, COUNT(*) AS count FROM class_records r
     JOIN bookings b ON b.member_id=r.member_id AND b.course_id=r.course_id
     WHERE r.member_id=? ${scopeSql} GROUP BY class_date ORDER BY class_date`,
    [memberId, ...scopeP]
  );
  return { courses, agg: agg || {}, distribution: dist };
}
api.get('/api/admin/members/:id/detail', authenticate, requireRole('admin'), async (req, res) => {
  res.json(await studentDetail(req.params.id, req.user));
});
api.get('/api/teacher/students/:id/detail', authenticate, requireRole('teacher'), async (req, res) => {
  // 校验该学生确属该教师
  const [chk] = await q(
    'SELECT 1 FROM bookings WHERE member_id=? AND teacher_id=? LIMIT 1',
    [req.params.id, req.user.teacherId]
  );
  if (!chk) return res.status(403).json({ error: '无权限' });
  res.json(await studentDetail(req.params.id, req.user));
});

// ================= 上课记录 =================
function recordsQuery(user, filters = {}) {
  let sql = `SELECT r.*, m.name AS member_name, c.title AS course_title, t.name AS teacher_name
     FROM class_records r LEFT JOIN members m ON r.member_id=m.id
     LEFT JOIN courses c ON r.course_id=c.id LEFT JOIN teachers t ON r.teacher_id=t.id WHERE 1=1`;
  const p = [];
  if (user.role === 'teacher') { sql += ' AND r.teacher_id=?'; p.push(user.teacherId); }
  if (filters.courseId) { sql += ' AND r.course_id=?'; p.push(filters.courseId); }
  if (filters.memberId) { sql += ' AND r.member_id=?'; p.push(filters.memberId); }
  if (filters.teacherId && user.role === 'admin') { sql += ' AND r.teacher_id=?'; p.push(filters.teacherId); }
  sql += ' ORDER BY r.class_date DESC';
  return { sql, p };
}
api.get('/api/admin/records', authenticate, requireRole('admin'), async (req, res) => {
  const { sql, p } = recordsQuery(req.user, req.query);
  res.json(await q(sql, p));
});
api.get('/api/teacher/records', authenticate, requireRole('teacher'), async (req, res) => {
  const { sql, p } = recordsQuery(req.user, req.query);
  res.json(await q(sql, p));
});

// ================= 排课 =================
// 网格数据：availability（可编辑块）+ bookings（已排课块）
api.get('/api/admin/schedule', authenticate, async (req, res) => {
  const { from, to, teacherId } = req.query;
  // 注意：JOIN 了 courses 之后 teacher_id / slot_date 在多张表里都有，WHERE 必须带表别名
  let cond = '1=1', p = [];
  if (from) { cond += ' AND a.slot_date >= ?'; p.push(from); }
  if (to) { cond += ' AND a.slot_date <= ?'; p.push(to); }
  if (req.user.role === 'teacher') { cond += ' AND a.teacher_id=?'; p.push(req.user.teacherId); }
  else if (teacherId) { cond += ' AND a.teacher_id=?'; p.push(teacherId); }

  const avail = await q(
    `SELECT 'avail' AS kind, a.id, a.slot_date, a.start_time, a.end_time, a.teacher_id,
            t.name AS teacher_name, c.title AS course_title, NULL AS member_name, a.status,
            a.classroom_id, cr.name AS classroom_name, a.course_id
     FROM availability a LEFT JOIN teachers t ON a.teacher_id=t.id
     LEFT JOIN classrooms cr ON a.classroom_id=cr.id
     LEFT JOIN courses c ON a.course_id=c.id
     WHERE ${cond}`,
    p
  );
  const book = await q(
    `SELECT 'book' AS kind, b.id, b.slot_date, b.start_time, b.end_time, b.teacher_id,
            t.name AS teacher_name, c.title AS course_title, m.name AS member_name, b.status,
            b.classroom_id, cr.name AS classroom_name, b.course_id
     FROM bookings b LEFT JOIN teachers t ON b.teacher_id=t.id
     LEFT JOIN courses c ON b.course_id=c.id LEFT JOIN members m ON b.member_id=m.id
     LEFT JOIN classrooms cr ON b.classroom_id=cr.id
     WHERE b.status!=3 AND ${cond.replace(/a\./g, 'b.')}`,
    p
  );
  res.json([...avail, ...book]);
});

// 教师只能操作属于自己的 availability 块；管理员不受限
async function canModifySlot(req, id) {
  if (req.user.role === 'admin') return true;
  const rows = await q('SELECT teacher_id FROM availability WHERE id=?', [id]);
  return rows.length > 0 && rows[0].teacher_id != null
    && String(rows[0].teacher_id) === String(req.user.teacherId);
}

// 覆盖处理：拖动/新建后的时段若与已有块重叠，保存时把被覆盖的块删掉（视为需要重排）
// 规则：同一教师，或同一教室（填了教室时）算冲突；已被学员预约的块跳过不删，返回 skipped
async function removeOverlappedSlots({ excludeId = 0, teacherId, classroomId, date, start, end, isAdmin, actorTeacherId }) {
  if (!date || !start || !end) return { deleted: 0, skipped: 0 };
  const params = [date, excludeId, end, start, teacherId ?? null];
  let sql = `SELECT a.id,
                    EXISTS(SELECT 1 FROM bookings b
                           WHERE b.teacher_id=a.teacher_id AND b.slot_date=a.slot_date
                             AND b.start_time=a.start_time AND b.status IN (1,2)) AS booked
             FROM availability a
             WHERE a.slot_date=? AND a.id<>? AND a.start_time<? AND a.end_time>?
               AND (a.teacher_id <=> ?`;
  if (classroomId) { sql += ' OR a.classroom_id = ?'; params.push(classroomId); }
  sql += ')';
  // 教师只能覆盖自己名下的块，管理员可覆盖全部
  if (!isAdmin) { sql += ' AND a.teacher_id = ?'; params.push(actorTeacherId); }
  const rows = await q(sql, params);
  const delIds = rows.filter((r) => !Number(r.booked)).map((r) => r.id);
  const skipped = rows.length - delIds.length;
  if (delIds.length) await q('DELETE FROM availability WHERE id IN (?)', [delIds]);
  return { deleted: delIds.length, skipped };
}

// 新增单个可约时段（教师强制排给自己）
api.post('/api/admin/schedule', authenticate, async (req, res) => {
  const { slot_date, start_time, end_time, classroom_id, course_id, overwrite } = req.body;
  const tid = req.user.role === 'admin' ? (req.body.teacher_id || null) : req.user.teacherId;
  if (!slot_date || !start_time || !end_time || !tid) return res.status(400).json({ error: '缺少日期/时间/教师' });
  if (String(start_time) >= String(end_time)) return res.status(400).json({ error: '结束时间需晚于开始时间' });

  let ov = { deleted: 0, skipped: 0 };
  if (overwrite) {
    ov = await removeOverlappedSlots({
      excludeId: 0, teacherId: tid, classroomId: classroom_id || null,
      date: slot_date, start: start_time, end: end_time,
      isAdmin: req.user.role === 'admin', actorTeacherId: req.user.teacherId,
    });
  }

  await q(
    `INSERT INTO availability (teacher_id, slot_date, start_time, end_time, status, classroom_id, course_id)
     VALUES (?,?,?,?,1,?,?)
     ON DUPLICATE KEY UPDATE status=1, end_time=VALUES(end_time),
       classroom_id=VALUES(classroom_id), course_id=VALUES(course_id)`,
    [tid, slot_date, start_time, end_time, classroom_id || null, course_id || null]
  );
  const [row] = await q('SELECT id FROM availability WHERE teacher_id=? AND slot_date=? AND start_time=?', [tid, slot_date, start_time]);
  res.json({ ok: true, id: row ? row.id : null, ...ov });
});

// 更新 availability 块（管理员可改教师；教师仅可改自己的时间，不能改归属）
api.put('/api/admin/schedule/:id', authenticate, async (req, res) => {
  if (!(await canModifySlot(req, req.params.id))) return res.status(403).json({ error: '只能修改自己的排课' });
  const { start_time, end_time, teacher_id, classroom_id, course_id, overwrite } = req.body;
  const sets = [];
  const p = [];
  if (start_time) { sets.push('start_time=?'); p.push(start_time); }
  if (end_time) { sets.push('end_time=?'); p.push(end_time); }
  if (classroom_id !== undefined) { sets.push('classroom_id=?'); p.push(classroom_id || null); }
  if (course_id !== undefined) { sets.push('course_id=?'); p.push(course_id || null); }
  if (teacher_id !== undefined && req.user.role === 'admin') { sets.push('teacher_id=?'); p.push(teacher_id); }
  if (!sets.length) return res.json({ ok: true });

  const [cur] = await q('SELECT teacher_id, slot_date, start_time, end_time, classroom_id FROM availability WHERE id=?', [req.params.id]);
  if (!cur) return res.status(404).json({ error: '时段不存在' });
  const nextTeacher = (teacher_id !== undefined && req.user.role === 'admin') ? teacher_id : cur.teacher_id;
  const nextClassroom = classroom_id !== undefined ? (classroom_id || null) : cur.classroom_id;

  // 覆盖：先删掉被这次调整盖住的其他块，避免唯一键冲突，也符合「被覆盖即视为需重排」
  let ov = { deleted: 0, skipped: 0 };
  if (overwrite) {
    ov = await removeOverlappedSlots({
      excludeId: Number(req.params.id), teacherId: nextTeacher, classroomId: nextClassroom,
      date: cur.slot_date, start: start_time || cur.start_time, end: end_time || cur.end_time,
      isAdmin: req.user.role === 'admin', actorTeacherId: req.user.teacherId,
    });
  }

  p.push(req.params.id);
  await q(`UPDATE availability SET ${sets.join(',')} WHERE id=?`, p);
  res.json({ ok: true, ...ov });
});

// 删除排课块（availability 直接删除；booking 仅管理员可取消）
api.delete('/api/admin/schedule/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const { kind } = req.query;
  if (kind === 'book') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '无权取消预约' });
    await q('UPDATE bookings SET status=3 WHERE id=?', [id]);
    return res.json({ ok: true });
  }
  if (!(await canModifySlot(req, id))) return res.status(403).json({ error: '只能删除自己的排课' });
  await q('DELETE FROM availability WHERE id=?', [id]);
  res.json({ ok: true });
});

// ================= 教室 / 琴房 =================
api.get('/api/admin/classrooms', authenticate, async (req, res) => {
  res.json(await q('SELECT id,name,capacity,status,sort FROM classrooms ORDER BY sort,id'));
});
api.post('/api/admin/classrooms', authenticate, requireRole('admin'), async (req, res) => {
  const { name, capacity = 1, status = 1, sort = 0 } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '教室名称不能为空' });
  try {
    const r = await q('INSERT INTO classrooms (name,capacity,status,sort) VALUES (?,?,?,?)',
      [String(name).trim(), Number(capacity) || 1, Number(status) ? 1 : 0, Number(sort) || 0]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '教室名称已存在' });
    throw e;
  }
});
api.put('/api/admin/classrooms/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { name, capacity, status, sort } = req.body || {};
  const sets = [], p = [];
  if (name !== undefined) { sets.push('name=?'); p.push(String(name).trim()); }
  if (capacity !== undefined) { sets.push('capacity=?'); p.push(Number(capacity) || 1); }
  if (status !== undefined) { sets.push('status=?'); p.push(Number(status) ? 1 : 0); }
  if (sort !== undefined) { sets.push('sort=?'); p.push(Number(sort) || 0); }
  if (!sets.length) return res.json({ ok: true });
  p.push(req.params.id);
  try {
    await q(`UPDATE classrooms SET ${sets.join(',')} WHERE id=?`, p);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '教室名称已存在' });
    throw e;
  }
});
// 删除教室：先解除排课引用，避免历史课表丢失教室信息时报外键错
api.delete('/api/admin/classrooms/:id', authenticate, requireRole('admin'), async (req, res) => {
  await q('UPDATE availability SET classroom_id=NULL WHERE classroom_id=?', [req.params.id]);
  await q('UPDATE bookings SET classroom_id=NULL WHERE classroom_id=?', [req.params.id]);
  await q('DELETE FROM classrooms WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// 快捷排课（管理员任意教师；教师强制排给自己）
api.post('/api/admin/quick-schedule', authenticate, async (req, res) => {
  const { startDate, endDate, startHour = 10, endHour = 21, weekdaysOnly = false } = req.body;
  const teacherId = req.user.role === 'admin' ? req.body.teacherId : req.user.teacherId;
  if (!teacherId || !startDate || !endDate) return res.status(400).json({ error: '缺少 teacherId/startDate/endDate' });
  const slots = [];
  const fmtLocal = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  let d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    const dow = d.getDay();
    if (!(weekdaysOnly && (dow === 0 || dow === 6))) {
      for (let h = startHour; h < endHour; h++) {
        // 用本地日期，避免 toISOString() 在 GMT+8 下把日期减一天
        slots.push([teacherId, fmtLocal(d), `${String(h).padStart(2,'0')}:00:00`, `${String(h+1).padStart(2,'0')}:00:00`, 1]);
      }
    }
    d.setDate(d.getDate() + 1);
  }
  if (slots.length) {
    await q(
      `INSERT INTO availability (teacher_id, slot_date, start_time, end_time, status) VALUES ?
       ON DUPLICATE KEY UPDATE status=VALUES(status)`,
      [slots]
    );
  }
  res.json({ ok: true, generated: slots.length });
});

// 课表导出 CSV（教师只能导出自己）
api.get('/api/admin/schedule/export', authenticate, async (req, res) => {
  const { from, to } = req.query;
  let teacherId = req.query.teacherId;
  if (req.user.role === 'teacher') teacherId = req.user.teacherId; // 强制自身
  let sql = `SELECT a.slot_date, a.start_time, a.end_time, t.name AS teacher_name,
                    b.member_id, m.name AS member_name, c.title AS course_title, a.status
             FROM availability a
             LEFT JOIN teachers t ON a.teacher_id=t.id
             LEFT JOIN bookings b ON b.slot_date=a.slot_date AND b.start_time=a.start_time AND b.teacher_id=a.teacher_id AND b.status!=3
             LEFT JOIN members m ON b.member_id=m.id
             LEFT JOIN courses c ON b.course_id=c.id
             WHERE 1=1`;
  const p = [];
  if (from) { sql += ' AND a.slot_date >= ?'; p.push(from); }
  if (to) { sql += ' AND a.slot_date <= ?'; p.push(to); }
  if (teacherId) { sql += ' AND a.teacher_id = ?'; p.push(teacherId); }
  sql += ' ORDER BY a.slot_date, a.start_time';
  const rows = await q(sql, p);
  const header = ['日期', '开始', '结束', '教师', '学员', '课程', '状态'];
  const statusMap = { 1: '可约', 0: '已约' };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.slot_date, r.start_time, r.end_time, r.teacher_name || '',
      r.member_name || '', r.course_title || '', statusMap[r.status] || r.status
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule.csv"');
  res.send('﻿' + lines.join('\n'));
});

// ================= 概览统计 + 图表聚合 =================
api.get('/api/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
  const [members] = await q('SELECT COUNT(*) c FROM members');
  const [courses] = await q('SELECT COUNT(*) c FROM courses WHERE status=1');
  const [bookings] = await q('SELECT COUNT(*) c FROM bookings WHERE status!=3');
  const [pending] = await q('SELECT COUNT(*) c FROM bookings WHERE status=1');
  const [records] = await q('SELECT COUNT(*) c FROM class_records WHERE status=1');
  const [slots] = await q('SELECT COUNT(*) c FROM availability WHERE status=1');
  res.json({
    members: members.c, courses: courses.c, bookings: bookings.c,
    pendingBookings: pending.c, records: records.c, availableSlots: slots.c
  });
});

api.get('/api/admin/charts', authenticate, requireRole('admin'), async (req, res) => {
  const dates = lastNDates(14);
  const bkRows = await q(
    `SELECT slot_date, COUNT(*) c FROM bookings WHERE slot_date >= ? GROUP BY slot_date`,
    [dates[0]]
  );
  const rcRows = await q(
    `SELECT class_date, COUNT(*) c FROM class_records WHERE class_date >= ? GROUP BY class_date`,
    [dates[0]]
  );
  const bkMap = Object.fromEntries(bkRows.map(r => [r.slot_date, r.c]));
  const rcMap = Object.fromEntries(rcRows.map(r => [r.class_date, r.c]));
  const bookingTrend = dates.map(d => ({ date: d, count: bkMap[d] || 0 }));
  const recordTrend = dates.map(d => ({ date: d, count: rcMap[d] || 0 }));

  const courseDist = await q(
    `SELECT c.title AS name, COUNT(b.id) AS value
     FROM courses c LEFT JOIN bookings b ON b.course_id=c.id AND b.status!=3
     GROUP BY c.id, c.title ORDER BY value DESC LIMIT 8`
  );
  const teacherWorkload = await q(
    `SELECT t.name AS name, COUNT(r.id) AS value
     FROM teachers t LEFT JOIN class_records r ON r.teacher_id=t.id AND r.status=1
     GROUP BY t.id, t.name ORDER BY value DESC`
  );
  const [bs] = await q(
    `SELECT
       SUM(status=1) AS pending, SUM(status=2) AS confirmed,
       SUM(status=3) AS cancelled, SUM(status=4) AS completed
     FROM bookings`
  );
  const statusBreakdown = [
    { name: '待确认', value: bs.pending || 0 },
    { name: '已确认', value: bs.confirmed || 0 },
    { name: '已取消', value: bs.cancelled || 0 },
    { name: '已完成', value: bs.completed || 0 },
  ];
  res.json({ bookingTrend, recordTrend, courseDist, teacherWorkload, statusBreakdown });
});

// ==================================================================
// 小程序端：教师 / 学生 双角色（无管理员）
// 教师：只能调整自己名下「已上架」课程的可约时段
// 学生：只能按教师已开放的可约时段预约
// ==================================================================
const BOOKING_STATUS = { 1: '待确认', 2: '已确认', 3: '已取消', 4: '已完成' };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function minOf(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function hhmmss(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}
function hhmm(t) { return String(t || '').slice(0, 5); }
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

// 某教师在日期区间内、所有有效预约占用的时间区间（按日期分组）
async function occupiedRanges(teacherId, from, to) {
  const rows = await q(
    `SELECT slot_date, start_time, end_time FROM bookings
     WHERE teacher_id=? AND status IN (1,2) AND slot_date BETWEEN ? AND ?`,
    [teacherId, from, to]
  );
  const map = {};
  for (const r of rows) {
    (map[r.slot_date] ||= []).push([minOf(r.start_time), minOf(r.end_time)]);
  }
  return map;
}

// ---------- 登录 / 身份 ----------
api.post('/api/app/login', async (req, res) => {
  const { role, username, password } = req.body || {};
  if (!['teacher', 'student', 'admin'].includes(role)) return res.status(400).json({ error: '请选择登录身份' });
  const rows = await q(
    'SELECT id,username,role,teacher_id,member_id FROM admin_users WHERE username=? AND password=?',
    [username || '', password || '']
  );
  const u = rows[0];
  if (!u || u.role !== role) return res.status(401).json({ error: '账号或密码错误，或身份选择不正确' });

  // 管理员：小程序里可代任意教师排课（教师侧页面顶部可切换教师）
  if (role === 'admin') {
    const token = signToken({ uid: u.id, username: u.username, role: 'admin', teacherId: null, memberId: null });
    return res.json({ ok: true, token, role, username: u.username, name: '管理员' });
  }

  let profile;
  if (role === 'teacher') {
    const [t] = await q('SELECT id,name,gender,title,bio,avatar,status FROM teachers WHERE id=?', [u.teacher_id]);
    if (!t || t.status !== 1) return res.status(403).json({ error: '教师账号不可用' });
    profile = { teacherId: t.id, name: t.name, gender: t.gender, title: t.title, bio: t.bio, avatar: t.avatar };
  } else {
    const [m] = await q('SELECT id,name,phone,avatar,gender,age,openid FROM members WHERE id=?', [u.member_id]);
    if (!m) return res.status(403).json({ error: '学员账号不可用' });
    profile = {
      memberId: m.id, name: m.name, phone: m.phone, avatar: m.avatar,
      gender: m.gender || null, age: m.age || null, hasWx: Boolean(m.openid),
    };
  }
  const token = signToken({
    uid: u.id, username: u.username, role,
    teacherId: role === 'teacher' ? u.teacher_id : null,
    memberId: role === 'student' ? u.member_id : null,
  });
  res.json({ ok: true, token, role, username: u.username, ...profile });
});

// ---------------- 学员自助注册 / 微信快捷登录 ----------------
// 教师账号只能由管理员在后台创建，这里只处理学员。
// 微信登录需要的服务端配置（云托管环境变量/部署 secrets）：
//   WX_APPID  小程序 AppID
//   WX_SECRET 小程序 AppSecret
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
const wxReady = () => Boolean(WX_APPID && WX_SECRET);

// 微信登录只证明「这个微信是谁」，真正建档还要填姓名/年龄，所以先发一张 10 分钟有效的票据，
// 注册时再带着票据绑定 openid，避免把 openid 直接暴露给客户端。
function signBindTicket(openid) {
  return signToken({ kind: 'wx_bind', openid, exp: Date.now() + 10 * 60 * 1000 });
}
function verifyBindTicket(ticket) {
  const p = verifyToken(ticket);
  if (!p || p.kind !== 'wx_bind' || !p.openid) return null;
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}

async function studentSession(member, username) {
  const token = signToken({
    uid: 0,
    username: username || '',
    role: 'student',
    teacherId: null,
    memberId: member.id,
  });
  return {
    ok: true,
    token,
    role: 'student',
    username: username || '微信用户',
    memberId: member.id,
    name: member.name,
    gender: member.gender || null,
    age: member.age || null,
    phone: member.phone || null,
    avatar: member.avatar || null,
    hasWx: Boolean(member.openid),
  };
}

// 微信一键登录：已绑定 openid 直接登录，没绑定返回 needRegister + ticket
api.post('/api/app/wx-login', async (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少微信登录 code' });
  if (!wxReady()) {
    return res.status(503).json({ error: '服务端未配置微信登录（WX_APPID / WX_SECRET）' });
  }

  let data;
  try {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(WX_APPID) +
      '&secret=' + encodeURIComponent(WX_SECRET) +
      '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
    const r = await fetch(url);
    data = await r.json();
  } catch (e) {
    return res.status(502).json({ error: '微信服务暂不可用，请稍后重试' });
  }
  if (!data || !data.openid) {
    return res.status(400).json({ error: '微信登录失败：' + ((data && data.errmsg) || '未取到 openid') });
  }

  const [m] = await q(
    'SELECT id,name,gender,age,phone,avatar FROM members WHERE openid=? LIMIT 1',
    [data.openid]
  );
  if (!m) {
    // 新微信：先给票据，让用户补姓名/年龄/账号后再建档
    return res.json({ ok: true, needRegister: true, ticket: signBindTicket(data.openid) });
  }
  const [acc] = await q(
    "SELECT username FROM admin_users WHERE member_id=? AND role='student' LIMIT 1",
    [m.id]
  );
  res.json(await studentSession(m, acc ? acc.username : ''));
});

// 学员注册（账号密码方式，或带微信票据的一次性绑定）
api.post('/api/app/register', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 50);
  const ageRaw = b.age;
  const age = ageRaw === '' || ageRaw == null ? null : Number(ageRaw);
  const gender = ['男', '女', '保密'].includes(b.gender) ? b.gender : null;
  const phone = String(b.phone || '').trim().slice(0, 32) || null;
  const username = String(b.username || '').trim();
  const password = String(b.password || '');

  if (!name) return res.status(400).json({ error: '请填写姓名' });
  if (!age || Number.isNaN(age) || age < 3 || age > 100) return res.status(400).json({ error: '请填写正确的年龄（3-100）' });
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });

  // 微信注册：openid 就是身份凭证，账号密码是可选项（换了手机想用账号登录时才需要）
  let openid = null;
  if (b.ticket) {
    const t = verifyBindTicket(b.ticket);
    if (!t) return res.status(400).json({ error: '微信授权已过期，请重新点击微信登录' });
    openid = t.openid;
    const [bound] = await q('SELECT id FROM members WHERE openid=? LIMIT 1', [openid]);
    if (bound) return res.status(409).json({ error: '该微信已注册过，请直接用微信登录' });
  }

  // 账号密码：微信注册时可留空；不带微信票据（纯账号注册）时必填
  const wantsAccount = Boolean(username || password);
  if (!openid && !wantsAccount) {
    return res.status(400).json({ error: '请设置登录账号和密码' });
  }
  if (wantsAccount) {
    if (!/^[A-Za-z0-9_.@-]{3,50}$/.test(username)) {
      return res.status(400).json({ error: '账号只能包含字母、数字、_ . @ -，长度 3-50' });
    }
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const [dup] = await q('SELECT id FROM admin_users WHERE username=?', [username]);
    if (dup) return res.status(409).json({ error: '该账号已被占用，换一个试试' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [mr] = await conn.query(
      'INSERT INTO members (name, gender, age, phone, openid, source) VALUES (?,?,?,?,?,?)',
      [name, gender, age, phone, openid, 'self']
    );
    const memberId = mr.insertId;
    if (wantsAccount) {
      await conn.query(
        "INSERT INTO admin_users (username, password, role, member_id) VALUES (?,?, 'student', ?)",
        [username, password, memberId]
      );
    }
    await conn.commit();
    res.json(await studentSession({ id: memberId, name, gender, age, phone, avatar: null, openid }, wantsAccount ? username : ''));
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '账号或微信已被占用' });
    throw e;
  } finally {
    conn.release();
  }
});

// 学员补设 / 修改登录账号密码（微信注册的学员想换手机登录时用）
api.post('/api/app/set-account', authenticate, requireRole('student'), async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!/^[A-Za-z0-9_.@-]{3,50}$/.test(username)) {
    return res.status(400).json({ error: '账号只能包含字母、数字、_ . @ -，长度 3-50' });
  }
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  const memberId = req.user.memberId;
  const [ex] = await q("SELECT id,username FROM admin_users WHERE member_id=? AND role='student' LIMIT 1", [memberId]);
  // q() 返回行数组，这里要判断「有没有别人占用这个名字」
  const dupRows = await q('SELECT id FROM admin_users WHERE username=?', [username]);
  const dup = dupRows[0] || null;
  if (dup && (!ex || dup.id !== ex.id)) {
    return res.status(409).json({ error: '该账号已被占用，换一个试试' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (ex) {
      await conn.query('UPDATE admin_users SET username=?, password=? WHERE id=?', [username, password, ex.id]);
    } else {
      await conn.query(
        "INSERT INTO admin_users (username, password, role, member_id) VALUES (?,?, 'student', ?)",
        [username, password, memberId]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该账号已被占用，换一个试试' });
    throw e;
  } finally {
    conn.release();
  }

  // 账号刚建好/改完，重新签发一次 token，保证 uid/username 是最新的
  const [m] = await q('SELECT id,name,gender,age,phone,avatar,openid FROM members WHERE id=?', [memberId]);
  res.json(await studentSession(m || { id: memberId, name: '' }, username));
});

// 学员登录后绑定微信（账号密码注册的学员，补绑后就能微信一键登录）
api.post('/api/app/bind-wx', authenticate, requireRole('student'), async (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少微信登录 code' });
  if (!wxReady()) return res.status(503).json({ error: '服务端未配置微信登录（WX_APPID / WX_SECRET）' });

  let data;
  try {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(WX_APPID) +
      '&secret=' + encodeURIComponent(WX_SECRET) +
      '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
    const r = await fetch(url);
    data = await r.json();
  } catch (e) {
    return res.status(502).json({ error: '微信服务暂不可用，请稍后重试' });
  }
  if (!data || !data.openid) {
    return res.status(400).json({ error: '微信绑定失败：' + ((data && data.errmsg) || '未取到 openid') });
  }

  const memberId = req.user.memberId;
  const [mine] = await q('SELECT id,openid FROM members WHERE id=?', [memberId]);
  if (!mine) return res.status(404).json({ error: '学员档案不存在' });
  if (mine.openid === data.openid) return res.json({ ok: true, hasWx: true, already: true });

  const [other] = await q('SELECT id,name FROM members WHERE openid=? AND id<>? LIMIT 1', [data.openid, memberId]);
  if (other) {
    return res.status(409).json({ error: `该微信已绑定其他学员账号（${other.name}），请用那个账号或换个微信` });
  }

  await q('UPDATE members SET openid=? WHERE id=?', [data.openid, memberId]);
  res.json({ ok: true, hasWx: true });
});

api.get('/api/app/me', authenticate, async (req, res) => {
  const u = req.user;
  if (u.role === 'admin') return res.json({ ...u, name: '管理员' });
  if (!['teacher', 'student'].includes(u.role)) return res.status(403).json({ error: '非小程序账号' });
  if (u.role === 'teacher') {
    const [t] = await q('SELECT id,name,gender,title,avatar FROM teachers WHERE id=?', [u.teacherId]);
    return res.json({ ...u, name: t?.name, gender: t?.gender, title: t?.title, avatar: t?.avatar });
  }
  const [m] = await q('SELECT id,name,phone,avatar,gender,age,openid FROM members WHERE id=?', [u.memberId]);
  const [acc] = await q("SELECT username FROM admin_users WHERE member_id=? AND role='student' LIMIT 1", [u.memberId]);
  res.json({
    ...u,
    username: acc ? acc.username : '',
    hasAccount: Boolean(acc),
    name: m?.name,
    phone: m?.phone,
    avatar: m?.avatar,
    gender: m?.gender || null,
    age: m?.age || null,
    hasWx: Boolean(m && m.openid),
  });
});

// ---------- 学生：概览 / 可约时段 / 预约 / 记录 ----------
api.get('/api/app/student/overview', authenticate, requireRole('student'), async (req, res) => {
  const t = todayStr();
  const [p] = await q('SELECT id,name,phone,avatar FROM members WHERE id=?', [req.user.memberId]);
  const [b] = await q(
    'SELECT COUNT(*) c FROM bookings WHERE member_id=? AND status IN (1,2) AND slot_date>=?',
    [req.user.memberId, t]
  );
  const [r] = await q(
    'SELECT COUNT(*) c FROM class_records WHERE member_id=? AND status=1', [req.user.memberId]
  );
  const [e] = await q(
    `SELECT COALESCE(SUM(status=1),0) approved, COALESCE(SUM(status=0),0) pending
     FROM enrollments WHERE member_id=?`, [req.user.memberId]
  );
  res.json({
    ...(p || {}), upcoming: b.c, records: r.c,
    enrolled: Number(e.approved || 0), pendingEnroll: Number(e.pending || 0),
    // 课时口径：已上 = 上课记录数；未上 = 尚未开课的有效预约数（含今天及以后）
    hoursDone: Number(r.c || 0),
    hoursUpcoming: Number(b.c || 0),
    hoursTotal: Number(r.c || 0) + Number(b.c || 0),
  });
});

// 可约时段：只返回 status=1、属于该教师、且未被任何有效预约时间重叠占用的时段
api.get('/api/app/slots', authenticate, requireRole('student'), async (req, res) => {
  const { teacherId, courseId, from, to } = req.query;
  if (!teacherId || !from || !to) return res.status(400).json({ error: '缺少 teacherId/from/to' });
  const [t] = await q('SELECT id,status FROM teachers WHERE id=?', [teacherId]);
  if (!t || t.status !== 1) return res.status(400).json({ error: '教师不可用' });

  // 把「可约 + 已被约」的时段一起返回：已被约的也要展示出来（标明是我约的还是别人约的），
  // 但前端不允许再选。注意 a.status IN (0,1)：0 = 已被占用，1 = 可约。
  // 只返回**指定了课程**的时段：教师课表上没填课程名的时段不进入学生预约列表（避免学生约到无名课）。
  const rows = await q(
    `SELECT a.id,a.course_id,a.slot_date,a.start_time,a.end_time,a.classroom_id,
            a.status, cr.name AS classroom_name, c.title AS course_title,
            b.id AS booking_id, b.member_id AS booking_member
     FROM availability a
     JOIN courses c ON c.id = a.course_id AND c.status = 1
     LEFT JOIN classrooms cr ON a.classroom_id=cr.id
     LEFT JOIN bookings b ON b.teacher_id=a.teacher_id AND b.slot_date=a.slot_date
          AND b.start_time=a.start_time AND b.status IN (1,2)
     WHERE a.teacher_id=? AND a.slot_date BETWEEN ? AND ? AND a.status IN (0,1)
       AND COALESCE(c.title,'') <> ''
       AND (? IS NULL OR a.course_id=?)
     ORDER BY a.slot_date,a.start_time`,
    [teacherId, from, to, courseId || null, courseId || null]
  );
  const occ = await occupiedRanges(teacherId, from, to);
  const me = req.user.memberId;
  const byDate = {};
  for (const r of rows) {
    const st = minOf(r.start_time), en = minOf(r.end_time);
    const takenByLesson = (occ[r.slot_date] || []).some(([bs, be]) => overlaps(st, en, bs, be));
    const hasBooking = r.booking_id != null;
    const booked = hasBooking || r.status === 0 || takenByLesson;
    // mine 只在能确认是本条预约时才是 true（别的来源占用一律按「已被预约」处理）
    const mine = hasBooking && Number(r.booking_member) === Number(me);
    (byDate[r.slot_date] ||= []).push({
      id: r.id, start: hhmm(r.start_time), end: hhmm(r.end_time), courseId: r.course_id,
      courseTitle: r.course_title || '',
      classroomId: r.classroom_id, classroomName: r.classroom_name,
      booked, mine,
    });
  }
  res.json(byDate);
});

api.post('/api/app/bookings', authenticate, requireRole('student'), async (req, res) => {
  const { courseId, teacherId, slotDate, startTime, remark } = req.body || {};
  if (!teacherId || !slotDate || !startTime) return res.status(400).json({ error: '缺少必要参数' });
  const [course] = await q('SELECT id,title,duration_min,teacher_id,status FROM courses WHERE id=?', [courseId]);
  if (!course || course.status !== 1) return res.status(400).json({ error: '课程未上架或不存在' });
  const [teacher] = await q('SELECT id,status FROM teachers WHERE id=?', [teacherId]);
  if (!teacher || teacher.status !== 1) return res.status(400).json({ error: '教师不可用' });

  // 报名门槛：只有审核通过的课程才允许预约（前端按钮也会拦截，这里是强校验）
  const [enroll] = await q(
    'SELECT status FROM enrollments WHERE member_id=? AND course_id=?',
    [req.user.memberId, courseId]
  );
  if (!enroll || enroll.status !== 1) {
    return res.status(403).json({ error: '请先报名该课程并等待审核通过，再预约时间' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [slots] = await conn.query(
      `SELECT id,start_time,end_time,status,course_id,classroom_id FROM availability
       WHERE teacher_id=? AND slot_date=? AND start_time=? FOR UPDATE`,
      [teacherId, slotDate, startTime]
    );
    if (!slots.length || slots[0].status !== 1) {
      await conn.rollback();
      return res.status(409).json({ error: '该时段不可预约或已被占用' });
    }
    const slot = slots[0];
    // 教师课表上没指定课程的时段不对外开放预约
    if (!slot.course_id) {
      await conn.rollback();
      return res.status(409).json({ error: '该时段未指定课程，暂不可预约' });
    }
    if (slot.course_id && courseId && String(slot.course_id) !== String(courseId)) {
      await conn.rollback();
      return res.status(409).json({ error: '该时段不属于所选课程' });
    }
    const st = minOf(slot.start_time), en = minOf(slot.end_time);
    const [booked] = await conn.query(
      'SELECT start_time,end_time FROM bookings WHERE teacher_id=? AND slot_date=? AND status IN (1,2)',
      [teacherId, slotDate]
    );
    if (booked.some((b) => overlaps(st, en, minOf(b.start_time), minOf(b.end_time)))) {
      await conn.rollback();
      return res.status(409).json({ error: '与已有课程时间冲突' });
    }
    await conn.query('UPDATE availability SET status=0 WHERE id=?', [slot.id]);
    const [r] = await conn.query(
      `INSERT INTO bookings (member_id,course_id,teacher_id,slot_date,start_time,end_time,status,remark,classroom_id)
       VALUES (?,?,?,?,?,?,2,?,?)`,
      [req.user.memberId, courseId, teacherId, slotDate, slot.start_time, slot.end_time, remark || null, slot.classroom_id || null]
    );
    await conn.query(
      `INSERT INTO messages (member_id,type,title,content,related_id) VALUES (?,'booking_success','预约成功',?,?)`,
      [req.user.memberId, `您预约的「${course.title}」已确认（${slotDate} ${hhmm(slot.start_time)}），请准时到课。`, r.insertId]
    );
    await conn.commit();
    res.json({ ok: true, bookingId: r.insertId });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

api.get('/api/app/bookings', authenticate, requireRole('student'), async (req, res) => {
  const rows = await q(
    `SELECT b.id,b.slot_date,b.start_time,b.end_time,b.status,b.remark,
            c.title AS course_title, c.duration_min, c.cover_image,
            t.name AS teacher_name, t.avatar AS teacher_avatar,
            cr.name AS classroom_name
     FROM bookings b LEFT JOIN courses c ON b.course_id=c.id
     LEFT JOIN teachers t ON b.teacher_id=t.id
     LEFT JOIN classrooms cr ON b.classroom_id=cr.id
     WHERE b.member_id=? ORDER BY b.slot_date DESC,b.start_time DESC`,
    [req.user.memberId]
  );
  const today = todayStr();
  res.json(rows.map((r) => ({
    ...r,
    startText: hhmm(r.start_time), endText: hhmm(r.end_time),
    statusText: BOOKING_STATUS[r.status] || '未知',
    canCancel: r.status === 2 && r.slot_date >= today,
  })));
});

api.post('/api/app/bookings/:id/cancel', authenticate, requireRole('student'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [b] = await conn.query('SELECT * FROM bookings WHERE id=? FOR UPDATE', [req.params.id]);
    if (!b.length) { await conn.rollback(); return res.status(404).json({ error: '预约不存在' }); }
    const bk = b[0];
    if (String(bk.member_id) !== String(req.user.memberId)) {
      await conn.rollback(); return res.status(403).json({ error: '只能取消自己的预约' });
    }
    if (bk.status === 3) { await conn.rollback(); return res.status(400).json({ error: '该预约已取消' }); }
    await conn.query('UPDATE bookings SET status=3 WHERE id=?', [bk.id]);
    await conn.query(
      'UPDATE availability SET status=1 WHERE teacher_id<=>? AND slot_date=? AND start_time=?',
      [bk.teacher_id, bk.slot_date, bk.start_time]
    );
    await conn.query(
      `INSERT INTO messages (member_id,type,title,content,related_id) VALUES (?,'booking_cancel','预约已取消',?,?)`,
      [bk.member_id, `您 ${bk.slot_date} ${hhmm(bk.start_time)} 的预约已取消。`, bk.id]
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

api.get('/api/app/records', authenticate, requireRole('student'), async (req, res) => {
  const rows = await q(
    `SELECT r.*, c.title AS course_title, t.name AS teacher_name
     FROM class_records r LEFT JOIN courses c ON r.course_id=c.id
     LEFT JOIN teachers t ON r.teacher_id=t.id
     WHERE r.member_id=? ORDER BY r.class_date DESC`,
    [req.user.memberId]
  );
  res.json(rows.map((r) => ({ ...r, startText: hhmm(r.start_time), endText: hhmm(r.end_time) })));
});

// ---------- 教师：概览 / 已上架课程 / 可约时段 / 学生预约 ----------
api.get('/api/app/teacher/overview', authenticate, requireRole('teacher'), async (req, res) => {
  const t = todayStr();
  const [a] = await q('SELECT COUNT(*) c FROM availability WHERE teacher_id=? AND status=1 AND slot_date>=?', [req.user.teacherId, t]);
  const [b] = await q('SELECT COUNT(*) c FROM bookings WHERE teacher_id=? AND status IN (1,2) AND slot_date>=?', [req.user.teacherId, t]);
  const [c] = await q('SELECT COUNT(*) c FROM courses WHERE teacher_id=? AND status=1', [req.user.teacherId]);
  const [d] = await q('SELECT COUNT(*) c FROM bookings WHERE teacher_id=? AND status IN (1,2) AND slot_date=?', [req.user.teacherId, t]);
  const [e] = await q(
    `SELECT COUNT(*) c FROM enrollments e JOIN courses c ON c.id=e.course_id
     WHERE c.teacher_id=? AND e.status=0`, [req.user.teacherId]
  );
  res.json({ openSlots: a.c, upcoming: b.c, courses: c.c, today: d.c, pendingEnroll: e.c });
});

// 教师只能看到自己名下、且已经上架的课程；管理员可指定 teacherId 代看
api.get('/api/app/teacher/courses', authenticate, requireRole('teacher', 'admin'), async (req, res) => {
  const tid = await teacherScope(req, req.query.teacherId);
  if (!tid) return res.json([]);
  const rows = await q(
    `SELECT c.id,c.title,c.category,c.description,c.cover_image,c.duration_min,c.teacher_id,
            t.name AS teacher_name,
            (SELECT COUNT(*) FROM availability a WHERE a.course_id=c.id AND a.status=1 AND a.slot_date>=CURDATE()) AS open_slots,
            (SELECT COUNT(*) FROM bookings b WHERE b.course_id=c.id AND b.status IN (1,2) AND b.slot_date>=CURDATE()) AS upcoming
     FROM courses c LEFT JOIN teachers t ON c.teacher_id=t.id
     WHERE c.status=1 AND c.teacher_id=? ORDER BY c.sort,c.id`,
    [tid]
  );
  res.json(rows);
});

api.get('/api/app/teacher/slots', authenticate, requireRole('teacher', 'admin'), async (req, res) => {
  const { from, to, courseId } = req.query;
  const tid = await teacherScope(req, req.query.teacherId);
  if (!tid) return res.json([]);
  const f = from || todayStr(), tt = to || f;
  const rows = await q(
    `SELECT a.id,a.course_id,a.slot_date,a.start_time,a.end_time,a.status,a.classroom_id,
            c.title AS course_title, cr.name AS classroom_name,
            EXISTS(SELECT 1 FROM bookings b WHERE b.teacher_id=a.teacher_id
                   AND b.slot_date=a.slot_date AND b.start_time=a.start_time
                   AND b.status IN (1,2)) AS booked
     FROM availability a LEFT JOIN courses c ON a.course_id=c.id
     LEFT JOIN classrooms cr ON a.classroom_id=cr.id
     WHERE a.teacher_id=? AND a.slot_date BETWEEN ? AND ?
       AND (? IS NULL OR a.course_id=? OR a.course_id IS NULL)
     ORDER BY a.slot_date,a.start_time`,
    [tid, f, tt, courseId || null, courseId || null]
  );
  res.json(rows.map((r) => ({
    ...r, startText: hhmm(r.start_time), endText: hhmm(r.end_time),
    booked: !!r.booked, generic: r.course_id == null,
    classroomName: r.classroom_name || '',
  })));
});

// 批量开放可约时段：课程必须在自己（或管理员指定教师）名下且已上架。
// 支持两种入参：
//   slots: [{ start:'14:00', end:'17:00' }]  —— 显式起止（小程序拖拽框选，时段 = 所选区间本身）
//   starts: ['14:00', ...]                    —— 兼容旧调用，结束时间按课程时长推导
// 重叠处理与网页端一致：与「本人已有空闲时段」重叠时直接替换（删旧插新）；
// 与已预约时段重叠时跳过，绝不覆盖学生已约的课。
api.post('/api/app/teacher/slots', authenticate, requireRole('teacher', 'admin'), async (req, res) => {
  const { courseId, date, starts, classroomId } = req.body || {};
  const rawSlots = req.body && req.body.slots;
  const hasRanges = Array.isArray(rawSlots) && rawSlots.length;
  const hasStarts = Array.isArray(starts) && starts.length;
  if (!courseId || !date || (!hasRanges && !hasStarts))
    return res.status(400).json({ error: '缺少 courseId/date 与 slots 或 starts' });

  const tid = await teacherScope(req, req.body.teacherId);
  if (!tid) return res.status(400).json({ error: '未指定教师' });
  const [course] = await q('SELECT id,duration_min,teacher_id,status FROM courses WHERE id=?', [courseId]);
  if (!course || course.status !== 1 || String(course.teacher_id) !== String(tid))
    return res.status(403).json({ error: '只能调整该教师名下已上架课程的课表' });

  const duration = Number(course.duration_min || 60);
  const wanted = [];
  if (hasRanges) {
    rawSlots.forEach((r) => {
      if (!r) return;
      const st = minOf(r.start), en = minOf(r.end);
      if (Number.isFinite(st) && Number.isFinite(en)) wanted.push([st, en]);
    });
  } else {
    starts.forEach((s) => {
      const st = minOf(s);
      if (Number.isFinite(st)) wanted.push([st, st + duration]);
    });
  }

  const occ = await occupiedRanges(tid, date, date);
  const booked = occ[date] || [];
  const existing = await q(
    'SELECT id,start_time,end_time FROM availability WHERE teacher_id=? AND slot_date=?',
    [tid, date]
  );
  // 已被学生预约的 availability 不可删除（与 bookings 区间有交集即视为已占用）
  const isBooked = (a) => {
    const as = minOf(a.start_time), ae = minOf(a.end_time);
    return booked.some(([bs, be]) => overlaps(as, ae, bs, be));
  };

  let created = 0, skipped = 0, replaced = 0;
  const fresh = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [st, en] of wanted) {
      if (en <= st || en - st < 30 || st < 6 * 60 || en > 24 * 60) { skipped++; continue; }
      // 与已预约时段重叠 → 跳过，不覆盖学生的课
      if (booked.some(([bs, be]) => overlaps(st, en, bs, be))) { skipped++; continue; }
      // 与本次已插入的区间重叠 → 跳过，避免自相重叠
      if (fresh.some(([bs, be]) => overlaps(st, en, bs, be))) { skipped++; continue; }

      // 同教师、同一天、与新区间重叠且未被预约的旧时段 → 直接替换
      const del = existing.filter((a) => {
        if (isBooked(a)) return false;
        return overlaps(st, en, minOf(a.start_time), minOf(a.end_time));
      }).map((a) => a.id);
      if (del.length) {
        await conn.query('DELETE FROM availability WHERE id IN (?)', [del]);
        for (let i = existing.length - 1; i >= 0; i--) {
          if (del.indexOf(existing[i].id) >= 0) existing.splice(i, 1);
        }
        replaced += del.length;
      }

      await conn.query(
        `INSERT INTO availability (teacher_id,course_id,slot_date,start_time,end_time,status,classroom_id)
         VALUES (?,?,?,?,?,1,?)
         ON DUPLICATE KEY UPDATE status=1, end_time=VALUES(end_time), course_id=VALUES(course_id),
           classroom_id=IF(VALUES(classroom_id) IS NULL, classroom_id, VALUES(classroom_id))`,
        [tid, courseId, date, hhmmss(st), hhmmss(en), classroomId || null]
      );
      fresh.push([st, en]);
      created++;
    }
    await conn.commit();
    res.json({ ok: true, created, skipped, replaced });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// 批量关闭时段：教师本人可关闭自己的时段（含已预约的：会先取消该预约并通知学员）
// （同时提供 POST 路由，避免部分小程序基础库不发送 DELETE body）
async function deleteTeacherSlots(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '缺少 ids' });
  const tid = await teacherScope(req, req.body.teacherId);
  if (!tid) return res.status(400).json({ error: '未指定教师' });
  // 先取出这些时段上的有效预约，删除时段时一并取消（否则已预约时段会删不掉，草稿永远保存不上）
  const booked = await q(
    `SELECT b.id, b.member_id, b.slot_date, b.start_time
     FROM bookings b
     JOIN availability a ON a.teacher_id=b.teacher_id AND a.slot_date=b.slot_date AND a.start_time=b.start_time
     WHERE a.id IN (?) AND a.teacher_id=? AND b.status IN (1,2)`,
    [ids, tid]
  );
  const r = await q(
    `DELETE a FROM availability a WHERE a.id IN (?) AND a.teacher_id=?`,
    [ids, tid]
  );
  for (const b of booked) {
    await q('UPDATE bookings SET status=3 WHERE id=?', [b.id]);
    await q(
      `INSERT INTO messages (member_id,type,title,content,related_id)
       VALUES (?, 'booking_cancel', '课程安排已调整', ?, ?)`,
      [b.member_id, `教师调整了 ${b.slot_date} ${hhmm(b.start_time)} 的课程安排，原预约已取消，请重新选择时间。`, b.id]
    );
  }
  res.json({ ok: true, deleted: r.affectedRows || 0, canceled: booked.length });
}
api.delete('/api/app/teacher/slots', authenticate, requireRole('teacher', 'admin'), deleteTeacherSlots);
api.post('/api/app/teacher/slots/delete', authenticate, requireRole('teacher', 'admin'), deleteTeacherSlots);

// 小程序排课页「指定学生」：教师/管理员可读全部学员精简列表
api.get('/api/app/teacher/members', authenticate, requireRole('teacher', 'admin'), async (req, res) => {
  res.json(await q('SELECT id,name,phone FROM members ORDER BY created_at DESC'));
});

// 指定 / 更换学生：时段空闲则下单，已有预约则直接把该预约换成新学员（教师侧可随时改）
api.post('/api/app/teacher/assign', authenticate, requireRole('teacher', 'admin'), async (req, res) => {
  const { memberId, courseId, slotDate, startTime, endTime } = req.body || {};
  if (!memberId || !slotDate || !startTime) return res.status(400).json({ error: '缺少必要参数' });
  const tid = await teacherScope(req, req.body.teacherId);
  if (!tid) return res.status(400).json({ error: '未指定教师' });
  // 注意：hhmmss() 收的是「分钟数」，这里传进来的是 'HH:mm' 字符串，必须先转分钟
  const stHms = hhmmss(minOf(startTime));
  const enHms = endTime ? hhmmss(minOf(endTime)) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [slots] = await conn.query(
      'SELECT id,status FROM availability WHERE teacher_id=? AND slot_date=? AND start_time=? FOR UPDATE',
      [tid, slotDate, stHms]
    );
    if (!slots.length) { await conn.rollback(); return res.status(404).json({ error: '该时段不存在，请先保存课表' }); }
    const [exist] = await conn.query(
      'SELECT id,member_id FROM bookings WHERE teacher_id=? AND slot_date=? AND start_time=? AND status IN (1,2) FOR UPDATE',
      [tid, slotDate, stHms]
    );
    if (exist.length) {
      // 已预约 → 直接换人（保留这条预约，不重复占用时段）
      await conn.query(
        `UPDATE bookings SET member_id=?, course_id=COALESCE(?, course_id),
                end_time=COALESCE(?, end_time) WHERE id=?`,
        [memberId, courseId || null, enHms, exist[0].id]
      );
      // 换人后把旧学员从「排课管理的镜像课」里移除，否则网站课表上会同时挂着两个人
      await conn.query(
        `DELETE ls FROM lesson_students ls
         JOIN lessons l ON l.id=ls.lesson_id AND l.origin_kind='booking' AND l.origin_id=?
         WHERE ls.member_id=?`,
        [exist[0].id, exist[0].member_id]
      );
      await conn.commit();
      return res.json({ ok: true, bookingId: exist[0].id, reassigned: true });
    }
    if (slots[0].status !== 1) { await conn.rollback(); return res.status(409).json({ error: '该时段不可预约或已被占用' }); }
    await conn.query('UPDATE availability SET status=0 WHERE id=?', [slots[0].id]);
    const [r] = await conn.query(
      `INSERT INTO bookings (member_id, course_id, teacher_id, slot_date, start_time, end_time, status)
       VALUES (?,?,?,?,?,?,2)`,
      [memberId, courseId || null, tid, slotDate, stHms, enHms]
    );
    await conn.query(
      `INSERT INTO messages (member_id,type,title,content,related_id) VALUES (?, 'booking_success', '预约成功', ?, ?)`,
      [memberId, `您预约的课程已确认（${slotDate} ${hhmm(stHms)}），请准时到课。`, r.insertId]
    );
    await conn.commit();
    res.json({ ok: true, bookingId: r.insertId, reassigned: false });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

api.get('/api/app/teacher/bookings', authenticate, requireRole('teacher'), async (req, res) => {
  const rows = await q(
    `SELECT b.id,b.slot_date,b.start_time,b.end_time,b.status,b.remark,
            c.title AS course_title, c.duration_min,
            m.name AS member_name, m.phone AS member_phone,
            cr.name AS classroom_name
     FROM bookings b LEFT JOIN courses c ON b.course_id=c.id
     LEFT JOIN members m ON b.member_id=m.id
     LEFT JOIN classrooms cr ON b.classroom_id=cr.id
     WHERE b.teacher_id=? AND b.status IN (1,2)
     ORDER BY b.slot_date,b.start_time`,
    [req.user.teacherId]
  );
  res.json(rows.map((r) => ({
    ...r, startText: hhmm(r.start_time), endText: hhmm(r.end_time),
    statusText: BOOKING_STATUS[r.status] || '未知',
  })));
});

// ==================================================================
// 课程报名 / 审核（小程序学员 + 小程序教师 + 网页端管理员 / 教师）
// ==================================================================
const ENROLL_STATUS = { 0: '待审核', 1: '已通过', 2: '已拒绝', 3: '已撤销' };
const ENROLL_PENDING = 0, ENROLL_APPROVED = 1, ENROLL_REJECTED = 2, ENROLL_CANCELED = 3;

// 通用审核：教师只能审核自己名下课程的报名；管理员可审核全部
async function reviewEnrollment(id, user, action, note) {
  const [row] = await q(
    `SELECT e.*, c.title AS course_title, c.teacher_id AS course_teacher_id
     FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.id=?`,
    [id]
  );
  if (!row) return { error: '报名记录不存在', code: 404 };
  if (user.role === 'teacher' && String(row.course_teacher_id) !== String(user.teacherId)) {
    return { error: '只能审核自己名下课程的报名', code: 403 };
  }
  if (row.status === ENROLL_CANCELED) return { error: '该报名已由学员撤销', code: 400 };
  const status = action === 'approve' ? ENROLL_APPROVED : ENROLL_REJECTED;
  await q(
    `UPDATE enrollments SET status=?, review_note=?, reviewed_by=?, reviewed_by_role=?, reviewed_at=NOW() WHERE id=?`,
    [status, note || null, user.uid || null, user.role || 'teacher', id]
  );
  const pass = status === ENROLL_APPROVED;
  await q(
    `INSERT INTO messages (member_id,type,title,content,related_id) VALUES (?,?,?,?,?)`,
    [
      row.member_id,
      pass ? 'enroll_approved' : 'enroll_rejected',
      pass ? '报名已通过' : '报名未通过',
      pass
        ? `你报名的「${row.course_title}」已通过审核，现在可以预约上课时间啦。`
        : `你报名的「${row.course_title}」未通过审核${note ? '：' + note : ''}，可调整后重新提交。`,
      id,
    ]
  );
  return { ok: true, status, statusText: ENROLL_STATUS[status] };
}

// 报名列表公共查询（网页端 & 小程序教师端复用）
async function listEnrollments({ status, teacherId, memberId }) {
  const where = ['1=1'];
  const p = [];
  if (status !== undefined && status !== null && status !== '') {
    where.push('e.status=?'); p.push(status);
  }
  if (teacherId) { where.push('c.teacher_id=?'); p.push(teacherId); }
  if (memberId) { where.push('e.member_id=?'); p.push(memberId); }
  const rows = await q(
    `SELECT e.id,e.member_id,e.course_id,e.teacher_id,e.status,e.remark,e.review_note,
            e.reviewed_by_role,e.reviewed_at,e.created_at,e.updated_at,
            DATE_FORMAT(e.created_at,'%Y-%m-%d %H:%i') AS created_text,
            DATE_FORMAT(e.reviewed_at,'%Y-%m-%d %H:%i') AS reviewed_text,
            c.title AS course_title, c.category, c.duration_min, c.cover_image,
            c.teacher_id AS course_teacher_id,
            t.name AS teacher_name,
            m.name AS member_name, m.phone AS member_phone, m.avatar AS member_avatar
     FROM enrollments e
     JOIN courses c ON c.id=e.course_id
     LEFT JOIN teachers t ON t.id=c.teacher_id
     LEFT JOIN members m ON m.id=e.member_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(e.status,0,1,2,3), e.created_at DESC, e.id DESC`,
    p
  );
  return rows.map((r) => ({ ...r, statusText: ENROLL_STATUS[r.status] || '未知' }));
}

// ---------- 网页端：管理员 / 教师审核 ----------
api.get('/api/admin/enrollments', authenticate, async (req, res) => {
  if (!['admin', 'teacher'].includes(req.user.role)) return res.status(403).json({ error: '无权限' });
  const teacherId = req.user.role === 'teacher' ? req.user.teacherId : null;
  res.json(await listEnrollments({ status: req.query.status, teacherId }));
});

api.get('/api/admin/enrollments/stats', authenticate, async (req, res) => {
  if (!['admin', 'teacher'].includes(req.user.role)) return res.status(403).json({ error: '无权限' });
  const teacherId = req.user.role === 'teacher' ? req.user.teacherId : null;
  const rows = await q(
    `SELECT e.status, COUNT(*) c FROM enrollments e JOIN courses c ON c.id=e.course_id
     WHERE ${teacherId ? 'c.teacher_id=?' : '1=1'} GROUP BY e.status`,
    teacherId ? [teacherId] : []
  );
  const out = { total: 0, pending: 0, approved: 0, rejected: 0, canceled: 0 };
  const key = { 0: 'pending', 1: 'approved', 2: 'rejected', 3: 'canceled' };
  rows.forEach((r) => { out[key[r.status]] = r.c; out.total += r.c; });
  res.json(out);
});

api.put('/api/admin/enrollments/:id/review', authenticate, async (req, res) => {
  if (!['admin', 'teacher'].includes(req.user.role)) return res.status(403).json({ error: '无权限' });
  const { action, note } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效的审核操作' });
  const r = await reviewEnrollment(req.params.id, req.user, action, note);
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json(r);
});

// ---------- 小程序学员：课程列表（带我的报名状态） ----------
api.get('/api/app/courses', authenticate, requireRole('student'), async (req, res) => {
  const rows = await q(
    `SELECT c.*, t.name AS teacher_name,
            (SELECT COUNT(*) FROM availability a WHERE a.course_id=c.id AND a.status=1 AND a.slot_date>=CURDATE()) AS open_slots,
            e.status AS enroll_status, e.id AS enrollment_id, e.review_note
     FROM courses c LEFT JOIN teachers t ON t.id=c.teacher_id
     LEFT JOIN enrollments e ON e.course_id=c.id AND e.member_id=?
     WHERE c.status=1 ORDER BY c.sort,c.id`,
    [req.user.memberId]
  );
  res.json(rows.map((r) => {
    const s = r.enroll_status == null ? -1 : r.enroll_status;
    return {
      ...r,
      enrollStatus: s,
      enrolled: s === ENROLL_APPROVED,
      enrollText: s === -1 ? '未报名' : (ENROLL_STATUS[s] || '未知'),
      canEnroll: s === -1 || s === ENROLL_REJECTED || s === ENROLL_CANCELED,
    };
  }));
});

// ---------- 小程序学员：我的报名 ----------
api.get('/api/app/my/enrollments', authenticate, requireRole('student'), async (req, res) => {
  res.json(await listEnrollments({ memberId: req.user.memberId }));
});

// ---------- 小程序学员：提交报名 ----------
api.post('/api/app/enrollments', authenticate, requireRole('student'), async (req, res) => {
  const { courseId, remark } = req.body || {};
  if (!courseId) return res.status(400).json({ error: '缺少课程参数' });
  const [course] = await q('SELECT id,title,teacher_id,status FROM courses WHERE id=?', [courseId]);
  if (!course || course.status !== 1) return res.status(400).json({ error: '课程未上架或不存在' });
  const [old] = await q(
    'SELECT id,status FROM enrollments WHERE member_id=? AND course_id=?',
    [req.user.memberId, courseId]
  );
  if (old && old.status === ENROLL_APPROVED) return res.status(400).json({ error: '你已报名该课程，无需重复提交' });
  if (old && old.status === ENROLL_PENDING) return res.status(400).json({ error: '报名正在审核中，请耐心等待' });

  let id;
  if (old) {
    // 被拒绝 / 已撤销 → 重新提交，清空上一次审核结果
    await q(
      `UPDATE enrollments SET status=0, remark=?, review_note=NULL, reviewed_by=NULL,
       reviewed_by_role=NULL, reviewed_at=NULL, teacher_id=?, created_at=NOW() WHERE id=?`,
      [remark || null, course.teacher_id || null, old.id]
    );
    id = old.id;
  } else {
    const r = await q(
      `INSERT INTO enrollments (member_id,course_id,teacher_id,status,remark) VALUES (?,?,?,0,?)`,
      [req.user.memberId, courseId, course.teacher_id || null, remark || null]
    );
    id = r.insertId;
  }
  await q(
    `INSERT INTO messages (member_id,type,title,content,related_id) VALUES (?,'enroll_submit','报名已提交',?,?)`,
    [req.user.memberId, `你已提交「${course.title}」的报名，老师或管理员审核通过后即可预约时间。`, id]
  );
  res.json({ ok: true, id, status: ENROLL_PENDING, statusText: ENROLL_STATUS[0] });
});

// ---------- 小程序学员：撤销待审核的报名 ----------
api.post('/api/app/enrollments/:id/cancel', authenticate, requireRole('student'), async (req, res) => {
  const r = await q(
    'UPDATE enrollments SET status=3 WHERE id=? AND member_id=? AND status=0',
    [req.params.id, req.user.memberId]
  );
  if (!r.affectedRows) return res.status(400).json({ error: '只能撤销待审核的报名' });
  res.json({ ok: true, status: ENROLL_CANCELED, statusText: ENROLL_STATUS[3] });
});

// ---------- 小程序教师：报名审核 ----------
api.get('/api/app/teacher/enrollments', authenticate, requireRole('teacher'), async (req, res) => {
  res.json(await listEnrollments({ status: req.query.status, teacherId: req.user.teacherId }));
});

api.post('/api/app/teacher/enrollments/:id/review', authenticate, requireRole('teacher'), async (req, res) => {
  const { action, note } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效的审核操作' });
  const r = await reviewEnrollment(req.params.id, req.user, action, note);
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json(r);
});

// 排课管理页的「课程实例」接口（独立于 availability / 小程序可约时段）
mountLessons(api, { q, authenticate });

// 教师管理（管理员）：档案 + 登录账号
mountAdminTeachers(api, { q, authenticate, requireRole });

// 兜底：挂在 router 末尾，未匹配到任何路由时打日志（否则只有一行无信息的 404，很难查）
api.use((req, res) => {
  console.log(`[api 404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `接口不存在：${req.method} ${req.path}` });
});

// 只有一个前缀：/goldenkey/api/*（网页端、小程序都走这里，不再保留 /api 别名）
app.use(API_PREFIX, api);

// 旧路径 /api/* 给一条明确的 404 提示，避免老客户端只拿到无信息的 HTML 404
app.use('/api', (req, res) => {
  console.log(`[api 404] 旧前缀 ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `接口前缀已改为 ${API_PREFIX}/api`, path: req.originalUrl });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🎹 GoldenKey server on http://localhost:${PORT}${API_PREFIX}/api`));
