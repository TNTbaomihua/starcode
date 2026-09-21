/* ══════════ 追星消费记账本 · app.js ══════════ */
'use strict';

/* ────────────── 工具 ────────────── */
const $  = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => Array.from((p || document).querySelectorAll(s));

const round2 = x => Math.round((Number(x) || 0) * 100) / 100;

function fmtMoney(n) {
  try {
    return '¥' + round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (e) { return '¥0.00'; }
}
function fmtMoneyShort(n) {
  const v = round2(n);
  if (Math.abs(v) >= 10000) return '¥' + (v / 10000).toFixed(2).replace(/\.?0+$/, '') + '万';
  return '¥' + Math.round(v).toLocaleString('zh-CN');
}
function todayStr() {
  try {  // 统一本地日期 YYYY-MM-DD，不用 ISO/UTC，避免时区错乱
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  } catch (e) { return '2000-01-01'; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function toast(msg, isErr) {
  try {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  } catch (e) { console.error(e); }
}
function safe(fn) {
  try { return fn(); } catch (e) { console.error(e); return undefined; }
}

/* ────────────── IndexedDB ────────────── */
const DB_NAME = 'starExpenseDB';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    if (!('indexedDB' in window)) return reject(new Error('浏览器不支持 IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('idols'))
        db.createObjectStore('idols', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('records'))
        db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('categories'))
        db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error || new Error('打开数据库失败（如处于无痕/隐私模式请退出后重试）'));
  });
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAdd(store, obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).add(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ────────────── 全局状态 ────────────── */
const state = {
  idols: [], records: [], categories: [],
  view: 'home',
  statMode: 'all',       // 'all' | 'single'
  statIdol: null,
  statYear: 'this',      // 'this' | 'last' | 'YYYY'
  detailIdolId: null,
  detailFilterCat: null,
  editingIdolId: null,
  editingCatId: null,
  editingRecId: null,
  catIconPick: '🎤',
  recImages: [],
  pendingDeleteIdolId: null,
};
const CAT_ICONS = ['🎤','✈️','🏨','🎬','👕','📚','🎫','💿','📸','🎁','💄','👟','🧸','🍜','🚄','💻','✨','💖'];
// 低饱和冷紫色系（图表 / 分类），适配深色背景
const PALETTE = ['#7B61FF','#9D8CFF','#5E4BD1','#B3A6FF','#8875E8','#4A3DA8','#6C5CE7','#A29BFE','#7161C8','#8F7BE8'];
/* 最终统一的 8 个默认分类（用户指定） */
const DEFAULT_CATS = [
  { name: '演唱会',   icon: '🎤' },
  { name: '交通费',   icon: '✈️' },
  { name: '酒店费',   icon: '🏨' },
  { name: '代言周边', icon: '🎬' },
  { name: '潮牌',     icon: '👕' },
  { name: '文化周边', icon: '📚' },
  { name: '助农产品', icon: '🌾' },
  { name: '其他',     icon: '📦' },
];
/* 历史别名 → 标准名（用于自动合并老数据里的长名/变体分类） */
const CAT_ALIAS = {
  '演唱会票价': '演唱会',
  '交通费用':   '交通费',
  '酒店住宿':   '酒店费',
  '潮牌消费':   '潮牌',
  '文化产品周边': '文化周边',
};

/* ────────────── 启动 ────────────── */
async function init() {
  try {
    await openDB();
    await reloadData();
    await ensureDefaultCats();
  } catch (e) {
    console.error(e);
    toast(e.message || '本地存储不可用，数据无法保存', true);
    // 存储不可用时仍允许界面打开（只读降级），但不阻塞绑定
  }
  try {
    bindAll();
    renderAll();
  } catch (e) { console.error(e); }
  initKeyboardFix();
}
async function reloadData() {
  [state.idols, state.records, state.categories] = await Promise.all([
    dbAll('idols'), dbAll('records'), dbAll('categories'),
  ]);
  state.idols.sort((a, b) => a.id - b.id);
}
function canonKey(name) {
  let k = String(name || '').replace(/（[^）]*）/g, '').replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '');
  return CAT_ALIAS[k] || k;
}

async function ensureDefaultCats() {
  let changed = await mergeCatsToCanon();
  // 补齐缺失的标准分类
  const have = new Set(state.categories.map(c => canonKey(c.name)));
  for (let i = 0; i < DEFAULT_CATS.length; i++) {
    const def = DEFAULT_CATS[i];
    if (have.has(canonKey(def.name))) continue;
    const c = { ...def, color: PALETTE[i % PALETTE.length] };
    const id = await dbAdd('categories', c);
    c.id = id;
    state.categories.push(c);
    have.add(canonKey(def.name));
    changed = true;
  }
  if (changed) {
    state.records = await dbAll('records');
    toast('分类已整理 ✓');
  }
}

/* 把所有分类归一到 DEFAULT_CATS 的 8 个标准名：
   同一 canonKey 的多个分类只保留一个（优先保留名字正好是标准名的），
   其下的账单改挂过来，多余的分类删除，缺失的标准分类由调用方补齐 */
async function mergeCatsToCanon() {
  const groups = {};
  state.categories.forEach(c => {
    const k = canonKey(c.name);
    (groups[k] = groups[k] || []).push(c);
  });
  const canonNames = new Set(DEFAULT_CATS.map(d => d.name));
  let changed = false;
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    // 优先保留名字恰好等于标准名的；否则保留 id 最小的
    let keep = g.find(c => canonNames.has(c.name)) ||
               g.slice().sort((a, b) => a.id - b.id)[0];
    const def = DEFAULT_CATS.find(d => d.name === (CAT_ALIAS[k] || k)) ||
                DEFAULT_CATS.find(d => canonKey(d.name) === k);
    // 把保留项名称/图标规范成标准名
    const stdName = def ? def.name : keep.name;
    const stdIcon = def ? def.icon : keep.icon;
    if (keep.name !== stdName || keep.icon !== stdIcon) {
      keep.name = stdName; keep.icon = stdIcon;
      await dbPut('categories', keep);
      changed = true;
    }
    for (const dup of g) {
      if (dup.id === keep.id) continue;
      for (const r of state.records.filter(r => r.categoryId === dup.id)) {
        r.categoryId = keep.id;
        await dbPut('records', r);
      }
      await dbDelete('categories', dup.id);
      state.categories = state.categories.filter(c => c.id !== dup.id);
      changed = true;
    }
  }
  return changed;
}
function renderAll() {
  safe(renderHome); safe(renderAddForm); safe(renderStats);
  if (state.view === 'detail') safe(renderDetail);
}

/* ────────────── 数据辅助 ────────────── */
const idolById = id => state.idols.find(x => x.id === id);
const catById  = id => state.categories.find(x => x.id === id);
const recsOf   = idolId => state.records.filter(r => r.idolId === idolId);
const totalOf  = recs => round2(recs.reduce((s, r) => s + (Number(r.price) || 0), 0));
function yearValue() {
  if (state.statYear === 'this') return new Date().getFullYear();
  if (state.statYear === 'last') return new Date().getFullYear() - 1;
  return parseInt(state.statYear, 10) || new Date().getFullYear();
}
const recsOfYear = year => state.records.filter(r => String(r.date || '').startsWith(String(year)));
const monthKey = dateStr => String(dateStr || '').slice(0, 7);

