#!/usr/bin/env node
/**
 * 追星消费记账本 · 云端服务
 * 零依赖 Node HTTP 服务：账号注册 / 登录 / 数据云同步 + 静态资源托管
 * 数据落地在 ./data 目录（users.json / sessions.json / u_<id>.json）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_TTL = 180 * 24 * 3600 * 1000;  // 会话有效期：180 天
const MAX_BODY = 256 * 1024 * 1024;          // 单次请求体上限
const USER_QUOTA = 300 * 1024 * 1024;        // 单账号云端数据上限
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;

/* ══════════════ 存储 ══════════════ */

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

const db = {
  users: readJson(USERS_FILE, {}),      // userId -> user
  sessions: readJson(SESS_FILE, {}),    // token  -> { userId, exp }
};
const udata = new Map();                // userId -> { rev, updatedAt, payload }

const udataFile = (userId) => path.join(DATA_DIR, 'u_' + userId + '.json');

function loadUserData(userId) {
  let rec = udata.get(userId);
  if (!rec) {
    rec = readJson(udataFile(userId), null) || { rev: 0, updatedAt: 0, payload: null };
    udata.set(userId, rec);
  }
  return rec;
}

const _saveQueue = new Map();
function saveJson(file, obj) {
  const text = JSON.stringify(obj);          // 立即快照，避免后续被改动
  const prev = _saveQueue.get(file) || Promise.resolve();
  const next = prev
    .then(async () => {
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, file);
    })
    .catch((err) => console.error('[save]', path.basename(file), err.message));
  _saveQueue.set(file, next);
  return next;
}

/* ══════════════ 安全工具 ══════════════ */

const hashPwd = (pwd, salt) => crypto.scryptSync(String(pwd), salt, 64).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const findUserByName = (name) =>
  Object.values(db.users).find((u) => u.username === name) || null;

/* 登录失败限流（内存态，防暴力破解） */
const fails = new Map();
const FAIL_MAX = 8;
const FAIL_WINDOW = 10 * 60 * 1000;

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || 'unknown';
}
function isBlocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.at > FAIL_WINDOW) { fails.delete(ip); return false; }
  return f.n >= FAIL_MAX;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.at > FAIL_WINDOW) fails.set(ip, { n: 1, at: Date.now() });
  else { f.n += 1; f.at = Date.now(); }
}
const clearFail = (ip) => fails.delete(ip);

function issueToken(userId) {
  // 清理过期会话
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[t];
  const token = newToken();
  db.sessions[token] = { userId, exp: now + SESSION_TTL };
  saveJson(SESS_FILE, db.sessions);
  return token;
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[token]; saveJson(SESS_FILE, db.sessions); return null; }
  const user = db.users[s.userId];
  if (!user) return null;
  return { token, user };
}

/* ══════════════ HTTP 小工具 ══════════════ */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, JSON_HEADERS);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('数据太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('数据格式错误')); }
    });
    req.on('error', reject);
  });
}

/* ══════════════ API 处理 ══════════════ */

async function apiRegister(req, res, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username))
    return send(res, 400, { error: '用户名需 3~20 位，可用中文、字母、数字、下划线' });
  if (password.length < 6)
    return send(res, 400, { error: '密码至少 6 位' });
  if (findUserByName(username))
    return send(res, 409, { error: '这个用户名已经被注册了，换一个吧' });

  const salt = newSalt();
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    salt,
    hash: hashPwd(password, salt),
    q: '', aSalt: '', aHash: '',
    createdAt: Date.now(),
  };
  const question = String(body.question || '').trim().slice(0, 60);
  const answer = String(body.answer || '').trim();
  if (question && answer) {
    user.q = question;
    user.aSalt = newSalt();
    user.aHash = hashPwd(answer.toLowerCase(), user.aSalt);
  }
  db.users[user.id] = user;
  await saveJson(USERS_FILE, db.users);

  const token = issueToken(user.id);
  return send(res, 200, { token, user: { id: user.id, username }, rev: 0, hasData: false });
}

async function apiLogin(req, res, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const ip = clientIp(req);
  if (isBlocked(ip))
    return send(res, 429, { error: '输错次数太多啦，请 10 分钟后再试' });

  const user = findUserByName(username);
  if (!user || !safeEqual(hashPwd(password, user.salt), user.hash)) {
    noteFail(ip);
    return send(res, 401, { error: '用户名或密码不正确' });
  }
  clearFail(ip);

  const token = issueToken(user.id);
  const d = loadUserData(user.id);
  return send(res, 200, {
    token,
    user: { id: user.id, username: user.username },
    rev: d.rev,
    hasData: !!d.payload,
  });
}

function apiMe(req, res) {
  const s = auth(req);
  if (!s) return send(res, 401, { error: '登录已失效，请重新登录' });
  const d = loadUserData(s.user.id);
  return send(res, 200, { user: { id: s.user.id, username: s.user.username }, rev: d.rev, hasData: !!d.payload });
}

function apiLogout(req, res) {
  const s = auth(req);
  if (s) { delete db.sessions[s.token]; saveJson(SESS_FILE, db.sessions); }
  return send(res, 200, { ok: true });
}

function apiGetData(req, res) {
  const s = auth(req);
  if (!s) return send(res, 401, { error: '登录已失效，请重新登录' });
  const d = loadUserData(s.user.id);
  return send(res, 200, { rev: d.rev, updatedAt: d.updatedAt, data: d.payload });
}

