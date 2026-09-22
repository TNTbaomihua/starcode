/* ══════════════════════════════════════════════════════════
   追星消费记账本 · 云同步模块
   设计原则：本地数据永远是主体，云端是账号的镜像。
   - 所有数据带全局唯一 id（跨设备不撞车）+ updatedAt + deletedAt（软删除）
   - 合并 = 两边并集，同 id 取 updatedAt 更新的那份
   - 删除用墓碑标记，避免「删掉的记录被另一台设备复活」
   ══════════════════════════════════════════════════════════ */
'use strict';

const SYNC = {
  token: null,
  userId: '',
  username: '',
  rev: 0,
  available: false,     // 服务端是否支持云同步（静态托管时为 false）
  busy: false,
  lastSyncAt: 0,
  lastError: '',
};

const LS = {
  token: 'se_token',
  user: 'se_user',
  rev: 'se_rev',
  owner: 'se_owner',    // 本机数据归属的账号 id
};

/* ────────── 全局唯一 id（数字型，保证 parseInt 兼容） ────────── */
let _gidMs = 0, _gidSeq = 0;
function newGid() {
  const ms = Date.now();
  if (ms !== _gidMs) { _gidMs = ms; _gidSeq = 0; }
  _gidSeq = (_gidSeq + 1) % 1000;
  return ms * 1000 + _gidSeq;   // ~1.79e15，安全落在 Number 精度内
}