/* ────────────── 图片处理（EXIF 方向 + HEIC 检测 + 压缩） ────────────── */
async function decodeImageFile(file) {
  // 优先 createImageBitmap：能正确读取 EXIF 方向（iPhone 竖拍不旋转）
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) { /* 降级 */ }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('DECODE_FAIL'));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
async function fileToData(file) {
  const isHeic = /heic|heif/i.test(file.type || '') || /\.heic$/i.test(file.name || '');
  try {
    const src = await decodeImageFile(file);
    const big = file.size > 5 * 1024 * 1024;   // 超 5MB 压到 1080p
    const maxSide = big ? 1080 : 1600;
    let { width: w, height: h } = src;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(src, 0, 0, w, h);
    if ('close' in src) { try { src.close(); } catch (e) {} }
    return cv.toDataURL('image/jpeg', big ? 0.82 : 0.88);
  } catch (e) {
    if (isHeic) throw new Error('iPhone 的 HEIC 照片无法直接解析：请在 设置→相机→格式 选「兼容性最佳」，或截图后再上传');
    throw new Error('图片解析失败，请换一张试试');
  }
}

/* 存储配额检查：超 80% 提醒 */
async function checkQuota() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota && usage / quota > 0.8) {
        $('#quotaBanner').classList.remove('hidden');
      }
    }
  } catch (e) { /* 忽略 */ }
}

/* ────────────── 键盘顶起修复（visualViewport） ────────────── */
function initKeyboardFix() {
  if (!window.visualViewport) return;
  const apply = () => {
    const kbH = window.innerHeight - visualViewport.height;
    document.documentElement.style.setProperty('--kb', (kbH > 120 ? kbH : 0) + 'px');
  };
  visualViewport.addEventListener('resize', apply);
  visualViewport.addEventListener('scroll', apply);
}

/* ────────────── 导航 ────────────── */
function bindAll() {
  // Tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    if (state.editingRecId && t.dataset.view !== 'add') state.editingRecId = null;
    try {
      switchView(t.dataset.view);
    } catch (e) {
      console.error(e);
      // 兜底：切换失败也要保证视图不空白、不跳走
      $$('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + t.dataset.view));
      toast('页面加载异常，请重试', true);
    }
  }));
  $('#btnSettings').addEventListener('click', openSettings);

  // 首页
  $('#btnAddIdol').addEventListener('click', () => openIdolSheet());
  $('#idolGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.idol-card');
    if (card) openIdolDetail(parseInt(card.dataset.id, 10));
  });

  // 记账页
  $('#btnManageCats').addEventListener('click', openCatManager);
  $('#btnNewCat').addEventListener('click', () => openCatSheet(null));
  $('#recImgGrid').addEventListener('click', (e) => {
    const rm = e.target.closest('.rm');
    if (rm) { state.recImages.splice(parseInt(rm.dataset.i, 10), 1); renderRecImgGrid(); return; }
    const img = e.target.closest('img.rec-thumb-img');
    if (img) { openViewer(state.recImages, parseInt(img.dataset.i, 10)); return; }
    if (e.target.closest('.img-add-btn')) $('#recImgInput').click();
    if (e.target.closest('.img-cam-btn')) $('#recCamInput').click();
  });
  $('#recImgInput').addEventListener('change', onPickRecImgs);
  $('#recCamInput').addEventListener('change', onPickRecImgs);
  $('#btnSaveRec').addEventListener('click', saveRec);

  // 明星详情
  $('#btnDetailBack').addEventListener('click', () => switchView('home'));
  $('#idolHero').addEventListener('click', (e) => {
    if (e.target.closest('#ihStats')) openIdolStats();
    if (e.target.closest('#ihEdit')) {
      const idol = idolById(state.detailIdolId);
      if (idol) openIdolSheet(idol);
    }
    if (e.target.closest('#ihDel')) askDeleteIdol(state.detailIdolId);
  });
  $('#detailCatChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.id === 'detailGoStats') return openIdolStats();
    if (chip.id === 'detailAllChip') { state.detailFilterCat = null; return renderDetail(); }
    state.detailFilterCat = state.detailFilterCat === chip.dataset.c ? null : chip.dataset.c;
    renderDetail();
  });

  // Sheets 关闭
  $$('[data-close-sheet]').forEach(b =>
    b.addEventListener('click', e => closeSheet(e.target.closest('.sheet-backdrop'))));
  $$('.sheet-backdrop').forEach(bk => bk.addEventListener('click', e => {
    if (e.target === bk) closeSheet(bk);
  }));

  // 明星表单
  $('#idolAvatarPick').addEventListener('click', () => $('#idolAvatarInput').click());
  $('#idolAvatarInput').addEventListener('change', onPickIdolAvatar);
  $('#btnSaveIdol').addEventListener('click', saveIdol);

  // 分类表单
  $('#btnSaveCat').addEventListener('click', saveCat);

  // 分类管理
  $('#btnMgrAddCat').addEventListener('click', () => openCatSheet(null));
  $('#catMgrList').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      const c = catById(parseInt(edit.dataset.edit, 10));
      if (c) openCatSheet(c);
    }
    if (del) deleteCat(parseInt(del.dataset.del, 10));
  });

  // 设置
  $('#settingsAvatar').addEventListener('click', () => $('#settingsAvatarInput').click());
  $('#settingsAvatarInput').addEventListener('change', onPickSettingsAvatar);
  $('#btnSaveProfile').addEventListener('click', saveProfile);
  $('#btnExport').addEventListener('click', exportData);
  $('#btnInstallGuide').addEventListener('click', () => showInstallGuide());
  $('#btnAbout').addEventListener('click', () => $('#aboutBackdrop').classList.remove('hidden'));
  $('#aboutOk').addEventListener('click', () => $('#aboutBackdrop').classList.add('hidden'));

  // 删除明星对话框
  $('#idolDelAll').addEventListener('click', () => doDeleteIdol(true));
  $('#idolDelKeep').addEventListener('click', () => doDeleteIdol(false));
  $('#idolDelCancel').addEventListener('click', () => {
    state.pendingDeleteIdolId = null;
    $('#idolDelBackdrop').classList.add('hidden');
  });

  // 配额横幅
  $('#quotaExport').addEventListener('click', exportData);
  $('#quotaClose').addEventListener('click', () => $('#quotaBanner').classList.add('hidden'));

  // 图片浏览器
  $('#viewerClose').addEventListener('click', () => $('#viewer').classList.remove('open'));
  $('#viewer').addEventListener('click', e => {
    if (e.target === $('#viewer')) $('#viewer').classList.remove('open');
  });
  $('#viewerStrip').addEventListener('scroll', throttle(() => {
    const strip = $('#viewerStrip');
    const i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
    $$('#viewerDots i').forEach((d, j) => d.classList.toggle('on', j === i));
  }, 120));

  // 通用确认
  $('#confirmNo').addEventListener('click', () => finishConfirm(false));
  $('#confirmYes').addEventListener('click', () => finishConfirm(true));

  // 安装引导
  $('#installOk').addEventListener('click', () => $('#installBackdrop').classList.add('hidden'));
  initInstall();
}
function throttle(fn, ms) {
  let t = 0;
  return (...a) => { const n = Date.now(); if (n - t > ms) { t = n; fn(...a); } };
}
function switchView(v) {
  state.view = v;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + v));
  const titles = { home: '追星消费记账本', add: '', stats: '', detail: '⭐ 明星详情' };
  $('#topTitle').textContent = titles[v] || '追星消费记账本';
  if (v === 'add') safe(renderAddForm);
  if (v === 'stats') safe(renderStats);
  if (v === 'detail') safe(renderDetail);
  window.scrollTo(0, 0);
}
function openSheet(bk) { bk.classList.add('open'); }
function closeSheet(bk) { if (bk) bk.classList.remove('open'); }