async function apiPostData(req, res, body) {
  const s = auth(req);
  if (!s) return send(res, 401, { error: '登录已失效，请重新登录' });
  const d = loadUserData(s.user.id);
  const baseRev = Number(body.baseRev);

  // 版本不一致 → 说明别的设备刚提交过，让客户端重新合并
  if (!Number.isFinite(baseRev) || baseRev !== d.rev)
    return send(res, 409, { conflict: true, rev: d.rev, updatedAt: d.updatedAt, data: d.payload });

  const payload = body.data || {};
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > USER_QUOTA)
    return send(res, 413, { error: '云端空间已满（上限 300MB），请先清理一些图片凭证' });

  d.rev += 1;
  d.updatedAt = Date.now();
  d.payload = payload;
  await saveJson(udataFile(s.user.id), { rev: d.rev, updatedAt: d.updatedAt, payload: d.payload });
  return send(res, 200, { rev: d.rev, updatedAt: d.updatedAt, bytes: size });
}

async function apiChangePassword(req, res, body) {
  const s = auth(req);
  if (!s) return send(res, 401, { error: '登录已失效，请重新登录' });
  const oldPwd = String(body.oldPassword || '');
  const newPwd = String(body.newPassword || '');
  if (!safeEqual(hashPwd(oldPwd, s.user.salt), s.user.hash))
    return send(res, 400, { error: '原密码不正确' });
  if (newPwd.length < 6)
    return send(res, 400, { error: '新密码至少 6 位' });
  s.user.salt = newSalt();
  s.user.hash = hashPwd(newPwd, s.user.salt);
  await saveJson(USERS_FILE, db.users);
  // 其他设备下线，仅保留当前会话
  for (const [t, ss] of Object.entries(db.sessions))
    if (ss.userId === s.user.id && t !== s.token) delete db.sessions[t];
  saveJson(SESS_FILE, db.sessions);
  return send(res, 200, { ok: true });
}

async function apiResetPassword(req, res, body) {
  const username = String(body.username || '').trim();
  const answer = String(body.answer || '').trim().toLowerCase();
  const newPwd = String(body.newPassword || '');
  const ip = clientIp(req);
  if (isBlocked(ip))
    return send(res, 429, { error: '尝试次数太多啦，请 10 分钟后再试' });

  const user = findUserByName(username);
  if (!user || !user.q || !user.aHash || !safeEqual(hashPwd(answer, user.aSalt), user.aHash)) {
    noteFail(ip);
    return send(res, 400, { error: '用户名或密保答案不正确' });
  }
  if (newPwd.length < 6) return send(res, 400, { error: '新密码至少 6 位' });

  clearFail(ip);
  user.salt = newSalt();
  user.hash = hashPwd(newPwd, user.salt);
  await saveJson(USERS_FILE, db.users);
  for (const [t, ss] of Object.entries(db.sessions))
    if (ss.userId === user.id) delete db.sessions[t];
  saveJson(SESS_FILE, db.sessions);
  return send(res, 200, { ok: true });
}

function apiQuestion(req, res, url) {
  const username = String(url.searchParams.get('username') || '').trim();
  const user = findUserByName(username);
  if (!user || !user.q) return send(res, 404, { error: '该账号没有设置密保问题，无法自助找回' });
  return send(res, 200, { question: user.q });
}

/* ══════════════ 静态资源 ══════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, rel);
  // 防目录穿越
  if (!filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  if (path.basename(filePath) === 'server.js' || rel.startsWith('/data/')) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // 前端路由回退
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, buf) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ext === '.html' || path.basename(filePath) === 'sw.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ══════════════ 路由 ══════════════ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, JSON_HEADERS); return res.end(); }

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/ping' && req.method === 'GET')
        return send(res, 200, { ok: true, app: '追星消费记账本', cloud: true, time: Date.now() });
      if (pathname === '/api/register' && req.method === 'POST')
        return await apiRegister(req, res, await readBody(req));
      if (pathname === '/api/login' && req.method === 'POST')
        return await apiLogin(req, res, await readBody(req));
      if (pathname === '/api/logout' && req.method === 'POST')
        return apiLogout(req, res);
      if (pathname === '/api/me' && req.method === 'GET')
        return apiMe(req, res);
      if (pathname === '/api/data' && req.method === 'GET')
        return apiGetData(req, res);
      if (pathname === '/api/data' && req.method === 'POST')
        return await apiPostData(req, res, await readBody(req));
      if (pathname === '/api/password' && req.method === 'POST')
        return await apiChangePassword(req, res, await readBody(req));
      if (pathname === '/api/reset' && req.method === 'POST')
        return await apiResetPassword(req, res, await readBody(req));
      if (pathname === '/api/question' && req.method === 'GET')
        return apiQuestion(req, res, url);
      return send(res, 404, { error: '接口不存在' });
    } catch (e) {
      console.error('[api]', pathname, e.message);
      return send(res, 400, { error: e.message || '请求处理失败' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('追星消费记账本 · 云端服务已启动  http://' + HOST + ':' + PORT);
  console.log('数据目录：' + DATA_DIR);
  console.log('已注册账号：' + Object.keys(db.users).length + ' 个');
});