/* ────────── 请求封装 ────────── */
async function apiFetch(pathname, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(opts.body);
  }
  if (SYNC.token) o.headers['Authorization'] = 'Bearer ' + SYNC.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
  try {
    const res = await fetch(pathname, { ...o, signal: ctrl.signal });
    const txt = await res.text();
    let json = {};
    try { json = txt ? JSON.parse(txt) : {}; } catch (e) { json = { error: '服务端返回异常' }; }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/* ────────── 账号状态 ────────── */
function syncLoadAuth() {
  SYNC.token = localStorage.getItem(LS.token) || null;
  SYNC.rev = parseInt(localStorage.getItem(LS.rev), 10) || 0;
  try {
    const u = JSON.parse(localStorage.getItem(LS.user) || '{}');
    SYNC.userId = u.id || '';
    SYNC.username = u.username || '';
  } catch (e) { SYNC.userId = ''; SYNC.username = ''; }
  return !!SYNC.token;
}
function applyAuth(json) {
  SYNC.token = json.token;
  SYNC.userId = json.user.id;
  SYNC.username = json.user.username;
  SYNC.rev = json.rev || 0;
  localStorage.setItem(LS.token, SYNC.token);
  localStorage.setItem(LS.user, JSON.stringify(json.user));
  localStorage.setItem(LS.rev, String(SYNC.rev));
}
function clearAuth() {
  SYNC.token = null; SYNC.userId = ''; SYNC.username = ''; SYNC.rev = 0;
  [LS.token, LS.user, LS.rev].forEach(k => localStorage.removeItem(k));
  refreshAuthUI();
}
const isLoggedIn = () => !!(SYNC.token && SYNC.userId);

function refreshAuthUI() {
  if (typeof renderAccountCard === 'function') {
    try { renderAccountCard(); } catch (e) { console.error(e); }
  }
}

/* ────────── 服务端探测（静态托管时优雅降级） ────────── */
async function syncDetect() {
  try {
    const r = await apiFetch('/api/ping', { timeout: 8000 });
    SYNC.available = !!(r.ok && r.json && r.json.cloud === true);
  } catch (e) {
    SYNC.available = false;
  }
  return SYNC.available;
}

/* ────────── 本地数据读写 ────────── */
async function collectLocal() {
  const [idols, records, categories] = await Promise.all([
    dbAll('idols'), dbAll('records'), dbAll('categories'),
  ]);
  return { idols: idols || [], records: records || [], categories: categories || [], profile: getProfile() };
}

async function applyDataset(data) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['idols', 'records', 'categories'], 'readwrite');
    [['idols', data.idols], ['records', data.records], ['categories', data.categories]].forEach(([name, list]) => {
      const store = tx.objectStore(name);
      store.clear();
      (list || []).forEach(item => { if (item && item.id != null) store.put(item); });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  try { localStorage.setItem('se_profile', JSON.stringify(data.profile || {})); } catch (e) { /* 忽略 */ }
}

/* 把本机数据的 id 全部换成新的全局 id（外键同步重写）
   —— 仅在本机数据从未与该账号关联过时执行，避免两边 id 撞车 */
async function remapLocalIds() {
  const [idols, records, categories] = await Promise.all([
    dbAll('idols'), dbAll('records'), dbAll('categories'),
  ]);
  if (!idols.length && !records.length && !categories.length) return false;

  const mI = new Map(), mC = new Map();
  idols.forEach(o => mI.set(o.id, newGid()));
  categories.forEach(o => mC.set(o.id, newGid()));

  const ni = idols.map(o => ({ ...o, id: mI.get(o.id) }));
  const nc = categories.map(o => ({ ...o, id: mC.get(o.id) }));
  const nr = records.map(r => ({
    ...r,
    id: newGid(),
    idolId: (r.idolId != null && mI.has(r.idolId)) ? mI.get(r.idolId) : null,
    categoryId: (r.categoryId != null && mC.has(r.categoryId)) ? mC.get(r.categoryId) : null,
  }));

  await applyDataset({ idols: ni, records: nr, categories: nc, profile: getProfile() });
  return true;
}

/* ────────── 合并算法 ────────── */
function mergeList(localList, remoteList) {
  const map = new Map();
  const put = (item) => {
    if (!item || item.id == null) return;
    const cur = map.get(item.id);
    if (!cur) { map.set(item.id, item); return; }
    const a = Number(cur.updatedAt) || 0;
    const b = Number(item.updatedAt) || 0;
    if (b > a) map.set(item.id, item);
  };
  (remoteList || []).forEach(put);   // 远端先放，本地同 id 更新时会覆盖
  (localList || []).forEach(put);
  return [...map.values()];
}

function mergeDataset(local, remote) {
  const out = {
    idols: mergeList(local && local.idols, remote && remote.idols),
    records: mergeList(local && local.records, remote && remote.records),
    categories: mergeList(local && local.categories, remote && remote.categories),
    profile: {},
  };
  const lp = (local && local.profile) || {};
  const rp = (remote && remote.profile) || {};
  out.profile = (lp.nickname || lp.avatar) ? lp : rp;
  return out;
}

function datasetSig(ds) {
  const sig = [];
  for (const k of ['idols', 'records', 'categories']) {
    for (const it of ((ds && ds[k]) || [])) {
      sig.push(k[0] + it.id + ':' + (Number(it.updatedAt) || 0) + (it.deletedAt ? 'd' : ''));
    }
  }
  return sig.sort().join('|');
}

/* ────────── 同步主流程 ────────── */
async function syncNow(opts = {}) {
  const quiet = opts.quiet !== false;
  if (!SYNC.available) return { ok: false, skipped: true, error: '当前版本不支持云同步' };
  if (!isLoggedIn()) return { ok: false, skipped: true, error: '未登录' };
  if (SYNC.busy) return { ok: false, skipped: true, error: '正在同步中' };

  SYNC.busy = true;
  refreshAuthUI();
  try {
    // 1) 拉取云端
    const g = await apiFetch('/api/data', { timeout: 60000 });
    if (g.status === 401) { clearAuth(); throw new Error('登录已失效，请重新登录'); }
    if (!g.ok) throw new Error(g.json.error || '读取云端数据失败');
    let remote = g.json.data || null;
    let rev = g.json.rev || 0;

    // 2) 首次连接到「已有数据的账号」时，先把本机数据重新编号
    let local = await collectLocal();
    const localCount = local.idols.length + local.records.length + local.categories.length;
    const owner = localStorage.getItem(LS.owner);
    if (remote && localCount > 0 && owner !== SYNC.userId) {
      await remapLocalIds();
      local = await collectLocal();
    }

    // 3) 合并 → 落本地 → 规范化分类 → 上传
    let merged = mergeDataset(local, remote);
    await applyDataset(merged);
    // 两台设备各自建过一套默认分类，合并后会重名 → 这里合并回标准的 8 个
    await reloadData();
    await ensureDefaultCats(true);
    local = await collectLocal();
    merged = local;

    let p = await apiFetch('/api/data', {
      method: 'POST', timeout: 180000,
      body: { baseRev: rev, data: merged },
    });

    // 4) 别的设备抢先提交过 → 拉最新再合并一轮
    if (p.status === 409) {
      remote = p.json.data || null;
      merged = mergeDataset(await collectLocal(), remote);
      await applyDataset(merged);
      await reloadData();
      await ensureDefaultCats(true);
      merged = await collectLocal();
      p = await apiFetch('/api/data', {
        method: 'POST', timeout: 180000,
        body: { baseRev: p.json.rev, data: merged },
      });
    }
    if (!p.ok) throw new Error(p.json.error || '上传失败');

    SYNC.rev = p.json.rev;
    SYNC.lastSyncAt = Date.now();
    SYNC.lastError = '';
    localStorage.setItem(LS.rev, String(SYNC.rev));
    localStorage.setItem(LS.owner, SYNC.userId);

    await reloadData();
    renderAll();
    refreshAuthUI();
    return { ok: true, rev: SYNC.rev, bytes: p.json.bytes };
  } catch (e) {
    SYNC.lastError = e.message || '同步失败';
    if (!quiet) toast('同步失败：' + SYNC.lastError, true);
    refreshAuthUI();
    return { ok: false, error: SYNC.lastError };
  } finally {
    SYNC.busy = false;
    refreshAuthUI();
  }
}

/* 数据变更后延迟同步（合并连续操作） */
let _syncTimer = null;
function scheduleSync(delay) {
  if (!SYNC.available || !isLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow({ quiet: true }); }, delay || 2500);
}