/* ────────────── 首页：明星档案 ────────────── */
function renderHome() {
  const grid = $('#idolGrid');
  if (!state.idols.length) {
    grid.innerHTML = `<div class="empty glass" style="grid-column:1/-1"><span class="em">⭐</span><div class="tt">还没有明星档案</div><div class="dd">点击右上角「＋ 新增明星」<br>创建第一位明星，开始记账</div></div>`;
    return;
  }
  grid.innerHTML = state.idols.map(i => {
    const recs = recsOf(i.id);
    return `
      <div class="idol-card glass" data-id="${i.id}">
        <div class="go">›</div>
        <div class="avatar-circle">${i.avatar ? `<img src="${i.avatar}" alt="">` : '⭐'}</div>
        <div class="nm">${esc(i.name)}</div>
        <div class="amt gold-grad num">${fmtMoneyShort(totalOf(recs))}</div>
        <div class="cnt">${recs.length} 条账单 · 点击进入 ›</div>
      </div>`;
  }).join('');
}

/* ────────────── 明星表单 ────────────── */
function onPickIdolAvatar(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  fileToData(f).then(d => {
    $('#idolAvatarPreview').innerHTML = `<img src="${d}" alt="">`;
    $('#idolAvatarPreview').dataset.img = d;
  }).catch(err => toast(err.message, true));
}
function openIdolSheet(idol) {
  state.editingIdolId = idol ? idol.id : null;
  $('#idolSheetTitle').textContent = idol ? '编辑明星' : '新增明星';
  $('#idolNameInput').value = idol ? idol.name : '';
  const pv = $('#idolAvatarPreview');
  pv.innerHTML = idol && idol.avatar ? `<img src="${idol.avatar}" alt="">` : '＋';
  pv.dataset.img = idol && idol.avatar ? idol.avatar : '';
  openSheet($('#sheetIdolBackdrop'));
  setTimeout(() => $('#idolNameInput').focus(), 350);
}
async function saveIdol() {
  const name = $('#idolNameInput').value.trim();
  if (!name) return toast('请填写明星昵称', true);
  const avatar = $('#idolAvatarPreview').dataset.img || '';
  try {
    if (state.editingIdolId) {
      const idol = idolById(state.editingIdolId);
      if (!idol) throw new Error('明星不存在');
      idol.name = name; idol.avatar = avatar;
      await dbPut('idols', idol);
      toast('已保存 ✓');
    } else {
      const idol = { name, avatar, createdAt: Date.now() };
      const id = await dbAdd('idols', idol);
      idol.id = id;
      toast('已创建「' + name + '」✨');
    }
    await reloadData(); renderAll();
    if (state.view === 'detail' && state.detailIdolId) renderDetail();
    closeSheet($('#sheetIdolBackdrop'));
  } catch (e) {
    console.error(e);
    toast('保存失败：' + (e.message || '存储异常'), true);
  }
}

/* ────────────── 删除明星（可选是否级联） ────────────── */
function askDeleteIdol(id) {
  const idol = idolById(id);
  if (!idol) return;
  const recs = recsOf(idol.id);
  state.pendingDeleteIdolId = idol.id;
  $('#idolDelText').innerHTML =
    `确定删除「<b>${esc(idol.name)}</b>」吗？<br>该明星下有 <b>${recs.length}</b> 条消费记录（合计 ${fmtMoney(totalOf(recs))}）。`;
  $('#idolDelBackdrop').classList.remove('hidden');
}
async function doDeleteIdol(cascade) {
  const id = state.pendingDeleteIdolId;
  state.pendingDeleteIdolId = null;
  $('#idolDelBackdrop').classList.add('hidden');
  if (!id) return;
  const idol = idolById(id);
  if (!idol) return;
  try {
    if (cascade) {
      // 级联删除：记录（含图片，图片存在记录内）一并删除
      for (const r of recsOf(id)) await dbDelete('records', r.id);
    } else {
      // 保留记录 → 归为无归属（idolId 置空）
      for (const r of recsOf(id)) { r.idolId = null; await dbPut('records', r); }
    }
    await dbDelete('idols', id);
    toast(cascade ? '已删除明星及其全部记录' : '已删除明星，记录保留为「无归属」');
    if (state.detailIdolId === id) {
      state.detailIdolId = null;
      switchView('home');
    }
    if (state.statIdol === id) { state.statIdol = null; state.statMode = 'all'; }
    await reloadData(); renderAll();
    checkQuota();
  } catch (e) { console.error(e); toast('删除失败', true); }
}

/* ────────────── 分类（全局） ────────────── */
function renderCatIconRow() {
  $('#catIconRow').innerHTML = CAT_ICONS.map(ic =>
    `<button type="button" class="cat-icon-opt${ic === state.catIconPick ? ' active' : ''}" data-ic="${ic}">${ic}</button>`).join('');
  $$('.cat-icon-opt').forEach(b => b.addEventListener('click', () => {
    state.catIconPick = b.dataset.ic;
    $$('.cat-icon-opt').forEach(x => x.classList.toggle('active', x === b));
  }));
}
function openCatSheet(cat) {
  state.editingCatId = cat ? cat.id : null;
  state.catIconPick = cat ? cat.icon : '🎤';
  $('#catSheetTitle').textContent = cat ? '编辑分类' : '新增分类';
  $('#catNameInput').value = cat ? cat.name : '';
  renderCatIconRow();
  openSheet($('#sheetCatBackdrop'));
  setTimeout(() => $('#catNameInput').focus(), 350);
}
async function saveCat() {
  const name = $('#catNameInput').value.trim();
  if (!name) return toast('请填写分类名称', true);
  try {
    if (state.editingCatId) {
      const c = catById(state.editingCatId);
      if (!c) throw new Error('分类不存在');
      c.name = name; c.icon = state.catIconPick;
      await dbPut('categories', c);
      toast('已保存 ✓');
    } else {
      const c = { name, icon: state.catIconPick, color: PALETTE[state.categories.length % PALETTE.length] };
      const id = await dbAdd('categories', c);
      c.id = id;
      state.categories.push(c);
      toast('已新增分类 ✓');
    }
    await reloadData(); renderAll();
    if (state.view === 'detail') renderDetail();
    closeSheet($('#sheetCatBackdrop'));
    if ($('#sheetCatMgrBackdrop').classList.contains('open')) renderCatManager();
  } catch (e) { console.error(e); toast('保存失败：' + (e.message || '存储异常'), true); }
}
function openCatManager() { renderCatManager(); openSheet($('#sheetCatMgrBackdrop')); }
function renderCatManager() {
  $('#catMgrList').innerHTML = state.categories.map(c => `
    <div class="mgr-item">
      <div class="mgr-icon">${c.icon}</div>
      <div class="mgr-name">${esc(c.name)}</div>
      <div class="mgr-acts">
        <button type="button" data-edit="${c.id}" title="改名">✎</button>
        <button type="button" data-del="${c.id}" title="删除">🗑</button>
      </div>
    </div>`).join('') || '<div class="empty" style="padding:20px"><div class="dd">暂无分类</div></div>';
}
async function deleteCat(catId) {
  const c = catById(catId);
  if (!c) return;
  const n = state.records.filter(r => r.categoryId === catId).length;
  const ok = await confirmDialog('删除分类',
    `确定删除分类「<b>${esc(c.name)}</b>」吗？<br>有 <b>${n}</b> 条账单使用该分类，删除后这些账单会显示为「其他」。`);
  if (!ok) return;
  try {
    await dbDelete('categories', catId);
    await reloadData(); renderAll();
    if (state.view === 'detail') renderDetail();
    renderCatManager();
    toast('已删除分类');
  } catch (e) { console.error(e); toast('删除失败', true); }
}

