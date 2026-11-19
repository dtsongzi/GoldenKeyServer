// 教师管理（管理员）：教师档案 + 登录账号一体增删改查
// 教师账号同时可登录商家端（role=teacher）和小程序端，这里统一维护。
import pool from './db.js';

export function mountAdminTeachers(api, { q, authenticate, requireRole }) {
  const base = '/api/admin/teachers';
  const only = [authenticate, requireRole('admin')];

  const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  // 履历/照片体积较大，单独放宽上限（photos 是 base64 数组 JSON）
  const resumeOf = (v) => str(v, 20000);
  const photosOf = (v) => str(v, 4 * 1024 * 1024);
  // 头像也改为 base64 上传，放宽上限（与 photos 一致）
  const avatarOf = (v) => str(v, 4 * 1024 * 1024);

  // 列表：教师档案 + 登录账号 + 名下课程/课次数量
  api.get(base, ...only, async (req, res) => {
    const kw = str(req.query.keyword, 50);
    const where = kw ? 'WHERE (t.name LIKE ? OR t.phone LIKE ? OR au.username LIKE ?)' : '';
    const params = kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`] : [];
    const rows = await q(
      `SELECT t.id, t.name, t.gender, t.title, t.bio, t.resume, t.avatar, t.phone, t.email,
              t.joined_at, t.remark, t.sort, t.status, t.created_at,
              au.id AS account_id, au.username,
              (SELECT COUNT(*) FROM courses c WHERE c.teacher_id=t.id) AS course_count,
              (SELECT COUNT(*) FROM lessons l WHERE l.teacher_id=t.id) AS lesson_count
         FROM teachers t
         LEFT JOIN admin_users au ON au.teacher_id=t.id AND au.role='teacher'
         ${where}
        ORDER BY t.status DESC, t.sort, t.id`,
      params
    );
    res.json(rows);
  });

  // 单条详情：列表不含照片（base64 体积大），编辑时按 id 取回
  api.get(`${base}/:id`, ...only, async (req, res) => {
    const [t] = await q(
      `SELECT t.id, t.name, t.gender, t.title, t.bio, t.resume, t.photos, t.avatar, t.phone, t.email,
              t.joined_at, t.remark, t.sort, t.status,
              au.id AS account_id, au.username
         FROM teachers t
         LEFT JOIN admin_users au ON au.teacher_id=t.id AND au.role='teacher'
        WHERE t.id=?`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '教师不存在' });
    res.json(t);
  });

  // 新增：教师 + 登录账号（同一事务）
  api.post(base, ...only, async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 50);
    const username = str(b.username, 50);
    const password = str(b.password, 64);
    if (!name) return res.status(400).json({ error: '请填写教师姓名' });
    if (!username) return res.status(400).json({ error: '请填写登录账号' });
    if (!/^[A-Za-z0-9_.@-]{3,50}$/.test(username)) {
      return res.status(400).json({ error: '账号只能包含字母、数字、_ . @ -，长度 3-50' });
    }
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

    const [dup] = await q('SELECT id FROM admin_users WHERE username=?', [username]);
    if (dup) return res.status(409).json({ error: '登录账号已被占用' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO teachers (name, gender, title, bio, resume, photos, avatar, phone, email, joined_at, remark, sort, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          name,
          str(b.gender, 8) || null,
          str(b.title, 50) || '钢琴教师',
          str(b.bio, 2000) || null,
          resumeOf(b.resume) || null,
          photosOf(b.photos) || null,
          avatarOf(b.avatar) || null,
          str(b.phone, 32) || null,
          str(b.email, 128) || null,
          str(b.joined_at, 10) || null,
          str(b.remark, 255) || null,
          num(b.sort) ?? 0,
          b.status === 0 || b.status === '0' ? 0 : 1,
        ]
      );
      const teacherId = r.insertId;
      await conn.query(
        "INSERT INTO admin_users (username, password, role, teacher_id) VALUES (?,?, 'teacher', ?)",
        [username, password, teacherId]
      );
      await conn.commit();
      res.json({ ok: true, id: teacherId });
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '登录账号已被占用' });
      throw e;
    } finally {
      conn.release();
    }
  });

  // 修改：档案 + 登录账号（账号改名要查重；密码改走单独接口）
  api.put(`${base}/:id`, ...only, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const [t] = await q('SELECT id, resume, photos FROM teachers WHERE id=?', [id]);
    if (!t) return res.status(404).json({ error: '教师不存在' });

    const name = str(b.name, 50);
    if (!name) return res.status(400).json({ error: '请填写教师姓名' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE teachers SET name=?, gender=?, title=?, bio=?, resume=?, photos=?, avatar=?, phone=?, email=?,
                             joined_at=?, remark=?, sort=?, status=?
          WHERE id=?`,
        [
          name,
          str(b.gender, 8) || null,
          str(b.title, 50) || '钢琴教师',
          str(b.bio, 2000) || null,
          b.resume === undefined ? (t.resume || null) : (resumeOf(b.resume) || null),
          b.photos === undefined ? (t.photos || null) : (photosOf(b.photos) || null),
          avatarOf(b.avatar) || null,
          str(b.phone, 32) || null,
          str(b.email, 128) || null,
          str(b.joined_at, 10) || null,
          str(b.remark, 255) || null,
          num(b.sort) ?? 0,
          b.status === 0 || b.status === '0' ? 0 : 1,
          id,
        ]
      );

      const username = str(b.username, 50);
      if (username) {
        if (!/^[A-Za-z0-9_.@-]{3,50}$/.test(username)) {
          await conn.rollback();
          return res.status(400).json({ error: '账号只能包含字母、数字、_ . @ -，长度 3-50' });
        }
        const [dup] = await conn.query(
          'SELECT id FROM admin_users WHERE username=? AND NOT (teacher_id=? AND role=\'teacher\')',
          [username, id]
        );
        if (dup.length) {
          await conn.rollback();
          return res.status(409).json({ error: '登录账号已被占用' });
        }
        const [acc] = await conn.query(
          "SELECT id FROM admin_users WHERE teacher_id=? AND role='teacher' LIMIT 1",
          [id]
        );
        if (acc.length) {
          await conn.query('UPDATE admin_users SET username=? WHERE id=?', [username, acc[0].id]);
        } else if (b.password) {
          // 原来没有账号：编辑时补一个
          await conn.query(
            "INSERT INTO admin_users (username, password, role, teacher_id) VALUES (?,?,'teacher',?)",
            [username, str(b.password, 64), id]
          );
        }
      }
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '登录账号已被占用' });
      throw e;
    } finally {
      conn.release();
    }
  });

  // 重置登录密码
  api.put(`${base}/:id/password`, ...only, async (req, res) => {
    const id = Number(req.params.id);
    const password = str((req.body || {}).password, 64);
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const [acc] = await q("SELECT id FROM admin_users WHERE teacher_id=? AND role='teacher' LIMIT 1", [id]);
    if (!acc) return res.status(404).json({ error: '该教师还没有登录账号' });
    await q('UPDATE admin_users SET password=? WHERE id=?', [password, acc.id]);
    res.json({ ok: true });
  });

  // 删除：被课程/课次/预约引用过的只允许停用（status=0），避免历史数据悬空
  api.delete(`${base}/:id`, ...only, async (req, res) => {
    const id = Number(req.params.id);
    const [t] = await q('SELECT id,name FROM teachers WHERE id=?', [id]);
    if (!t) return res.status(404).json({ error: '教师不存在' });

    const [used] = await q(
      `SELECT (SELECT COUNT(*) FROM courses WHERE teacher_id=?) c,
              (SELECT COUNT(*) FROM lessons WHERE teacher_id=?) l,
              (SELECT COUNT(*) FROM bookings WHERE teacher_id=?) b,
              (SELECT COUNT(*) FROM availability WHERE teacher_id=?) a,
              (SELECT COUNT(*) FROM class_records WHERE teacher_id=?) r`,
      [id, id, id, id, id]
    );
    // q() 返回的就是行数组，第一行已经是对象，别再取 [0]
    const u = used || {};
    const total = Number(u.c || 0) + Number(u.l || 0) + Number(u.b || 0) + Number(u.a || 0) + Number(u.r || 0);
    if (total > 0) {
      return res.status(409).json({
        error: `该教师已有课程/课次/预约数据（${total} 条），不能删除，请改为「停用」`,
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM admin_users WHERE teacher_id=? AND role='teacher'", [id]);
      await conn.query('DELETE FROM teachers WHERE id=?', [id]);
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  });

  // 教师本人：查看 / 修改自己的资料（小程序端「我的」用）
  api.get('/api/teacher/profile', authenticate, async (req, res) => {
    if (req.user.role !== 'teacher' || !req.user.teacherId) return res.status(403).json({ error: '仅教师可访问' });
    const [t] = await q(
      `SELECT id,name,gender,title,bio,avatar,phone,email,joined_at,status
         FROM teachers WHERE id=?`,
      [req.user.teacherId]
    );
    if (!t) return res.status(404).json({ error: '教师不存在' });
    res.json(t);
  });

  api.put('/api/teacher/profile', authenticate, async (req, res) => {
    if (req.user.role !== 'teacher' || !req.user.teacherId) return res.status(403).json({ error: '仅教师可访问' });
    const b = req.body || {};
    await q('UPDATE teachers SET gender=?, phone=?, email=?, bio=? WHERE id=?', [
      str(b.gender, 8) || null,
      str(b.phone, 32) || null,
      str(b.email, 128) || null,
      str(b.bio, 2000) || null,
      req.user.teacherId,
    ]);
    res.json({ ok: true });
  });
}

export default mountAdminTeachers;