/* ────────── 账号操作 ────────── */
async function doRegister(username, password, question, answer) {
  const r = await apiFetch('/api/register', {
    method: 'POST',
    body: { username, password, question: question || '', answer: answer || '' },
  });
  if (!r.ok) throw new Error(r.json.error || '注册失败，请稍后再试');
  applyAuth(r.json);
  const s = await syncNow({ quiet: false });   // 注册后立刻把本机数据传上去
  return { user: r.json.user, sync: s };
}

async function doLogin(username, password) {
  const r = await apiFetch('/api/login', { method: 'POST', body: { username, password } });
  if (!r.ok) throw new Error(r.json.error || '登录失败，请稍后再试');
  applyAuth(r.json);
  const s = await syncNow({ quiet: false });   // 登录后立刻把云端数据拉回来
  return { user: r.json.user, sync: s };
}

async function doLogout() {
  try { if (SYNC.token) await apiFetch('/api/logout', { method: 'POST', timeout: 8000 }); }
  catch (e) { /* 离线也允许退出 */ }
  clearAuth();
  toast('已退出登录，本机数据仍然保留 ✓');
}

async function doChangePassword(oldPassword, newPassword) {
  const r = await apiFetch('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
  if (!r.ok) throw new Error(r.json.error || '修改失败');
  return true;
}

async function fetchSecurityQuestion(username) {
  const r = await apiFetch('/api/question?username=' + encodeURIComponent(username), { timeout: 15000 });
  if (!r.ok) throw new Error(r.json.error || '获取密保问题失败');
  return r.json.question;
}

async function doResetPassword(username, answer, newPassword) {
  const r = await apiFetch('/api/reset', {
    method: 'POST', body: { username, answer, newPassword },
  });
  if (!r.ok) throw new Error(r.json.error || '重置失败');
  return true;
}

/* ────────── 启动 ────────── */
async function syncBootstrap() {
  await syncDetect();
  syncLoadAuth();
  refreshAuthUI();
  if (!SYNC.available) return;
  if (isLoggedIn()) {
    await syncNow({ quiet: true });
  }
}

/* 回到前台时同步（限频 60 秒） */
function syncInitVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!SYNC.available || !isLoggedIn()) return;
    if (Date.now() - SYNC.lastSyncAt < 60000) return;
    syncNow({ quiet: true });
  });
  window.addEventListener('online', () => {
    if (SYNC.available && isLoggedIn()) syncNow({ quiet: true });
  });
}