/* ────────────── 记账页 ────────────── */
function renderAddForm() {
  const card = $('#addFormCard');
  // 没有明星档案时：不显示空表单，直接引导去创建
  if (!state.idols.length) {
    card.innerHTML = `
      <div class="empty" style="padding:30px 16px">
        <span class="em">⭐</span>
        <div class="tt">还没有明星档案</div>
        <div class="dd">每笔账单都归属到一位明星，<br>请先创建明星档案再记账</div>
        <button class="btn gold" id="addGotoIdol">＋ 去新增明星</button>
      </div>`;
    $('#addGotoIdol').addEventListener('click', () => {
      switchView('home');
      openIdolSheet();
    });
    return;
  }
  // 恢复表单结构（空状态引导后回到正常表单）
  if (!card.querySelector('#recIdolSelect')) {
    card.innerHTML = `
      <label class="field"><span class="field-label">所属明星 *</span><select id="recIdolSelect"></select></label>
      <div class="field-row">
        <label class="field grow"><span class="field-label">消费分类 *</span><select id="recCatSelect"></select></label>
        <button class="btn ghost sm" type="button" id="btnNewCat">＋ 新分类</button>
      </div>
      <label class="field"><span class="field-label">消费名称 *</span><input type="text" id="recNameInput" placeholder="如：上海演唱会 980 内场" maxlength="50"></label>
      <div class="field-row">
        <label class="field grow"><span class="field-label">价格（¥）*</span><div class="price-wrap"><span class="price-sym">¥</span><input type="number" id="recPriceInput" placeholder="0.00" step="0.01" min="0" inputmode="decimal"></div></label>
        <label class="field grow"><span class="field-label">消费日期 *</span><input type="date" id="recDateInput"></label>
      </div>
      <div class="field">
        <span class="field-label">图片凭证：小票 / 订单截图 / 实物照（最多 9 张）</span>
        <div class="img-pick-grid" id="recImgGrid"></div>
        <input type="file" id="recImgInput" accept="image/*" multiple class="ghost-input">
        <input type="file" id="recCamInput" accept="image/*" capture="environment" class="ghost-input">
      </div>
      <label class="field"><span class="field-label">备注（选填）</span><textarea id="recNoteInput" rows="2" placeholder="想说的话…" maxlength="200"></textarea></label>
      <button class="btn gold block" id="btnSaveRec">保存账单</button>`;
    bindAddFormControls();
    resetRecForm();
  }
  const sel = $('#recIdolSelect');
  const prevIdol = sel.value;
  sel.innerHTML = state.idols.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
  if (prevIdol && state.idols.some(i => String(i.id) === prevIdol)) sel.value = prevIdol;
  if (state.editingRecId) {
    const r = state.records.find(x => x.id === state.editingRecId);
    if (r) sel.value = r.idolId || '';
  }
  const catSel = $('#recCatSelect');
  const prevCat = catSel.value;
  catSel.innerHTML = state.categories.map(c =>
    `<option value="${c.id}">${esc(c.name)}</option>`).join('') || '<option value="">请先新增分类</option>';
  if (prevCat && state.categories.some(c => String(c.id) === prevCat)) catSel.value = prevCat;
  if (!state.editingRecId && !$('#recDateInput').value) $('#recDateInput').value = todayStr();
  renderRecImgGrid();
  $('#addTitle').textContent = state.editingRecId ? '✏️ 编辑账单' : '✏️ 记一笔';
}
function bindAddFormControls() {
  $('#btnNewCat').addEventListener('click', () => openCatSheet(null));
  $('#recImgGrid').addEventListener('click', (e) => {
    const rm = e.target.closest('.rm');
    if (rm) { state.recImages.splice(parseInt(rm.dataset.i, 10), 1); renderRecImgGrid(); return; }
    const img = e.target.closest('img.rec-thumb-img');
    if (img) { openViewer(state.recImages, parseInt(img.dataset.i, 10)); return; }
    if (e.target.closest('.img-add-btn')) $('#recImgInput').click();
    if (e.target.closest('.img-cam-btn')) $('#recCamInput').click();
  });
  $('#recImgInput').addEventListener('change', onPickRecImgs);
  $('#recCamInput').addEventListener('change', onPickRecImgs);
  $('#btnSaveRec').addEventListener('click', saveRec);
}
function resetRecForm(presetIdol) {
  state.editingRecId = null;
  state.recImages = [];
  $('#recIdolSelect').value = presetIdol || (state.idols[0] ? state.idols[0].id : '');
  $('#recCatSelect').value = state.categories[0] ? state.categories[0].id : '';
  $('#recNameInput').value = '';
  $('#recPriceInput').value = '';
  $('#recDateInput').value = todayStr();
  $('#recNoteInput').value = '';
  renderRecImgGrid();
}
function startEditRec(rec) {
  state.editingRecId = rec.id;
  switchView('add');
  $('#recIdolSelect').value = rec.idolId || '';
  $('#recCatSelect').value = rec.categoryId || '';
  $('#recNameInput').value = rec.name || '';
  $('#recPriceInput').value = rec.price != null ? rec.price : '';
  $('#recDateInput').value = rec.date || todayStr();
  $('#recNoteInput').value = rec.note || '';
  state.recImages = (rec.images || []).slice();
  renderRecImgGrid();
  renderAddForm();
  // 重新填 selects（renderAddForm 会覆盖 cat），再校正
  $('#recIdolSelect').value = rec.idolId || '';
  $('#recCatSelect').value = rec.categoryId || '';
}
function renderRecImgGrid() {
  const grid = $('#recImgGrid');
  if (!grid) return;
  let html = state.recImages.map((d, i) => `
    <div class="img-pick"><img class="rec-thumb-img" src="${d}" data-i="${i}" loading="lazy"><button type="button" class="rm" data-i="${i}">✕</button></div>
  `).join('');
  if (state.recImages.length < 9) {
    html += `
      <button type="button" class="img-pick-add img-add-btn"><span class="big-ic">🖼️</span><span class="mini-lbl">相册上传</span></button>
      <button type="button" class="img-pick-add img-cam-btn"><span class="big-ic">📷</span><span class="mini-lbl">拍照上传</span></button>`;
  }
  grid.innerHTML = html;
}
async function onPickRecImgs(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const room = 9 - state.recImages.length;
  if (room <= 0) return toast('最多 9 张图片', true);
  const picks = files.slice(0, room);
  if (files.length > room) toast('超出上限，仅添加前 ' + room + ' 张');
  for (const f of picks) {
    try { state.recImages.push(await fileToData(f)); }
    catch (err) { toast(err.message || '图片处理失败', true); }
  }
  renderRecImgGrid();
}
async function saveRec() {
  const btn = $('#btnSaveRec');
  if (!btn || btn.disabled) return;
  const idolId = parseInt($('#recIdolSelect').value, 10) || null;
  const catId = parseInt($('#recCatSelect').value, 10) || null;
  const name = $('#recNameInput').value.trim();
  const price = round2($('#recPriceInput').value);
  const date = $('#recDateInput').value || todayStr();
  const note = $('#recNoteInput').value.trim();
  if (!idolId) { toast('请先选择或创建明星档案', true); switchView('home'); openIdolSheet(); return; }
  if (!catId) { toast('请先新增消费分类', true); return; }
  if (!name) { toast('请填写消费名称', true); $('#recNameInput').focus(); return; }
  if (isNaN(price) || price < 0) { toast('请填写正确的价格', true); $('#recPriceInput').focus(); return; }
  btn.disabled = true;
  const oldTxt = btn.textContent;
  btn.textContent = '保存中…';
  try {
    if (state.editingRecId) {
      const r = state.records.find(x => x.id === state.editingRecId);
      if (!r) throw new Error('账单不存在');
      Object.assign(r, { idolId, categoryId: catId, name, price, date, note, images: state.recImages });
      await dbPut('records', r);
      toast('已保存 ✓');
      state.editingRecId = null;
    } else {
      const r = { idolId, categoryId: catId, name, price, date, note, images: state.recImages.slice(), createdAt: Date.now() };
      await dbAdd('records', r);
      toast('已记账 ✨ ' + fmtMoney(price));
      checkQuota();
    }
    await reloadData(); renderAll();
    if (state.view === 'detail') renderDetail();
    resetRecForm(idolId);
  } catch (e) {
    console.error(e);
    toast('保存失败：' + (e.message || '存储异常') + '（表单内容已保留，可重试）', true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldTxt;
  }
}

/* ────────────── 明星详情页 ────────────── */
function openIdolDetail(id) {
  state.detailIdolId = id;
  state.detailFilterCat = null;
  switchView('detail');
}
function renderDetail() {
  const idol = idolById(state.detailIdolId);
  if (!idol) {
    $('#idolHero').innerHTML = '<div class="ih-info"><div class="ih-name">明星不存在</div></div>';
    return;
  }
  const recs = recsOf(idol.id).sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0));
  $('#idolHero').innerHTML = `
    <div class="avatar-circle">${idol.avatar ? `<img src="${idol.avatar}" alt="">` : '⭐'}</div>
    <div class="ih-info">
      <div class="ih-name">${esc(idol.name)}</div>
      <div class="ih-sub">累计 <span class="num" style="color:var(--accent2)">${fmtMoney(totalOf(recs))}</span> · ${recs.length} 条账单</div>
    </div>
    <div class="ih-acts">
      <button class="icon-btn" id="ihStats" title="年度统计">📊</button>
      <button class="icon-btn" id="ihEdit" title="编辑">✎</button>
      <button class="icon-btn danger" id="ihDel" title="删除">🗑</button>
    </div>`;

  // 分类 chips + 统计入口
  const chips = state.categories.map(c => {
    const amt = totalOf(recs.filter(r => r.categoryId === c.id));
    if (amt === 0 && state.detailFilterCat !== 'c' + c.id) return '';
    return `<button class="chip${state.detailFilterCat === 'c' + c.id ? ' active' : ''}" data-c="c${c.id}"><span class="em">${c.icon}</span>${esc(c.name)} <span class="num" style="color:var(--accent2)">${fmtMoneyShort(amt)}</span></button>`;
  }).filter(Boolean).join('');
  $('#detailCatChips').innerHTML =
    `<button class="chip${!state.detailFilterCat ? ' active' : ''}" id="detailAllChip">全部</button>` +
    chips +
    `<button class="chip" id="detailGoStats">📊 年度统计 ›</button>`;

  let shown = recs;
  if (state.detailFilterCat && state.detailFilterCat[0] === 'c') {
    shown = recs.filter(r => 'c' + r.categoryId === state.detailFilterCat);
  }
  const list = $('#detailRecords');
  if (!shown.length) {
    list.innerHTML = `<div class="empty glass"><span class="em">🎫</span><div class="tt">暂无消费记录</div><div class="dd">去「记账」页为 TA 记一笔吧</div><button class="btn gold" id="detailGoAdd">＋ 记一笔</button></div>`;
    $('#detailGoAdd').addEventListener('click', () => {
      resetRecForm(idol.id);
      switchView('add');
    });
  } else {
    list.innerHTML = shown.slice(0, 200).map(r => recItemHtml(r, idol)).join('');
    $$('.rec-item', list).forEach(el =>
      el.addEventListener('click', () => openRecDetail(parseInt(el.dataset.id, 10))));
  }
}
function openIdolStats() {
  state.statMode = 'single';
  state.statIdol = state.detailIdolId;
  switchView('stats');
}

/* ────────────── 记录条目 / 详情 ────────────── */
function recItemHtml(r, idolOverride) {
  const idol = idolOverride || idolById(r.idolId);
  const cat = catById(r.categoryId);
  const th = (r.images && r.images[0])
    ? `<img src="${r.images[0]}" alt="" loading="lazy">`
    : (cat ? cat.icon : '🎫');
  return `
    <div class="rec-item glass" data-id="${r.id}">
      <div class="rec-thumb">${th}</div>
      <div class="rec-main">
        <div class="rec-name">${esc(r.name)}</div>
        <div class="rec-meta">
          ${cat ? `<span class="cat-tag" style="color:${cat.color}">${cat.icon} ${esc(cat.name)}</span>` : '<span class="cat-tag">其他</span>'}
          <span>${esc(idol ? idol.name : '无归属')}</span>
          <span class="num">${esc(r.date || '')}</span>
        </div>
      </div>
      <div class="rec-price num">${fmtMoney(r.price)}</div>
    </div>`;
}
function openRecDetail(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  const idol = idolById(r.idolId);
  const cat = catById(r.categoryId);
  const imgs = r.images || [];
  $('#recDetailBody').innerHTML = `
    <div class="rd-carousel">${imgs.map((d, i) =>
      `<div class="rd-slide"><img src="${d}" data-zoom="${i}" ${i > 0 ? 'loading="lazy"' : ''}></div>`).join('')}</div>
    <div class="rd-row"><span class="k">所属明星</span><span class="v">${esc(idol ? idol.name : '无归属')}</span></div>
    <div class="rd-row"><span class="k">消费分类</span><span class="v">${cat ? cat.icon + ' ' + esc(cat.name) : '其他'}</span></div>
    <div class="rd-row"><span class="k">消费名称</span><span class="v">${esc(r.name)}</span></div>
    <div class="rd-row"><span class="k">价格</span><span class="v money num">${fmtMoney(r.price)}</span></div>
    <div class="rd-row"><span class="k">消费时间</span><span class="v num">${esc(r.date || '')}</span></div>
    <div class="rd-row"><span class="k">备注</span><span class="v">${esc(r.note || '—')}</span></div>
    <div class="sheet-btns rd-actions">
      <button class="btn danger" id="rdDel">删除</button>
      <button class="btn gold" id="rdEdit">编辑</button>
    </div>`;
  $$('[data-zoom]', $('#recDetailBody')).forEach(im =>
    im.addEventListener('click', () => openViewer(imgs, parseInt(im.dataset.zoom, 10))));
  $('#rdEdit').addEventListener('click', () => {
    closeSheet($('#sheetRecDetailBackdrop'));
    startEditRec(r);
  });
  $('#rdDel').addEventListener('click', async () => {
    const ok = await confirmDialog('删除账单', `确定删除「<b>${esc(r.name)}</b>」吗？<br>对应的图片凭证会一并删除。`);
    if (!ok) return;
    try {
      await dbDelete('records', r.id);
      closeSheet($('#sheetRecDetailBackdrop'));
      await reloadData(); renderAll();
      if (state.view === 'detail') renderDetail();
      checkQuota();
      toast('已删除');
    } catch (e) { console.error(e); toast('删除失败', true); }
  });
  openSheet($('#sheetRecDetailBackdrop'));
}

/* ────────────── 图片浏览器（当前图 + 前后 1 张，其余懒加载） ────────────── */
function openViewer(images, start) {
  if (!images || !images.length) return;
  $('#viewerStrip').innerHTML = images.map((d, i) =>
    `<div class="viewer-slide"><img src="${d}" alt="" ${i > 0 ? 'loading="lazy"' : ''}></div>`).join('');
  $('#viewerDots').innerHTML = images.map((_, i) =>
    `<i class="${i === start ? 'on' : ''}"></i>`).join('');
  const strip = $('#viewerStrip');
  strip.scrollLeft = start * Math.max(1, strip.clientWidth);
  $('#viewer').classList.add('open');
}

/* ────────────── 通用确认 ────────────── */
let _confirmResolve = null;
function finishConfirm(v) {
  $('#confirmBackdrop').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(v); _confirmResolve = null; }
}
function confirmDialog(title, html, yesText) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').innerHTML = html;
  $('#confirmYes').textContent = yesText || '删除';
  $('#confirmBackdrop').classList.remove('hidden');
  return new Promise(res => { _confirmResolve = res; });
}

/* ═══════════════ 统计页 ═══════════════ */
function renderStats() {
  const modeChips = $('#statModeChips');
  modeChips.innerHTML = `
    <button class="chip${state.statMode === 'all' ? ' active' : ''}" data-m="all">🌐 全部总统计</button>
    <button class="chip${state.statMode === 'single' ? ' active' : ''}" data-m="single">⭐ 单个明星统计</button>`;
  $$('#statModeChips .chip').forEach(b => b.addEventListener('click', () => {
    state.statMode = b.dataset.m;
    renderStats();
  }));

  // 年份 chips
  const yChips = $('#statYearChips');
  yChips.innerHTML =
    `<button class="chip${state.statYear === 'this' ? ' active' : ''}" data-y="this">本年</button>` +
    `<button class="chip${state.statYear === 'last' ? ' active' : ''}" data-y="last">去年</button>` +
    (state.statYear !== 'this' && state.statYear !== 'last'
      ? `<button class="chip active" data-y="${state.statYear}">${yearValue()} 年</button>` : '') +
    `<button class="chip" id="chipCustomYear">📅 自定义</button>`;
  $$('#statYearChips .chip[data-y]').forEach(b => b.addEventListener('click', () => {
    state.statYear = b.dataset.y; renderStats();
  }));
  $('#chipCustomYear').addEventListener('click', () => {
    const yv = prompt('请输入年份（如 2025）：', String(yearValue()));
    if (yv && /^\d{4}$/.test(yv.trim())) { state.statYear = yv.trim(); renderStats(); }
  });

  const body = $('#statBody');
  if (state.statMode === 'single') {
    // 明星选择 chips
    const idolChips = $('#statIdolChips');
    idolChips.classList.remove('hidden');
    if (!state.idols.length) {
      idolChips.innerHTML = '';
      body.innerHTML = `<div class="empty glass"><span class="em">⭐</span><div class="tt">还没有明星档案</div><div class="dd">先去首页创建明星并记账</div></div>`;
      return;
    }
    if (!state.statIdol || !idolById(state.statIdol)) state.statIdol = state.idols[0].id;
    idolChips.innerHTML = state.idols.map(i =>
      `<button class="chip${state.statIdol === i.id ? ' active' : ''}" data-v="${i.id}">⭐ ${esc(i.name)}</button>`).join('');
    $$('#statIdolChips .chip').forEach(b => b.addEventListener('click', () => {
      state.statIdol = parseInt(b.dataset.v, 10); renderStats();
    }));
    renderSingleStats(body, idolById(state.statIdol));
  } else {
    $('#statIdolChips').classList.add('hidden');
    renderAllStats(body);
  }
}

const MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
function fillMonths(recs) {
  const months = Array(12).fill(0);
  recs.forEach(r => {
    const mm = parseInt(String(r.date || '').slice(5, 7), 10);
    if (mm >= 1 && mm <= 12) months[mm - 1] += Number(r.price) || 0;
  });
  return months;
}

/* —— 视图 A：单个明星年度统计 —— */
function renderSingleStats(body, idol) {
  const year = yearValue();
  const recs = recsOfYear(year).filter(r => r.idolId === idol.id)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const total = totalOf(recs);

  const byCat = state.categories.map(c => {
    const sub = recs.filter(r => r.categoryId === c.id);
    return { cat: c, recs: sub, total: totalOf(sub) };
  }).filter(x => x.total > 0);
  const catItems = byCat.map(x => ({ label: x.cat.icon + ' ' + x.cat.name, value: x.total, color: x.cat.color }));

  body.innerHTML = `
    <div class="stat-hero glass">
      <div class="lbl">${esc(idol.name)} · ${year} 年度总消费</div>
      <div class="big gold-grad num">${fmtMoney(total)}</div>
      <div class="lbl">共 ${recs.length} 条账单</div>
    </div>
    <div class="chart-card glass"><div class="chart-title">📊 各分类总花费（柱状图）</div><canvas id="chCatBar" data-h="210"></canvas></div>
    <div class="chart-card glass"><div class="chart-title">🥧 分类占比（饼图）</div><canvas id="chCatPie" data-h="200"></canvas>
      <div id="pctList">${pctListHtml(catItems, total)}</div>
    </div>
    <div class="chart-card glass"><div class="chart-title">📈 月度趋势</div><canvas id="chMonth" data-h="180"></canvas></div>
    <div class="chart-card glass"><div class="chart-title">🗒️ ${year} 年全部消费流水（${recs.length}）</div>
      <div id="flowList">${recs.length ? recs.map(r => recItemHtml(r, idol)).join('') : '<div class="empty" style="padding:20px"><div class="dd">该明星本年暂无账单</div></div>'}</div>
    </div>`;
  bindFlow($('#flowList'));
  drawChartsWhenReady([
    ['#chCatBar', cv => drawBarChart(cv, byCat.map(x => x.cat.icon), byCat.map(x => x.total))],
    ['#chCatPie', cv => drawPieChart(cv, catItems)],
    ['#chMonth',  cv => drawLineChart(cv, MONTHS, fillMonths(recs))],
  ]);
}

/* —— 视图 B：全部明星合并年度统计 —— */
function renderAllStats(body) {
  const year = yearValue();
  const recs = recsOfYear(year).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const total = totalOf(recs);

  const byCatMap = {};
  recs.forEach(r => {
    const c = catById(r.categoryId);
    const k = c ? c.id : -1;
    if (!byCatMap[k]) byCatMap[k] = { label: c ? c.icon + ' ' + c.name : '其他', color: c ? c.color : '#4A4A55', value: 0 };
    byCatMap[k].value += Number(r.price) || 0;
  });
  const catItems = Object.values(byCatMap).map(x => ({ ...x, value: round2(x.value) })).sort((a, b) => b.value - a.value);

  const idolsWithTotal = state.idols.map(i => ({ label: i.name, value: totalOf(recs.filter(r => r.idolId === i.id)) }))
    .filter(x => x.value > 0).sort((a, b) => b.value - a.value);
  const orphan = totalOf(recs.filter(r => !r.idolId));
  if (orphan > 0) idolsWithTotal.push({ label: '无归属', value: orphan });

  const top5 = recs.slice().sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, 5);

  body.innerHTML = `
    <div class="stat-hero glass">
      <div class="lbl">${year} 年 · 全部追星总支出</div>
      <div class="big gold-grad num">${fmtMoney(total)}</div>
      <div class="lbl">共 ${recs.length} 条账单 · ${state.idols.length} 位明星</div>
    </div>
    <div class="chart-card glass"><div class="chart-title">🥧 消费大类占比（饼图）</div><canvas id="chCatPie" data-h="200"></canvas>
      <div id="pctList">${pctListHtml(catItems, total)}</div>
    </div>
    <div class="chart-card glass"><div class="chart-title">📊 消费大类总花费（柱状图）</div><canvas id="chCatBar" data-h="210"></canvas></div>
    <div class="chart-card glass"><div class="chart-title">⭐ 各明星全年总开销对比</div><canvas id="chIdolBar" data-h="210"></canvas></div>
    <div class="chart-card glass"><div class="chart-title">🏆 Top 5 高额消费</div>
      <div id="top5List">${top5.length ? top5.map((r, i) => {
        const idol = idolById(r.idolId);
        return `<div class="top5-item" data-id="${r.id}"><div class="top5-name"><span class="rk num">${i + 1}</span>${esc(r.name)}<span class="who">${esc(idol ? idol.name : '无归属')}</span></div><div class="top5-amt num">${fmtMoney(r.price)}</div></div>`;
      }).join('') : '<div class="empty" style="padding:20px"><div class="dd">本年暂无账单</div></div>'}</div>
    </div>
    <div class="chart-card glass"><div class="chart-title">🗒️ ${year} 年全部流水汇总（${recs.length}）</div>
      <div id="flowList">${recs.length ? recs.slice(0, 300).map(r => recItemHtml(r)).join('') : '<div class="empty" style="padding:20px"><div class="dd">本年暂无账单</div></div>'}</div>
    </div>`;
  bindFlow($('#flowList'));
  $$('#top5List .top5-item').forEach(el => el.addEventListener('click', () => openRecDetail(+el.dataset.id)));
  drawChartsWhenReady([
    ['#chCatPie', cv => drawPieChart(cv, catItems)],
    ['#chCatBar', cv => drawBarChart(cv, catItems.map(x => x.label.split(' ')[0]), catItems.map(x => x.value))],
    ['#chIdolBar', cv => drawBarChart(cv, idolsWithTotal.map(x => x.label), idolsWithTotal.map(x => x.value))],
  ]);
}
function pctListHtml(items, total) {
  if (!items.length) return '<div class="empty" style="padding:14px"><div class="dd">暂无数据</div></div>';
  return items.map(x => `
    <div class="pct-item">
      <span class="dot" style="background:${x.color}"></span>
      <span class="pn">${esc(x.label)}</span>
      <span class="pv num">${fmtMoney(x.value)}</span>
      <span class="pp num">${total > 0 ? (x.value / total * 100).toFixed(1) : '0.0'}%</span>
    </div>`).join('');
}
function bindFlow(el) {
  if (!el) return;
  $$('.rec-item', el).forEach(item =>
    item.addEventListener('click', () => openRecDetail(parseInt(item.dataset.id, 10))));
}
function drawChartsWhenReady(jobs) {
  requestAnimationFrame(() => jobs.forEach(([sel, fn]) => safe(() => fn($(sel)))));
}

/* ═══════════════ 原生 Canvas 图表（深色适配） ═══════════════ */
function setupCanvas(cv) {
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320;
  const h = cv.getAttribute('data-h') ? +cv.getAttribute('data-h') : 200;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function chartFont(size, bold) { return (bold ? '600 ' : '') + size + 'px "SF Mono","Menlo",monospace'; }
function drawEmpty(cv, ctx, w, h) {
  ctx.fillStyle = 'rgba(110,110,120,.9)';
  ctx.font = '12px "PingFang SC",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('暂无数据', w / 2, h / 2);
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, 0);
  ctx.arcTo(x, y + h, x, y, 0);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function shortNum(v) {
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

/* 柱状图 */
function drawBarChart(cv, labels, values) {
  const s = setupCanvas(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);
  if (!values.length || values.every(v => !v)) return drawEmpty(cv, ctx, w, h);
  const padL = 8, padR = 8, padT = 26, padB = 26;
  const iw = w - padL - padR, ih = h - padT - padB;
  const maxV = Math.max(1, ...values);
  const n = labels.length || 1;
  const bw = Math.min(34, iw / n * 0.55);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ih - ih * g / 3;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, '#A795FF'); grad.addColorStop(1, '#5E4BD1');
  labels.forEach((lb, i) => {
    const v = values[i] || 0;
    const cx = padL + iw / n * (i + 0.5);
    const bh = v > 0 ? Math.max(2, ih * v / maxV) : 2;
    ctx.fillStyle = v > 0 ? grad : 'rgba(255,255,255,.08)';
    roundRect(ctx, cx - bw / 2, padT + ih - bh, bw, bh, 4);
    ctx.fill();
    if (v > 0) {
      ctx.fillStyle = '#B3A6FF';
      ctx.font = chartFont(9);
      ctx.textAlign = 'center';
      ctx.fillText(shortNum(v), cx, padT + ih - bh - 5);
    }
    ctx.fillStyle = 'rgba(180,180,190,.85)';
    ctx.font = '9px "PingFang SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(lb), cx, h - 8);
  });
}

/* 折线图 */
function drawLineChart(cv, labels, values) {
  const s = setupCanvas(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);
  if (!values.length || values.every(v => !v)) return drawEmpty(cv, ctx, w, h);
  const padL = 8, padR = 8, padT = 22, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;
  const maxV = Math.max(1, ...values);
  const n = values.length || 1;
  const px = i => padL + iw / (n - 1 || 1) * i;
  const py = v => padT + ih - ih * v / maxV;
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ih - ih * g / 3;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(px(0), py(v)) : ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(n - 1), padT + ih); ctx.lineTo(px(0), padT + ih); ctx.closePath();
  const fill = ctx.createLinearGradient(0, padT, 0, h - padB);
  fill.addColorStop(0, 'rgba(123,97,255,.32)'); fill.addColorStop(1, 'rgba(123,97,255,0)');
  ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(px(0), py(v)) : ctx.lineTo(px(i), py(v)));
  const stroke = ctx.createLinearGradient(0, padT, 0, h - padB);
  stroke.addColorStop(0, '#B3A6FF'); stroke.addColorStop(1, '#7B61FF');
  ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  values.forEach((v, i) => {
    ctx.beginPath(); ctx.arc(px(i), py(v), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#B3A6FF'; ctx.fill();
  });
  ctx.fillStyle = 'rgba(180,180,190,.85)';
  ctx.font = '9px "PingFang SC",sans-serif'; ctx.textAlign = 'center';
  labels.forEach((lb, i) => { if (i % 2 === 0) ctx.fillText(lb, px(i), h - 8); });
}

/* 饼图（带图例） */
function drawPieChart(cv, items) {
  const s = setupCanvas(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);
  if (!items || !items.length || items.every(x => x.value <= 0)) return drawEmpty(cv, ctx, w, h);
  const total = items.reduce((sum, x) => sum + Math.max(0, x.value), 0) || 1;
  const cx = h * 0.5, cy = h / 2, R = Math.min(h / 2 - 8, 72);
  let ang = -Math.PI / 2;
  items.forEach((it, i) => {
    const a = Math.max(0, it.value) / total * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, ang, ang + a);
    ctx.closePath();
    ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
    ctx.fill();
    ang += a;
  });
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#141419'; ctx.fill();
  let ly = 14;
  items.slice(0, 7).forEach((it, i) => {
    ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
    ctx.beginPath(); ctx.arc(h * 1.28, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#B4B4BE';
    ctx.font = '11px "PingFang SC",sans-serif'; ctx.textAlign = 'left';
    const pct = (it.value / total * 100).toFixed(1);
    ctx.fillText(`${it.label}  ${pct}%`, h * 1.28 + 10, ly + 4);
    ly += 20;
  });
}

/* ────────────── 设置 ────────────── */
function getProfile() {
  try { return JSON.parse(localStorage.getItem('se_profile') || '{}'); }
  catch (e) { return {}; }
}
function openSettings() {
  const p = getProfile();
  $('#settingsNickname').value = p.nickname || '';
  $('#settingsAvatar').innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : '🌙';
  $('#settingsAvatar').dataset.img = p.avatar || '';
  openSheet($('#sheetSettingsBackdrop'));
}
function onPickSettingsAvatar(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  fileToData(f).then(d => {
    $('#settingsAvatar').innerHTML = `<img src="${d}" alt="">`;
    $('#settingsAvatar').dataset.img = d;
  }).catch(err => toast(err.message, true));
}
function saveProfile() {
  const p = getProfile();
  p.nickname = $('#settingsNickname').value.trim() || '追星人';
  p.avatar = $('#settingsAvatar').dataset.img || '';
  try {
    localStorage.setItem('se_profile', JSON.stringify(p));
    toast('已保存 ✓');
    closeSheet($('#sheetSettingsBackdrop'));
  } catch (e) { toast('图片太大，本机存储空间不足，换一张小图试试', true); }
}
function exportData() {
  try {
    const data = {
      app: '追星消费记账本', version: 2, exportedAt: new Date().toISOString(),
      idols: state.idols, categories: state.categories, records: state.records,
      profile: getProfile(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '追星消费记账本_' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已导出 ✓ 建议每月备份一次');
  } catch (e) { console.error(e); toast('导出失败', true); }
}

/* ═══════════════ PWA 安装 ═══════════════ */
let _deferredPrompt = null;
function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPrompt = e;
  });
}
function showInstallGuide() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  let html;
  if (isIOS) {
    html = `<b>iOS · Safari</b><ol>
      <li>用 <b>Safari</b> 打开本页（微信内打开请点右上角 ⋯ → 「在浏览器中打开」）</li>
      <li>点击底部 <b>分享</b> 按钮（方框加箭头）</li>
      <li>选择 <b>「添加到主屏幕」</b></li>
      <li>点击 <b>「添加」</b> 完成 ✨</li></ol>`;
  } else if (isAndroid) {
    html = `<b>Android · Chrome / 系统浏览器</b><ol>
      <li>建议用 <b>Chrome</b> 打开（微信内打开请点 ⋯ → 「在浏览器中打开」）</li>
      <li>点击右上角 <b>⋮</b> 菜单</li>
      <li>选择 <b>「安装应用」/「添加到主屏幕」</b></li>
      <li>点击 <b>「安装」</b> 完成 ✨</li></ol>`;
  } else {
    html = `<b>桌面 · Chrome / Edge</b><ol>
      <li>点击地址栏右侧 <b>⊕ 安装图标</b>（或右上角 ⋮ → 「安装应用」）</li>
      <li>点击 <b>「安装」</b> 完成 ✨</li></ol>
      安装后是独立窗口应用，离线可用。`;
  }
  html += `<br><br>💡 无痕/隐私模式下数据无法保存，请正常模式使用。`;
  $('#installGuideText').innerHTML = html;
  $('#installBackdrop').classList.remove('hidden');
  $('#installOk').addEventListener('click', async () => {
    $('#installBackdrop').classList.add('hidden');
    if (_deferredPrompt) {
      _deferredPrompt.prompt();
      await _deferredPrompt.userChoice;
      _deferredPrompt = null;
    }
  }, { once: true });
}

/* ────────────── Service Worker（注册失败自动降级） ────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      // 用户是否已经开始操作（点过屏幕）——更新时绝不打断正在使用的用户
      let userInteracted = false;
      const mark = () => { userInteracted = true; };
      ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
        window.addEventListener(ev, mark, { once: true, passive: true }));

      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshed) return;
        refreshed = true;
        // 还没开始操作 → 静默刷新到最新版；已在操作中 → 只提示，不打断
        if (!userInteracted) { location.reload(); }
        else { try { toast('已更新到最新版本，下次打开自动生效 ✨'); } catch (_) {} }
      });

      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.update && reg.update().catch(() => {});
      }).catch(err => console.warn('SW 注册失败，降级为普通模式', err));
    } catch (e) { console.warn('SW 注册异常，降级为普通模式', e); }
  });
}

document.addEventListener('DOMContentLoaded', init);
