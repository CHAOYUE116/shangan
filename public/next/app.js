/* 上岸 · 新版前端（真实数据，server/local 双模式） */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 粉笔的公式图是协议相对 URL（//fb.fbstatic.cn/...），在 http:// 页面里会被当成
// http://fb.fbstatic.cn 加载失败，看起来就是「选项是空的」。统一补成 https。
function normSrc(html) {
  return String(html || '').replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])\/\//gi, '$1https://');
}

function safeHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = normSrc(html);
  t.content.querySelectorAll('script,style,iframe,object,embed').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  return t.innerHTML;
}

/* ---------- 公式图离线化（不依赖 Service Worker） ----------
 * Capacitor 的 WebView 里 serviceWorker.register 会失败（本地资源根是自定义
 * scheme），所以 sw-local.js 那套拦截在 App 内一直没生效，结果是公式图画不出来。
 * 这里改成渲染后直接把 <img src="…formulas?latex=KEY"> 换成 data: URL：
 * KEY 就是 images.db 的主键，走原生桥一次查询即可，全程离线。
 */
const IMG_KEY_RE = /[?&]latex=([^&"']+)/;
const _imgUrlCache = new Map();

function imgKeyOf(src) {
  const m = IMG_KEY_RE.exec(String(src || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return `data:${mime || 'image/png'};base64,${btoa(bin)}`;
}

function hydrateImages(root) {
  const imgApi = window.__LOCAL_IMAGES__;
  if (!imgApi || !root || !root.querySelectorAll) return;
  for (const im of root.querySelectorAll('img:not([data-img-ok])')) {
    const key = imgKeyOf(im.getAttribute('src'));
    if (!key) continue;
    im.dataset.imgOk = '1';
    let url = _imgUrlCache.get(key);
    if (url === undefined) {
      try {
        const rec = imgApi.formula(key);
        url = rec && rec.blob ? bytesToDataUrl(rec.blob, rec.mime) : null;
      } catch { url = null; }
      _imgUrlCache.set(key, url);
    }
    if (url) im.src = url;
  }
}

if (typeof MutationObserver !== 'undefined') {
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') hydrateImages(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) hydrateImages(n);
    }
  });
  const startImgWatch = () => {
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    hydrateImages(document.body);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startImgWatch, { once: true });
  else startImgWatch();
}

/* 选项/解析渲染：含公式图（<img>）时走 safeHtml 保留图片，否则按纯文本转义 */
const hasRichHtml = (s) => /<img\b/i.test(String(s || ''));
function renderRichText(s) {
  const t = String(s || '');
  if (hasRichHtml(t)) return safeHtml(t);
  return esc(t.replace(/<[^>]+>/g, ''));
}
function renderOption(o) {
  return renderRichText(o);
}

async function api(path, opts) {
  if (window.__LOCAL_API_PROMISE__) return (await window.__LOCAL_API_PROMISE__)(path, opts);
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms || 1800);
}
function sheet(html) {
  const w = $('#sheet');
  w.innerHTML = `<div class="sheet">${html}</div>`;
  w.hidden = false;
  w.onclick = (e) => { if (e.target === w) closeSheet(); };
  const b = w.querySelector('.sheet-close');
  if (b) b.onclick = closeSheet;
}
function closeSheet() { const w = $('#sheet'); w.hidden = true; w.innerHTML = ''; }

const APP_VERSION = '0.7.1';
const DEFAULT_PROFILE = { examType: '公务员', province: '山东', examName: '2027 国考', examDate: '2026-11-29', dailyGoal: 20, scheme: '公务员·国考', excluded: [] };
const DEFAULT_EXAM_BY_TYPE = {
  '事业编': { name: '2027 事业单位联考', date: '2027-03-15' },
  '三支一扶': { name: '2027 三支一扶', date: '2027-05-15' },
};

/* ---------- 考试组合（2026-11） ----------
 * 以前的毛病：科目是全局的，公基 2.3 万题占事业编 57%，随机 15 题里 8~9 道是公基；
 * 但浙江统考、联考 A 类根本不考公基，只有福建《综合基础知识》、山西《综合知识》考。
 * 现在一场考试 = 若干科目 + 权重，每日任务、随机练习、组卷都按权重分配额，不按题库比例。
 */
const EXAM_SCHEMES = {
  '公务员·国考': { type: '公务员', subs: [['公务员·行测', 6], ['公务员·申论', 4]] },
  '公务员·省考': { type: '公务员', subs: [['公务员·行测', 6], ['公务员·申论', 4]] },
  '事业编·联考A类': { type: '事业编', subs: [['事业编·职测', 6], ['事业编·综应', 4]] },
  '事业编·浙江统考': { type: '事业编', subs: [['事业编·职测', 6], ['事业编·综应', 4]] },
  '事业编·福建综合基础': { type: '事业编', subs: [['事业编·公基', 7], ['事业编·综应', 3]] },
  '事业编·山西综合知识': { type: '事业编', subs: [['事业编·公基', 10]] },
  '三支一扶·综合知识': { type: '三支一扶', subs: [['事业编·公基', 6], ['事业编·职测', 4]] },
};
/** 当前档案对应的考试组合；档案里没写或写了不存在的，按类型兜底 */
function currentScheme() {
  const name = S.profile.scheme;
  if (name && EXAM_SCHEMES[name]) return { name, ...EXAM_SCHEMES[name] };
  const type = S.profile.examType || '公务员';
  const hit = Object.entries(EXAM_SCHEMES).find(([, v]) => v.type === type);
  return hit ? { name: hit[0], ...hit[1] } : { name: '公务员·国考', ...EXAM_SCHEMES['公务员·国考'] };
}
/** 本场考试要练的科目（已剔除"我不考这科"的），按权重降序 */
function schemeSubjects() {
  const sch = currentScheme();
  const off = new Set(S.profile.excluded || []);
  const list = sch.subs.filter(([s]) => !off.has(s)).map(([subject, w]) => ({ subject, w }));
  return list.length ? list : sch.subs.map(([subject, w]) => ({ subject, w }));
}
/** 按权重把 n 道题分给各科目：先保底 1 道，剩下的按权重摊，余数给权重最大的 */
function quotaFor(n, objectiveOnly = false) {
  // 每日任务只做客观题：综应/申论是主观题（作文、材料分析），塞进每日 15 题里体验很差，
  // 这两科走「按试卷/按考点」的整卷练习。主观题科目在题库里仍然可见可练。
  let subs = schemeSubjects();
  if (objectiveOnly) {
    const obj = subs.filter((x) => !/综应|申论/.test(x.subject));
    if (obj.length) subs = obj;
  }
  const total = subs.reduce((a, b) => a + b.w, 0) || 1;
  const raw = subs.map((s) => ({ subject: s.subject, v: (n * s.w) / total }));
  const out = raw.map((r) => ({ subject: r.subject, n: Math.max(n >= subs.length ? 1 : 0, Math.floor(r.v)) }));
  let left = n - out.reduce((a, b) => a + b.n, 0);
  // 余数按小数部分从大到小补
  const order = raw.map((r, i) => ({ i, frac: r.v - Math.floor(r.v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k = (k + 1) % order.length) { out[order[k].i].n += 1; left--; }
  while (left < 0) { const i = out.findIndex((o) => o.n > 0); if (i < 0) break; out[i].n -= 1; left++; }
  return out.filter((o) => o.n > 0);
}
// 档案自洽：类型不是公务员、考试名却还是默认的「2027 国考」时按类型换掉，
// 否则首页、考试页会写「事业编考生在准备国考」，自相矛盾。
function fixProfile(p) {
  if (!p) return p;
  // 老档案没有 scheme（0.3.6 之前），按考试类型补一个默认组合，
  // 否则 currentScheme() 会兜底到「国考」，事业编用户又会被带偏。
  if (!p.scheme) {
    const type = p.examType || '公务员';
    const hit = Object.entries(EXAM_SCHEMES).find(([, v]) => v.type === type);
    if (hit) p = { ...p, scheme: hit[0] };
  }
  if (!Array.isArray(p.excluded)) p = { ...p, excluded: [] };
  if (!p.examType || p.examType === '公务员') return p;
  if (p.examName && p.examName !== DEFAULT_PROFILE.examName && !/国考/.test(p.examName)) return p;
  const d = DEFAULT_EXAM_BY_TYPE[p.examType];
  if (!d) return p;
  return { ...p, examName: d.name, examDate: d.date };
}
function loadProfile() {
  try { return fixProfile(JSON.parse(localStorage.getItem('sg_profile') || 'null')); } catch { return null; }
}
function saveProfile(p) { localStorage.setItem('sg_profile', JSON.stringify(p)); S.profile = p; }

const S = {
  profile: loadProfile() || DEFAULT_PROFILE,
  tab: 'home',
  subjects: [],
  stats: null,
  lib: { view: 'subjects', subject: null, chapters: [], categories: [], papers: [], filter: { category: '全部', year: '全部', type: '全部' }, show: 80 },
  search: { q: '', list: [] },
  review: { tab: 'wrong', data: { wrong: [], fav: [], notes: [] }, loaded: {}, chapter: '' },
  practice: { open: false, qs: [], idx: 0, selected: null, confirmed: false, answers: {}, results: [], feedback: null, elapsed: 0, timer: null, ai: '', aiLoading: false, aiChat: [], aiError: '', aiCached: false, subject: '', title: '', kind: '', lastWrongIds: [], exam: false, remaining: 0, limitSec: 0 },
  planView: false,
  plan: null,
  examResult: null,
  meView: 'main',
  agents: [],
  skills: [],
  smart: { scope: 'weak', count: 20, difficulty: 'balanced', types: [1], year: 'all' },
};

const SUBJECT_RANK = { '公务员·行测': 0, '公务员·申论': 1, '事业编·综应': 2, '事业编·职测': 3, '事业编·公基': 4 };
function visibleSubjects() {
  const t = S.profile.examType;
  const byType = (t === '事业编' || t === '三支一扶')
    ? S.subjects.filter((s) => s.subjectName.startsWith('事业编'))
    : S.subjects.filter((s) => s.subjectName.startsWith('公务员'));
  // 先按「本场考试考什么」排：考试组合里的科目在前（权重高的更前），
  // 组合外的科目仍然保留（用户可能想看题库），但排到后面并标灰。
  const subs = schemeSubjects();
  const rankOf = (name) => {
    const i = subs.findIndex((x) => x.subject === name);
    return i < 0 ? 100 + (SUBJECT_RANK[name] ?? 9) : i;
  };
  return byType.slice().sort((a, b) => rankOf(a.subjectName) - rankOf(b.subjectName));
}
/** 本场考试不考的科目（用来在题库页标「不考」） */
function notInScheme(name) { return !schemeSubjects().some((x) => x.subject === name); }
function defaultSubject() {
  const subs = visibleSubjects();
  if (!subs.length) return '';
  // 优先用考试组合的第一科：浙江统考就是职测，福建综合基础就是公基
  const first = schemeSubjects()[0];
  if (first) {
    const hit = subs.find((s) => s.subjectName === first.subject);
    if (hit) return hit.subjectName;
  }
  const last = localStorage.getItem('sg_last_subject');
  if (last && subs.some((s) => s.subjectName === last)) return last;
  // 申论/综应是主观题，和客观题刷题体验完全不同，没练过时先不选它们
  const objective = subs.filter((s) => !/申论|综应/.test(s.subjectName));
  const pool = objective.length ? objective : subs;
  return pool.slice().sort((x, y) => (Number(y.questions) || 0) - (Number(x.questions) || 0))[0].subjectName;
}
function daysLeft() {
  const d = new Date(S.profile.examDate + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((d - now) / 86400000));
}
function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function todayCount() {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const arr = (S.stats && S.stats.daily) || [];
  const hit = arr.find((x) => x.d === key);
  return hit ? Number(hit.c) || 0 : 0;
}
function dailyGoal() { return S.profile.dailyGoal || 20; }
function dailyRemaining() { return Math.max(0, dailyGoal() - todayCount()); }
/* 一次请求最多只回 15 道（服务端限制），要 20 道或 50 道就得循环补齐。
   以前「50 题模考」实际只给 15 题、「20 题每日任务」只给 15 题，就是这个原因。 */
async function fetchPool(subject, need, types = '1,2,3') {
  const out = []; const seen = new Set();
  for (let round = 0; round < 8 && out.length < need; round++) {
    const ask = Math.min(60, Math.max(need - out.length, 15) * 2);
    let rows = [];
    try { rows = await api(`/api/practice?subject=${encodeURIComponent(subject)}&n=${ask}&mock=0&year=10&difficulty=random&types=${types}`); } catch { break; }
    let added = 0;
    for (const q of rows || []) {
      const k = String(q.questionId ?? q.id);
      if (seen.has(k)) continue;
      seen.add(k); out.push(q); added++;
      if (out.length >= need) break;
    }
    if (!added) break;
  }
  return out;
}

function dailySubject() {
  // 取本场考试权重最高的科目（原来写死「事业编→职测」，公基/综应永远轮不到）
  return schemeSubjects()[0].subject;
}

// 按考点抽题（走了 /api/practice 的 keypoint 分支），带难度档
async function fetchByKp(subject, kp, n, difficulty = 'random') {
  const url = `/api/practice?subject=${encodeURIComponent(subject)}&keypoint=${encodeURIComponent(kp)}&n=${Math.max(2, n)}&mock=0&year=10&difficulty=${difficulty}&types=1,2,3`;
  try { return (await api(url)) || []; } catch { return []; }
}

/** 按「章节（模块）」抽题：实验版能力账本按章节记账，抽题也要能按章节抽 */
async function fetchByChapter(subject, chapter, n, difficulty = 'random') {
  const url = `/api/practice?subject=${encodeURIComponent(subject)}&chapters=${encodeURIComponent(chapter)}&n=${Math.max(2, n)}&mock=0&year=10&difficulty=${difficulty}&types=1,2,3`;
  try { return (await api(url)) || []; } catch { return []; }
}

/* ---------- 复习排期（本机） ---------- */
const REVIEW_KEY = 'sg_review_v1';
// 记忆层档位（天）。正式版保持原表；实验版（0.7）换成更密的档位。
// 依据 tools/lab-policy.mjs 的调度对照实验（60 个知识点 × 90 天，固定表 vs 遗忘曲线）：
//   1/2/4/7/15/30 → 947 次复习，复习时平均保持率 64.0%
//   1/1/2/4/9/18  → 949 次复习，平均保持率 70.8%
// 换 FSRS（按遗忘曲线排期）达到同等 70% 保持率只需 896 次（省 7.5%），
// 所以「换算法」收益很小，真正的问题是原档位表把保持率压在 64%——加密一档就够了。
const INTERVALS = [0, 1, 2, 4, 7, 15, 30];            // 正式版档位
const INTERVALS_LAB = [0, 1, 1, 2, 4, 9, 18];          // 实验版（0.7）加密档位
function intervalsOf() { return window.__LAB__ ? INTERVALS_LAB : INTERVALS; }
function loadReviewState() { try { return JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}'); } catch { return {}; } }
function saveReviewState(v) {
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(v));
  } catch (e) {
    // localStorage 只有 5MB，复习条目每条约 90 字节；真做满 5 万题会顶到上限，
    // 顶不住时先丢「已掌握」的条目（它们本来就不再参与复习），让写入活下来。
    try {
      const slim = {};
      for (const [k, r] of Object.entries(v)) if (!r || !r.mastered) slim[k] = r;
      localStorage.setItem(REVIEW_KEY, JSON.stringify(slim));
    } catch (_) { /* 仍然写不进：本轮复习状态放弃，不影响答题 */ }
  }
}
function updateReview(qid, ok, costMs, difficulty) {
  const m = loadReviewState(); const k = String(qid);
  const r = m[k] || { level: 1, next: 0, wrong: 0, streak: 0, mastered: false };
  const cost = Number(costMs) || 0;
  // 难度加权：题库里的 difficulty 是 1-5 的真题难度。难题忘得快，间隔压到 0.8；
  // 简单题可以拉长到 1.15。没有难度值的题按 1.0 处理，不影响老数据。
  const diff = Number(difficulty) || 0;
  const factor = diff >= 4 ? 0.8 : diff > 0 && diff <= 2 ? 1.15 : 1;
  // 「会但慢」：答对了但比这道题平时的用时翻一倍还多（且超过 45 秒），
  // 说明是硬算/半蒙出来的，不该按正常答对升级。8 秒答对和 80 秒蒙对
  // 在纯 Leitner 里是同一次成功，这是它最失真的一处。
  const base = Number(r.avgCost) || 0;
  const slow = ok && cost > 0 && cost > Math.max(45000, base * 2);
  if (ok) {
    r.streak = (r.streak || 0) + 1;
    if (!slow) r.level = Math.min(6, (r.level || 1) + 1);
    // 「掌握」的门槛：连对 3 次、且间隔已经推到 7 天档。
    // 慢答对不升档，所以蒙对的题到不了这一档。
    if (r.streak >= 3 && r.level >= 4) r.mastered = true;
    // 间隔按天算，但保留小数：难度 5 的第 2 档是 2×0.8=1.6 天，难度 2 的是 2×1.15=2.3 天，
    // 取整会把这两者抹平成同一个 2 天，加权就白做了。
    const iv = intervalsOf();
    r.next = Date.now() + Math.max(1, iv[Math.min(6, r.level)] * factor) * 86400000;
  } else {
    r.streak = 0; r.level = 1; r.wrong = (r.wrong || 0) + 1; r.mastered = false;
    r.next = Date.now() + 86400000;
  }
  // 每题自己的用时基线（指数平滑），下次判「慢」用
  if (cost > 0) r.avgCost = base ? Math.round(base * 0.7 + cost * 0.3) : cost;
  // 判「掌握」不等于这辈子不用再看：30 天后回炉抽检一次，
  // 答错就掉回 level 1（上面的 else 分支），答对再推 30 天。
  if (r.mastered) { r.recheckAt = Date.now() + 30 * 86400000; r.next = r.recheckAt; }
  r.last = Date.now();
  r.lastSlow = !!slow;
  m[k] = r; saveReviewState(m);
  return { slow, level: r.level, mastered: !!r.mastered };
}
// 一次性迁移：老数据里 next=0 的错题会全部「今天到期」，
// 直接摊到未来若干天，每天 PER_DAY 道，避免首页出现 189 道债。
const SPREAD_FLAG = 'sg_review_spread_v1';
function spreadLegacyReviews(perDay = 15) {
  if (localStorage.getItem(SPREAD_FLAG)) return;
  const m = loadReviewState();
  const now = Date.now();
  const overdue = Object.entries(m)
    .filter(([, r]) => !r.mastered && (r.next || 0) <= now)
    .map(([k, r]) => ({ k, r, t: r.next || 0, w: r.wrong || 0 }))
    .sort((a, b) => b.w - a.w || a.t - b.t);
  if (overdue.length <= perDay) { localStorage.setItem(SPREAD_FLAG, '1'); return; }
  overdue.forEach((it, i) => {
    const day = Math.floor(i / perDay);
    const target = new Date(); target.setHours(9, 0, 0, 0); target.setDate(target.getDate() + day);
    m[it.k].next = target.getTime();
  });
  saveReviewState(m);
  localStorage.setItem(SPREAD_FLAG, '1');
  console.log(`[review] 摊平 ${overdue.length} 道错题，每天 ${perDay} 道`);
}

function reviewCountOn(dayOffset) {
  const m = loadReviewState();
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + dayOffset);
  const end = new Date(start); end.setHours(23, 59, 59, 999);
  return Object.values(m).filter((r) => (!r.mastered || !!r.recheckAt) && (r.next || 0) >= start.getTime() && (r.next || 0) <= end.getTime()).length;
}
function dueIds() {
  const m = loadReviewState();
  const end = new Date(); end.setHours(23, 59, 59, 999);
  // 到期队列按「错得多、拖得久」优先：错 3 次的题应该排在错 1 次的前面，
  // 否则每天 15 道的额度会被一批只错一次的题占满，真正的硬骨头永远排不上。
  return Object.entries(m)
    .filter(([, r]) => !r.mastered || !!r.recheckAt)
    .filter(([, r]) => (r.next || 0) <= end.getTime())
    .sort((a, b) => (b[1].wrong || 0) - (a[1].wrong || 0) || (a[1].next || 0) - (b[1].next || 0))
    .map(([k]) => k);
}
// 错题本副标题：今天要复习几道，以及下一批什么时候到期（只有「今日到期 0 道」会让人觉得没安排）
function dueLine(list) {
  const rows = list || [];
  if (!rows.length) return '今日到期 <b>0</b> 道';
  const m = loadReviewState();
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const endTs = end.getTime();
  const states = rows.map((r) => m[r.questionId]).filter((x) => x && !x.mastered);
  const due = states.filter((r) => (r.next || 0) <= endTs).length;
  if (due > 0) return `今日到期 <b>${due}</b> 道 · 重新作答`;
  const nextTs = states.map((r) => r.next || 0).filter((t) => t > endTs).sort((a, b) => a - b)[0];
  if (!nextTs) return '今日到期 <b>0</b> 道 · 暂无复习计划';
  const days = Math.ceil((nextTs - endTs) / 86400000);
  const d = new Date(nextTs);
  const label = days <= 1 ? '明天' : days <= 30 ? `${days} 天后` : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `今日到期 <b>0</b> 道 · 下次复习 ${label}`;
}

/* ---------- 练习现场（自动保存 / 恢复） ---------- */
const SESSION_KEY = 'sg_session_v1';
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !Array.isArray(s.ids) || !s.ids.length) return null;
    if (Date.now() - (s.ts || 0) > 3 * 86400000) return null;
    // 档案换了考试组合之后，旧科目（如公务员·行测）的现场不该再出现在首页
    if (s.subject && notInScheme(s.subject)) return null;
    return s;
  } catch { return null; }
}
function saveSession() {
  const P = S.practice;
  if (!P.open || !P.qs.length) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      ts: Date.now(), title: P.title, subject: P.subject, kind: P.kind,
      ids: P.qs.map((q) => q.id), idx: P.idx, answers: P.answers || {}, elapsed: P.elapsed,
      exam: !!P.exam, remaining: P.remaining || 0, limitSec: P.limitSec || 0,
      flagged: P.flagged || {}, paperId: P.paperId || 0,
    }));
  } catch { /* 空间不足时不影响答题 */ }
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }
function saveCurrentAnswer() {
  const P = S.practice;
  if (!P.qs.length) return;
  // 主观题的作答文本也要落盘，否则切题/退出就丢
  const box = document.querySelector('#grade-input');
  if (box && typeof box.value === 'string') {
    const cur = P.answers[P.idx] || {};
    P.answers[P.idx] = { ...cur, text: box.value };
  }
  const cur = P.answers[P.idx] || {};
  if (P.selected != null || P.confirmed || cur.text || cur.grade) {
    P.answers[P.idx] = { ...cur, selected: P.selected, confirmed: P.confirmed, feedback: P.feedback, ai: P.ai, chat: P.aiChat || [], cached: P.aiCached };
  }
}
function loadAnswerState() {
  const P = S.practice;
  const a = P.answers[P.idx];
  P.selected = a?.selected ?? null;
  P.confirmed = !!a?.confirmed;
  P.feedback = a?.feedback || null;
  P.ai = a?.ai || '';
  P.aiChat = a?.chat || [];
  P.aiCached = !!a?.cached;
  P.aiLoading = false;
  P.aiError = '';
}

/** 把当前题的停留时长累加进 P.qCost[idx]（切题/确认/交卷时调用） */
function tickQCost() {
  const P = S.practice;
  if (!P.open) return;
  const now = Date.now();
  if (!P.qStart) { P.qStart = now; return; }
  const dt = Math.max(0, now - P.qStart);
  P.qStart = now;
  if (!P.qCost) P.qCost = {};
  P.qCost[P.idx] = (P.qCost[P.idx] || 0) + dt;
}
/** 取某题累计用时（毫秒） */
function qCostOf(idx) {
  const P = S.practice;
  return Math.min(Number((P.qCost || {})[idx]) || 0, 30 * 60 * 1000);
}

/* ---------- AI 刷题班计划 ---------- */
const PLAN_KEY = 'sg_plan_v1';
function loadPlan() { try { return JSON.parse(localStorage.getItem(PLAN_KEY) || 'null'); } catch { return null; } }
function savePlan(v) { localStorage.setItem(PLAN_KEY, JSON.stringify(v)); S.plan = v; }
function buildPlan() {
  const days = Math.max(7, daysLeft());
  const rate = (S.stats && S.stats.rate) || 0;
  const weak = weakPoints();
  const stages = [
    { name: '理论速通', ratio: 0.30, focus: '基础方法 + 高频考点', desc: '打牢基础，建立解题框架' },
    { name: '题型强化', ratio: 0.30, focus: '薄弱题型专项 + 限时训练', desc: '把方法用到题上，提升正确率' },
    { name: '模块刷题', ratio: 0.25, focus: '整模块限时 + 错题复盘', desc: '提升速度与稳定性' },
    { name: '套题冲刺', ratio: 0.15, focus: '全真套卷 + 考场节奏', desc: '模拟考试，查漏补缺' },
  ];
  let cursor = 0;
  const fmt = (d) => `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
  for (const st of stages) {
    const len = Math.max(2, Math.round(days * st.ratio));
    const start = new Date(); start.setDate(start.getDate() + cursor);
    const end = new Date(); end.setDate(end.getDate() + Math.min(days, cursor + len - 1));
    st.range = `${fmt(start)} - ${fmt(end)}`;
    st.days = len;
    st.tasks = [
      `每日错题复习 ${Math.max(5, Math.round((S.stats?.wrong || 10) / 10))} 题`,
      `薄弱专项 10-15 题（${weak[0]?.name || '按模块轮换'}）`,
      `新题 ${S.profile.dailyGoal || 20} 题`,
    ];
    cursor += len;
  }
  const message = `你的当前正确率 ${rate}%，目标 ${S.profile.targetScore || 70} 分。建议先补 ${weak[0]?.name || '薄弱模块'}，每天 ${S.profile.minutes || 90} 分钟，按四阶段推进；每周日复盘一次，正确率连续 3 天低于 50% 就回退一个阶段。`;
  savePlan({ createdAt: Date.now(), days, stages, message, target: S.profile.targetScore || 70, minutes: S.profile.minutes || 90 });
}
function streakDays() {
  const arr = (S.stats && S.stats.last7) || [];
  const set = new Set(arr.map((x) => x.d));
  let n = 0; const d = new Date();
  for (;;) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!set.has(k)) break;
    n++; d.setDate(d.getDate() - 1);
  }
  return n;
}
function weakPoints() {
  const b = (S.stats && S.stats.byChapter) || [];
  return b.filter((x) => x.c >= 5).map((x) => ({ name: x.chapter, pct: Math.round((x.ok / x.c) * 100), total: x.c }))
    .sort((a, b2) => a.pct - b2.pct).slice(0, 3);
}

/* ---------- 数据加载 ---------- */
async function refreshStats() {
  try {
    S.stats = await api('/api/records/stats');
    const w = await api('/api/records/wrong?limit=1');
    S.wrongTotal = Number(w.total) || 0;
  } catch { /* ignore */ }
}
async function loadHome() {
  const [subjects, stats, wrong] = await Promise.all([
    api('/api/subjects'), api('/api/records/stats'), api('/api/records/wrong?limit=1').catch(() => ({ total: 0 })),
  ]);
  S.subjects = subjects;
  S.stats = stats;
  S.wrongTotal = Number(wrong.total) || 0;
  // 时政不在首屏关键路径上：先放个占位，数据到了再补一次渲染
  S.politicsCount = 0;
  loadPolitics()
    .then((p) => {
      S.politicsCount = (p.items || []).length;
      if (S.tab === 'home') render();
    })
    .catch(() => { /* ignore */ });
}

/* ---------- 首页 ---------- */
/* 把「A项正确：…B项错误：…」这种解析切成结构化块；切不出来返回 null */
function splitAnalysis(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < 40) return null;
  const re = /([A-H])\s*项?\s*(正确|错误)/g;
  const hits = [];
  let m;
  while ((m = re.exec(s))) hits.push({ at: m.index, letter: m[1], ok: m[2] === '正确' });
  if (hits.length < 2) return null;
  return hits.map((h, i) => ({
    letter: h.letter,
    ok: h.ok,
    text: s.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : s.length)
      .replace(/^[A-H]\s*项?\s*(正确|错误)\s*[：:，,、]?\s*/, '')
      .trim(),
  }));
}


function renderDeepBlock(d) {
  if (!d) return '';
  const rows = [];
  if (d.kadian) rows.push(['考点', esc(d.kadian)]);
  if (d.fastest) rows.push(['秒杀', renderRichText(d.fastest)]);
  if (d.pitfalls) rows.push(['陷阱', renderRichText(d.pitfalls)]);
  if (d.askModel) rows.push(['题型识别', renderRichText(d.askModel)]);
  if (d.mother) rows.push(['母题', renderRichText(d.mother)]);
  if (!rows.length) return '';
  return `<details class="ana-deep"><summary><span>粉笔深度解析</span><em>展开 ›</em></summary>
    <div class="ana-deep-body">${rows.map(([k, v]) => `<div class="deep-row"><b>${k}</b><span>${v}</span></div>`).join('')}</div>
  </details>`;
}
/**
 * 把库里的 answer 统一转成字母（如 "2" → "C"，"0,2" → "AC"）。
 *
 * 库里 88.6% 的题 answer 存的是选项索引数字，不是字母。原来这里直接
 * String(q.answer).replace(/[^A-H]/g,'') —— 数字被抹成空串，于是回退到「见解析」，
 * 导致回顾页、错题详情里根本看不到正确答案是什么（答题时有 fb.correct 兜底才正常）。
 */
function answerToLetters(q) {
  const raw = q && q.answer;
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // 已经是字母
  if (/^[A-Ha-h]+$/.test(s)) return s.toUpperCase();
  // 索引："0" / "2,3" / "[0,2]" / "[[0,2]]"
  const cleaned = s.replace(/[\[\]]/g, '');
  if (/^\d+(\s*,\s*\d+)*$/.test(cleaned)) {
    return cleaned.split(',').map((n) => 'ABCDEFGH'[Number(n.trim())] || '').join('');
  }
  return '';
}

function renderAnalysisBlock(q, fb, extraBtns) {
  const raw = String(q.analysis || '').trim();
  const rich = q.analysisHtml;
  const correctLetters = ((fb && fb.correct) || []).map((i) => 'ABCDEFGH'[i]).join('');
  const pickedLetters = ((fb && fb.selected) || []).map((i) => 'ABCDEFGH'[i]).join('');
  const blocks = splitAnalysis(raw);
  const head = `<div class="ana-h"><span>解析</span><span style="display:flex;gap:6px">${extraBtns || ''}</span></div>`;

  if (!raw && !rich) {
    const hasDeep = !!((S.deepCache || {})[q.id] || q.deep);
    const hint = hasDeep
      ? '这道题没有官方答案解析，往下看「进阶解析」——考点拆解、秒杀思路和易错点都在那里。'
      : '这道题还没有解析。点下面的「AI 讲题」可以让它换个说法讲一遍。';
    return `<div class="ana-card">${head}<div class="ana-line" style="color:var(--text-3)">${hint}</div></div>`;
  }
  if (!blocks) {
    return `<div class="ana-card">${head}<div class="ana-line" style="white-space:pre-wrap">${renderRichText(rich || raw)}</div></div>`;
  }
  const ansTxt = correctLetters || answerToLetters(q) || '见解析';
  const ansBlock = blocks.find((b) => b.letter === ansTxt[0]) || blocks.find((b) => !b.ok);
  const pickedBlock = pickedLetters ? blocks.find((b) => b.letter === pickedLetters[0]) : null;
  const isNeg = /错误的是|不属于|不包括|不符合|不正确|不能/.test(String(q.content || ''));
  const whyTitle = `为什么选 ${ansTxt}`;
  const pickedLabel = pickedBlock && pickedBlock.ok
    ? `${esc(pickedBlock.letter)} 为什么不算答案${isNeg ? '（它本身说法是对的，但题问的是「错误的」）' : ''}`
    : `${esc(pickedLetters)} 错在哪里`;
  return `<div class="ana-card">
    ${head.replace('解析', whyTitle)}
    ${ansBlock ? `<div class="ana-line"><b>${esc(ansBlock.letter)} 为什么是答案：</b>${renderRichText(ansBlock.text)}</div>` : ''}
    ${pickedBlock && pickedLetters && pickedLetters !== ansTxt ? `<div class="ana-line bad"><b>${pickedLabel}：</b>${renderRichText(pickedBlock.text)}</div>` : ''}
    <details class="ana-more"><summary><span>完整解析${blocks.length > 2 ? ` · ${blocks.length} 段` : ''}</span><em>展开 ›</em></summary><div class="ana-full" style="white-space:pre-wrap">${renderRichText(rich || raw)}</div></details>
  </div>`;
}

/* 这一轮最该记住的一点：按错题的共性给一句人话 */
const KP_STATS_KEY = 'sg_kp_stats';

function loadKpStats() {
  try { return JSON.parse(localStorage.getItem(KP_STATS_KEY) || '{}') || {}; } catch { return {}; }
}

function saveKpStats(m) {
  try { localStorage.setItem(KP_STATS_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

function kpRecord(name, done, right, subject) {
  if (!name || !done) return null;
  const m = loadKpStats();
  const cur = m[name] || { done: 0, right: 0 };
  const before = cur.done ? Math.round((cur.right / cur.done) * 100) : null;
  cur.done += done;
  cur.right += right;
  // 记下科目：同一个考点名在不同科目里都可能出现，按科目抽题时不能串科
  if (subject) cur.sub = subject;
  m[name] = cur;
  saveKpStats(m);
  const now = Math.round((cur.right / cur.done) * 100);
  return { name, rate: now, before, done: cur.done, right: cur.right };
}

/* ---------- 基础测评（能力画像） ---------- */
// 测评是「先验」：新装的头几天没有做题历史，每日任务只能瞎抽；
// 做完一次测评，引擎至少知道该先补哪几块。历史一旦攒够（考点 8 题），记录就顶掉它。
const DIAG_KEY = 'sg_diag_v1';
const DIAG_SKIP_KEY = 'sg_diag_skipped';
function loadDiag() {
  try { return JSON.parse(localStorage.getItem(DIAG_KEY) || 'null'); } catch { return null; }
}
function saveDiag(d) {
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(d)); } catch { /* 存不下就只留内存 */ }
  S.diag = d;
}
function diagAgeDays() {
  const d = S.diag || loadDiag();
  if (!d || !d.at) return null;
  return Math.max(0, Math.floor((Date.now() - d.at) / 86400000));
}

// 考点权重：先看本机记录（够 8 题），不够再用测评结果。
// 返回按正确率升序（最弱的在前）。
function weakKpList(subject) {
  // 0.7 实验版：走能力引擎（θ + 难度先验 + 蒙对率，见 lab.js 的 __ENGINE2__），
  // 它有记录就优先；没记录（新装/刚升级还没回放完）再退回下面的老口径。
  const E2 = window.__LAB__ && window.__ENGINE2__;
  if (E2 && E2.ready()) {
    const list = E2.weakList(subject, 40);
    if (list.length >= 3) {
      // 0.7 起（实验版）：出题不再纯按「最弱」排，而是按 ZPD（目标正确率 0.75）+ Thompson 探索。
      // 离线对照实验（tools/lab-policy.mjs）：最弱口径覆盖 32/75 个考点，ZPD+探索 +14%，纯随机也 +9.8%。
      // pick 只改「顺序与选谁」，配额和难度档仍走原来的逻辑。
      try {
        const order = E2.pick ? E2.pick(subject, Math.min(3, list.length)) : [];
        if (order.length) {
          const by = new Map(list.map((x) => [x.name, x]));
          const head = order.map((n) => by.get(n)).filter(Boolean);
          const rest = list.filter((x) => !order.includes(x.name));
          if (head.length) return head.concat(rest);
        }
      } catch { /* 挑不出来就用最弱口径 */ }
      return list;
    }
  }
  const out = new Map();
  const stats = loadKpStats() || {};
  for (const [name, s] of Object.entries(stats)) {
    if (!s || !s.done || s.done < 8) continue;
    if (subject && s.sub && s.sub !== subject) continue;
    if (subject && !s.sub) continue; // 老数据没记科目，宁可不猜
    out.set(name, { name, rate: s.right / s.done, n: s.done, src: 'record' });
  }
  const d = S.diag || loadDiag();
  for (const k of (d && d.kps) || []) {
    if (subject && k.sub && k.sub !== subject) continue;
    if (out.has(k.name)) continue;
    out.set(k.name, { name: k.name, rate: k.ok / Math.max(1, k.n), n: k.n, src: 'diag', sub: k.sub });
  }
  return [...out.values()].sort((a, b) => a.rate - b.rate);
}
// 正确率 → 难度档（对应 local-queries 的 XINGCE_DIFFICULTY）
function diffBandFor(rate) {
  return rate < 0.4 ? 'easy' : rate > 0.8 ? 'hard' : 'balanced';
}
// 0.7 实验版：难度档也按「离目标正确率差多少」调。
// 真机实测 ZPD 命中率只有 38%、平均预测正确率 56%（目标 75%）：考点挑对了，
// 但固定按 0.4/0.8 切档，弱考点里仍抽到偏难的题 → 预测正确率上不去。
// 这里改成：p̂ < 0.6 用 easy、0.6~0.9 用 balanced、> 0.9 用 hard，正式版走原逻辑。
function diffBandForKp(subject, chapter, rate) {
  const E2 = window.__LAB__ && window.__ENGINE2__;
  if (E2 && E2.ready() && subject && chapter) {
    const p = E2.ability(`${subject}|${chapter}`);
    if (p != null) return p < 0.6 ? 'easy' : p > 0.9 ? 'hard' : 'balanced';
  }
  return diffBandFor(rate);
}

// 0.7 实验版：把这一轮作答喂给能力引擎（考点级 θ），正式版直接返回
function feedEngine(P) {
  const E2 = window.__LAB__ && window.__ENGINE2__;
  if (!E2 || !P || !Array.isArray(P.qs)) return;
  const items = [];
  P.qs.forEach((q, i) => {
    const a = P.answers && P.answers[i];
    if (!q) return;
    const kp = q.kp || P.kp || '';
    if (!kp) return;
    if (!a || !a.confirmed) return;
    if (q.__fed) return;
    let oc = 0;
    try { oc = Array.isArray(q.options) ? q.options.length : JSON.parse(q.options || '[]').length; } catch { oc = 0; }
    items.push({
      kp, sub: P.subject || q.subject || '', chapter: q.chapter, type: q.type, qid: q.id,
      optionCount: oc, y: a.feedback && a.feedback.ok ? 1 : 0, ts: Date.now(),
    });
  });
  if (items.length) { try { E2.recordAnswered(items); } catch { /* 实验功能失败不影响正常流程 */ } }
}

function kpRate(name) {
  const cur = loadKpStats()[name];
  if (!cur || !cur.done) return null;
  return Math.round((cur.right / cur.done) * 100);
}

function kpBadge(name) {
  const r = kpRate(name);
  if (r == null) return '';
  return '<span class="kp-badge">' + r + '%</span>';
}

function kpHtml(kp) {
  if (!kp) return '';
  const delta = kp.before == null ? '' : kp.rate > kp.before ? ' <span class="kp-up">↑' + (kp.rate - kp.before) + '</span>' : kp.rate < kp.before ? ' <span class="kp-up flat">↓' + (kp.before - kp.rate) + '</span>' : '';
  const tone = kp.rate >= 80 ? 'good' : kp.rate >= 50 ? 'mid' : 'bad';
  return '<div class="round-kp"><div class="round-kp-h"><span>考点 · ' + esc(kp.name) + '</span><b class="kp-' + tone + '">掌握度 ' + kp.rate + '%' + delta + '</b></div><div class="round-kp-bar"><i style="width:' + kp.rate + '%"></i></div><div class="card-sub">累计 ' + kp.done + ' 题 · 对 ' + kp.right + ' 错 ' + (kp.done - kp.right) + '</div></div>';
}

function roundInsight(P) {
  const wrongs = P.qs.filter((q, i) => P.answers[i]?.confirmed && !P.answers[i].feedback?.ok);
  if (!wrongs.length) return { text: '这一轮全对。可以换成更难的模块，或者去模考里练一次整卷。', rows: [] };
  const byChapter = new Map();
  wrongs.forEach((q) => { const k = q.chapter || '未分类'; byChapter.set(k, (byChapter.get(k) || 0) + 1); });
  const top = [...byChapter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n }));
  const negCount = wrongs.filter((q) => /错误的是|不属于|不包括|不符合|不正确/.test(String(q.content || ''))).length;
  let text;
  if (negCount >= 2 && negCount >= wrongs.length * 0.4) {
    text = `「下列…<b>错误</b>的是」这类选非题，先把题干里的「错误」两个字圈出来再读选项 —— 你这一轮有 <b>${negCount} 道</b>错在这里。`;
  } else if (top[0] && top[0].n >= 2) {
    text = `<b>${esc(top[0].name)}</b>这一类错了 <b>${top[0].n} 道</b>，是这一轮最集中的失分点 —— 先把它这几道的解析读完，再往下做。`;
  } else {
    text = `这一轮错了 <b>${wrongs.length} 道</b>，分布比较散。把错的这几道点开重看一遍解析，比继续做新题划算。`;
  }
  return { text, rows: top };
}

function yesterdayStat() {
  const arr = (S.stats && S.stats.last7) || [];
  const d = new Date(); d.setDate(d.getDate() - 1);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hit = arr.find((x) => x.d === key);
  if (!hit || !Number(hit.c)) return null;
  return { n: Number(hit.c), rate: Math.round((Number(hit.ok) / Number(hit.c)) * 100) };
}

/** 近 7 天的账，首页「本周小结」用 */
function weekSummary() {
  const arr = (S.stats && S.stats.last7) || [];
  let n = 0, ok = 0, days = 0;
  for (const x of arr) {
    const c = Number(x.c) || 0;
    if (c > 0) { days++; n += c; ok += Number(x.ok) || 0; }
  }
  const rate = n ? Math.round((ok / n) * 100) : 0;
  let advice;
  if (!n) advice = '这周还没开张。先做 10 道，把这周的账记上。';
  else if (days <= 2) advice = `只练了 ${days} 天。备考这件事，频次比时长更要紧。`;
  else if (rate < 60) advice = '正确率偏低，建议先放一放缓，把错题的解析逐条读完再练。';
  else if (rate < 80) advice = `正确率 ${rate}%，处在提分期。薄弱模块单独拉出来做专项。`;
  else advice = `正确率 ${rate}%，很稳。可以开始限时练整卷了。`;
  return { n, ok, rate, days, advice };
}

/** 首页顶部的更新横幅：只盖题库和 App 两条，用户点过「暂不」就不再提 */
function renderUpdateBanner() {
  const h = S.updateHint;
  if (!h) return '';
  const muted = JSON.parse(localStorage.getItem('sg_update_mute') || '{}');
  const bits = [];
  if (h.tiku && muted.tiku !== h.tiku) bits.push(`题库 ${h.tiku}`);
  if (h.app && muted.app !== h.app) bits.push(`App ${h.app}`);
  if (!bits.length) return '';
  const ver = h.app || h.tiku;
  return `<div class="upd-banner">
    <span class="upd-banner-ico">${iconSvg('refresh', 16)}</span>
    <div class="upd-banner-main">
      <div class="upd-banner-t">有新版本可用</div>
      <div class="upd-banner-s">${esc(bits.join(' · '))}</div>
    </div>
    <button class="upd-banner-go" data-act="upd-banner-go" data-ver="${esc(ver)}">更新</button>
    <button class="upd-banner-x" data-act="upd-banner-close" data-ver="${esc(ver)}" aria-label="关闭">✕</button>
  </div>`;
}

function renderHome() {
  const today = todayCount();
  const goal = dailyGoal();
  const due = dueIds().length;
  const remain = dailyRemaining();
  const over = today > goal;
  const shown = Math.min(today, goal);
  const pct = Math.min(100, Math.round((today / goal) * 100));
  const weak = weakPoints();
  const topWeak = (weak[0] && weak[0].name) || '按模块轮换';
  // 考点级重点：记录够 8 题就用记录，否则用测评结果（见 weakKpList）
  const kpFocus = (() => {
    try { return weakKpList(dailySubject()).slice().sort((x, y) => x.rate - y.rate).slice(0, 2); } catch { return []; }
  })();
  const focusLine = kpFocus.length
    ? `今日重点：<b>${kpFocus.map((k) => esc(k.name)).join('、')}</b>${kpFocus[0].src === 'diag' ? '（测评给的）' : `（正确率 ${Math.round(kpFocus[0].rate * 100)}%）`}`
    : '';
  const yd = yesterdayStat();
  const resume = loadSession();

  let title, sub, cta, act;
  if (due > 0) {
    // 有到期题时，今日任务 = 复习（最多 40%）+ 新题补足剩余额度，
    // 标题按「还剩多少道 / 到期多少道」说清楚，别让人以为只能复习
    const rq = reviewQuota();
    title = remain > 0 ? `今天还剩 <em>${remain}</em> 道` : `复习 <em>${Math.min(due, 15)}</em> 道到期题`;
    const tmr = reviewCountOn(1);
    const st = streakDays();
    // 把「还剩 18 道」拆开写，否则下面的「新题 15 道」和它看起来自相矛盾
    const newN = Math.max(0, remain - rq);
    sub = (remain > 0
      ? (rq > 0 ? `= 复习 <b>${rq}</b> 道 + 新题 <b>${newN}</b> 道` : `今天要做 <b>${remain}</b> 道新题`)
      : `到期 <b>${due}</b> 道`)
      + (tmr > 0 ? ` · 明天还有 ${tmr} 道` : '')
      + (st > 1 ? ` · 已连续 <b>${st}</b> 天` : '')
      + ` · 弱项是<b>${esc(topWeak)}</b>`;
    cta = remain > 0 ? '开始今日任务' : '开始复习';
    act = 'daily-task';
  } else if (remain > 0) {
    title = `今天还剩 <em>${remain}</em> 道`;
    const rq = reviewQuota();
    sub = (rq > 0 ? `= 复习 <b>${rq}</b> 道 + 新题 <b>${Math.max(0, remain - rq)}</b> 道` : `今天要做 <b>${remain}</b> 道新题`)
      + ` · 从<b>${esc(topWeak)}</b>开始`;
    cta = '开始做题';
    act = 'daily-task';
  } else {
    title = '今天的任务完成了';
    sub = `今天做了 <b>${today}</b> 题${over ? '，超额完成' : ''} · 明天继续`;
    cta = '再练 10 题';
    act = 'extra-practice';
  }

  return `
  <div class="topline">
    <span class="eyebrow">距离考试还有 <b style="font-size:17px;color:var(--text);font-variant-numeric:tabular-nums;margin:0 2px">${daysLeft()}</b> 天</span>
    <span class="eyebrow" style="color:var(--text-3)">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
  </div>
  ${renderUpdateBanner()}
  <section class="home-hero">
    <div class="hero-kick">今天这一件事</div>
    <h1 class="hero-h1">${title}</h1>
    <div class="hero-sub">${sub}</div>
    <div class="hero-bar"><i style="width:${pct}%"></i></div>
    <div class="hero-barfoot"><span>${over ? `今日 ${today} 题 · 目标已完成` : `今日任务 ${shown} / ${goal}`}</span><span>${over ? '✓' : `还差 ${goal - today} 题`}</span></div>
    <button class="btn btn-primary btn-block hero-btn" data-act="${act}">${cta}</button>
  </section>
  ${remain <= 0 && due > 0 ? (() => {
    // 今日任务已完成时才单独露这张卡；任务没做完时 hero 里已经包含复习，两张卡并列会让人犯选择困难
    const tmr = reviewCountOn(1);
    return `<button class="home-alt due-card" data-act="review-train"><span>再复习 <b>${due} 道</b>到期题${tmr > 0 ? `<i class="due-sub">明天还有 ${tmr} 道</i>` : ''}</span><span class="home-alt-r">开始复习 ›</span></button>`;
  })() : ''}
  ${weak.length && weak[0].pct > 0 ? `<button class="home-alt" data-act="weak" data-name="${esc(weak[0].name)}" style="margin-top:12px"><span>最弱的一块：<b>${esc(weak[0].name)} ${weak[0].pct}%</b></span><span class="home-alt-r">专项练 ›</span></button>` : ''}
  ${focusLine ? `<div class="home-yday"><span>${focusLine}</span><span data-act="diag-view" class="link-sm">看画像 ›</span></div>` : ''}
  ${yd ? `<div class="home-yday"><span>昨天</span><span>${yd.n < 5 ? `${yd.n} 题 · 刚起步` : `${yd.n} 题 · 正确率 ${yd.rate}%`}</span></div>` : ''}
  <div class="quick-row three">
    <button class="quick-card" data-act="politics">
      <span class="quick-ico" style="background:var(--primary-soft);color:var(--primary)">${iconSvg('lightbulb', 18)}</span>
      <span class="quick-main"><b>时政</b><i>${(() => { const n = S.politicsCount || 0; return n ? `${n} 篇 · 本周` : '每周汇总'; })()}</i></span>
    </button>
    <button class="quick-card" data-act="feishu">
      <span class="quick-ico" style="background:var(--amber-soft);color:#9a6700">${iconSvg('book', 18)}</span>
      <span class="quick-main"><b>资料库</b><i>讲义与知识点</i></span>
    </button>
    <button class="quick-card" data-act="exam-hub">
      <span class="quick-ico" style="background:var(--green-soft);color:var(--green)">${iconSvg('folder', 18)}</span>
      <span class="quick-main"><b>模考</b><i>整卷 / 随机</i></span>
    </button>
  </div>
  ${resume && (resume.ids || []).length >= 3 ? `<button class="continue-card" data-act="resume-session" style="width:100%;text-align:left;border:0;cursor:pointer"><div class="subject-ico">${iconFor('')}</div><div class="continue-main"><div class="continue-title">继续上次：${esc(resume.title)}</div><div class="continue-sub">${esc(resume.subject || '')} · 第 ${Math.min(resume.idx + 1, resume.ids.length)} / ${resume.ids.length} 题 · 点击继续</div></div><span style="color:var(--text-3)">›</span></button>` : ''}
  ${(() => {
    const w = weekSummary();
    const got = new Map(((S.stats && S.stats.last7) || [])
      .filter((x) => x && x.d)
      .map((x) => [String(x.d).slice(0, 10), x]));
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      arr.push(got.get(k) || { d: k, c: 0, ok: 0 });
    }
    const maxC = Math.max(1, ...arr.map((x) => Number(x.c) || 0));
    const bars = `<div class="home-week-bars">${arr.map((x) => {
      const c = Number(x.c) || 0;
      const h = c ? Math.max(6, Math.round((c / maxC) * 40)) : 3;
      return `<div><span class="home-week-slot"><span class="home-week-bar" style="height:${h}px"></span></span><i>${esc(String(x.d).slice(5))}</i></div>`;
    }).join('')}</div>`;
    return `<div class="home-week">
      <div class="home-week-head"><span class="home-week-title">本周学习报告</span><button class="home-week-more" data-act="report" style="border:0;background:transparent;cursor:pointer">完整报告 ›</button></div>
      <div class="home-week-nums">
        <div class="home-week-num"><b>${w.n}</b><span>做题</span></div>
        <div class="home-week-num"><b>${w.rate}%</b><span>正确率</span></div>
        <div class="home-week-num"><b>${w.days}</b><span>活跃天数</span></div>
      </div>
      ${bars}
      <div class="home-week-advice">${esc(w.advice)}</div>
      <div class="home-week-foot">
        <button data-act="stats">学习统计 ›</button>
        <button data-act="report">学习报告 ›</button>
      </div>
    </div>`;
  })()}`;
}

/** 首页 AI 刷题班那行的副标题：有计划就报当前阶段进度，没有就写清楚它干什么 */
function planStageNow(p) {
  if (!p || !Array.isArray(p.stages) || !p.stages.length) return null;
  const used = Math.floor((Date.now() - (Number(p.createdAt) || Date.now())) / 86400000);
  let acc = 0;
  for (const st of p.stages) {
    acc += Number(st.days) || 0;
    if (used < acc) return st;
  }
  return p.stages[p.stages.length - 1];
}

function planHint() {
  const p = S.plan;
  if (!p || !Array.isArray(p.stages) || !p.stages.length) {
    return '按目标分和每天投入时间，排四阶段计划';
  }
  const st = planStageNow(p);
  const left = daysLeft();
  const parts = [];
  if (st) parts.push(st.name);
  parts.push(`目标 ${p.target} 分`);
  if (left > 0) parts.push(`剩 ${left} 天`);
  return parts.join(' · ');
}

/** AI 是否已经能用（至少一个智能体填了 key） */
function aiReady() {
  try {
    const arr = (S.agents || []).filter((x) => x && x.api_key);
    return arr.length > 0;
  } catch { return false; }
}

/** 点首页横幅 → 让用户选：现在更新题库 / 现在更新 App / 以后再说 */
function openUpdateChoice() {
  const h = S.updateHint || {};
  const rows = [];
  if (h.tiku) rows.push(`<button class="btn btn-primary btn-block" style="margin-bottom:8px" data-act="upd-do-tiku">更新题库（${esc(h.tiku)}）</button>`);
  if (h.app) rows.push(`<button class="btn btn-primary btn-block" style="margin-bottom:8px" data-act="upd-do-app">更新 App（${esc(h.app)}）</button>`);
  rows.push(`<button class="btn btn-ghost btn-block" data-act="upd-later">暂不提醒</button>`);
  sheet(`<div class="sheet-head"><b>有更新可用</b><button class="sheet-close">✕</button></div>
    <div class="card-sub" style="margin:-4px 0 14px">题库走增量包，几 MB；App 走安装包，下完需要你点一下安装。</div>
    ${rows.join('')}`);
}
function iconFor(name) {
  return '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>';
}
const ICON_PATHS = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  bot: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 17h6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor" stroke="none"/>',
  save: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v1h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3Z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 21h20Z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 4v7h-7"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
};
function iconSvg(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${ICON_PATHS[name] || ICON_PATHS.book}</svg>`;
}
function descFor(name) {
  return { '公务员·行测': '言语·判断·资料·数量·常识', '公务员·申论': '归纳概括·综合分析·大作文', '事业编·职测': '言语·判断·资料·数量·常识', '事业编·综应': '归纳概括·案例分析·应用文', '事业编·公基': '政治·法律·经济·科技人文' }[name] || '';
}
function artDawn() {
  return `<svg class="banner-art" viewBox="0 0 220 150" aria-hidden="true"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBE3BE"/><stop offset="1" stop-color="#F7F2E7"/></linearGradient></defs><rect width="220" height="150" fill="url(#sky)"/><circle cx="158" cy="48" r="22" fill="#EFA93D"/><circle cx="158" cy="48" r="30" fill="#EFA93D" opacity=".16"/><path d="M0 108 46 78 82 100 120 68 158 96 192 80 220 96V150H0Z" fill="#6F8AA6" opacity=".55"/><path d="M0 122 40 98 78 118 116 92 154 116 188 102 220 118V150H0Z" fill="#3E5C77"/><path d="M0 136 52 120 96 134 142 116 184 132 220 122V150H0Z" fill="#273F55"/></svg>`;
}

function artDesk() {
  return `<svg class="banner-art" viewBox="0 0 150 120" aria-hidden="true">
    <rect x="30" y="58" width="80" height="40" rx="4" fill="#E9DCC6"/>
    <rect x="38" y="50" width="80" height="40" rx="4" fill="#F7EFDF" stroke="#D9C9AE"/>
    <path d="M48 64h50M48 72h34M48 80h44" stroke="#B9A88D" stroke-width="2" stroke-linecap="round"/>
    <path d="M96 104l18-38" stroke="#2F4A66" stroke-width="5" stroke-linecap="round"/>
    <path d="M96 104l4-11 7 4-11 7Z" fill="#2F4A66"/>
    <circle cx="104" cy="50" r="9" fill="#EFA93D" opacity=".9"/>
    <path d="M104 41v-6M104 59v6M95 50h-6M113 50h6" stroke="#EFA93D" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}
function artClock() {
  return `<svg class="banner-art" viewBox="0 0 150 120" aria-hidden="true">
    <circle cx="75" cy="58" r="36" fill="#F7EFDF" stroke="#D9C9AE" stroke-width="2"/>
    <circle cx="75" cy="58" r="29" fill="#FFFDF8"/>
    <path d="M75 39v20l13 8" stroke="#2F4A66" stroke-width="3" stroke-linecap="round"/>
    <circle cx="75" cy="58" r="3" fill="#EFA93D"/>
    <path d="M36 30l6 6M114 30l-6 6" stroke="#EFA93D" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}
function artStudy() {
  return `<svg class="banner-art" viewBox="0 0 150 120" aria-hidden="true">
    <path d="M26 104h98" stroke="#D9C9AE" stroke-width="3" stroke-linecap="round"/>
    <path d="M34 76 64 68v28L34 104Z" fill="#F7EFDF" stroke="#D9C9AE" stroke-width="2"/>
    <path d="M64 68 94 76v28L64 96Z" fill="#EFE3CE" stroke="#D9C9AE" stroke-width="2"/>
    <path d="M48 79v18M79 79v18" stroke="#B9A88D" stroke-width="2" stroke-linecap="round"/>
    <path d="M101 88h20v14h-20z" fill="#F7EFDF" stroke="#2F4A66" stroke-width="2"/>
    <path d="M121 92h5a5 5 0 0 1 0 10h-5" fill="none" stroke="#2F4A66" stroke-width="2"/>
    <path d="M105 100h12" stroke="#B9A88D" stroke-width="2" stroke-linecap="round"/>
    <circle cx="96" cy="38" r="10" fill="#EFA93D"/>
    <circle cx="96" cy="38" r="16" fill="#EFA93D" opacity=".14"/>
    <path d="M96 18v-5M96 64v5M76 38h-5M122 38h5" stroke="#EFA93D" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

/* ---------- 题库 ---------- */
async function openLibrary(subject) {
  const valid = visibleSubjects().some((s) => s.subjectName === S.lib.subject);
  const next = subject || (valid ? S.lib.subject : defaultSubject());
  if (!next) { S.lib.view = 'subjects'; S.tab = 'library'; go('library'); return; }
  S.lib.subject = next;
  try { localStorage.setItem('sg_last_subject', next); } catch { /* ignore */ }
  S.lib.view = 'subjects';
  S.tab = 'library';
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    const [chapters, categories, chapDone] = await Promise.all([
      api('/api/chapters?subject=' + encodeURIComponent(next)),
      api('/api/categories?subject=' + encodeURIComponent(next)),
      api('/api/records/chapters').catch(() => ({})),
    ]);
    S.lib.chapters = chapters || [];
    S.lib.categories = categories || [];
    S.lib.chapDone = chapDone || {};
    go('library');
  } catch (e) { toast(e.message); }
}
function renderLibrary() {
  if (S.lib.view === 'papers') return renderPapers();
  if (S.lib.view === 'search') return renderSearchPage();
  if (S.lib.view === 'keypoints') return renderKeypointsPage();
  const subject = S.lib.subject || defaultSubject();
  const subs = visibleSubjects();
  const groups = (S.lib.chapters || []).filter((g) => g.total > 0);
  const subj = S.subjects.find((x) => x.subjectName === subject) || {};
  // 题量以模块树之和为准：subj.questions 是后端按年份窗口统计的，公基卷跨 2015-2024 会被砍掉大半
  // （实测 subj.questions=450，而 8 个模块加起来 2,722）
  const groupSum = groups.reduce((a, g) => a + g.total, 0);
  const total = groupSum || subj.questions || 0;
  const wrong = (S.stats && S.stats.wrong) || 0;
  const shortName = subject.split('·')[1] || subject;
  // 模块完成度：records 里按 chapter 聚合出的「做过多少道不同的题」
  const chapDone = S.lib.chapDone || {};
  const doneOf = (name) => {
    const direct = chapDone[name];
    if (direct) return direct.n || 0;
    let n = 0;
    for (const k of Object.keys(chapDone)) if (k.startsWith(name) || name.startsWith(k)) n += chapDone[k].n || 0;
    return n;
  };
  // 展开过的模块（二级标题默认收起，像粉笔那样点开再看）
  const openGroups = S.lib.openGroups || (S.lib.openGroups = {});
  // 模块完成度：接口算好的 g.done（二级之和）与 records 按 chapter 聚合取大，两个口径都不丢
  const doneTotal = (g) => Math.max(g.done || 0, doneOf(g.group));
  return `
  <div class="topline"><span class="eyebrow">题库</span><div style="display:flex;align-items:center;gap:6px"><button class="icon-btn" data-act="search" aria-label="搜索题目">${iconSvg('search', 20)}</button><button class="profile-chip" data-act="profile">${esc(S.profile.examType)} · ${esc(S.profile.province)} ›</button></div></div>
  <h1 class="page-title">刷题</h1>
  <div class="lib-head">
    <div class="lib-head-sub">${esc(subject)} · 共 ${total} 题</div>
    <div class="segmented seg-sm"><button class="${S.settings.recite ? '' : 'active'}" data-lib-mode="do">做题</button><button class="${S.settings.recite ? 'active' : ''}" data-lib-mode="recite">背题</button></div>
  </div>
  <div class="chips nowrap" style="margin-bottom:10px">${subs.map((s) => `<button class="chip ${s.subjectName === subject ? 'active' : ''} ${notInScheme(s.subjectName) ? 'dim' : ''}" data-lib-subject="${esc(s.subjectName)}">${esc(s.subjectName)}</button>`).join('')}</div>
  <div class="section-head"><h2 class="section-title">${esc(shortName)}模块</h2><span class="module-count">${groups.reduce((s, g) => s + doneTotal(g), 0)} 题已做</span></div>
  <div class="card module-card">
    ${groups.map((g, i) => {
      const dn = doneTotal(g);
      const pct = g.total ? Math.min(100, Math.round((dn / g.total) * 100)) : 0;
      const subs2 = (g.subs || []).filter((x) => x.total > 0 && x.name !== '全部');
      const open = !!openGroups[g.group];
      const caret = subs2.length ? `<button class="module-caret ${open ? 'open' : ''}" data-toggle-group="${esc(g.group)}" aria-label="${open ? '收起' : '展开'}">${open ? '▾' : '▸'}</button>` : '<span class="module-caret ghost"></span>';
      return `<div class="module-row" data-act="group" data-group="${esc(g.group)}" data-sub="全部">${caret}<div class="module-no">${String(i + 1).padStart(2, '0')}</div><div class="module-name">${esc(g.group)}</div><div class="module-count ${dn ? 'has' : ''}">${dn}/${g.total}</div><div class="module-bar"><i style="width:${pct}%"></i></div></div>${open ? subs2.map((x) => {
        // 二级的「已做」直接用接口算好的 x.done（按 category|sub 索引统计），
        // 之前用 doneOf(name) 是按 chapter 名匹配，二级名和 chapter 对不上，永远显示 0
        const sd = x.done != null ? x.done : doneOf(x.name);
        return `<div class="module-row sub" data-act="group" data-group="${esc(g.group)}" data-sub="${esc(x.name)}"><div class="module-name">${esc(x.name)}</div><div class="module-count ${sd ? 'has' : ''}">${sd}/${x.total}</div></div>`;
      }).join('') : ''}`;
    }).join('') || '<div class="empty-state">暂无专项数据</div>'}
  </div>
  <div class="stats-row three" style="margin-top:14px">
    <button class="stat stat-link" data-act="wrong-train"><span class="stat-txt"><b>错题再练</b><span>${wrong} 道待巩固</span></span><span class="stat-go">练 ›</span></button>
    <button class="stat stat-link" data-act="library-exam"><span class="stat-txt"><b>随堂测</b><span>10 题 · 限时</span></span><span class="stat-go">测 ›</span></button>
    <button class="stat stat-link" data-act="subject-random"><span class="stat-txt"><b>随机 20 题</b><span>本${esc(shortName)} · 不计时</span></span><span class="stat-go">练 ›</span></button>
  </div>
  <button class="paper-entry" data-act="papers">
    <div class="subject-ico">${iconFor('')}</div>
    <div class="continue-main"><div class="continue-title">按试卷练习</div><div class="continue-sub">整卷限时 · 按年份、省份、真题筛选</div></div>
    <span class="chev">›</span>
  </button>
  <button class="paper-entry" data-act="keypoints">
    <div class="subject-ico">${iconFor('')}</div>
    <div class="continue-main"><div class="continue-title">按考点练</div><div class="continue-sub">按真题考点专项突破 · 专攻一个，练完再换</div></div>
    <span class="chev">›</span>
  </button>`;
}
function openKeypoints(subject) {
  if (subject) S.lib.subject = subject;
  S.lib.view = 'keypoints';
  S.tab = 'library';
  S.lib.kps = [];
  S.lib.kpLoading = true;
  const want = S.lib.subject;
  go('library');
  api('/api/keypoints?subject=' + encodeURIComponent(want))
    .then((list) => {
      if (S.lib.subject !== want) return;
      S.lib.kps = Array.isArray(list) ? list : [];
      S.lib.kpCount = S.lib.kps.length;
    })
    .catch(() => { if (S.lib.subject === want) S.lib.kps = []; })
    .finally(() => { S.lib.kpLoading = false; if (S.lib.view === 'keypoints') go('library'); });
}
function renderKeypointsPage() {
  const kps = S.lib.kps || [];
  const loading = S.lib.kpLoading;
  const subject = S.lib.subject || defaultSubject();
  const subs = visibleSubjects();
  const withKp = S.lib.kpSubjects || {};
  const max = Math.max(1, ...kps.map((k) => k.questions || 0));
  return `<div class="subpage-head"><button class="icon-btn" data-act="back-library">‹</button><div class="subpage-title">按考点练</div><span style="width:38px"></span></div>
  <div class="chips nowrap" style="margin:0 0 12px">${subs.map((s) => `<button class="chip ${s.subjectName === subject ? 'active' : ''} ${withKp[s.subjectName] === 0 ? 'dim' : ''}" data-kp-subject="${esc(s.subjectName)}">${esc(s.subjectName)}</button>`).join('')}</div>
  <div class="hint" style="margin:0 2px 12px">考点来自真题标注，练完一个考点再换下一个，比乱刷有用。</div>
  ${loading ? '<div class="spinner"></div>' : kps.length ? `<div class="card" style="padding:6px 14px">${kps.slice(0, 120).map((k) => `
    <div class="kp-row" data-kp="${esc(k.name)}">
      <div class="kp-main"><div class="kp-name">${esc(k.name)}</div><div class="kp-bar"><i style="width:${Math.round(((k.questions || 0) / max) * 100)}%"></i></div></div>
      <div class="kp-num">${k.questions || 0} 题${kpBadge(k.name)}</div>
    </div>`).join('')}</div>` : `<div class="empty-state">${esc(subject)} 还没有考点数据<br><span class="card-sub" style="display:inline-block;margin-top:6px">可以在上面换个科目，或先用「按试卷练习」</span></div>`}
  `;
}
function openSearch() {
  S.lib.view = 'search';
  S.tab = 'library';
  S.search = { q: '', list: [], scope: 'all', year: '' };
  go('library');
  setTimeout(() => $('#search-input')?.focus(), 80);
}
/** 关键词高亮（先把 HTML 转义，再包 <mark>，避免注入） */
function hlSearch(text, kw) {
  const safe = esc(String(text || ''));
  const k = String(kw || '').trim();
  if (!k) return safe;
  const pat = esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(pat, 'gi'), (m) => `<mark class="kw">${m}</mark>`);
  } catch {
    return safe;
  }
}
function searchResultRows() {
  const list = S.search.list || [];
  const kw = S.search.q || '';
  return list.map((x) => {
    const stemHit = x.inStem !== 0;
    const anaHit = !!x.inAnalysis;
    const snip = anaHit ? String(x.snippet || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return `<div class="paper-item" data-act="search-open" data-id="${esc(String(x.id))}">
      <div class="paper-top"><span class="tag">${esc(x.subject || '')}</span>${stemHit ? '<span class="tag ok">题干命中</span>' : ''}${anaHit ? '<span class="tag">解析命中</span>' : ''}${x.hasAnalysis ? '' : '<span class="tag warn">暂无解析</span>'}</div>
      <div class="paper-title">${hlSearch(String(x.content || '').slice(0, 110), kw)}</div>
      ${snip ? `<div class="search-snip">${hlSearch(snip.slice(0, 120), kw)}</div>` : ''}
      <div class="paper-meta">${esc(x.paper || '')}${x.chapter ? ' · ' + esc(x.chapter) : ''}</div>
    </div>`;
  }).join('');
}
function renderSearchPage() {
  const q = S.search.q || '';
  const list = S.search.list || [];
  const sc = S.search.scope || 'all';
  const yr = S.search.year || '';
  const curSub = S.lib.subject || '';
  return `<div class="subpage-head"><button class="icon-btn" data-act="back-library">‹</button><div class="subpage-title">搜索题目</div><span style="width:38px"></span></div>
  <div class="card" style="padding:10px"><input class="field" id="search-input" placeholder="搜题干或解析，如 乡村振兴、边际效用" value="${esc(q)}"><button class="btn btn-primary btn-block" style="margin-top:10px" data-act="search-run">搜索</button>
  <div class="chips" style="margin-top:10px">
    <button class="chip ${sc === 'all' ? 'active' : ''}" data-act="search-scope" data-v="all">全库</button>
    <button class="chip ${sc === 'subject' ? 'active' : ''}" data-act="search-scope" data-v="subject">只看${esc((curSub.split('·')[1] || '当前科目'))}</button>
    ${['近3年', '近5年'].map((t, i) => `<button class="chip ${yr === String(i === 0 ? 3 : 5) ? 'active' : ''}" data-act="search-year" data-v="${i === 0 ? 3 : 5}">${t}</button>`).join('')}
  </div></div>
  <div id="search-results" style="margin-top:12px">${q ? (list.length ? searchResultRows() : '<div class="empty-state">没有找到匹配题目</div>') : '<div class="empty-state">题干和解析都会搜；结果可直接打开做题</div>'}</div>`;
}
async function runSearch() {
  const q = ($('#search-input')?.value || '').trim();
  if (!q) { toast('请输入关键词'); return; }
  S.search.q = q;
  $('#search-results').innerHTML = '<div class="spinner"></div>';
  try {
    const p = new URLSearchParams({ q, limit: '40' });
    if (S.search.scope === 'subject' && S.lib.subject) p.set('subject', S.lib.subject);
    if (S.search.year) p.set('year', S.search.year);
    const d = await api('/api/search?' + p.toString());
    S.search.list = d.list || [];
    $('#search-results').innerHTML = S.search.list.length ? searchResultRows() : '<div class="empty-state">没有找到匹配题目</div>';
  } catch (e) {
    $('#search-results').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

async function loadPapers(opts = {}) {
  // 同一套列表现在有两个落地页：题库里的「按试卷练习」和考试 tab 的「真题整卷」。
  // host 决定渲染完后停在哪个 tab，也决定顶部返回箭头往哪走。
  const inExam = opts.host === 'exam';
  if (!S.lib.subject || !visibleSubjects().some((s) => s.subjectName === S.lib.subject)) S.lib.subject = defaultSubject();
  if (!S.lib.subject) { toast('暂无可用科目'); return; }
  S.lib.view = 'papers';
  S.examPapers = inExam;
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    const [papers, categories, chapters, done] = await Promise.all([
      api('/api/papers?subject=' + encodeURIComponent(S.lib.subject) + '&limit=2000'),
      api('/api/categories?subject=' + encodeURIComponent(S.lib.subject)),
      api('/api/chapters?subject=' + encodeURIComponent(S.lib.subject)),
      api('/api/records/papers').catch(() => ({})),
    ]);
    S.lib.papers = papers || [];
    S.lib.categories = categories || [];
    S.lib.chapters = chapters || [];
    S.lib.done = done || {};
    S.lib.filter = { region: '全部', year: '全部', kind: '全部' };
    S.lib.show = 80;
    go(inExam ? 'exam' : 'library');
  } catch (e) { toast(e.message); }
}
function yearOf(name) { const m = String(name).match(/(20\d{2})/); return m ? m[1] : '其他'; }
// 首页「模考」和考试 tab 的整卷入口都走这里：先清掉上一次的交卷结果/计划页，
// 再把整卷列表装进考试 tab，避免停在中途的模考成绩单上。
async function openExamPapers() {
  S.examResult = null;
  S.planView = false;
  await loadPapers({ host: 'exam' });
}
// 「分类」这一栏原来直接用数据库里的 papers.category，可那列是采集时粉笔的 label 名，
// 里�面混了三种维度：省份（福建/江苏/天津）、考试类型（事业单位/书记员/选调）、
// 联考类别（联考A类/C类），还有【辅警】这种带括号的 —— 摊在一排 chip 里根本没法用。
// 现在拆成两个互斥维度，全部从卷名现算：地区 + 卷型。
const REGION_NAMES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆'];
function regionOf(name) {
  const s = String(name || '');
  if (/国家公务员|国考|中央机关/.test(s)) return '国考';
  for (const p of REGION_NAMES) if (s.includes(p)) return p;
  if (/联考/.test(s)) return '联考';
  if (/事业单位|事业编/.test(s)) return '事业编统考';
  if (/省考/.test(s)) return '省考';
  return '其他';
}
function kindOf(name) {
  const s = String(name || '');
  if (/模拟|模考|预测|押题/.test(s)) return '模拟';
  return '真题';
}
function renderPapers(opts = {}) {
  const inExam = opts.host === 'exam' || (opts.host == null && !!S.examPapers);
  const f = S.lib.filter;
  const uniq = (arr) => [...new Set(arr)];
  const regions = ['全部', ...uniq(S.lib.papers.map((p) => regionOf(p.name))).sort((a, b) => a.localeCompare(b, 'zh'))];
  const years = ['全部', ...[...new Set(S.lib.papers.map((p) => yearOf(p.name)))].filter((y) => y !== '其他').sort((a, b) => Number(b) - Number(a)).slice(0, 7), '其他'];
  const kinds = ['全部', '真题', '模拟'];
  const list = S.lib.papers.filter((p) => (f.region === '全部' || regionOf(p.name) === f.region) && (f.year === '全部' || yearOf(p.name) === f.year) && (f.kind === '全部' || kindOf(p.name) === f.kind));
  const chip = (key, val) => `<button class="chip ${f[key] === val ? 'active' : ''}" data-pf="${key}" data-val="${esc(val)}">${esc(val)}</button>`;
  return `
  ${inExam
    ? `<div class="subpage-head"><button class="icon-btn" data-act="back-exam">‹</button><div class="subpage-title">真题整卷</div><span style="width:38px"></span></div>`
    : `<div class="subpage-head"><button class="icon-btn" data-act="back-subject">‹</button><div class="subpage-title">筛选试卷</div><span style="width:38px"></span></div>`}
  <div class="filter-group"><div class="filter-label">科目</div><div class="chips nowrap">${visibleSubjects().map((x) => `<button class="chip ${S.lib.subject === x.subjectName ? 'active' : ''}" data-pf-subject="${esc(x.subjectName)}">${esc(x.subjectName)}</button>`).join('')}</div></div>
  <div class="card-sub" style="margin:-4px 0 10px">${esc(S.lib.subject)} · 共 ${list.length} 套</div>
  <div class="filter-group"><div class="filter-label">地区</div><div class="chips nowrap">${regions.map((c) => chip('region', c)).join('')}</div></div>
  <div class="filter-group"><div class="filter-label">年份</div><div class="chips nowrap">${years.map((y) => chip('year', y)).join('')}</div></div>
  <div class="filter-group"><div class="filter-label">卷型</div><div class="chips nowrap">${kinds.map((t) => chip('kind', t)).join('')}</div></div>
  <div class="paper-list">${list.slice(0, S.lib.show).map((p) => {
    const d = (S.lib.done || {})[p.id];
    const rate = d && d.n >= 3 ? Math.round((d.ok / d.n) * 100) : null;
    const qn = Number(p.questionCount || p.questions || 0);
    // 进过这份卷但没做满 → 「未完成 n/N」；做满了才叫「做过」。粉笔列表就是这么分的，
    // 我们之前只有「做过」，做到一半退出再回来根本认不出哪套没做完。
    const doneTag = !d ? '' : (qn && d.n < qn
      ? `<span class="tag warn">未完成 ${d.n}/${qn}</span>`
      : `<span class="tag done">做过 ${d.n} 题${rate == null ? '' : ` · ${rate}%`}</span>`);
    return `
    <div class="paper-item" data-act="paper" data-id="${p.id}" data-name="${esc(p.name || '')}" data-subject="${esc(p.subject || '')}">
      <div class="paper-top"><span class="tag">${esc(S.lib.subject)}</span><span class="tag ${kindOf(p.name) === '模拟' ? 'warn' : 'ok'}">${kindOf(p.name)}</span>${d ? doneTag : ''}<span class="paper-year">${yearOf(p.name)}</span></div>
      <div class="paper-title">${esc(p.name)}</div>
      <div class="paper-meta">${p.questionCount} 题${p.difficulty ? ` · 难度 ${p.difficulty}` : ''}</div>
    </div>`; }).join('') || '<div class="empty-state">没有匹配的试卷</div>'}</div>
  ${list.length > S.lib.show ? `<button class="btn btn-ghost btn-block" data-act="more-papers" style="margin-top:12px">加载更多（已显示 ${Math.min(S.lib.show, list.length)} / ${list.length} 套）</button>` : ''}`;
}

/* ---------- 回顾 ---------- */
function itemShape(x, kind) {
  return { questionId: x.questionId || x.question_id || x.id, content: x.content || x.prompt || '', subject: x.subject || '', chapter: x.chapter || '', note: x.note || '', time: x.time || '', answer: x.answer == null ? '' : String(x.answer), myAnswer: x.myAnswer == null ? '' : String(x.myAnswer), available: x.available !== false };
}
async function loadReview(tab) {
  S.review.tab = tab;
  S.tab = 'review';
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    if (tab === 'wrong') {
      const d = await api('/api/records/wrong?limit=500');
      S.review.data.wrong = (d.list || d || []).map((x) => itemShape(x));
    } else if (tab === 'fav') {
      const d = await api('/api/favorites?limit=50');
      S.review.data.fav = (d.list || d || []).map((x) => itemShape(x));
    } else if (tab === 'essay') {
      const [st, d] = await Promise.all([api('/api/essays/stats'), api('/api/essays?limit=50')]);
      S.review.data.essayStats = st || {};
      S.review.data.essays = d.list || d || [];
    } else {
      const d = await api('/api/notes?limit=200');
      S.review.data.notes = (d.list || d || []).map((x) => itemShape(x));
    }
    go('review');
  } catch (e) { toast(e.message); }
}
// 错题列表里补一行「你选了 X · 正确答案 Y」——复习时最想回忆的就是这个
function answerHint(r) {
  const mine = String(r.myAnswer == null ? '' : r.myAnswer).trim();
  const right = String(r.answer == null ? '' : r.answer).trim();
  const letter = (v) => {
    if (!v) return '';
    if (/^[A-H]$/i.test(v)) return v.toUpperCase();
    if (/^\d+(,\d+)*$/.test(v)) return v.split(',').map((x) => 'ABCDEFGH'[Number(x)] || '').join('');
    return v;
  };
  const m = letter(mine);
  const a = letter(right);
  if (!m && !a) return '';
  const mineCls = m && a && m === a ? 'ok' : 'bad';
  let out = '';
  if (m) out += `<span class="tag ${mineCls}">你选了 ${esc(m)}</span>`;
  else out += '<span class="tag">未作答</span>';
  if (a) out += `<span class="tag ok">正确答案 ${esc(a)}</span>`;
  return out;
}

/** 批改记录页：分数趋势 + 列表回看（批改全文存在 IndexedDB essays 里，离线可查） */
function essayBlock() {
  const st = S.review.data.essayStats || {};
  const list = S.review.data.essays || [];
  if (!list.length) {
    return '<div class="empty-state">还没有批改记录<br><span class="muted">做申论 / 综应主观题时，写完点「AI 批改」就会存到这里</span></div>';
  }
  const trend = (st.trend || []).slice(-12);
  const bars = trend.length
    ? `<div class="essay-trend">${trend.map((t) => `<i style="height:${Math.max(6, Math.min(100, Number(t.pct) || 0))}%" title="${esc(t.name || '')} ${t.pct == null ? '' : t.pct + '%'}"></i>`).join('')}</div>`
    : '';
  const bits = [`已批改 <b>${st.graded || list.length}</b> 篇`];
  if (st.avgPct != null) bits.push(`平均 <b>${st.avgPct}%</b>`);
  if (st.bestPct != null) bits.push(`最高 ${st.bestPct}%`);
  if (st.trend && st.trend.length > 1) bits.push(`最近 ${st.lastPct}%（首次 ${st.firstPct}%）`);
  const stat = `<section class="training-card"><div class="training-title">申论 / 综应批改</div><div class="training-sub">${bits.join(' · ')}</div>${bars}</section>`;
  const rows = list.map((r) => `<div class="list-item" data-act="essay-open" data-id="${esc(String(r.id))}">
      <div class="list-main"><div class="item-snippet">${esc(String(r.answer || '(未留作答)').slice(0, 80))}</div>
      <div class="item-bottom"><span class="tag">${esc(r.chapter || r.subject || '主观题')}</span>${r.score ? `<span class="tag ok">${esc(r.score)}</span>` : ''}<span class="tag">${esc(r.time || '')}</span></div></div></div>`).join('');
  return stat + `<div class="card list-card">${rows}</div>`;
}
function openEssayDetail(id) {
  const list = S.review.data.essays || [];
  const r = list.find((x) => String(x.id) === String(id));
  if (!r) { toast('记录不存在'); return; }
  const ans = esc(String(r.answer || '(未留作答)')).replace(/\n/g, '<br>');
  const body = esc(String(r.content || '')).replace(/\n/g, '<br>');
  sheet(`<div class="sheet-head"><div class="sheet-title">${esc(r.score || '批改记录')}</div><span class="sheet-close">✕</span></div>
    <div class="sheet-sub">${esc(r.chapter || r.subject || '')} · ${esc(r.time || '')}</div>
    <div class="grade-view"><div class="grade-view-t">我的作答</div><div class="grade-view-b">${ans}</div></div>
    <div class="grade-view"><div class="grade-view-t">批改</div><div class="grade-view-b">${body}</div></div>`);
}
function renderReview() {
  const tab = S.review.tab;
  const tabs = [['wrong', '错题'], ['fav', '收藏'], ['notes', '笔记'], ['essay', '批改']];
  const head = `
  <div class="topline"><span class="eyebrow">回顾</span></div>
  <h1 class="page-title">把错题变成会的题</h1>
  <div class="segmented">${tabs.map(([k, t]) => `<button class="seg ${tab === k ? 'active' : ''}" data-review-tab="${k}">${t}</button>`).join('')}</div>`;
  if (tab === 'essay') return head + essayBlock();
  const raw = tab === 'wrong' ? S.review.data.wrong : tab === 'fav' ? S.review.data.fav : S.review.data.notes;
  // 同一道题可能在多套卷里都做错过 -> 按 questionId 去重，只留最近一条
  const seenQ = new Set();
  const list = (raw || []).filter((it) => {
    const id = it && (it.questionId != null ? it.questionId : it.question_id);
    if (id == null) return true;
    if (seenQ.has(id)) return false;
    seenQ.add(id);
    return true;
  }).filter((it) => {
    // 错题按当前考试组合过滤：换档案后别的科目的错题不再混进来（收藏/笔记是用户主动存的，保留）
    if (tab !== 'wrong') return true;
    const s = it && it.subject;
    return !s || !notInScheme(s);
  });
  // 模块筛选：错题本里同一个模块（chapter）的题常常占一半以上，
  // 不给筛选就只能从头翻。只列出现 ≥2 次的模块，最多 6 个，避免 chips 铺满一屏。
  const chapCount = new Map();
  for (const it of list) {
    const c = (it && it.chapter) || '';
    if (c) chapCount.set(c, (chapCount.get(c) || 0) + 1);
  }
  const chapList = [...chapCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (S.review.chapter && !chapCount.has(S.review.chapter)) S.review.chapter = '';
  const shown = tab === 'wrong' && S.review.chapter ? list.filter((it) => (it.chapter || '') === S.review.chapter) : list;
  // 到期数也要跟着过滤，否则会出现「到期 6 道」但列表里只有 3 道
  const listIds = new Set(shown.map((it) => String(it && (it.questionId != null ? it.questionId : it.question_id))));
  const dueN = tab === 'wrong' ? dueIds().filter((id) => listIds.has(String(id))).length : dueIds().length;
  const chapChips = tab === 'wrong' && chapList.length > 1
    ? `<div class="chips chap-chips"><button class="chip ${!S.review.chapter ? 'active' : ''}" data-act="review-chap" data-c="">全部 ${list.length}</button>${chapList.map(([c, n]) => `<button class="chip ${S.review.chapter === c ? 'active' : ''}" data-act="review-chap" data-c="${esc(c)}">${esc(c)} ${n}</button>`).join('')}</div>`
    : '';
  // 全部错题（跨科目）与当前组合口径的题数会不一样：换个档案后，别的科目的错题被藏起来了。
  // 不解释清楚就会出现「我的说 62 道、错题本说 25 道」的割裂感，这里直接说明差额去哪了。
  const allWrong = Number(S.stats && S.stats.wrong) || 0;
  const otherWrong = !S.review.chapter && allWrong > shown.length ? allWrong - shown.length : 0;
  const otherHint = otherWrong > 0 ? `<i class="wrong-other">另有 ${otherWrong} 道属于当前考试组合以外的科目</i>` : '';
  return `${head}
  ${chapChips}
  ${tab === 'wrong' ? `<section class="training-card"><div class="training-title">${dueN ? '今日复习' : '错题训练'}</div><div class="training-sub">${dueN ? `到期 <b>${dueN}</b> 道 · ${S.review.chapter ? `「${esc(S.review.chapter)}」共 ` : '错题本共 '}${shown.length} 道 · ${dueLine(shown)}` : `${S.review.chapter ? `「${esc(S.review.chapter)}」` : '错题本'} <b>${shown.length}</b> 道 · ${dueLine(shown)}`}${otherHint}</div><button class="btn btn-primary btn-block" data-act="wrong-train">${dueN ? `开始今日复习（${Math.min(dueN, 15)} 道）` : '开始训练'}</button><div class="training-foot"><span>做对的题自动移出错题本</span><button class="switch ${S.settings.dropFixed !== false ? 'on' : ''}" data-drop-fixed aria-label="做对的题自动移出错题本"><i></i></button></div></section>` : ''}
  ${tab === 'notes' && list.length ? `<button class="btn btn-ghost btn-block" style="margin-bottom:10px" data-act="note-search">搜索笔记</button>` : ''}
  <div class="card list-card">
    ${shown.length ? shown.map((r) => `<div class="list-item" data-act="open-q" data-id="${r.questionId}">
      <div class="list-main"><div class="item-snippet">${esc(r.content || r.note || '(无题干)')}</div>
      <div class="item-bottom"><span class="tag">${esc(r.subject || '')}</span><span class="tag">${esc(r.chapter || '')}</span>${r.note ? `<span class="tag ok">有笔记</span>` : ''}${tab === 'wrong' ? answerHint(r) : ''}</div></div></div>`).join('') : `<div class="empty-state">${S.review.chapter ? `「${esc(S.review.chapter)}」下没有${tab === 'wrong' ? '错题' : '内容'}` : `暂无${tab === 'wrong' ? '错题' : tab === 'fav' ? '收藏' : '笔记'}`}<br><span class="muted">去刷题后会自动出现在这里</span></div>`}
  </div>`;
}

/* ---------- 考试 ---------- */
// 每道题给多少秒，直接决定「N 题 · M 分钟」对不对得上。
// 行测/职测 55 秒：130 题 = 119 分钟，和真实行测（120 分钟）吻合；
// 公基 45 秒；主观题不参加模考。卡片上的分钟数由 examMinutes() 现算，
// 不再手写「20 题 · 30 分钟」这种和实际计时（n*60）不一致的文案。
function secPerQ(subject) {
  const s = String(subject || '');
  if (/行测|职测/.test(s)) return 55;
  if (/公基|综合知识/.test(s)) return 45;
  return 60;
}
function examMinutes(n, subject) { return Math.max(1, Math.ceil((n * secPerQ(subject)) / 60)); }
function examPresets() {
  const subj = dailySubject();
  const mk = (no, title, n) => ({ no, title, meta: `${n} 题 · ${examMinutes(n, subj)} 分钟`, n });
  const base = [mk('01', '热身小考', 10), mk('02', '稳步进阶', 20), mk('03', '综合耐力', 50)];
  if (S.profile.examType === '事业编' || S.profile.examType === '三支一扶') return base;
  return [...base, mk('04', '行测全真', 130)];
}
function renderExam() {
  if (S.examResult) return renderExamResult();
  if (S.planView) return renderPlan();
  if (S.diagResult) return renderDiagResult();
  // 整卷列表借住在考试 tab 里：它是最像真考试的东西，所以排第一，而不是塞进题库
  if (S.examPapers) return renderPapers({ host: 'exam' });
  const presets = examPresets();
  const weak = weakPoints();
  const last7 = ((S.stats && S.stats.last7) || []).filter((x) => x && x.d && x.c != null);
  const hist = loadExamHistory();
  return `
  <div class="topline"><span class="eyebrow">考试</span></div>
  <h1 class="page-title">模考</h1>
  <div class="card-sub" style="margin:-8px 0 16px">先独立作答，再看答案。每一次交卷都有自己的成绩单。</div>
  <section class="training-card exam-hero" style="cursor:pointer" data-act="exam-papers"><div class="training-kicker">首选</div><div class="training-title">真题整卷</div><div class="training-sub">按地区、年份挑一份真卷 · 按真题时长计时 · 交卷出成绩单</div><button class="btn btn-primary btn-block" data-act="exam-papers">选一份卷子</button></section>
  <section class="training-card" style="cursor:pointer" data-act="smart-paper"><div class="training-title">薄弱专项 · 智能组卷</div><div class="training-sub">${weak.length ? `${weak.map((w) => w.label || w.name).slice(0, 3).join(' / ')} · 15 题` : '先做几道题，系统会按正确率找薄弱点'}</div><button class="btn btn-ghost btn-block" data-act="smart-paper">${weak.length ? '按薄弱点组 15 题' : '去刷几题'}</button></section>
  ${(() => {
    const d = S.diag || loadDiag();
    const age = diagAgeDays();
    if (!d || !d.modules || !d.modules.length) {
      return `<section class="training-card diag-card" data-act="diag-start"><div class="training-kicker">先摸摸底</div><div class="training-title">基础测评 · 约 25 分钟</div><div class="training-sub">六个模块各抽几道题，测出哪块最弱。做完之后，每日任务就按这个顺序给你推题。</div><button class="btn btn-ghost btn-block" data-act="diag-start">开始测评</button></section>`;
    }
    // 测过之后就没什么存在感了：收成一行，别一直占着大块版面
    const w = d.modules[0];
    const stale = age != null && age >= 30;
    return `<button class="diag-mini" data-act="diag-view"><span class="diag-mini-txt"><span class="diag-mini-top"><b>基础测评</b> · ${age == null ? '已保存' : age === 0 ? '今天测的' : age + ' 天前'}</span><span class="diag-mini-sub">最该补 ${esc(w.name)} ${Math.round(w.rate * 100)}%${stale ? ' · 已过一个月，建议重测' : ''}</span></span><span class="chev">›</span></button>`;
  })()}
  <div class="section-head"><h2 class="section-title">随机组卷</h2><span class="muted" style="font-size:12px">不挑卷子，按题量直接开考</span></div>
  ${presets.map((p) => `<section class="exam-card"><div class="exam-top"><span class="exam-no">${p.no}</span><span class="module-count">${esc(p.meta)}</span></div><div class="exam-title">${p.title}</div><div class="exam-meta">${esc(S.profile.examName)} · 随机组卷</div><button class="btn btn-primary btn-block" data-act="exam" data-n="${p.n}">开始模考</button></section>`).join('')}
  ${hist.length ? (() => {
    const scores = hist.map((r) => (r.total ? (r.right / r.total) * 100 : 0));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const best = Math.max(...scores);
    const lastOne = hist[hist.length - 1];
    const lastRate = lastOne && lastOne.total ? Math.round((lastOne.right / lastOne.total) * 100) : 0;
    const rows = hist.slice(-3).reverse().map((r) => {
      const sc = Math.round((r.right / (r.total || 1)) * 1000) / 10;
      const d = new Date(r.ts);
      const rate = r.total ? Math.round((r.right / r.total) * 100) : 0;
      return `<div class="hist-row"><div class="hist-main"><div class="hist-title">${esc(r.title || '模考')}</div><div class="hist-sub">${d.getMonth() + 1}/${d.getDate()} · ${esc(r.kind || '随机')} · ${r.total} 题 · 用时 ${fmtTime(r.used || 0)}</div></div><div class="hist-score"><b>${sc}</b><span>${r.right}/${r.total} · ${rate}%</span></div></div>`;
    }).join('');
    return `<div class="section-head"><h2 class="section-title">模考成绩单</h2><button class="section-more" data-act="exam-history">全部 ${hist.length} 次 ›</button></div>`
      + `<div class="card sum-strip">`
      + `<div class="sum-cell"><b>${Math.round(avg * 10) / 10}</b><span>平均分</span></div>`
      + `<div class="sum-cell"><b>${Math.round(best * 10) / 10}</b><span>最高分</span></div>`
      + `<div class="sum-cell"><b>${lastRate}%</b><span>最近一次</span></div>`
      + `<div class="sum-cell"><b>${hist.length}</b><span>已考次数</span></div>`
      + `</div>`
      + `<div class="card list-card">${rows}</div>`;
  })() : ''}
  ${trendCard(hist)}
  <button class="home-alt" data-act="plan" style="margin-top:14px"><span>没有计划？让 AI 排一个<b>四阶段备考计划</b></span><span class="home-alt-r">去生成 ›</span></button>
  ${last7.length ? `<div class="section-head"><h2 class="section-title">近 7 天</h2></div><div class="card list-card">${last7.map((d) => `<div class="exam-row"><div class="subject-ico">${iconFor('')}</div><div class="subject-main"><div class="subject-title">${d.d}</div><div class="subject-sub">做题 ${Number(d.c) || 0} · 答对 ${Number(d.ok) || 0}</div></div><div class="weak-pct">${d.c ? Math.round(((Number(d.ok) || 0) / Number(d.c)) * 100) : 0}%</div></div>`).join('')}</div>` : ''}`;
}


/** 按年份 / 按省份聚合整卷成绩（只有 kind='整卷' 且带 year/region 的才算） */
function trendStats(hist, key) {
  const m = new Map();
  for (const r of hist) {
    const k = r && r[key];
    if (!k) continue;
    if (r.kind && r.kind !== '整卷') continue;
    const e = m.get(k) || { k, n: 0, right: 0, total: 0 };
    e.n++;
    e.right += r.right || 0;
    e.total += r.total || 0;
    m.set(k, e);
  }
  return [...m.values()]
    .map((x) => ({ ...x, score: x.total ? Math.round((x.right / x.total) * 1000) / 10 : 0 }))
    .sort((a, b) => (key === 'year' ? a.k - b.k : b.n - a.n || b.score - a.score));
}

function trendBars(list, key, max) {
  if (!list.length) return '<div class="card-sub">还没有可对比的整卷成绩</div>';
  const top = Math.max(1, ...list.map((x) => x.score));
  return '<div class="trend-bars">' + list.slice(0, max).map((x) => `<div class="trend-col" title="${esc(String(x.k))} · ${x.n} 场 · 平均 ${x.score} 分">
    <div class="trend-col-v">${Math.round(x.score)}</div>
    <div class="trend-col-bar" style="height:${Math.max(6, Math.round((x.score / top) * 56))}px"></div>
    <div class="trend-col-k">${esc(key === 'year' ? String(x.k).slice(2) + '年' : String(x.k))}</div>
  </div>`).join('') + '</div>';
}

function trendCard(hist) {
  const ys = trendStats(hist, 'year');
  const rs = trendStats(hist, 'region');
  if (!ys.length && !rs.length) return '';
  return `<div class="section-head"><h2 class="section-title">成绩趋势</h2><button class="section-more" data-act="exam-trend">按年份 / 省份 ›</button></div>
  <div class="card trend-card">
    <div class="trend-label">按年份 · 平均分</div>${trendBars(ys, 'year', 6)}
    <div class="trend-label" style="margin-top:14px">按省份 · 平均分</div>${trendBars(rs, 'region', 6)}
  </div>`;
}

function openExamTrend() {
  const hist = loadExamHistory();
  const ys = trendStats(hist, 'year');
  const rs = trendStats(hist, 'region');
  const row = (x, key) => `<div class="hist-row"><div class="hist-main"><div class="hist-title">${esc(String(x.k))}${key === 'year' ? ' 年' : ''}</div><div class="hist-sub">${x.n} 场 · 累计 ${x.total} 题 · 答对 ${x.right}</div></div><div class="hist-score"><b>${Math.round(x.score)}</b><span>平均分</span></div></div>`;
  sheet(`<div class="sheet-head"><b>成绩趋势</b><button class="sheet-close">✕</button></div>
    <div class="trend-label">按年份</div>
    <div style="max-height:32vh;overflow-y:auto">${ys.map((x) => row(x, 'year')).join('') || '<div class="card-sub">暂无</div>'}</div>
    <div class="trend-label" style="margin-top:12px">按省份</div>
    <div style="max-height:32vh;overflow-y:auto">${rs.map((x) => row(x, 'region')).join('') || '<div class="card-sub">暂无</div>'}</div>`);
}

function renderExamResult() {
  const R = S.examResult;
  if (!R) return '';
  const costs = R.costs || [];
  const modules = new Map();
  R.items.forEach(({ q, a }, i) => {
    const key = q.chapter || '未分类';
    const m = modules.get(key) || { name: key, total: 0, right: 0, answered: 0, cost: 0, kps: new Map() };
    m.total++;
    m.cost += Number(costs[i]) || 0;
    if (a && a.selected != null) m.answered++;
    const ok = !!a?.feedback?.ok;
    if (ok) m.right++;
    // 考点级下钻：同一模块里再按考点（question_keypoints）分一层
    const kp = q.kp || '';
    if (kp) {
      const k = m.kps.get(kp) || { name: kp, total: 0, right: 0 };
      k.total++; if (ok) k.right++;
      m.kps.set(kp, k);
    }
    modules.set(key, m);
  });
  const mods = [...modules.values()].sort((x, y) => (x.right / x.total) - (y.right / y.total));
  const rate = R.total ? Math.round((R.right / R.total) * 100) : 0;
  const unanswered = R.items.filter(({ a }) => !a || a.selected == null).length;
  const wrong = R.total - R.right - unanswered;
  const score = Math.round((R.right / (R.total || 1)) * 1000) / 10;   // 百分制
  const avgSec = R.total ? Math.round((R.used || 0) / R.total) : 0;
  // 历史对照：模块历史正确率 + 近 7 天趋势（来自 /api/records/stats）
  const hist = new Map(((S.stats && S.stats.byChapter) || []).map((x) => [x.chapter, x]));
  const last7 = (S.stats && S.stats.last7) || [];
  const trend = last7.slice(-7).map((d) => ({
    d: d.d, rate: d.c ? Math.round(((Number(d.ok) || 0) / Number(d.c)) * 100) : 0, n: Number(d.c) || 0,
  }));
  const trendMax = Math.max(1, ...trend.map((t) => t.n));
  // ---- 复盘：按模块分组，可只看错题 / 只看待定 ----
  const fgSet = new Set(R.flagged || []);
  const isBlank = (a) => !a || a.selected == null;
  const isWrong = (a) => !isBlank(a) && !a?.feedback?.ok;
  const pass = (it, i) => (reviewFilter === 'wrong' ? (isWrong(it.a) || isBlank(it.a)) : reviewFilter === 'flag' ? fgSet.has(i) : true);
  const wrongN = R.items.filter((it) => isWrong(it.a) || isBlank(it.a)).length;
  const groups = new Map();
  R.items.forEach((it, i) => {
    if (!pass(it, i)) return;
    const k = it.q.chapter || '未分类';
    const g = groups.get(k) || { name: k, list: [], right: 0, total: 0, kps: new Set() };
    g.list.push({ it, i });
    g.total++;
    if (it.a?.feedback?.ok) g.right++;
    if (it.q.kp) g.kps.add(it.q.kp);
    groups.set(k, g);
  });
  const gList = [...groups.values()].sort((x, y) => (x.right / x.total) - (y.right / y.total));
  const rowOf = ({ it, i }) => {
    const { q, a } = it;
    const fb = a?.feedback;
    const status = isBlank(a) ? '未答' : fb?.ok ? '正确' : '错误';
    const color = status === '正确' ? 'var(--green)' : status === '错误' ? 'var(--red)' : 'var(--text-3)';
    const costTxt = costs[i] ? fmtTime(Math.round(costs[i] / 1000)) : '—';
    const opts = (q.options || []).map((o, j) => {
      const correct = (fb?.correct || []).includes(j);
      const picked = a?.selected === j;
      const cls = correct ? 'correct' : picked ? 'wrong' : '';
      return `<div class="result-opt ${cls}"><b>${'ABCDEFGH'[j]}</b> ${renderOption(o)}${picked ? ' · 你的选择' : ''}${correct ? ' · 正确答案' : ''}</div>`;
    }).join('');
    return `<details class="card result-q" style="margin-bottom:8px">
      <summary style="cursor:pointer;list-style:none"><div class="paper-top"><span class="tag">第 ${i + 1} 题</span>${q.kp ? `<span class="tag kp">${esc(q.kp)}</span>` : ''}${fgSet.has(i) ? '<span class="tag flag">待定</span>' : ''}<span class="tag" style="color:${color}">${status}</span><span class="tag">${costTxt}</span></div><div class="subject-title" style="margin-top:8px">${esc(String(q.content || '').replace(/\s+/g, ' ').slice(0, 70))}${String(q.content || '').length > 70 ? '…' : ''}</div></summary>
      <div class="q-stem" style="margin-top:12px">${q.sourceTag ? `<span class="q-src">${esc(q.sourceTag)}</span>` : ''}${safeHtml(q.contentHtml || esc(q.content || ''))}</div>${renderMaterial(q)}${opts}<div class="explain" style="margin-top:12px"><h4>解析</h4><p>${renderRichText(q.analysisHtml || q.analysis || '暂无解析')}</p></div>
    </details>`;
  };
  const reviewHtml = gList.length ? gList.map((g) => `<section class="rv-group">
      <div class="rv-head">
        <div><div class="rv-name">${esc(g.name)}</div><div class="rv-meta">${g.total} 题 · 答对 ${g.right} · ${Math.round((g.right / g.total) * 100)}%${g.kps.size > 1 ? ` · ${g.kps.size} 个考点` : ''}</div></div>
        <button class="chip" data-act="review-kp" data-chapter="${esc(g.name)}">练这个考点</button>
      </div>
      ${g.list.map(rowOf).join('')}
    </section>`).join('') : '<div class="empty-state">这个筛选下没有题目</div>';
  return `<div class="subpage-head"><button class="icon-btn" data-act="exam-result-back">‹</button><div class="subpage-title">考试报告</div><span style="width:38px"></span></div>
  <div class="card-sub" style="margin:-6px 0 14px">${esc(R.title)} · 用时 ${fmtTime(R.used)} · 平均每题 ${fmtTime(avgSec)}${R.fromHistory ? ' · 历史成绩' : ''}</div>
  <div class="card" style="text-align:center;padding:20px 16px 16px">
    <div style="font-size:44px;font-weight:780;letter-spacing:-.04em;line-height:1">${score}<span style="font-size:18px;font-weight:600;color:var(--text-3)"> / 100</span></div>
    <div class="card-sub" style="margin-top:6px">答对 ${R.right} · 答错 ${wrong} · 未答 ${unanswered}</div>
    <div style="display:flex;gap:2px;margin-top:16px;align-items:flex-end;height:44px">${trend.length ? trend.map((t) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px" title="${t.d} · ${t.n} 题 · ${t.rate}%"><div style="width:100%;background:var(--primary);opacity:${0.35 + 0.65 * (t.rate / 100)};height:${Math.max(6, Math.round((t.n / trendMax) * 40))}px;border-radius:3px 3px 0 0"></div><span style="font-size:10px;color:var(--text-3)">${String(t.d).slice(5)}</span></div>`).join('') : '<div class="card-sub" style="width:100%">还没有历史记录，做题后会显示近 7 天趋势</div>'}</div>
    ${trend.length ? '<div class="card-sub" style="margin-top:6px">近 7 天做题量（柱高）与正确率（深浅）</div>' : ''}
  </div>
  <div class="stats-row"><div class="stat"><b>${rate}%</b><span>正确率</span></div><div class="stat"><b>${fmtTime(R.used)}</b><span>总用时</span></div><div class="stat"><b>${fmtTime(avgSec)}</b><span>每题均时</span></div></div>
  <div class="section-head"><h2 class="section-title">模块得分</h2></div>
  <div class="card">${mods.map((m) => {
    const h = hist.get(m.name);
    const histTxt = h && h.c ? ` · 历史 ${Math.round(((Number(h.ok) || 0) / Number(h.c)) * 100)}%` : '';
    const kps = [...m.kps.values()].sort((x, y) => y.total - x.total);
    const kpLine = kps.length > 1
      ? `<div class="kp-line">${kps.slice(0, 4).map((k) => `<span class="kp-tag${k.right === k.total ? ' ok' : k.right === 0 ? ' no' : ''}">${esc(k.name)} ${k.right}/${k.total}</span>`).join('')}${kps.length > 4 ? `<span class="kp-tag">+${kps.length - 4}</span>` : ''}</div>`
      : '';
    return `<div class="plan-stage"><div class="subject-main"><div class="subject-title">${esc(m.name)}</div><div class="subject-sub">答对 ${m.right} / ${m.total} · 用时 ${m.cost ? fmtTime(Math.round(m.cost / 1000)) : '—'}${histTxt}${m.total > m.answered ? ` · 未答 ${m.total - m.answered}` : ''}</div>${kpLine}</div><div class="weak-pct">${Math.round((m.right / m.total) * 100)}%</div></div>`;
  }).join('') || '<div class="empty-state">暂无数据</div>'}</div>
  <div class="section-head"><h2 class="section-title">复盘</h2><span class="section-more">${gList.length} 个模块</span></div>
  <div class="chips rv-filters">
    <button class="chip ${reviewFilter === 'all' ? 'active' : ''}" data-act="review-filter" data-f="all">全部 ${R.total}</button>
    <button class="chip ${reviewFilter === 'wrong' ? 'active' : ''}" data-act="review-filter" data-f="wrong">错题 ${wrongN}</button>
    <button class="chip ${reviewFilter === 'flag' ? 'active' : ''}" data-act="review-filter" data-f="flag">待定 ${fgSet.size}</button>
  </div>
  ${reviewHtml}
  ${R.items.some(({ a }) => a?.selected != null && !a.feedback?.ok) ? `<button class="btn btn-primary btn-block" style="margin-top:14px" data-act="retry-wrong">错题再练</button>` : ''}`;
}

/* ---------- AI 刷题班 ---------- */
function renderPlan() {
  const p = S.plan;
  if (!p) {
    return `<div class="subpage-head"><button class="icon-btn" data-act="plan-back">‹</button><div class="subpage-title">AI 刷题班</div><span style="width:38px"></span></div>
    <div class="card-sub" style="margin:-6px 0 14px">按你的基础、目标分和备考时长，生成四阶段计划</div>
    <div class="filter-label">目标分</div><div class="chips">${[60, 70, 80].map((x) => `<button class="chip ${(S.profile.targetScore || 70) === x ? 'active' : ''}" data-plan-target="${x}">${x} 分</button>`).join('')}</div>
    <div class="filter-label">每天可投入</div><div class="chips">${[60, 90, 120].map((x) => `<button class="chip ${(S.profile.minutes || 90) === x ? 'active' : ''}" data-plan-min="${x}">${x} 分钟</button>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="subject-title">当前数据</div><div class="subject-sub">累计做题 ${S.stats?.total || 0} · 正确率 ${S.stats?.rate || 0}% · 距考试 ${daysLeft()} 天</div></div>
    <button class="btn btn-primary btn-block" data-act="plan-gen">生成四阶段计划</button>`;
  }
  const due = dueIds().length;
  const weak = weakPoints();
  const today = todayCount();
  const remain = dailyRemaining();
  const done = due === 0 && remain === 0;
  return `<div class="subpage-head"><button class="icon-btn" data-act="plan-back">‹</button><div class="subpage-title">AI 刷题班</div><span style="width:38px"></span></div>
  <div class="card-sub" style="margin:-6px 0 10px">目标 ${p.target} 分 · 每天 ${p.minutes} 分钟 · 剩余 ${daysLeft()} 天</div>
  <div class="card"><div class="subject-title">AI 老师对你说</div><div class="ai-out">${esc(p.message)}</div></div>
  <div class="section-head"><h2 class="section-title">四阶段</h2></div>
  <div class="card">${p.stages.map((st, i) => `<div class="plan-stage"><div class="plan-no">${String(i + 1).padStart(2, '0')}</div><div class="subject-main"><div class="subject-title">${st.name} <span class="tag">${st.range}</span></div><div class="subject-sub">${st.desc} · ${st.focus}</div></div></div>`).join('')}</div>
  <div class="section-head"><h2 class="section-title">今日任务</h2></div>
  <div class="training-card"><div class="training-title">${done ? '今日任务完成' : due ? `待复习 ${due} 题` : `今日新题 ${Math.min(remain, 15)} 题`}</div><div class="training-sub">薄弱：${(weak[0] && weak[0].name) || '按模块轮换'} · 今日已做 ${today} / ${dailyGoal()}</div><button class="btn ${done ? 'btn-ghost' : 'btn-primary'} btn-block" data-act="${done ? 'extra-practice' : 'plan-practice'}">${done ? '再加练 10 题' : '开始今日任务'}</button></div>
  <button class="btn btn-ghost btn-block" data-act="plan-reset">重新生成计划</button>`;
}


/* ---------- AI 设置 ---------- */
const AI_GATEWAYS = [
  { label: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-flash', agents: [1, 2], signup: 'https://platform.deepseek.com/api_keys', tip: '便宜、中文好，新号有免费额度' },
  { label: '智谱 BigModel', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', agents: [4, 6], signup: 'https://open.bigmodel.cn/usercenter/apikeys', tip: 'glm-4-flash 免费额度大' },
  { label: '商汤 SenseNova', url: 'https://token.sensenova.cn/v1', model: 'SenseChat-5', agents: [], signup: 'https://platform.sensenova.cn', tip: '有免费额度' },
  { label: 'Open Code', url: 'https://opencode.ai/zen/v1', model: '', agents: [], signup: '', tip: '' },
];
async function openAi() {
  S.meView = 'ai'; S.tab = 'me';
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    const [agents, skills] = await Promise.all([
      api('/api/ai/agents'),
      api('/api/skills').catch(() => []),
    ]);
    S.agents = agents || [];
    S.skills = skills || [];
  } catch (e) { toast(e.message); }
  go('me');
}
/* ---------- AI 助手（设置） ---------- */
function hostOf(url) {
  return String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}
function renderAiSettings() {
  const agents = S.agents || [];
  const skills = S.skills || [];
  const live = agents.filter((a) => a.enabled);
  const cur = live[0];
  const rows = agents.map((a) => `
    <div class="ai-row${a.enabled ? ' on' : ''}" data-act="ai-edit" data-id="${a.id}">
      <div class="ai-ava">${esc(String(a.name || 'AI').trim().slice(0, 1).toUpperCase())}</div>
      <div class="ai-row-main">
        <div class="ai-row-t">${esc(a.name || ('AI ' + a.id))}${a.enabled ? '<i class="ai-live"></i>' : ''}</div>
        <div class="ai-row-s">${esc(a.model || '还没选模型')} · ${esc(hostOf(a.base_url) || '还没填地址')}</div>
      </div>
      <button class="ai-sw${a.enabled ? ' on' : ''}" data-act="ai-toggle" data-id="${a.id}">${a.enabled ? '已启用' : '启用'}</button>
      <span class="ai-chev">›</span>
    </div>`).join('');
  const skillRows = skills.length
    ? skills.map((s) => `
      <div class="ai-skill">
        <div class="ai-skill-main">
          <div class="ai-skill-t">${esc(s.name)}</div>
          <div class="ai-skill-s">${s.inUse && s.inUse.length ? '被 ' + esc(s.inUse.join('、')) + ' 使用' : '还没挂到任何模型上'}${s.description ? ' · ' + esc(s.description) : ''}</div>
        </div>
        <button class="chip" data-act="ai-skill-del" data-name="${esc(s.name)}">移除</button>
      </div>`).join('')
    : '<div class="ai-empty">还没放技能包。技能包是给 AI 的参考资料，解析时会一起带过去。</div>';

  return `<div class="subpage-head"><button class="icon-btn" data-act="me-back">‹</button><div class="subpage-title">AI 助手</div><span style="width:38px"></span></div>

  <div class="ai-hero">
    <div class="ai-hero-k">${cur ? '正在用' : '当前状态'}</div>
    <div class="ai-hero-v">${cur ? esc(cur.model || '还没选模型') : '还没启用模型'}</div>
    <div class="ai-hero-s">${cur
      ? esc(cur.name || ('AI ' + cur.id)) + ' · ' + esc(hostOf(cur.base_url) || '还没填地址')
      : '填好地址和 Key 之后，讲题、批改、排计划才会真的跑起来'}</div>
    <div class="ai-hero-tags"><span class="tag">${agents.length} 个配置</span><span class="tag">${live.length} 个在用</span><span class="tag">${skills.length} 套技能</span></div>
  </div>

  <div class="sec-head"><h2>模型配置</h2><span class="sec-hint">Key 只存这台手机</span></div>
  <div class="card ai-list">${rows || '<div class="ai-empty">还没有配置。</div>'}</div>

  <div class="sec-head"><h2>解析缓存</h2></div>
  <div class="card">
    <div class="opt-row">
      <span class="opt-label">清空已缓存的解析<div class="opt-hint">同一道题重复问会直接用上次结果；清掉之后重新算</div></span>
      <button class="chip" data-act="ai-clear-cache">清空</button>
    </div>
  </div>

  <div class="sec-head"><h2>技能包</h2><span class="sec-hint">${skills.length} 套</span></div>
  <div class="card">${skillRows}
    <div class="opt-row">
      <span class="opt-label">内置技能默认开启<div class="opt-hint">申论批改、花生十三技巧；开着的话新装的机器进来自动挂上</div></span>
      <button class="switch ${S.settings.skills !== false ? 'on' : ''}" data-act="skills-toggle" aria-label="内置技能开关"></button>
    </div>
    <div class="btn-row"><button class="btn btn-ghost" data-act="ai-skill-builtin">装内置技能</button><button class="btn btn-ghost" data-act="ai-skill-import">从文本导入</button></div>
  </div>

  <p class="ai-foot">所有请求从这台手机直接发到你填的地址，不经过我们的服务器。</p>`;
}
function editAgent(id) {
  const a = (S.agents || []).find((x) => String(x.id) === String(id));
  if (!a) return;
  const presets = AI_GATEWAYS.map((g) => `<option value="${esc(g.url)}" ${a.base_url === g.url ? 'selected' : ''}>${esc(g.label)} · ${esc(g.url)}</option>`).join('');
  const skills = S.skills || [];
  sheet(`<div class="sheet-head"><b>${esc(a.name || '模型配置')}</b><button class="sheet-close">✕</button></div>
    <div class="ai-form">
      <div class="ai-form-sec">连接</div>
      <label class="ai-field"><span>常用地址</span><select class="field" id="ai-base-preset"><option value="">选一个网关，或自己填</option>${presets}<option value="__custom__">自定义…</option></select></label>
      <label class="ai-field"><span>Base URL</span><input class="field" id="ai-base" value="${esc(a.base_url || '')}" placeholder="https://api.deepseek.com/v1"></label>
      <label class="ai-field"><span>API Key</span><input class="field" id="ai-key" type="password" placeholder="${esc(a.api_key_masked || '还没填')}"><em>留空表示不改</em></label>
      <label class="ai-field"><span>模型</span><input class="field" id="ai-model" value="${esc(a.model || '')}" placeholder="deepseek-chat"></label>
      <button class="btn btn-ghost btn-block" data-act="ai-models" data-id="${a.id}">拉一下这个地址有哪些模型</button>
      <div class="ai-form-sec">生成参数</div>
      <div class="ai-two">
        <label class="ai-field"><span>温度</span><input class="field" id="ai-temp" type="number" step="0.1" min="0" max="1" value="${a.temperature ?? 0.5}"></label>
        <label class="ai-field"><span>最大 tokens</span><input class="field" id="ai-maxtok" type="number" step="100" min="100" value="${a.max_tokens ?? 4000}"></label>
      </div>
      <label class="ai-field"><span>挂哪套技能</span><input class="field" id="ai-skill" list="ai-skill-list" value="${esc(a.skill || '')}" placeholder="不挂也行"><datalist id="ai-skill-list">${skills.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist></label>
      <div class="ai-form-sec">人设</div>
      <textarea class="field" id="ai-prompt" rows="7" placeholder="告诉它该怎么讲题">${esc(a.system_prompt || '')}</textarea>
    </div>
    <button class="btn btn-primary btn-block" data-act="ai-save" data-id="${a.id}">保存</button>
    <div class="btn-row"><button class="btn btn-ghost" data-act="ai-test" data-id="${a.id}">试一句</button><button class="btn btn-ghost" data-act="ai-history" data-id="${a.id}">历史版本</button></div>
    <div id="ai-extra" style="margin-top:10px"></div>`);
}

function agentFields() {
  const f = {
    base_url: ($('#ai-base')?.value || '').trim(),
    model: ($('#ai-model')?.value || '').trim(),
    skill: ($('#ai-skill')?.value || '').trim(),
    system_prompt: $('#ai-prompt')?.value || '',
    temperature: Number($('#ai-temp')?.value || 0.5),
    max_tokens: Number($('#ai-maxtok')?.value || 4000),
  };
  const key = ($('#ai-key')?.value || '').trim();
  if (key) f.api_key = key;
  return f;
}
async function saveAgentFields(id) {
  return api(`/api/ai/agents/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agentFields()) });
}
async function fetchModelList(baseUrl, apiKey) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('请先填写正确的 Base URL');
  const nativeHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  const headers = { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  const doGet = async (url) => {
    if (nativeHttp) {
      const r = await nativeHttp.request({ url, method: 'GET', headers, connectTimeout: 15000, readTimeout: 30000 });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
    }
    const proxied = await api('/api/ai/models-proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: base, apiKey }) }).catch(() => null);
    if (proxied && !proxied.error) return { ok: true, status: 200, data: proxied };
    if (proxied && proxied.error) return { ok: false, status: proxied.status || 400, data: null, error: proxied.error };
    const r = await fetch(url, { headers });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  };
  const cands = [`${base}/models`];
  if (!/\/v1$/.test(base)) cands.push(`${base}/v1/models`);
  let last = '';
  for (const url of cands) {
    const r = await doGet(url);
    if (r.ok && r.data) {
      const models = (Array.isArray(r.data.data) ? r.data.data : []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
      if (/open\.bigmodel\.cn/i.test(base)) {
        for (const m of ['GLM-4.1V-Thinking-Flash', 'GLM-4V-Plus', 'GLM-4V-Flash']) if (!models.includes(m)) models.push(m);
      }
      if (models.length) return models;
      last = '接口返回了空模型列表';
    } else {
      last = r.error || `HTTP ${r.status}`;
    }
  }
  throw new Error(last || '获取模型列表失败');
}
async function runAgentTest(id, box) {
  if (!box) return;
  box.innerHTML = '<div class="ai-loading"><span class="spinner ai-spinner"></span> 正在调用 AI…</div>';
  try {
    const r = await api(`/api/ai/agents/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '（测试）请用一句话介绍你的职责，并说明你准备好了。' }) });
    box.innerHTML = r && r.content
      ? `<div class="ai-sec"><div class="ai-sec-title">调用成功</div><div class="ai-sec-body">${aiRichText(r.content)}</div></div>`
      : `<div class="empty-state" style="color:var(--red)">${esc(r?.error || r?.notice || '调用失败')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}
async function importBuiltinSkills(silent) {
  const bundles = ['skill-gongkao-huasheng13.json', 'skill-shenlun-master.json'];
  const imported = [];
  for (const f of bundles) {
    try {
      const r = await fetch('/app-assets/' + f, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.json();
      const paths = [...String(b.text || '').matchAll(/----- ([^\n]+) -----/g)].map((m) => ({ path: m[1], size: 0 }));
      const res = await api('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: b.name, description: '', text: b.text, files: [{ path: 'SKILL.md', size: 0 }, ...paths] }) });
      if (res.error) throw new Error(res.error);
      imported.push(b.name);
    } catch (e) { if (!silent) toast(`导入 ${f} 失败：${e.message}`); }
  }
  if (silent) return imported.length;
  if (imported.length) { toast('已导入：' + imported.join('、')); openAi(); }
}

/**
 * 首次启动（或用户重新打开开关）时把内置技能灌进技能库。
 * 技能内容就是 SKILL.md + references 全文，装在 IndexedDB 里，随用随取；
 * 没配 AI Key 也不影响，等配了模型就能直接挂上。
 */
const SKILLS_SEED_KEY = 'sg_skills_seeded';
async function ensureBuiltinSkills(force) {
  if (!force && S.settings.skills === false) return 0;
  if (!force && localStorage.getItem(SKILLS_SEED_KEY) === '1') return 0;
  const n = await importBuiltinSkills(true);
  if (n > 0) {
    try { localStorage.setItem(SKILLS_SEED_KEY, '1'); } catch { /* ignore */ }
    try { S.skills = await api('/api/skills'); } catch { /* ignore */ }
  }
  return n;
}
function openSkillImport() {
  sheet(`<div class="sheet-head"><b>导入技能</b><button class="sheet-close">✕</button></div><div class="filter-label">技能名</div><input class="field" id="sk-name" placeholder="如 my-skill"><div class="filter-label">说明（可选）</div><input class="field" id="sk-desc"><div class="filter-label">SKILL.md / 技能正文</div><textarea class="field" id="sk-text" rows="10" placeholder="粘贴 SKILL.md 内容"></textarea><button class="btn btn-primary btn-block" style="margin-top:12px" data-act="ai-skill-save">保存技能</button>`);
}


/* ---------- 数据与备份 ---------- */
/* ---------- 数据与备份 ---------- */
function renderDataPage() {
  setTimeout(async () => {
    const host = $('#bk-host');
    if (!host) return;
    const store = window.__LOCAL_STORE__;
    if (!store) {
      host.innerHTML = '<div class="empty-state">这一页只在 App 里能用。<br>网页版的数据存在服务器上。</div>';
      return;
    }
    let mod;
    try { mod = await import('../backup.js'); }
    catch (e) { host.innerHTML = `<div class="empty-state">备份模块没加载起来：${esc(e.message)}</div>`; return; }

    let d;
    try { d = await mod.collectData(store, { includeImages: true, includeKeys: false }); }
    catch (e) { host.innerHTML = `<div class="empty-state">读不到本地数据：${esc(e.message)}</div>`; return; }

    const wrongN = d.records.filter((r) => r.is_correct === 0).length;
    const imgN = mod.countImages(d.customQuestions);
    const autoOn = mod.autoBackupEnabled();
    const lastT = mod.lastAutoBackupTime();
    const canUndo = await mod.hasUndoSnapshot();
    const p2 = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => {
      if (!ms) return '还没有';
      const t = new Date(Number(ms));
      if (isNaN(t.getTime())) return '还没有';
      return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
    };
    const gz = async (bytes) => {
      if (typeof CompressionStream === 'undefined') return null;
      try {
        const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(s).arrayBuffer());
      } catch { return null; }
    };
    const dl = (bytes, name) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    host.innerHTML = `
      <div class="data-hero">
        <div class="data-hero-k">这台手机上的数据</div>
        <div class="data-grid">
          <div class="data-m"><b>${d.records.length}</b><span>做题记录</span></div>
          <div class="data-m"><b>${wrongN}</b><span>错题</span></div>
          <div class="data-m"><b>${d.favorites.length + d.notes.length}</b><span>收藏与笔记</span></div>
        </div>
        <div class="data-hero-f">自定义题库 ${d.customBatches.length} 批 · ${d.customQuestions.length} 题${imgN ? ` · 图片 ${imgN} 张` : ''} · 技能 ${d.skills.length} 套</div>
      </div>

      <div class="btn-row data-main-btns">
        <button class="btn btn-primary" id="bk-export">导出备份</button>
        <button class="btn btn-ghost" id="bk-import">导入备份</button>
      </div>

      <div class="card">
        <div class="opt-row">
          <span class="opt-label">每周自动备份<div class="opt-hint">存在应用私有目录，能救误删；卸载会被清掉</div></span>
          <button class="switch${autoOn ? ' on' : ''}" id="bk-auto"><i></i></button>
        </div>
        <div class="data-last">上次备份：${fmt(lastT)}</div>
        <div class="btn-row">
          <button class="btn btn-ghost" id="bk-now">现在就备份一次</button>
          <button class="btn btn-ghost" id="bk-history">历史备份</button>
        </div>
        ${canUndo ? '<button class="btn btn-ghost btn-block" id="bk-undo" style="margin-top:10px;color:var(--red)">撤销上次导入</button>' : ''}
        <p class="data-note">备份里只有你自己的东西：做题记录、错题、收藏、笔记、自定义题库、AI 配置。题库本体和图片缓存不进去——那些随时能重新下。</p>
      </div>`;

    // ---- 导出 ----
    const exportSheet = () => {
      sheet(`<div class="sheet-head"><b>导出备份</b><button class="sheet-close">✕</button></div>
        <div class="data-chk">
          <label><input type="checkbox" id="bk-opt-records" checked><span>记录 / 错题 / 收藏 / 笔记</span></label>
          <label><input type="checkbox" id="bk-opt-custom" checked><span>自定义题库（含图片）</span></label>
          <label><input type="checkbox" id="bk-opt-skills" checked><span>技能包</span></label>
          <label><input type="checkbox" id="bk-opt-keys"><span>AI Key（明文，导出前想一下）</span></label>
        </div>
        <button class="btn btn-primary btn-block" id="bk-export-go">生成文件</button>
        <p class="data-note">文件里有你的作答和笔记，只发给自己。</p>`);
      const go = $('#bk-export-go');
      if (!go) return;
      go.onclick = async () => {
        const rOn = $('#bk-opt-records').checked;
        const cOn = $('#bk-opt-custom').checked;
        const sOn = $('#bk-opt-skills').checked;
        const kOn = $('#bk-opt-keys').checked;
        if (!rOn && !cOn && !sOn) { toast('至少选一项'); return; }
        go.disabled = true; go.textContent = '正在打包…';
        try {
          const full = await mod.collectData(store, { includeImages: true, includeKeys: false });
          const picked = {
            records: rOn ? full.records : [],
            favorites: rOn ? full.favorites : [],
            notes: rOn ? full.notes : [],
            customBatches: cOn ? full.customBatches : [],
            customQuestions: cOn ? full.customQuestions : [],
            skills: sOn ? full.skills : [],
            agents: full.agents,
            prefs: rOn ? full.prefs : {},
          };
          const payload = await mod.buildPayloadFromData(picked, { includeImages: cOn, includeKeys: kOn });
          let bytes = new TextEncoder().encode(JSON.stringify(payload));
          let name = `kaogong-backup-${mod.stamp()}.json`;
          if (bytes.length > 8 * 1024 * 1024) {
            const z = await gz(bytes);
            if (z) { bytes = z; name += '.gz'; }
          }
          const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
          const Share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
          if (FS) {
            const path = `exports/${name}`;
            await FS.mkdir({ path: 'exports', directory: 'CACHE', recursive: true }).catch(() => {});
            await FS.writeFile({ path, data: mod.bytesToBase64(bytes), directory: 'CACHE' });
            const uriRes = await FS.getUri({ path, directory: 'CACHE' });
            if (Share && uriRes && uriRes.uri) {
              await Share.share({ title: '上岸 · 数据备份', files: [uriRes.uri], dialogTitle: '保存或发送备份文件' });
            }
            toast(`已生成 ${name}（${(bytes.length / 1048576).toFixed(1)} MB）`);
          } else {
            dl(bytes, name);
            toast('开始下载');
          }
          closeSheet();
        } catch (e) {
          toast('导出失败：' + e.message);
          go.disabled = false; go.textContent = '生成文件';
        }
      };
    };

    // ---- 导入预览 ----
    const openPreview = async (payload, filename) => {
      let plan;
      try { plan = await mod.planImport(store, payload.data, 'merge'); }
      catch (e) { toast('读不了这个文件：' + e.message); return; }
      const add = (o) => (o && o.add) || 0;
      const skip = (o) => (o && o.skip) || 0;
      sheet(`<div class="sheet-head"><b>导入预览</b><button class="sheet-close">✕</button></div>
        <div class="data-file">${esc(filename || '备份文件')}<em>${esc(fmt(payload.exportedAt))} · v${esc(payload.appVersion || '—')}</em></div>
        <div class="data-plan">
          <div><span>做题记录</span><b>+${add(plan.records)}</b>${skip(plan.records) ? `<em>已有 ${skip(plan.records)}</em>` : ''}</div>
          <div><span>收藏</span><b>+${add(plan.favorites)}</b>${skip(plan.favorites) ? `<em>已有 ${skip(plan.favorites)}</em>` : ''}</div>
          <div><span>笔记</span><b>+${add(plan.notes)}</b>${(plan.notes && plan.notes.update) ? `<em>更新 ${plan.notes.update}</em>` : ''}</div>
          <div><span>自定义题库</span><b>+${add(plan.batches)} 批 / +${add(plan.questions)} 题</b></div>
          <div><span>技能包</span><b>+${add(plan.skills)}</b></div>
        </div>
        <button class="btn btn-primary btn-block" id="bk-do-merge">合并进来</button>
        <button class="btn btn-ghost btn-block" id="bk-do-replace" style="margin-top:10px;color:var(--red)">清空本地再导入</button>
        <p class="data-note">导入前会自动存一份当前数据的快照，导错了能撤销。</p>`);
      const run = async (btn, mode) => {
        if (mode === 'replace' && !confirm('会先清空本机的记录、收藏、笔记和自定义题库，确定？')) return;
        btn.disabled = true; btn.textContent = '正在导入…';
        try {
          const r = await mod.applyImport(store, payload, mode);
          closeSheet();
          toast(`导入完成：记录 ${r.records} / 收藏 ${r.favorites} / 笔记 ${r.notes} / 自定义题 ${r.customQuestions}`);
          setTimeout(() => location.reload(), 1200);
        } catch (e) {
          toast('导入失败：' + e.message);
          btn.disabled = false; btn.textContent = mode === 'replace' ? '清空本地再导入' : '合并进来';
        }
      };
      const a1 = $('#bk-do-merge'); if (a1) a1.onclick = () => run(a1, 'merge');
      const a2 = $('#bk-do-replace'); if (a2) a2.onclick = () => run(a2, 'replace');
    };

    // ---- 历史备份 ----
    const openHistory = async () => {
      let files = [];
      try { files = await mod.listAutoBackups(); } catch { files = []; }
      if (!files.length) { toast('还没有自动备份'); return; }
      sheet(`<div class="sheet-head"><b>历史备份</b><button class="sheet-close">✕</button></div>
        <div class="data-plan" id="bk-hist">${files.map((n) => `<div data-name="${esc(n)}"><span>${esc(n.replace(/^auto-/, '').replace(/\.json(\.gz)?$/, ''))}</span><b>${n.endsWith('.gz') ? '压缩' : '原始'}</b></div>`).join('')}</div>
        <p class="data-note">点一条就能恢复到那个时间点。</p>`);
      const list = $('#bk-hist');
      if (!list) return;
      list.querySelectorAll('[data-name]').forEach((row) => {
        row.style.cursor = 'pointer';
        row.onclick = async () => {
          try {
            const payload = await mod.readAutoBackup(row.dataset.name);
            closeSheet();
            await openPreview(payload, row.dataset.name);
          } catch (e) { toast('读不出来：' + e.message); }
        };
      });
    };

    const btnExport = $('#bk-export'); if (btnExport) btnExport.onclick = exportSheet;
    const btnImport = $('#bk-import');
    if (btnImport) btnImport.onclick = async () => {
      let file;
      try { file = await mod.pickBackupFile(); } catch { return; }
      if (!file) return;
      try {
        const payload = await mod.readBackupFile(file);
        await openPreview(payload, file.name);
      } catch (e) { toast(e.message); }
    };
    const sw = $('#bk-auto');
    if (sw) sw.onclick = () => {
      const on = !sw.classList.contains('on');
      mod.setAutoBackupEnabled(on);
      sw.classList.toggle('on', on);
      toast(on ? '已开启每周自动备份' : '已关闭自动备份');
    };
    const btnNow = $('#bk-now');
    if (btnNow) btnNow.onclick = async () => {
      btnNow.disabled = true; btnNow.textContent = '正在备份…';
      try {
        const r = await mod.maybeAutoBackup(store, { force: true });
        toast(r ? '备份好了' : '当前环境不支持自动备份');
      } catch (e) { toast('备份失败：' + e.message); }
      btnNow.disabled = false; btnNow.textContent = '现在就备份一次';
    };
    const btnHist = $('#bk-history'); if (btnHist) btnHist.onclick = openHistory;
    const btnUndo = $('#bk-undo');
    if (btnUndo) btnUndo.onclick = async () => {
      if (!confirm('撤销上次导入，恢复到导入前的数据？')) return;
      try {
        await mod.undoLastImport(store);
        toast('已撤销');
        setTimeout(() => location.reload(), 900);
      } catch (e) { toast('撤销失败：' + e.message); }
    };
  }, 0);
  return `<div class="subpage-head"><button class="icon-btn" data-act="me-back">‹</button><div class="subpage-title">数据与备份</div><span style="width:38px"></span></div><div id="bk-host"><div class="spinner"></div></div>`;
}


/* ---------- 时政热点 ---------- */
let _politics = null;
let _politicsSrc = '';

/**
 * 时政走「远端优先、本地兜底」：
 * 远端是仓库里的 release/politics.json，改完 push 就生效，不用发版。
 * 远端全部失败（离线 / 代理挂了）才用打包进来的那份，保证永远打不开空页面。
 */
const POLITICS_URLS = (() => {
  const ts = Date.now();
  const path = 'release/politics.json';
  const raw = `raw.githubusercontent.com/CHAOYUE116/shangan/main/${path}?t=${ts}`;
  return [
    `https://gh-proxy.com/https://${raw}`,
    `https://ghfast.top/https://${raw}`,
    `https://raw.gitmirror.com/CHAOYUE116/shangan/main/${path}?t=${ts}`,
    `https://${raw}`,
    `https://cdn.jsdelivr.net/gh/CHAOYUE116/shangan@main/${path}?t=${ts}`,
  ];
})();

async function loadPolitics(force) {
  if (_politics && !force) return _politics;

  const local = async () => {
    const r = await fetch('./app-assets/politics.json');
    if (!r.ok) throw new Error('时政数据未就绪');
    return r.json();
  };

  for (const u of POLITICS_URLS) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(u, { signal: ac.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!r.ok) continue;
      const d = await r.json();
      if (!d || !Array.isArray(d.items) || !d.items.length) continue;
      _politics = d;
      _politicsSrc = 'online';
      localStorage.setItem('sg_politics_cache', JSON.stringify(d));
      return _politics;
    } catch { /* 换下一个源 */ }
  }

  // 上次联网成功时的缓存（离线也能看）
  try {
    const c = localStorage.getItem('sg_politics_cache');
    if (c) {
      const d = JSON.parse(c);
      if (d && Array.isArray(d.items) && d.items.length) {
        _politics = d;
        _politicsSrc = 'cache';
        return _politics;
      }
    }
  } catch { /* ignore */ }

  _politics = await local();
  _politicsSrc = 'local';
  return _politics;
}

/** 把「时政汇总| xxx」这种前缀去掉，标题只留正文部分 */
function polTitle(t) {
  return String(t || '').replace(/^时政(汇总|热点)\s*[|｜]\s*/, '').trim();
}

/** 摘要里常把「时政热点 1 标题」连在一起，切掉前缀 */
function polSummary(s, title) {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  // summary 字段里塞了「时政汇总| 标题 时政汇总| 标题 1 标题 …」这种重复，卡片摘要于是全是同一行。
  // 先把标记剥掉，再砍掉开头重复的那几遍标题，最后取第一句正文。
  t = t.replace(/时政(汇总|热点)\s*[|｜]?/g, " ").replace(/\s+/g, " ").trim();
  const ttl = String(title || "").trim();
  const escT = (x) => x.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  if (ttl) {
    // 只砍开头连续重复的标题（正文中间引用同一份文件名的要留着）
    const lead = new RegExp("^(?:\\s*" + escT(ttl) + "\\s*(?:\\d{1,2}(?=\\s))?\\s*)+");
    t = t.replace(lead, " ").replace(/\s+/g, " ").trim();
  } else {
    // 拿不到标题时，退一步：同一段《XX》在开头连出现两次以上，砍到最后一次之后
    const mt = t.match(/《[^》]{2,40}》/);
    if (mt && t.split(mt[0]).length > 2) t = t.split(mt[0]).join(" ").replace(/\s+/g, " ").trim();
  }
  // 标题字段与正文标题对不上时（标题是概括句、正文用《简称》），开头仍会连续重复，再兜一次
  const mt2 = t.match(/《[^》]{2,40}》/);
  if (mt2 && t.indexOf(mt2[0]) < 40 && t.split(mt2[0]).length > 2) {
    const last = t.lastIndexOf(mt2[0]);
    t = t.slice(last + mt2[0].length).replace(/^\s*\d{1,2}\s*/, "").replace(/\s+/g, " ").trim();
  }
  const segs = t.split(/(?<=[。！？])/).map((x) => x.replace(/^[\s|｜]+/, "").replace(/^\d{1,2}\s+(?=[《“"（])/, "").trim()).filter((x) => x.length >= 15);
  return (segs[0] || t).slice(0, 90);
}
async function openPolitics() {
  // 时政现在从首页快捷卡进，也可能从「我的」进——别硬把 tab 改成 me，
  // 否则返回时会莫名其妙落到「我的」页
  $('#view').innerHTML = '<div class="spinner"></div>';
  const head = '<div class="subpage-head"><button class="icon-btn" data-act="me-back">‹</button><div class="subpage-title">时政热点</div><button class="icon-btn" data-act="politics-refresh" aria-label="刷新">↻</button></div>';
  try {
    const data = await loadPolitics();
    const allItems = (data.items || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    S.politicsList = allItems;
    const readSet = polReadSet();
    const unreadOf = (x, idx) => !readSet.has(String(x.id != null ? x.id : idx));
    const unreadCount = allItems.filter((x, i) => unreadOf(x, i)).length;
    // 「只看未读」只在真的读过一些之后才有意义，否则等于全量列表
    const onlyUnread = !!S.polUnreadOnly && unreadCount > 0;
    const items = onlyUnread ? allItems.filter((x, i) => unreadOf(x, i)) : allItems;

    // 按月份分组，长列表才扫得动
    const groups = new Map();
    for (const it of items) {
      const d = String(it.date || '');
      const key = d.slice(0, 7) || '其他';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }

    const monthLabel = (k) => {
      if (k === '其他') return '其他';
      const [y, m] = k.split('-');
      return `${y} 年 ${Number(m)} 月`;
    };

    const body = [...groups.entries()].map(([k, list]) => `
      <div class="pol-month">${esc(monthLabel(k))}<span>${list.length} 篇</span></div>
      <div class="pol-list">
      ${list.map((x, i) => {
        const idx = allItems.indexOf(x);
        const t = polTitle(x.title);
        const sum = polSummary(x.summary, t);
        const day = String(x.date || '').slice(8, 10) || '--';
        const pq = (x.practice || []).length;
        const isRead = !unreadOf(x, idx);
        return `<div class="pol-item ${isRead ? 'read' : ''}" data-act="politics-open" data-idx="${idx}">
          <div class="pol-card-r">
            <div class="pol-card-t">${esc(t)}${isRead ? '<span class="pol-read-tag">已读</span>' : ''}</div>
            ${sum ? `<div class="pol-card-s">${esc(sum)}</div>` : ''}
            <div class="pol-item-foot">
              <span class="pol-item-day">${esc(day)} 日 · ${Number(x.chars) || 0} 字</span>
              ${pq ? `<span class="pol-card-q">练一练 ${pq} 题</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
      </div>
    `).join('');

    const srcTag = _politicsSrc === 'online' ? '已是最新' : _politicsSrc === 'cache' ? '离线缓存' : '本地版本';
    const filterRow = `<div class="chips nowrap" style="margin:0 0 10px"><button class="chip ${onlyUnread ? '' : 'active'}" data-act="pol-filter" data-v="all">全部 ${allItems.length}</button>${unreadCount ? `<button class="chip ${onlyUnread ? 'active' : ''}" data-act="pol-filter" data-v="unread">未读 ${unreadCount}</button>` : ''}</div>`;
    $('#view').innerHTML = `${head}
      <div class="pol-top-note"><span>${items.length} 篇 · ${unreadCount ? `未读 ${unreadCount} 篇` : '都读过了'} · ${esc(srcTag)}</span><span>更新于 ${esc(String(data.updatedAt || '').slice(0, 10))}</span></div>
      ${filterRow}
      ${body || '<div class="empty-state">暂无时政数据</div>'}`;
  } catch (e) {
    $('#view').innerHTML = `${head}<div class="empty-state">${esc(e.message)}</div>`;
  }
}

/* ---------- 时政已读 ---------- */
const POL_READ_KEY = 'sg_pol_read_v1';
function polReadSet() {
  try {
    const a = JSON.parse(localStorage.getItem(POL_READ_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.map(String) : []);
  } catch { return new Set(); }
}
function polMarkRead(id) {
  if (id == null) return;
  try {
    const s = polReadSet();
    s.add(String(id));
    localStorage.setItem(POL_READ_KEY, JSON.stringify([...s].slice(-300)));
  } catch { /* ignore */ }
}

/** 时政文章末尾的「模拟演练」做成可点的题卡（2026-11 起采集脚本会把题目解析进 practice[]） */
function renderPolPractice(it, idx) {
  const qs = (it && it.practice) || [];
  if (!qs.length) return '';
  const saved = (S.polQuiz && S.polQuiz[it.id]) || {};
  const cards = qs.map((q, qi) => {
    const picked = saved[q.no != null ? q.no : qi];
    const ans = String(q.answer || '').trim();
    const opts = (q.options || []).map((t, oi) => {
      const key = String.fromCharCode(65 + oi);
      const cls = picked
        ? (key === ans ? ' pol-opt right' : (key === picked ? ' pol-opt wrong' : ' pol-opt locked'))
        : ' pol-opt';
      return `<button class="${cls.trim()}" data-act="pol-opt" data-idx="${idx}" data-o="${key}" data-q="${q.no != null ? q.no : qi}"${picked ? ' disabled' : ''}><i>${key}</i><span>${esc(t)}</span></button>`;
    }).join('');
    const fb = picked
      ? (String(picked) === ans ? '✓ 答对了' : '✗ 正确答案 ' + (ans || '—'))
      : '';
    return `<div class="pol-q" data-ans="${esc(ans)}">
      <div class="pol-q-stem"><b>${qi + 1}.</b> ${esc(q.stem || '')}</div>
      <div class="pol-opts">${opts}</div>
      <div class="pol-fb">${fb}</div>
    </div>`;
  }).join('');
  return `<div class="pol-practice">
    <div class="pol-practice-head">练一练<span>${qs.length} 题 · 点选项看答案</span></div>
    ${cards}
  </div>`;
}

function openPoliticsDetail(idx) {
  const it = (S.politicsList || [])[idx];
  if (!it) return;
  const raw = String(it.text || '')
    .replace(/^时政热点\s*\n?/, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // 正文是「1 / 标题 / 正文… / 2 / 标题 / 正文…」这种结构：编号单独成行、标题紧跟一行。
  // 按编号切成一个个主题，每个主题带序号，主题之间用分割线隔开。
  const para = (s) => (/^[一二三四五六七八九十]+是/.test(s)
    ? `<p class="pol-p"><b>${esc(s.slice(0, 3))}</b>${esc(s.slice(3))}</p>`
    : `<p class="pol-p">${esc(s)}</p>`);
  const secs = [];
  let cur = null;
  const loose = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const isNo = /^\d{1,2}$/.test(s);
    const isHead = isNo && raw[i + 1] && raw[i + 1].length <= 40 && !/^\d{1,2}$/.test(raw[i + 1]);
    if (isHead) {
      if (cur) secs.push(cur);
      cur = { no: s, title: raw[i + 1], body: [] };
      i++;
      continue;
    }
    if (cur) cur.body.push(s);
    else loose.push(s);
  }
  if (cur) secs.push(cur);

  const intro = loose.length ? `<div class="pol-sec-lead">${loose.map(para).join('')}</div>` : '';
  const body = secs.length
    ? intro + `<div class="pol-secs">${secs.map((x) => `<section class="pol-sec">
        <div class="pol-sec-h"><span class="pol-sec-no">${esc(x.no)}</span><h3 class="pol-h3">${esc(x.title)}</h3></div>
        ${x.body.map(para).join('')}
      </section>`).join('')}</div>`
    : intro || '<p class="pol-p">暂无正文</p>';

  sheet(`<div class="sheet-head"><b>${esc(polTitle(it.title))}</b><button class="sheet-close">✕</button></div>
    <div class="pol-detail-meta"><span>${esc(it.date || '')}</span><span>${secs.length ? secs.length + ' 个主题 · ' : ''}${Number(it.chars) || 0} 字</span></div>
    <div class="pol-body">${body}${renderPolPractice(it, idx)}</div>
    <button class="btn btn-ghost btn-block" style="margin-top:14px" data-act="close-sheet">关闭</button>`);
}

/* ---------- 外部链接 ---------- */
const EXTERNAL_LINKS = {
  feishu: 'https://my.feishu.cn/wiki/R0oTwIX7Ti014gkTTLtcIH60nwb',
};

/** 用系统浏览器打开外部链接（WebView 里 window.open 不可靠，优先走 Capacitor Browser） */
function openExternal(url) {
  if (!url) return;
  try {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (B && typeof B.open === 'function') { B.open({ url }); return; }
  } catch { /* 回退 */ }
  try {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  } catch {
    location.href = url;
  }
}

/**
 * 在 App 内打开外部页面（原生 WebView，带登录态）。
 * 飞书知识库是私有的，未登录会 302 到 accounts.feishu.cn；iframe 因登录页 + 第三方 cookie 限制打不开，
 * 所以走原生 WebViewActivity：登录一次之后 cookie 留着，下次直接进页面。
 * 返回 false 表示当前环境没有原生桥（比如浏览器调试），调用方回退到 openExternal。
 */
function openInApp(url, title) {
  if (!url) return false;
  try {
    const N = window.NativeWebView;
    if (N && typeof N.open === 'function') { N.open(url, title || ''); return true; }
  } catch { /* 回退 */ }
  return false;
}

/* ---------- 题库在线更新 ---------- */
// 换成你自己的仓库地址；GitHub 直连不稳时用镜像
//
// 为什么有 7 个源：raw.githubusercontent 在国内时通时不通，gh-proxy 这类公共反代
// 偶尔 502/限速。原生层会并发跑「第一波」（反代 + raw 镜像 + 直连，12 秒封顶），
// 全挂了才跑「第二波」CDN —— 因为 jsDelivr 的 @main 有 12 小时缓存，
// 让它跟直连一起赛跑，它反而最快，拿到的却是半天前的清单（会误判"已是最新"）。
// 每个地址都带时间戳，避免任何一层拿到旧 manifest。
const MANIFEST_PATH = 'release/manifest.json';
function manifestUrls(fresh) {
  const ts = fresh || Date.now();
  const raw = `raw.githubusercontent.com/CHAOYUE116/shangan/main/${MANIFEST_PATH}?t=${ts}`;
  return [
    `https://gh-proxy.com/https://${raw}`,
    `https://ghfast.top/https://${raw}`,
    `https://ghproxy.net/https://${raw}`,
    `https://raw.gitmirror.com/CHAOYUE116/shangan/main/${MANIFEST_PATH}?t=${ts}`,
    `https://${raw}`,
    `https://cdn.jsdelivr.net/gh/CHAOYUE116/shangan@main/${MANIFEST_PATH}?t=${ts}`,
    `https://fastly.jsdelivr.net/gh/CHAOYUE116/shangan@main/${MANIFEST_PATH}?t=${ts}`,
  ];
}
const UPDATE_MANIFEST_URLS = manifestUrls();

/**
 * 更新进度块。
 * 进度还是 0 的时候不画「0% 的空条」（看起来像没有进度条），改画一条流动条；
 * 一直不动超过 20 秒，补一行「网络慢，正在换源重试」。
 */
function updProgress(opts) {
  const o = opts || {};
  const p = Math.max(0, Math.min(100, Number(o.pct) || 0));
  const mb = (n) => (Number(n) > 0 ? (Number(n) / 1048576).toFixed(1) + ' MB' : '');
  const size = Number(o.total) > 0 ? `${mb(o.got) || '0.0 MB'} / ${mb(o.total)}` : (mb(o.total) || '');
  const bar = p > 0
    ? `<div class="upd-prog-bar"><i style="width:${Math.max(3, p)}%"></i></div>`
    : '<div class="upd-prog-bar indet"><i></i></div>';
  const label = esc(o.label == null ? '正在下载' : String(o.label));
  const left = label + (p > 0 ? ' ' + p + '%' : '');
  return `<div class="upd-prog">${bar}
    ${(left || size) ? `<div class="upd-prog-meta"><span>${left}</span><span>${esc(size)}</span></div>` : ''}
    ${o.tip ? `<div class="upd-prog-tip">${esc(o.tip)}</div>` : ''}</div>`;
}

function checkUpdate(mode) {
  if (!window.AppUpdate) { toast('在线更新只在 App 内可用'); return; }
  // 题库和 App 是两条独立的更新链：各查各的，各说各的。
  // 之前 App 弹层第一行显示的是题库的 message（「已是最新题库 0.5.x」），
  // 用户扫一眼就以为没检测到新版 App —— 现在彻底分开。
  const onlyApp = mode === 'app';
  const mb = (n) => { const v = Number(n) || 0; return v > 0 ? (v / 1048576).toFixed(1) + ' MB' : '大小未知'; };
  sheet(`<div class="sheet-head"><b>${onlyApp ? 'App 更新' : '题库更新'}</b><button class="sheet-close">✕</button></div>
    <div id="upd-body" style="padding:4px 0 16px"><div class="card-sub">${onlyApp ? '正在检查 App 新版本…' : '正在检查题库更新…'}</div>
    ${updProgress({ pct: 0, label: '' })}</div>`);
  // 后台已经在下载时不要再 reset：reset 会把进度清零，弹层看起来「没在下载」，
  // 而通知栏那条进度还在正常走 —— 用户会以为进度条丢了
  let pre = {};
  try { pre = JSON.parse(AppUpdate.status()); } catch { /* ignore */ }
  if (!(pre.running && (pre.state === 'downloading' || pre.state === 'checking'))) {
    AppUpdate.reset();
    AppUpdate.start(JSON.stringify(manifestUrls()));
  }

  const t0 = Date.now();
  let reloading = false;
  let autoRetried = false;
  let lastState = '';
  // 进度停滞检测：百分比 20 秒没变过，就提示「网络慢」，免得用户盯着一条不动的条
  let seenPct = -1;
  let seenAppPct = -1;
  let movedAt = Date.now();
  let appMovedAt = Date.now();
  clearInterval(checkUpdate._t);
  checkUpdate._t = setInterval(() => {
    let s;
    try { s = JSON.parse(AppUpdate.status()); } catch { return; }
    const box = $('#upd-body');
    if (!box) { clearInterval(checkUpdate._t); return; }
    const pct = Number(s.progress) || 0;
    const appPctNow = Number(s.newAppProgress) || 0;
    const now = Date.now();
    if (pct !== seenPct) { seenPct = pct; movedAt = now; }
    if (appPctNow !== seenAppPct) { seenAppPct = appPctNow; appMovedAt = now; }
    const dlingStalled = s.state === 'downloading' && now - movedAt > 20000;
    const appStalled = s.newAppState === 'downloading' && now - appMovedAt > 20000;
    const canApply = s.state === 'done' && s.hasPending;
    const finished = s.state === 'done' && !s.hasPending;
    const stuck = s.state === 'checking' && Date.now() - t0 > 45000;
    const curVer = s.currentVersionName || APP_VERSION;
    // 从 checking 掉进 error：多半是某次 DNS/反代抽风，自动再试一次（换新时间戳）
    if (s.state === 'error' && lastState === 'checking' && !autoRetried && !s.hasPending) {
      autoRetried = true;
      setTimeout(() => { try { AppUpdate.start(JSON.stringify(manifestUrls())); } catch { /* ignore */ } }, 1200);
    }
    lastState = s.state;

    let body;

    if (onlyApp) {
      const appPct = Number(s.newAppProgress) || 0;
      const dl = Number(s.newAppDownloaded) || 0;
      const tt = Number(s.newAppTotal) || Number(s.newAppSize) || 0;
      const appErr = s.newAppState === 'error';
      const dling = s.newAppState === 'downloading';
      const done = s.newAppState === 'done';

      let head, sub;
      if (stuck) {
        head = '没查到更新源';
        sub = '网络不通或更新源被挡，点下面重新检查';
      } else if (s.newAppAvailable) {
        head = `v${esc(curVer)} → <b style="color:var(--primary,#3D6FE0)">v${esc(s.newAppVersion)}</b>`;
        sub = `新版本 ${mb(s.newAppSize)}`;
      } else if (s.state === 'error') {
        head = '检查失败';
        sub = esc(s.message || '更新源不可达');
      } else if (s.state === 'checking') {
        head = '正在检查…';
        sub = `当前 v${esc(curVer)}，读更新清单中`;
      } else {
        head = `已是最新版 v${esc(curVer)}`;
        sub = '更新清单里没有更高的版本号';
      }

      body = `
        <div style="font-size:20px;font-weight:600;line-height:1.35;margin:2px 0 6px">${head}</div>
        <div class="card-sub" style="margin:0 0 12px">${sub}</div>
        ${(dling || appStalled) ? updProgress({
          pct: appPct, got: dl, total: tt, label: appPct > 0 ? '正在下载' : '',
          tip: appStalled ? '网络慢，正在换源重试…（可以留在这一页，也可以退出去让它后台下）' : '',
        }) : ''}
        ${done ? '<div class="card-sub" style="margin:0 0 10px;color:var(--green,#1a7f37)">下载完成。点下面按钮安装（安装时 App 会关闭）</div>' : ''}
        ${s.newAppState === 'needPermission' ? '<div class="card-sub" style="margin:0 0 10px;color:var(--orange,#b26a00)">要先允许「安装未知应用」。已帮你打开系统设置，打开开关后回来点安装。</div>' : ''}
        ${appErr && s.newAppAvailable ? `<div class="card-sub" style="margin:0 0 10px;color:var(--red,#c62828)">${esc(s.message || '下载失败')}</div>` : ''}
        ${(done || s.newAppState === 'needPermission') && s.newAppAvailable
          ? `<button class="btn btn-primary btn-block" id="upd-install">立即安装</button>
             <button class="btn btn-ghost btn-block" style="margin-top:10px" id="upd-app">重新下载</button>`
          : (s.newAppAvailable ? `<button class="btn btn-primary btn-block" id="upd-app"${dling ? ' disabled' : ''}>${dling ? `下载中 ${appPct}%` : (appErr ? '重试下载' : '下载并安装')}</button>` : '')}
        ${(stuck || s.state === 'error') ? '<button class="btn btn-ghost btn-block" style="margin-top:12px" id="upd-retry">重新检查</button>' : ''}`;
    } else {
      const ver = `${esc(s.localVersion || '无记录')}${s.remoteVersion && s.remoteVersion !== s.localVersion ? ' → ' + esc(s.remoteVersion) : ''}`;
      // 用缓存时原生已经把说明拼进 message 了，这里去掉，避免和下面的诊断行重复
      let line = esc(String(s.message || '处理中…').replace(/（网络不稳，用的是本机 \d+ 分钟前的清单）$/, ''));
      // 下载中原生那条 message 自己带着百分比和大小，和下面进度条重复，换成一句人话
      if (s.state === 'downloading') line = '题库有更新，正在下载增量包';
      if (stuck) line = '检查超时 —— 换个网络或点下面重试';
      body = `
        <div class="card-sub">${line}</div>
        ${(s.state === 'checking' || s.state === 'downloading' || canApply) ? updProgress({
          pct, got: s.downloaded, total: s.total,
          label: pct > 0 ? (s.state === 'done' ? '已下载' : '正在下载') : '',
          tip: dlingStalled ? '网络慢，还在下，可以留着这一页等它；超过 3 分钟没动静再点重试' : '',
        }) : ''}
        <div class="card-sub" style="margin-top:8px">题库版本：${ver}</div>
        ${canApply ? '<button class="btn btn-primary btn-block" style="margin-top:14px" id="upd-apply">立即更新（' + esc(s.remoteVersion) + '）</button>' : ''}
        ${s.state === 'error' || stuck ? '<button class="btn btn-ghost btn-block" style="margin-top:12px" id="upd-retry">重试</button>' : ''}`;
    }

    // 诊断行：告诉用户这次清单是从哪个源拿的；如果用了本机缓存，说明网络没通
    const srcNote = s.cachedManifest
      ? `网络没连上更新源，用的是本机缓存清单（${Number(s.cacheAgeMin) || 0} 分钟前）`
      : (s.manifestSource
        ? `清单来源：${esc(s.manifestSource)}${String(s.manifestSource).includes('jsDelivr') ? '（CDN 有缓存，版本号可能滞后几小时）' : ''}`
        : '');
    if (srcNote && !finished) {
      body += `<div class="card-sub" style="margin-top:10px;font-size:12px;opacity:.72">${srcNote}</div>`;
    }

    box.innerHTML = body;

    const ai = $('#upd-install');
    if (ai) ai.onclick = () => {
      try {
        const r = AppUpdate.installApp();
        if (r === 'ok') { toast('已打开安装器'); closeSheet(); }
        else if (r === 'needPermission') toast('请在系统设置里允许「安装未知应用」');
        else toast(String(r || '安装失败'));
      } catch (e) { toast('安装失败：' + e.message); }
    };
    const ab = $('#upd-app');
    if (ab) ab.onclick = () => {
      if (s.newAppState === 'downloading') return;
      try { AppUpdate.downloadApp(); toast('正在下载新版 App…'); } catch (e) { toast('下载失败：' + e.message); }
    };
    const ap = $('#upd-apply');
    if (ap) ap.onclick = () => {
      const r = AppUpdate.applyPending();
      if (r === 'ok' || (typeof r === 'string' && r.startsWith('ok'))) {
        box.innerHTML = '<div class="card-sub">题库已更新，正在重新加载…</div>';
      } else { toast(r); }
    };
    const rt = $('#upd-retry');
    if (rt) rt.onclick = () => { closeSheet(); checkUpdate(mode); };

    // 题库更新落地后自动重载一次（App 更新走系统安装器，不重载）
    if (finished && !onlyApp && !reloading) {
      reloading = true;
      clearInterval(checkUpdate._t);
      setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 1200);
    }
    if (['error', 'uptodate'].includes(s.state)
        && !['downloading'].includes(s.newAppState)) clearInterval(checkUpdate._t);
    // 下载完成后轮询没意义了，App 更新这一支可以停（题库那支还要继续）
    if (onlyApp && ['done', 'needPermission', 'error'].includes(s.newAppState)) clearInterval(checkUpdate._t);
  }, 600);
}

/* ---------- 学习统计 ---------- */
// 接口只回有记录的天；图表要固定 7 列，缺的补 0，否则「近 7 天」里只剩两列，看不出趋势
function fillLast7(got) {
  const map = new Map((got || []).filter((x) => x && x.d).map((x) => [String(x.d), x]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(map.get(k) || { d: k, c: 0, ok: 0 });
  }
  return out;
}
function renderStatsPage() {
  const st = S.stats || {};
  const by = (st.byChapter || []).slice().sort((a, b) => (a.c ? a.ok / a.c : 0) - (b.c ? b.ok / b.c : 0));
  const filled = fillLast7(st.last7);
  const pct = (x) => (x.c ? Math.round((x.ok / x.c) * 100) : 0);
  return `<div class="subpage-head"><button class="icon-btn" data-act="me-back">‹</button><div class="subpage-title">学习统计</div><span style="width:38px"></span></div>
  <div class="stats-row"><div class="stat"><b>${st.total || 0}</b><span>累计做题</span></div><div class="stat"><b>${st.rate || 0}%</b><span>正确率</span></div><div class="stat"><b>${st.wrong || 0}</b><span>答错次数</span></div></div>
  <div class="section-head"><h2 class="section-title">章节正确率</h2></div>
  <div class="card">${by.length ? by.map((x) => `<div class="plan-stage"><div class="subject-main"><div class="subject-title">${esc(x.chapter)}${x.c < 5 ? ' <span class="tag">样本少</span>' : ''}</div><div class="subject-sub">做 ${x.c} 题 · 对 ${x.ok} 题</div><div class="kp-bar"><i style="width:${pct(x)}%;background:${pct(x) >= 60 ? 'var(--green)' : pct(x) >= 45 ? 'var(--amber)' : 'var(--red)'}"></i></div></div><div class="weak-pct">${pct(x)}%</div></div>`).join('') : '<div class="empty-state">还没有做题记录</div>'}</div>
  <div class="section-head"><h2 class="section-title">近 7 天</h2></div>
  <div class="card">${filled.map((x) => `<div class="plan-stage"><div class="subject-main"><div class="subject-title">${esc(x.d)}</div><div class="subject-sub">做题 ${x.c} · 答对 ${x.ok}</div>${x.c ? `<div class="kp-bar"><i style="width:${pct(x)}%"></i></div>` : ''}</div><div class="weak-pct">${x.c ? pct(x) + '%' : '—'}</div></div>`).join('')}</div>`;
}

function renderWeeklyReport() {
  const st = S.stats || {};
  const last = fillLast7(st.last7 || []);
  const total = last.reduce((s, x) => s + (Number(x.c) || 0), 0);
  const right = last.reduce((s, x) => s + (Number(x.ok) || 0), 0);
  const active = last.filter((x) => Number(x.c) > 0).length;
  const rate = total ? Math.round((right / total) * 100) : 0;
  const max = Math.max(1, ...last.map((x) => Number(x.c) || 0));
  const weak = (st.byChapter || []).filter((x) => x.c >= 3).sort((a, b) => (a.ok / a.c) - (b.ok / b.c)).slice(0, 3);
  const d0 = last.length ? String(last[0].d) : '';
  const d1 = last.length ? String(last[last.length - 1].d) : '';
  const range = !last.length ? '近 7 天' : (d0 === d1 ? d0 : `${d0} ~ ${d1}`);
  const advice = !total
    ? '本周还没有做题记录，先完成今日任务，报告会自动生成。'
    : rate < 50
      ? `正确率 ${rate}%，建议先补 ${weak[0]?.chapter || '基础模块'}，每天先复习再刷新题。`
      : active < 3
        ? `本周只活跃 ${active} 天，建议把每日目标拆小，先保持连续。`
        : `节奏不错：本周 ${active} 天有练习，正确率 ${rate}%，继续保持错题复盘。`;
  return `<div class="subpage-head"><button class="icon-btn" data-act="me-back">‹</button><div class="subpage-title">学习报告</div><span style="width:38px"></span></div>
  <div class="card-sub" style="margin:-6px 0 14px">${range} · 最近 7 天</div>
  <div class="stats-row"><div class="stat"><b>${total}</b><span>本周做题</span></div><div class="stat"><b>${rate}%</b><span>正确率</span></div><div class="stat"><b>${active}</b><span>活跃天数</span></div></div>
  <div class="card" style="margin-top:14px"><div class="subject-title">每日做题量</div>
    <div class="rep-bars">${last.length ? last.map((x) => `<div class="rep-col"><div class="rep-v">${Number(x.c) || 0}</div><div class="rep-bar" style="height:${Math.max(6, Math.round((Number(x.c) || 0) / max * 82))}px"></div><div class="rep-d">${esc(String(x.d).slice(5))}</div></div>`).join('') : '<div class="empty-state">暂无记录</div>'}</div>
  </div>
  <div class="section-head"><h2 class="section-title">薄弱模块</h2></div>
  <div class="card">${weak.length ? weak.map((x) => `<div class="plan-stage"><div class="subject-main"><div class="subject-title">${esc(x.chapter)}</div><div class="subject-sub">做 ${x.c} 题 · 对 ${x.ok} 题</div></div><div class="weak-pct">${Math.round((x.ok / x.c) * 100)}%</div><button class="btn btn-ghost btn-sm" data-act="weak" data-name="${esc(x.chapter)}">专项</button></div>`).join('') : '<div class="empty-state">做完几道题后，这里会显示薄弱模块</div>'}</div>
  <div class="card" style="margin-top:14px"><div class="subject-title">本周建议</div><div class="ai-out" style="margin-top:8px">${esc(advice)}</div></div>
  <button class="btn btn-primary btn-block" style="margin-top:14px" data-act="daily-task">去完成今日任务</button>`;
}

/* ---------- 我的 ---------- */
function renderMe() {
  if (S.meView === 'ai') return renderAiSettings();
  if (S.meView === 'backup') return renderDataPage();
  if (S.meView === 'stats') return renderStatsPage();
  if (S.meView === 'report') return renderWeeklyReport();
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const st = S.stats || {};
  return `
  <div class="topline"><span class="eyebrow">我的</span></div>
  <h1 class="page-title">把这里，调成喜欢的样子</h1>
  <section class="banner small">
    ${artStudy()}
    <div class="banner-copy">
      <div class="banner-kicker">MY STUDY</div>
      <div class="banner-title small">你的备考空间</div>
      <div class="banner-sub">${esc(S.profile.examName)} · 还剩 ${daysLeft()} 天</div>
    </div>
  </section>
  <section class="card profile-card">
    <div class="profile">
      <div class="avatar">${iconFor('')}</div>
      <div class="subject-main"><div class="subject-title">${esc(S.profile.examName)}</div><div class="subject-sub">${esc(S.profile.examType)} · ${esc(S.profile.province)} · 每日 ${S.profile.dailyGoal} 题</div></div>
      <button class="btn btn-ghost btn-sm" data-act="profile">编辑</button>
    </div>
    <div class="me-goal"><div><b>${daysLeft()}</b><span>天后考试</span></div><div><b>${st.total || 0}</b><span>累计做题</span></div><div><b>${st.rate || 0}%</b><span>正确率</span></div><div><b>${st.wrong || 0}</b><span>错题</span></div></div>
  </section>
  <div class="section-head"><h2 class="section-title">学习数据</h2></div>
  <div class="card menu-card">
    <div class="menu-row" data-act="stats"><div class="menu-ico" style="background:var(--primary-soft);color:var(--primary)">${iconSvg('chart')}</div><div class="subject-main"><div class="subject-title">学习统计</div><div class="subject-sub">章节正确率 · 近 7 天趋势</div></div><span class="chev">›</span></div>
    <div class="menu-row" data-act="report"><div class="menu-ico" style="background:var(--amber-soft);color:#9a6700">${iconSvg('lightbulb')}</div><div class="subject-main"><div class="subject-title">学习报告</div><div class="subject-sub">本周做题 · 正确率 · 下周建议</div></div><span class="chev">›</span></div>
    <div class="menu-row" data-act="ai"><div class="menu-ico" style="background:var(--amber-soft);color:#9a6700">${iconSvg('bot')}</div><div class="subject-main"><div class="subject-title">AI 设置</div><div class="subject-sub">解析 · 批改 · 模型与 Key</div></div><span class="chev">›</span></div>
  </div>
  <div class="section-head"><h2 class="section-title">阅读与练习</h2></div>
  <div class="card">
    <div class="filter-label" style="margin-top:0">外观</div>
    <div class="theme-row">${(() => {
      const auto = (() => { try { return !localStorage.getItem('theme'); } catch { return true; } })();
      const cur = auto ? 'auto' : theme;
      return [['light', '日间白'], ['dark', '夜间墨'], ['auto', '跟随系统']].map(([k, t]) => `<button class="chip ${cur === k ? 'active' : ''}" data-theme-set="${k}">${t}</button>`).join('');
    })()}</div>
    <div class="filter-label">正文字号</div>
    <div class="theme-row">${[['s', '小'], ['m', '中'], ['l', '大']].map(([k, t]) => `<button class="chip ${(k === 'm' ? (S.settings.fs !== 's' && S.settings.fs !== 'l') : S.settings.fs === k) ? 'active' : ''}" data-fs="${k}">${t}</button>`).join('')}</div>
    <div class="opt-row"><span class="opt-label">点选项立即判对错<div class="opt-hint">关掉后要先点「确认答案」</div></span><button class="switch ${S.settings.instant ? 'on' : ''}" data-instant><i></i></button></div>
    <div class="opt-row"><span class="opt-label">答对自动下一题<div class="opt-hint">停 1.2 秒再翻页；答错会停在解析上</div></span><button class="switch ${S.settings.autoNext ? 'on' : ''}" data-auto-next><i></i></button></div>
    <div class="opt-row"><span class="opt-label">背题模式<div class="opt-hint">不答题，直接看题和解析；考前扫一遍用</div></span><button class="switch ${S.settings.recite ? 'on' : ''}" data-recite><i></i></button></div>
  </div>
  <div class="section-head"><h2 class="section-title">数据与维护</h2></div>
  <div class="card menu-card">
    <div class="menu-row" data-act="backup"><div class="menu-ico" style="background:var(--green-soft);color:var(--green)">${iconSvg('database')}</div><div class="subject-main"><div class="subject-title">数据与备份</div><div class="subject-sub">导出到文件 · 换机迁移 · 每周自动存档</div></div><span class="chev">›</span></div>
    ${window.AppUpdate ? `<div class="menu-row" data-act="update"><div class="menu-ico" style="background:var(--primary-soft);color:var(--primary)">${iconSvg('save')}</div><div class="subject-main"><div class="subject-title">检查题库更新</div><div class="subject-sub">只更新题库数据，不动 App</div></div><span class="chev">›</span></div>` : ''}
    ${window.AppUpdate ? `<div class="menu-row" data-act="app-update"><div class="menu-ico" style="background:var(--amber-soft);color:#9a6700">${iconSvg('save')}</div><div class="subject-main"><div class="subject-title">检查 App 新版本</div><div class="subject-sub">当前 v${APP_VERSION}${window.__NEW_APP_VER ? ` · 有新版本 ${esc(window.__NEW_APP_VER)}` : ''}</div></div><span class="chev">›</span></div>` : ''}
    <div class="menu-row" data-act="about"><div class="menu-ico">${iconSvg('info')}</div><div class="subject-main"><div class="subject-title">关于上岸</div><div class="subject-sub">v${APP_VERSION} · 题库数据仅个人学习使用</div></div><span class="chev">›</span></div>
    ${window.__LAB__ ? `<div class="menu-row" data-act="lab-open"><div class="menu-ico" style="background:rgba(224,163,46,.14);color:#B87B14">${iconSvg('lightbulb')}</div><div class="subject-main"><div class="subject-title">实验室 · 自学习引擎</div><div class="subject-sub">测试版专用 · 用自己的记录回测能力模型</div></div><span class="chev">›</span></div>` : ''}
  </div>`;
}

/* ---------- 路由 ---------- */
function go(tab) {
  // 切页时先收掉弹层：弹层是全局的，页面换了它还挂着会盖住新页面
  try { if (document.querySelector('.sheet-wrap:not([hidden])')) closeSheet(); } catch { /* ignore */ }
  S.tab = tab;
  const renders = { home: renderHome, library: renderLibrary, review: renderReview, exam: renderExam, me: renderMe };
  $('#view').innerHTML = renders[tab]();
  $$('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
}

/* ---------- 练习 ---------- */
async function startPracticeByUrl(url, title, subject, kind = '', kp = '') {
  $('#practice').hidden = false;
  $('#p-body').innerHTML = '<div class="spinner"></div>';
  try {
    // 随机类练习去重：库里 9 万题，纯随机出题会把你做过的题再端上来。
    // 服务端单次最多给 15 道，所以过滤后不足就再要一轮，最多补 3 轮。
    const dedupe = !['review', 'paper', 'smart'].includes(kind);
    const want = dedupe ? Number((/[?&]n=(\d+)/.exec(url) || [])[1] || 0) : 0;
    let qs = await api(url);
    if (dedupe && want > 0) {
      const done = await doneIdSet();
      if (done.size) {
        const seen = new Set();
        const pool = [];
        const take = (arr) => {
          for (const q of Array.isArray(arr) ? arr : []) {
            const k = String(q.questionId != null ? q.questionId : q.id);
            if (done.has(k) || seen.has(k)) continue;
            seen.add(k); pool.push(q);
          }
        };
        take(qs);
        for (let round = 0; round < 3 && pool.length < want; round++) {
          try { take(await api(url)); } catch { break; }
        }
        if (pool.length) qs = pool.slice(0, want);
      } else if (Array.isArray(qs) && qs.length > want) {
        qs = qs.slice(0, want);
      }
    }
    if (!Array.isArray(qs) || !qs.length) { toast('暂无题目'); $('#practice').hidden = true; return; }
    startPractice(qs, title, subject, kind, null, kp);
  } catch (e) { toast(e.message); $('#practice').hidden = true; }
}

/** 做过的题号集合（IndexedDB records），缓存 60 秒，避免每次进去都全表扫一遍 */
let _doneCache = { at: 0, set: new Set() };
async function doneIdSet() {
  if (Date.now() - _doneCache.at < 60000) return _doneCache.set;
  const set = new Set();
  try {
    const store = window.__LOCAL_STORE__;
    if (store) {
      const rows = await store.getAll('records');
      for (const r of rows || []) {
        const id = r.questionId != null ? r.questionId : r.question_id;
        if (id != null) set.add(String(id));
      }
    }
  } catch { /* 拿不到就当没有记录，别拦着做题 */ }
  _doneCache = { at: Date.now(), set };
  return set;
}
function startPractice(qs, title, subject, kind = '', restore = null, kp = '') {
  // /api/practice 回来的是 id，POST /api/records 要的是 questionId —— 在这一层统一好，
  // 免得每条调用链各自记得该用哪个字段（两侧都传，兼容老数据）
  qs = (qs || []).map((q) => (q && q.questionId == null && q.id != null) ? Object.assign({}, q, { questionId: q.id }) : q);
  const P = S.practice;
  P.open = true; P.qs = qs; P.idx = 0; P.selected = null; P.confirmed = false; P.answers = {}; P.results = []; P.feedback = null; P.elapsed = 0; P.ai = ''; P.aiLoading = false; P.aiChat = []; P.aiError = ''; P.aiCached = false; P.title = title || '练习'; P.subject = subject || ''; P.kind = kind; P.kp = kp || ''; P.lastWrongIds = []; P.exam = false; P.remaining = 0; P.limitSec = 0; P.qCost = {}; P.flagged = {}; P.paperId = 0; P.qStart = Date.now();
  if (restore) {
    P.idx = Math.min(Math.max(0, Number(restore.idx) || 0), qs.length - 1);
    P.answers = restore.answers || {};
    P.elapsed = Number(restore.elapsed) || 0;
    P.exam = !!restore.exam;
    P.remaining = Number(restore.remaining) || 0;
    P.limitSec = Number(restore.limitSec) || 0;
    P.flagged = restore.flagged || {};
    P.paperId = Number(restore.paperId) || 0;
    loadAnswerState();
  }
  clearInterval(P.timer);
  P.timer = setInterval(() => {
    if (!P.open) return;
    if (P.exam) {
      P.remaining = Math.max(0, P.remaining - 1);
      const t = $('#p-timer');
      if (t) { t.textContent = fmtTime(P.remaining); t.style.color = P.remaining <= 60 ? 'var(--red)' : ''; }
      if (P.remaining <= 0) submitExam();
    } else {
      P.elapsed++;
      const t = $('#p-timer');
      if (t) t.textContent = fmtTime(P.elapsed);
    }
  }, 1000);
  try { localStorage.setItem('sg_last', JSON.stringify({ subject, title: P.title, ts: Date.now() })); } catch { /* ignore */ }
  $('#practice').hidden = false;
  renderPractice();
  saveSession();
}
function currentQ() { return S.practice.qs[S.practice.idx]; }

function aiRichText(text) {
  const lines = esc(String(text || '')).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (inList) { html += '</div>'; inList = false; }
      continue;
    }
    const m = line.match(/^\s*(?:[-•*]|\d+[.、)])\s+(.*)$/);
    if (m) {
      if (!inList) { html += '<div class="ai-list">'; inList = true; }
      html += `<div class="ai-li">${m[1].replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div>`;
    } else {
      if (inList) { html += '</div>'; inList = false; }
      html += `<p>${line.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</p>`;
    }
  }
  if (inList) html += '</div>';
  return html;
}
function renderAiStructured(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const parts = raw.split(/【([^】\n]{1,20})】/);
  if (parts.length >= 3) {
    let html = '';
    for (let i = 1; i < parts.length; i += 2) {
      const title = parts[i];
      const body = (parts[i + 1] || '').trim();
      if (!body) continue;
      html += `<div class="ai-sec"><div class="ai-sec-title">${esc(title)}</div><div class="ai-sec-body">${aiRichText(body)}</div></div>`;
    }
    if (html) return html;
  }
  return `<div class="ai-sec"><div class="ai-sec-body">${aiRichText(raw)}</div></div>`;
}
// 第 1 题的「上一题」应当禁用——点了没反应会让人以为卡了
function prevBtn() {
  const dis = S.practice.idx === 0 ? ' disabled style="opacity:.45"' : '';
  return `<button class="btn btn-ghost" data-prev${dis}>上一题</button>`;
}

// 资料分析的材料动辄两三屏（三段文字 + 一张表），直接铺在题干下面会把选项挤到屏幕外，
// 做一题要上下滚三四次。这里限高 + 内部滚动：短材料原样显示，长材料在框里滚。
// 标题上标字数和是否可滚，用户一眼知道「还有内容」。
function renderMaterial(q) {
  if (!q || !q.material) return '';
  const plain = String(q.material).replace(/<[^>]+>/g, '');
  const chars = plain.length;
  const hasImg = /<img\b/i.test(String(q.material));
  // 纯图材料（资料分析的图表、图形推理的九个图）文字长度为 0，
  // 以前会写「给定材料 0 字」，看着像没加载出来 —— 改成「图表」。
  const meta = chars > 0
    ? `${chars} 字${chars > 420 ? ' · 框内可滚动' : ''}`
    : (hasImg ? '图表' : '');
  return `<div class="q-material${chars > 420 ? ' tall' : ''}">
    <div class="q-material-head">给定材料${meta ? `<span class="q-material-meta">${meta}</span>` : ''}</div>
    <div class="q-material-body">${safeHtml(q.material)}</div>
  </div>`;
}

// 题型标签：以前一律写死「单项选择」，多选题、判断题都跟着错标。
// 题干自带「(不定项选择)」这类前缀时以它为准，并把前缀从正文里去掉，免得一行里两次题型。
const TYPE_PREFIX = /^[（(]\s*(不定项选择|多项选择|单项选择|单选|多选|判断)\s*[）)]\s*/;
const JUDGE_OPTS = ['正确', '错误'];
/** 题库里判断题（type 5）没有选项文本，答案存成 0/1。
 *  不补选项的话，判断题会被当成主观题渲染成「AI 批改」框 —— 公基 3,655 道全废。 */
function optionsOf(q) {
  const o = Array.isArray(q.options) ? q.options : [];
  if (o.length) return o;
  const ai = Number(q.answerIndex);
  if (String(q.type ?? '') === '5') return JUDGE_OPTS;
  if (ai >= 0 && /^[01]$/.test(String(q.answer ?? '').trim())) return JUDGE_OPTS;
  return o;
}
/** 多选题：type 2，或多答案存在 answer 里（"0,2,3"）。 */
function isMultiOf(q) {
  if (String(q.type ?? '') === '2') return true;
  const ans = String(q.answer ?? '').trim();
  return /^[\d,\s]+$/.test(ans) && ans.includes(',');
}
const selArr = (s) => (Array.isArray(s) ? s : s == null ? [] : [s]);
const hasSel = (s) => (Array.isArray(s) ? s.length > 0 : s != null && s !== '');
function typeTagOf(q, options) {
  const t = String(q.type ?? '');
  if (t === '5') return '判断题';
  if (!options.length) return '主观题';
  if (t === '2') return '多项选择';
  if (t === '3') return '判断';
  const m = String(q.content || '').match(TYPE_PREFIX);
  if (m) return m[1];
  const ch = String(q.chapter || '');
  if (/判断/.test(ch)) return '判断';
  return '单项选择';
}
/** 题后参照统计（本地口径）：考点上的历史正确率 + 这道题的易错项。
 *  注意措辞是「你」，不是「全站」——离线题库只有本机数据。 */
function refStatLine(ref) {
  if (!ref) return '';
  const parts = [];
  if (ref.kp && ref.kp.n) {
    const pct = Math.round((ref.kp.ok / ref.kp.n) * 100);
    parts.push(`考点 <b>${esc(ref.kp.name)}</b> · 你在这个考点正确率 <b>${pct}%</b>（${ref.kp.n} 题）`);
  }
  if (ref.q && ref.q.wrong > 0 && ref.q.top != null) {
    parts.push(`易错项 <b>${'ABCDEFGH'[ref.q.top]}</b>（你 ${ref.q.topN} 次选了它）`);
  }
  if (!parts.length) return '';
  return `<div class="ref-stat">${parts.join(' · ')}</div>`;
}
function renderQuestionBlock(q, fb) {
  const P = S.practice;
  const options = optionsOf(q);
  const opts = options.map((o, i) => {
    const correct = (fb?.correct || []).includes(i);
    const picked = (fb?.selected || []).includes(i);
    const cls = correct ? 'correct' : picked ? 'wrong' : '';
    return `<div class="option static ${cls}"><span class="key">${'ABCDEFGH'[i]}</span><span class="txt">${renderOption(o)}</span>${correct ? '<span class="opt-note">正确答案</span>' : picked ? '<span class="opt-note">你的选择</span>' : ''}</div>`;
  }).join('');
  const tagText = typeTagOf(q, options);
  const stemHtml = q.contentHtml
    ? String(q.contentHtml).replace(TYPE_PREFIX, '')
    : esc(String(q.content || '').replace(TYPE_PREFIX, ''));
  // 出处标识只放在题干最前面，不写进 content：题库里同一道题可能属于多套卷，
  // 写死会把「跨卷复用」改错，也会污染搜索与指纹匹配。
  const src = q.sourceTag ? `<span class="q-src">${esc(q.sourceTag)}</span>` : '';
  return `<div class="q-meta"><span class="tag">${esc(q.chapter || '')}</span><span class="tag">${tagText}</span>${q.difficulty > 0 ? `<span class="tag">难度 ${q.difficulty}</span>` : ''}${P.exam ? '<span class="tag warn">考试</span>' : ''}</div><div class="q-stem">${src}${safeHtml(stemHtml)}</div>${renderMaterial(q)}${opts}`;
}
function renderPractice() {
  const P = S.practice; const q = currentQ(); if (!q) return;
  const answeredCount = Object.values(P.answers || {}).filter((a) => a.selected != null).length;
  $('#p-count').textContent = `${P.idx + 1} / ${P.qs.length}`;
  $('#p-bar').style.width = `${((P.exam ? answeredCount : P.idx + (P.confirmed ? 1 : 0)) / P.qs.length) * 100}%`;
  $('#p-timer').textContent = fmtTime(P.exam ? P.remaining : P.elapsed);
  $('#p-timer').style.color = P.exam && P.remaining <= 60 ? 'var(--red)' : '';
  const flagEl = $('#p-flag-btn');
  if (flagEl) flagEl.classList.toggle('on', !!(P.flagged || {})[P.idx]);
  const body = $('#p-body'); const acts = $('#p-actions');
  const options = optionsOf(q);
  // 背题模式：不答题，直接连题带解析一起看。答案从 /api/question 取（按题干缓存），
  // 拿不到就退化成「只有题干 + 解析」，不影响阅读。
  if (S.settings.recite && !P.exam) {
    const at = P.idx;
    if (q.__ans === undefined) {
      q.__ans = null;
      api('/api/question?id=' + encodeURIComponent(q.id)).then((full) => {
        if (!full) return;
        q.__ans = { answer: full.answer || '', answerIndex: Number.isFinite(full.answerIndex) ? full.answerIndex : -1 };
        if (S.practice.open && S.practice.idx === at) renderPractice();
      }).catch(() => {});
    }
    const ai = q.__ans && q.__ans.answerIndex >= 0 ? q.__ans.answerIndex : -1;
    const fb = { correct: ai >= 0 ? [ai] : [], selected: [], ok: true };
    body.innerHTML = `<div class="card-sub" style="margin:-4px 0 10px;color:var(--brand)">背题模式 · 直接看答案和解析</div>${renderQuestionBlock(q, fb)}${renderAnalysisBlock(q, fb, '<button class="btn btn-ghost btn-sm" data-act="similar">同考点再练</button><button class="btn btn-ghost btn-sm" data-act="correction">纠错</button>')}`;
    acts.innerHTML = `${prevBtn()}<button class="btn btn-ghost" data-act="fav-toggle">收藏</button><button class="btn btn-ghost" data-act="note-edit">笔记</button><button class="btn btn-primary" data-next>${P.idx >= P.qs.length - 1 ? '完成本轮' : '下一题'}</button>`;
    return;
  }
  if (P.exam || !P.confirmed) {
    const picked = selArr(P.selected);
    const multi = isMultiOf(q) && !P.exam;
    const hint = multi ? `<div class="q-hint">多选题 · 选几个都行，选完点「确认答案」</div>` : '';
    const faved = S.favIds && S.favIds.has(String(q.id));
    const tools = `<div class="q-tools"><button class="link-sm ${faved ? 'on' : ''}" data-act="fav-toggle" aria-pressed="${faved}">${faved ? '★ 已收藏' : '☆ 收藏'}</button><button class="link-sm" data-act="note-edit">✎ 笔记</button></div>`;
    body.innerHTML = `<div class="q-meta"><span class="tag">${esc(q.chapter || '')}</span><span class="tag">${typeTagOf(q, options)}</span>${q.difficulty > 0 ? `<span class="tag">难度 ${q.difficulty}</span>` : ''}${P.exam ? '<span class="tag warn">考试</span>' : ''}</div><div class="q-stem">${q.sourceTag ? `<span class="q-src">${esc(q.sourceTag)}</span>` : ''}${safeHtml(q.contentHtml || esc(q.content || ''))}</div>${renderMaterial(q)}${hint}${options.map((o, i) => `<button class="option ${picked.includes(i) ? 'selected' : ''}" data-opt="${i}"><span class="key">${'ABCDEFGH'[i]}</span><span class="txt">${renderOption(o)}</span></button>`).join('')}${options.length ? '' : gradeBox(q)}${P.exam ? '' : tools}`;
    if (P.exam) acts.innerHTML = `${prevBtn()}<button class="btn btn-primary" data-next>${P.idx >= P.qs.length - 1 ? '交卷' : '下一题'}</button>`;
    else if (options.length) acts.innerHTML = `${prevBtn()}<button class="btn btn-primary" data-confirm ${hasSel(P.selected) ? '' : 'disabled style="opacity:.45"'}>确认答案</button>`;
    else acts.innerHTML = `${prevBtn()}<button class="btn btn-ghost" data-act="show-answer">参考答案</button><button class="btn btn-primary" data-act="ai-grade" ${P.gradeLoading ? 'disabled style="opacity:.45"' : ''}>${P.gradeLoading ? '批改中…' : 'AI 批改'}</button>`;
  } else {
    const fb = P.feedback || {};
    // 进阶解析（考点/秒杀/步骤/陷阱/母题），来源 question_deep，按题缓存
    const deep = (S.deepCache || {})[q.id];
    const deepCard = deep ? `<div class="explain" style="margin-top:12px"><h4>进阶解析</h4>
      ${deep.kadian ? `<div class="card-sub" style="margin-bottom:10px">考点 · ${esc(deep.kadian)}</div>` : ''}
      ${deep.fastest ? `<div style="margin-bottom:10px"><b style="color:var(--primary)">⚡ 秒杀</b><p style="white-space:pre-wrap;margin-top:4px">${esc(deep.fastest)}</p></div>` : ''}
      ${deep.reasoning ? `<div style="margin-bottom:10px"><b>解题步骤</b><p style="white-space:pre-wrap;margin-top:4px">${esc(deep.reasoning)}</p></div>` : ''}
      ${deep.pitfalls ? `<div style="margin-bottom:10px"><b style="color:var(--red)">⚠ 易错点</b><p style="white-space:pre-wrap;margin-top:4px">${esc(deep.pitfalls)}</p></div>` : ''}
      ${deep.mother ? `<div><b>母题模板</b><p style="white-space:pre-wrap;margin-top:4px">${esc(deep.mother)}</p></div>` : ''}
    </div>` : '';
    const aiCard = `<div class="ai-card"><div class="ai-head"><span class="ai-badge">AI 讲题</span>${P.aiCached ? '<span class="tag ok">缓存</span>' : ''}<span class="ai-sub">换个方式讲这道题</span><button class="btn btn-ghost btn-sm" data-act="ai-explain" ${P.aiLoading ? 'disabled' : ''}>${P.aiLoading ? '解析中…' : P.ai ? '重新讲' : '听一遍'}</button></div>${P.aiLoading ? `<div class="ai-loading"><span class="spinner ai-spinner"></span><span>AI 正在拆解题目…</span></div>` : ''}${P.ai ? `<div class="ai-sections">${renderAiStructured(P.ai)}</div>` : ''}${P.ai ? `<div class="ai-chat"><div class="ai-chat-title">继续追问</div>${P.aiChat.map((m) => `<div class="ai-chat-bubble ${m.role}">${m.role === 'assistant' ? aiRichText(m.content) : esc(m.content)}</div>`).join('')}${P.aiLoading ? `<div class="ai-chat-loading"><span class="spinner ai-spinner"></span> AI 正在回答…</div>` : ''}<div class="ai-chat-input"><input id="ai-chat-input" class="field" placeholder="还有哪里不懂？继续问"><button class="btn btn-primary btn-sm" data-act="ai-send">发送</button></div></div>` : ''}</div>`;
    body.innerHTML = `${renderQuestionBlock(q, fb)}<div class="feedback ${fb.ok ? 'ok' : 'no'}" style="margin-top:14px"><div class="fb-title">${fb.ok ? '✓ 答对了' : '✗ 选错了'}</div><div class="fb-compare">正确答案 <b>${(fb.correct || []).map((i) => 'ABCDEFGH'[i]).join('') || '见解析'}</b> · 你的选择 <b>${(fb.selected || []).map((i) => 'ABCDEFGH'[i]).join('') || '—'}</b>${fb.slow ? ' · <span class="tag warn">会但慢</span>' : ''}</div></div>${refStatLine(q.__ref)}${renderAnalysisBlock(q, fb, '<button class="btn btn-ghost btn-sm" data-act="similar">同考点再练</button><button class="btn btn-ghost btn-sm" data-act="correction">纠错</button>')}${deepCard}${aiCard}`;
    acts.innerHTML = `${prevBtn()}<button class="btn btn-ghost" data-act="fav-toggle">收藏</button><button class="btn btn-ghost" data-act="note-edit">笔记</button><button class="btn btn-primary" data-next>${P.idx >= P.qs.length - 1 ? '完成本轮' : '下一题'}</button>`;
  }
}
async function confirmAnswer() {
  const P = S.practice; const q = currentQ();
  if (!hasSel(P.selected) || P.confirmed) return;
  tickQCost();
  try {
    const r = await api('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, selected: P.selected }) });
    P.feedback = r; P.confirmed = true;
    P.results.push(!!r.ok);
    // 用时进复习模型：答对但明显超时 → 只记成功不升档
    const rev = updateReview(q.id, !!r.ok, qCostOf(P.idx), q.difficulty);
    if (rev && rev.slow) r.slow = true;
    saveCurrentAnswer();
    renderPractice();
    saveSession();
    // 答对才自动翻页：先让人看到「✓ 答对了」停 1.2 秒；答错必须停在解析上，
    // 否则连错的题一闪而过，复盘等于没有。考试模式一律不自动跳（会吞掉检查时间）。
    if (r.ok && !P.exam && S.settings.autoNext) {
      clearTimeout(S.autoNextTimer);
      const at = P.idx;
      S.autoNextTimer = setTimeout(() => {
        const C = S.practice;
        if (!C || !C.open || !C.confirmed || C.idx !== at) return;
        if (C.idx >= C.qs.length - 1) { toast('这轮做完了，点「完成本轮」看报告'); return; }
        nextQuestion();
      }, 1200);
    }
    // 拉取深度解析（考点/秒杀/陷阱/母题），拿到后补渲染
    if (!S.deepCache) S.deepCache = {};
    if (!S.deepCache[q.id]) {
      api('/api/question?id=' + encodeURIComponent(q.id))
        .then((full) => {
          if (full?.deep) {
            S.deepCache[q.id] = full.deep;
            if (S.practice.open) renderPractice();
          }
        })
        .catch(() => {});
    }
    await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, subject: q.subject || P.subject, chapter: q.chapter, type: q.type, selected: selArr(P.selected), correct: r.ok, costMs: qCostOf(P.idx), autoDrop: S.settings.dropFixed !== false }) }).catch(() => {});
    // 实验版（0.7）：逐题喂能力账本，答完这道账本就变，不用等整轮结束
    if (window.__LAB__ && window.__ENGINE2__) {
      const kpName = q.kp || P.kp || '';
      if (kpName && !q.__fed) {
        let oc = 0;
        try { oc = Array.isArray(q.options) ? q.options.length : JSON.parse(q.options || '[]').length; } catch { oc = 0; }
        try {
          window.__ENGINE2__.recordAnswered([{
            kp: kpName, sub: q.subject || P.subject || '', chapter: q.chapter,
            type: q.type, optionCount: oc, y: r.ok ? 1 : 0, ts: Date.now(), qid: q.id,
          }]);
          q.__fed = true;
        } catch { /* 实验功能失败不影响正常流程 */ }
      }
    }
    // 参照统计（本地口径）：这道题所在考点上你的历史正确率、这道题你常错在哪个选项。
    // 明确不是「全站正确率」——离线题库没有别人数据，标成全站就是编数字。
    const atIdx = P.idx;
    api('/api/refstats?ids=' + q.id).then((st) => {
      if (!st) return;
      const kpName = Object.keys(st.kp || {})[0] || '';
      q.__ref = { kp: kpName ? { name: kpName, ...st.kp[kpName] } : null, q: (st.q || {})[q.id] || null };
      if (S.practice.open && S.practice.idx === atIdx) renderPractice();
    }).catch(() => {});
    saveSession();
  } catch (e) { toast(e.message); }
}
function nextQuestion() {
  const P = S.practice;
  saveCurrentAnswer();
  tickQCost();
  if (P.exam) {
    if (P.idx >= P.qs.length - 1) { requestSubmitExam(); return; }
    P.idx++; loadAnswerState(); saveSession();
    renderPractice(); $('#p-body').scrollTop = 0;
    return;
  }
  if (P.idx >= P.qs.length - 1) { finishPractice(); return; }
  P.idx++; loadAnswerState(); saveSession();
  renderPractice(); $('#p-body').scrollTop = 0;
}
function prevQuestion() {
  const P = S.practice;
  if (P.idx === 0) { toast('已经是第一题'); return; }
  saveCurrentAnswer();
  tickQCost();
  P.idx--; loadAnswerState(); saveSession();
  renderPractice();
  $('#p-body').scrollTop = 0;
}
async function finishPractice() {
  const P = S.practice;
  saveCurrentAnswer();
  P.open = false; clearInterval(P.timer); $('#practice').hidden = true;
  clearSession();
  await attachKeypoints(P.qs);
  feedEngine(P);
  const answers = Object.values(P.answers || {});
  const answered = answers.filter((a) => a.confirmed).length;
  const right = answers.filter((a) => a.feedback && a.feedback.ok).length;
  P.lastWrongIds = P.qs.filter((q, i) => !P.answers[i]?.feedback?.ok).map((q) => q.id);
  try { await refreshStats(); } catch { /* ignore */ }
  const due = dueIds().length;
  const remain = dailyRemaining();
  const daily = P.kind === 'review' || P.kind === 'new';
  const rate = answered ? Math.round((right / answered) * 100) : 0;
  const prevRate = Number(localStorage.getItem('sg_last_round_rate'));
  const delta = Number.isFinite(prevRate) && answered ? rate - prevRate : null;
  localStorage.setItem('sg_last_round_rate', String(rate));
  const ins = roundInsight(P);
  const kpInfo = P.kp ? kpRecord(P.kp, answered, right, P.subject) : null;
  const usedSec = Math.round(P.elapsed || 0);
  let extra = '';
  if (daily && due === 0 && remain > 0) {
    extra = `<button class="btn btn-primary btn-block" data-act="daily-next" style="margin-top:8px">继续今日新题 · 还差 ${remain} 题</button>`;
  } else if (daily && due === 0 && remain === 0) {
    extra = `<div class="task-foot" style="justify-content:center;margin:2px 0 12px;color:var(--green)">今日任务完成 ✓</div>`;
  }
  if (P.lastWrongIds.length) {
    extra += `<button class="btn btn-primary btn-block" data-act="retry-wrong" style="margin-top:8px">错题再练（${P.lastWrongIds.length} 题）</button>`;
  }
  sheet(`<div class="sheet-head"><b>本轮完成</b><button class="sheet-close">✕</button></div><div class="round-hero"><div class="rbig">${rate}<i>%</i></div><div class="rlab">这一轮正确率</div>${delta == null ? '' : delta > 0 ? `<div class="rup">比上一轮高 ${delta}%</div>` : delta < 0 ? `<div class="rup flat">比上一轮低 ${-delta}%</div>` : `<div class="rup flat">和上一轮持平</div>`}<div class="round-kv"><div><b>${answered}</b><span>做题</span></div><div><b>${right}</b><span>答对</span></div><div><b>${answered - right}</b><span>答错</span></div></div><div class="card-sub" style="margin-top:12px">用时 ${fmtTime(usedSec)} · 平均每题 ${answered ? fmtTime(Math.round(usedSec / answered)) : '—'}</div></div>${kpHtml(kpInfo)}<div class="round-insight"><div class="h">这一轮最该记住的一点</div><div class="t">${ins.text}</div></div>${ins.rows.length ? `<div class="round-next">${ins.rows.map((r) => `<div class="row"><i></i><span><b>${esc(r.name)}</b> 错了 ${r.n} 道</span><em data-act="weak" data-name="${esc(r.name)}">去练 ›</em></div>`).join('')}</div>` : ''}${extra}<button class="btn ${extra ? 'btn-ghost' : 'btn-primary'} btn-block" data-act="close-sheet" style="margin-top:${extra ? '8px' : '0'}">回到首页</button>`);
  loadHome().then(() => { if (S.tab === 'home') go('home'); }).catch(() => {});
}
async function openQuestionById(id, title) {
  try {
    const q = await api('/api/question?id=' + encodeURIComponent(id));
    if (!q || q.id == null) { toast('题目不存在'); return; }
    startPractice([q], title || '单题重做', q.subject || '');
  } catch (e) { toast(e.message); }
}

/* ---------- 事件 ---------- */
document.addEventListener('click', (e) => {
  // 考点行：直接开练
  const kpEl = e.target.closest('[data-kp]');
  if (kpEl) {
    const kpName = kpEl.getAttribute('data-kp');
    if (kpName) {
      const subj = S.lib.subject;
      startPracticeByUrl('/api/practice?subject=' + encodeURIComponent(subj) + '&keypoint=' + encodeURIComponent(kpName) + '&n=15', '考点 · ' + kpName, subj, 'keypoint', kpName);
      return;
    }
  }
  const tab = e.target.closest('#tabbar .tab');
  if (tab) {
    const t = tab.dataset.tab;
    if (t === 'library') {
      const valid = visibleSubjects().some((s) => s.subjectName === S.lib.subject);
      if (!valid || !S.lib.chapters.length || S.lib.view !== 'subjects') { openLibrary(valid ? S.lib.subject : undefined); return; }
      go(t); return;
    }
    if (t === 'me' || t === 'review' || t === 'home') {
      // 点底部 tab 是「回到这个栏目」，不是「回到上次那一页」：
      // 之前从首页点进学习报告，返回后再点「我的」，还停在报告页 —— 很别扭。
      if (t === 'me') S.meView = 'main';
      refreshStats().then(() => { go(t); if (t === 'review') loadReview(S.review.tab); }).catch(() => go(t));
      return;
    }
    go(t); return;
  }
  const pf = e.target.closest('[data-pf]');
  if (pf) { S.lib.filter[pf.dataset.pf] = pf.dataset.val; S.lib.show = 80; $('#view').innerHTML = renderPapers({ host: S.examPapers ? 'exam' : 'library' }); return; }
  const pfs = e.target.closest('[data-pf-subject]');
  if (pfs) { S.lib.subject = pfs.dataset.pfSubject; loadPapers({ host: S.examPapers ? 'exam' : 'library' }); return; }
  const libSub = e.target.closest('[data-lib-subject]');
  if (libSub) {
    // 换科目时把展开状态清掉，避免上一科展开的模块名在这一科残留
    S.lib.openGroups = {};
    openLibrary(libSub.dataset.libSubject);
    return;
  }
  const kpSub = e.target.closest('[data-kp-subject]');
  if (kpSub) { openKeypoints(kpSub.dataset.kpSubject); return; }
  const rt = e.target.closest('[data-review-tab]');
  if (rt) { S.review.chapter = ''; loadReview(rt.dataset.reviewTab); return; }
  const rc = e.target.closest('[data-act="review-chap"]');
  if (rc) { S.review.chapter = rc.dataset.c || ''; render(); return; }
  const df = e.target.closest('[data-drop-fixed]');
  if (df) {
    S.settings.dropFixed = S.settings.dropFixed === false;
    saveSettings();
    render();
    toast(S.settings.dropFixed ? '做对的题会自动移出错题本' : '做对的题保留在错题本，累计 3 天做对才移除');
    return;
  }
  if (e.target.closest('#p-card-btn')) { openAnswerCard(); return; }
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    saveCurrentAnswer();
    S.practice.idx = Number(jump.dataset.jump);
    loadAnswerState();
    closeSheet();
    saveSession();
    renderPractice();
    $('#p-body').scrollTop = 0;
    return;
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    const P2 = S.practice;
    const idx = Number(opt.dataset.opt);
    if (isMultiOf(currentQ())) {
      // 多选题：点一下加进去，再点一下取消，不自动判分（判分要整组对比）
      const cur = selArr(P2.selected).slice();
      const at = cur.indexOf(idx);
      if (at >= 0) cur.splice(at, 1); else cur.push(idx);
      cur.sort((a, b) => a - b);
      P2.selected = cur;
      saveCurrentAnswer(); saveSession(); renderPractice();
      return;
    }
    P2.selected = idx;
    saveCurrentAnswer(); saveSession(); renderPractice();
    // 练习模式默认点选项即判定（少点一次），考试模式必须留到交卷
    if (!P2.exam && !P2.confirmed && S.settings.instant) confirmAnswer();
    return;
  }
  if (e.target.closest('#p-flag-btn') || e.target.closest('[data-flag]')) {
    const P2 = S.practice;
    if (!P2.flagged) P2.flagged = {};
    P2.flagged[P2.idx] = !P2.flagged[P2.idx];
    saveSession(); renderPractice();
    toast(P2.flagged[P2.idx] ? '已标记待定，答题卡里会标黄' : '已取消待定');
    return;
  }
  const fsBtn = e.target.closest('button[data-fs]');   // 必须限定 button：<html data-fs="m"> 也带这个属性，否则任何点击都会命中
  if (fsBtn) { applyFontSize(fsBtn.dataset.fs); go('me'); return; }
  const instBtn = e.target.closest('[data-instant]');
  if (instBtn) { S.settings.instant = !S.settings.instant; saveSettings(); go('me'); toast(S.settings.instant ? '已开启：点选项直接判对错' : '已关闭：点完选项还要按确认'); return; }
  const anBtn = e.target.closest('[data-auto-next]');
  if (anBtn) { S.settings.autoNext = !S.settings.autoNext; saveSettings(); go('me'); toast(S.settings.autoNext ? '已开启：答对停一下自动翻页' : '已关闭：每题都要自己点下一题'); return; }
  const rcBtn = e.target.closest('[data-recite]');
  if (rcBtn) { S.settings.recite = !S.settings.recite; saveSettings(); go('me'); toast(S.settings.recite ? '已开启背题模式：不答题，直接看解析' : '已回到做题模式'); return; }
  const libMode = e.target.closest('[data-lib-mode]');
  if (libMode) {
    const want = libMode.dataset.libMode === 'recite';
    if (S.settings.recite !== want) { S.settings.recite = want; saveSettings(); }
    go('library');
    toast(want ? '背题模式：进入练习直接看答案和解析' : '做题模式：先选答案再对答案');
    return;
  }
  if (e.target.closest('[data-confirm]')) { confirmAnswer(); return; }
  if (e.target.closest('[data-next]')) { nextQuestion(); return; }
  if (e.target.closest('[data-prev]')) { prevQuestion(); return; }
  if (e.target.closest('[data-show-answer]')) {
    const q = currentQ();
    sheet(`<div class="sheet-head"><b>参考答案</b><button class="sheet-close">✕</button></div><div class="ai-out">${esc(q.analysis || '暂无参考答案')}</div>`);
    return;
  }
  if (e.target.closest('#p-close')) {
    saveCurrentAnswer();
    saveSession();
    S.practice.open = false;
    clearInterval(S.practice.timer);
    $('#practice').hidden = true;
    toast('已保存，可在首页继续');
    return;
  }
  const th = e.target.closest('[data-theme-set]');
  if (th) { applyTheme(th.dataset.themeSet); return; }
  const sm = e.target.closest('[data-smart]');
  if (sm) {
    const key = sm.dataset.smart;
    const val = sm.dataset.val;
    if (key === 'count') S.smart.count = Number(val) || 20;
    else if (key === 'types') S.smart.types = val.split(',').map(Number).filter((n) => n > 0);
    else S.smart[key] = val;
    openSmartPaper();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  // 打开二级页面之前，先记住「从哪来」，返回才能回到正确的地方
  if (NAV_DOWN.has(a)) rememberFrom();
  if (a === 'subject') { openLibrary(act.dataset.name); return; }
  if (a === 'back-library') { goBackSmart('library'); return; }
  if (a === 'search') { openSearch(); return; }
  if (a === 'keypoints') { openKeypoints(); return; }
  if (a === 'search-run') { runSearch(); return; }
  if (a === 'search-scope') { S.search.scope = act.dataset.v || 'all'; render(); runSearch(); return; }
  if (a === 'search-year') {
    const v = String(act.dataset.v || '');
    S.search.year = S.search.year === v ? '' : v;
    render();
    if (S.search.q) runSearch();
    return;
  }
  if (a === 'search-open') { openQuestionById(act.dataset.id, '搜索结果'); return; }
  if (a === 'back-subject') {
    // 从考试 tab 进来的整卷列表，返回要回考试首页，而不是掉到题库里去
    if (S.examPapers) { S.examPapers = false; go('exam'); return; }
    goBackSmart('library'); return;
  }
  if (a === 'back-exam') { S.examPapers = false; go('exam'); return; }
  if (a === 'papers') { loadPapers({ host: S.tab === 'exam' ? 'exam' : 'library' }); return; }
  if (a === 'papers-entry') { loadPapers({ host: S.tab === 'exam' ? 'exam' : 'library' }); return; }
  if (a === 'exam-papers') { openExamPapers(); return; }
  if (a === 'more-papers') { S.lib.show += 80; $('#view').innerHTML = renderPapers({ host: S.examPapers ? 'exam' : 'library' }); return; }
    if (a === 'paper') {
      const pid = act.dataset.id;
      const pname = act.dataset.name || '';
      sheet(`<div class="sheet-head"><b>${esc(pname || '这份卷子')}</b><button class="sheet-close">✕</button></div>
        <div class="card-sub" style="margin:0 0 14px">整卷模考会按真题时长计时，交卷后出成绩单和逐题解析。</div>
        <button class="btn btn-primary btn-block" data-act="paper-exam" data-id="${esc(pid)}" data-name="${esc(pname)}">整卷模考</button>
        <button class="btn btn-ghost btn-block" style="margin-top:8px" data-act="paper-practice" data-id="${esc(pid)}" data-name="${esc(pname)}">当练习做（不计时，边做边看解析）</button>`);
      return;
    }
    if (a === 'paper-exam') { closeSheet(); startPaperExam(act.dataset.id, act.dataset.name, S.lib.subject); return; }
    if (a === 'paper-practice') {
      closeSheet();
      api(`/api/papers/${act.dataset.id}`).then((p) => startPractice(p.questions || [], p.name, p.subjectName)).catch((err) => toast(err.message));
      return;
    }
    if (a === 'exam-history') { openExamHistory(); return; }
    if (a === 'hist-detail') { openHistDetail(Number(act.dataset.ts)); return; }
  if (a === 'exam-trend') { openExamTrend(); return; }
  if (a === 'keypoints') { openKeypoints(); return; }
  if (a === 'group') {
    // 点行 → 练这个模块；点行首的小三角 → 只展开/收起二级，不跳去做题
    const caret = e.target.closest('[data-toggle-group]');
    if (caret) {
      const name = caret.dataset.toggleGroup;
      S.lib.openGroups = S.lib.openGroups || {};
      S.lib.openGroups[name] = !S.lib.openGroups[name];
      go('library');
      return;
    }
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(S.lib.subject)}&group=${encodeURIComponent(act.dataset.group)}&sub=${encodeURIComponent(act.dataset.sub)}&n=15&mock=0&year=10&difficulty=random`, act.dataset.group, S.lib.subject); return;
  }
  if (a === 'subject-random' || a === 'library-random') { startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(S.lib.subject)}&n=20&mock=0&year=10&difficulty=random`, '随机 20 题', S.lib.subject); return; }
  if (a === 'library-exam') { startExam(10, '随堂测'); return; }
  // 首页那张「模考」卡：直接落到考试 tab 的整卷列表，不再先停在 tab 顶
  if (a === 'exam-hub') { openExamPapers(); return; }
  if (a === 'review-train' || a === 'wrong-train') { reviewTrain(); return; }
  if (a === 'open-q') { openQuestionById(act.dataset.id); return; }
  if (a === 'exam') { startExam(Number(act.dataset.n) || 20, '模拟考试'); return; }
  if (a === 'continue' || a === 'resume-session') { resumeSession(); return; }
  if (a === 'plan') { S.planView = true; go('exam'); return; }
  if (a === 'plan-back') { S.planView = false; goBackSmart('exam'); return; }
  if (a === 'plan-gen') { buildPlan(); S.planView = true; go('exam'); return; }
  if (a === 'plan-practice') { startDailyTask(); return; }
  if (a === 'daily-task') { startDailyTask(); return; }
  if (a === 'daily-new') { startNewDaily(); return; }
  if (a === 'daily-next') { closeSheet(); startNewDaily(); return; }
  if (a === 'exam-submit') { closeSheet(); requestSubmitExam(); return; }
  if (a === 'exam-submit-confirm') { closeSheet(); submitExam(); return; }
  if (a === 'exam-review') { closeSheet(); S.tab = 'exam'; go('exam'); return; }
  if (a === 'review-filter') { reviewFilter = act.dataset.f || 'all'; go('exam'); return; }
  if (a === 'review-kp') {
    const ch = act.dataset.chapter || '';
    const subj = (S.examResult && S.examResult.subject) || S.lib.subject;
    closeSheet();
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(subj)}&chapter=${encodeURIComponent(ch)}&n=10&mock=0&year=10&difficulty=balanced`, '考点 · ' + ch, subj, 'random');
    return;
  }
  if (a === 'exam-result-back') { S.examResult = null; goBackSmart('exam'); return; }
  if (a === 'extra-practice') {
    const subject = dailySubject();
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(subject)}&n=10&mock=0&year=10&difficulty=random`, '加练 10 题', subject, 'random');
    return;
  }
  if (a === 'plan-reset') { S.plan = null; localStorage.removeItem('sg_plan_v1'); go('exam'); return; }
  if (a === 'profile') { S._draft = { ...S.profile }; openProfile(); return; }
  if (a === 'ai-explain') { aiExplain(); return; }
  if (a === 'ai-send') { sendAiFollowup(); return; }
  if (a === 'fav-toggle') {
    const q = currentQ();
    if (!q) return;
    const id = String(q.id);
    if (!S.favIds) S.favIds = new Set();
    const faved = S.favIds.has(id);
    api('/api/favorites', {
      method: faved ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.id, subject: q.subject || S.practice.subject, chapter: q.chapter }),
    })
      .then(() => {
        if (faved) S.favIds.delete(id); else S.favIds.add(id);
        toast(faved ? '已取消收藏' : '已收藏，在「回顾 → 收藏」里能找到');
        renderPractice();
      })
      .catch((err) => toast(err.message));
    return;
  }
  if (a === 'note-edit') { openNoteEditor(); return; }
  if (a === 'lab-open') { if (window.__LAB_OPEN__) window.__LAB_OPEN__(); else toast('这个版本没带实验室'); return; }
  if (a === 'note-search') { openNoteSearch(); return; }
  if (a === 'similar') {
    const q = currentQ();
    const chapter = q?.chapter;
    const subject = S.practice.subject || q?.subject || dailySubject();
    if (!chapter) { toast('这道题没有章节信息'); return; }
    closeSheet();
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(subject)}&chapter=${encodeURIComponent(chapter)}&n=3&mock=0&year=10&difficulty=balanced`, `同考点 · ${chapter}`, subject, 'similar');
    return;
  }
  if (a === 'correction') { openCorrection(); return; }
  if (a === 'ai-grade') { aiGrade(); return; }
  if (a === 'essay-open') { openEssayDetail(act.dataset.id); return; }
  if (a === 'show-answer') {
    const q = currentQ();
    sheet(`<div class="sheet-head"><b>参考答案</b><button class="sheet-close">✕</button></div><div class="ai-out">${esc(q?.analysis || '暂无参考答案')}</div>`);
    return;
  }
  if (a === 'correction-save') {
    const q = currentQ();
    const text = ($('#correction-text')?.value || '').trim();
    if (!text) { toast('请填写纠错内容'); return; }
    api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, subject: q.subject || S.practice.subject, chapter: q.chapter, note: `【纠错】${text}` }) })
      .then(() => { closeSheet(); toast('纠错已记录到笔记'); })
      .catch((err) => toast(err.message));
    return;
  }
  if (a === 'note-save') {
    const q = currentQ();
    const note = ($('#note-text')?.value || '').trim();
    if (!note) { toast('笔记不能为空'); return; }
    api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, subject: q.subject || S.practice.subject, chapter: q.chapter, note }) })
      .then(() => { closeSheet(); toast('笔记已保存'); })
      .catch((err) => toast(err.message));
    return;
  }
  if (a === 'retry-wrong') {
    const ids = S.practice.lastWrongIds || [];
    if (!ids.length) return;
    closeSheet();
    (async () => {
      const qs = await fetchQuestions(ids);
      if (qs.length) startPractice(qs, '错题再练', qs[0].subject || S.practice.subject, 'wrong');
      else toast('错题加载失败');
    })();
    return;
  }
  if (a === 'close-sheet') { closeSheet(); return; }
  if (a === 'stats') { S.meView = 'stats'; go('me'); return; }
  if (a === 'report') { S.meView = 'report'; go('me'); return; }
  if (a === 'backup') { S.meView = 'backup'; go('me'); return; }
  if (a === 'about') { sheet(`<div class="sheet-head"><b>关于上岸</b><button class="sheet-close">✕</button></div><div class="card-sub">上岸 v${APP_VERSION} · 本地离线题库<br>题库与解析来源：粉笔等公开整理，仅限个人学习使用，请勿传播或商用。<br>不提供公开商店分发。</div>`); return; }
  if (a === 'ai') { openAi(); return; }
  if (a === 'update') { checkUpdate('tiku'); return; }
  if (a === 'app-update') { checkUpdate('app'); return; }
  if (a === 'politics-refresh') { _politics = null; openPolitics(); return; }
  if (a === 'ai-teach') { openAi(); go('me'); return; }
  if (a === 'upd-banner-go') { openUpdateChoice(); return; }
  if (a === 'upd-banner-close') {
    // 关掉就不再提这个版本，等下一版再说
    const muted = JSON.parse(localStorage.getItem('sg_update_mute') || '{}');
    muted.tiku = S.updateHint && S.updateHint.tiku;
    muted.app = S.updateHint && S.updateHint.app;
    localStorage.setItem('sg_update_mute', JSON.stringify(muted));
    go('home');
    return;
  }
  if (a === 'upd-do-tiku') { closeSheet(); checkUpdate('tiku'); return; }
  if (a === 'upd-do-app') { closeSheet(); checkUpdate('app'); return; }
  if (a === 'upd-later') {
    const muted = JSON.parse(localStorage.getItem('sg_update_mute') || '{}');
    muted.tiku = S.updateHint && S.updateHint.tiku;
    muted.app = S.updateHint && S.updateHint.app;
    localStorage.setItem('sg_update_mute', JSON.stringify(muted));
    closeSheet();
    go('home');
    return;
  }
  if (a === 'feishu') {
    // 私有飞书知识库：App 内打开（有原生桥时），否则退回系统浏览器
    if (!openInApp(EXTERNAL_LINKS.feishu, '备考资料库')) openExternal(EXTERNAL_LINKS.feishu);
    return;
  }
  if (a === 'politics') { openPolitics(); return; }
  if (a === 'politics-open') {
    const it = (S.politicsList || [])[Number(act.dataset.idx)];
    if (it) polMarkRead(it.id != null ? it.id : act.dataset.idx);
    openPoliticsDetail(Number(act.dataset.idx));
    return;
  }
  if (a === 'pol-filter') { S.polUnreadOnly = act.dataset.v === 'unread'; openPolitics(); return; }
    if (a === 'pol-opt') {
      const card = act.closest('.pol-q');
      if (!card || card.dataset.done === '1') return;
      const ans = String(card.dataset.ans || '');
      const pick = String(act.dataset.o || '');
      card.dataset.done = '1';
      card.querySelectorAll('.pol-opt').forEach((b) => {
        const k = String(b.dataset.o || '');
        b.disabled = true;
        if (k === ans) b.classList.add('right');
        else if (k === pick) b.classList.add('wrong');
        else b.classList.add('locked');
      });
      const fb = card.querySelector('.pol-fb');
      if (fb) fb.textContent = pick === ans ? '✓ 答对了' : '✗ 正确答案 ' + (ans || '—');
      // 记住选择，重开这篇文章时还显示
      const i = Number(act.dataset.idx);
      const art = (S.politicsList || [])[i];
      if (art) {
        S.polQuiz = S.polQuiz || {};
        S.polQuiz[art.id] = S.polQuiz[art.id] || {};
        S.polQuiz[art.id][act.dataset.q] = pick;
      }
      return;
    }
  if (a === 'me-back') { goBackSmart('me'); return; }
  if (a === 'ai-edit') { editAgent(act.dataset.id); return; }
  if (a === 'ai-toggle') {
    const id = act.dataset.id;
    const a2 = (S.agents || []).find((x) => String(x.id) === String(id));
    api(`/api/ai/agents/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: a2 && a2.enabled ? 0 : 1 }) })
      .then(() => openAi()).catch((e) => toast(e.message));
    return;
  }
  if (a === 'ai-save' || a === 'ai-test') {
    const id = act.dataset.id;
    (async () => {
      try {
        const box = $('#ai-extra');
        if (a === 'ai-test' && !box) {
          sheet(`<div class="sheet-head"><b>测试 ${esc((S.agents || []).find((x) => String(x.id) === String(id))?.name || 'AI')}</b><button class="sheet-close">✕</button></div><div id="ai-test-box"></div>`);
          await runAgentTest(id, $('#ai-test-box'));
          return;
        }
        const r = await saveAgentFields(id);
        if (a === 'ai-test' && box) {
          toast('已保存，正在测试…');
          await runAgentTest(id, box);
          return;
        }
        closeSheet();
        toast(r && r.promptChanged ? '已保存：prompt/skill 变化，解析缓存已清空' : '已保存');
        openAi();
      } catch (e) { toast(e.message); }
    })();
    return;
  }
  if (a === 'ai-clear-cache') {
    api('/api/ai/explain-cache', { method: 'DELETE' })
      .then((r) => toast(r && r.cleared > 0 ? `已清除 ${r.cleared} 条解析缓存` : '缓存本来就是空的'))
      .catch((e) => toast(e.message));
    return;
  }
  if (a === 'ai-models') {
    const box = $('#ai-extra');
    if (!box) return;
    const base = ($('#ai-base')?.value || '').trim();
    const key = ($('#ai-key')?.value || '').trim();
    box.innerHTML = '<div class="ai-loading"><span class="spinner ai-spinner"></span> 获取模型列表…</div>';
    fetchModelList(base, key).then((models) => {
      box.innerHTML = `<div class="card-sub">共 ${models.length} 个模型，点击选择后记得保存</div><div class="chips">${models.map((m) => `<button class="chip" data-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>`;
    }).catch((e) => { box.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`; });
    return;
  }
  if (a === 'ai-history') {
    const box = $('#ai-extra');
    if (!box) return;
    box.innerHTML = '<div class="spinner ai-spinner"></div>';
    api(`/api/ai/agents/${act.dataset.id}/history`).then((h) => {
      box.innerHTML = h && h.length ? h.map((x) => `<div class="ai-sec"><div class="ai-sec-title">${esc(x.saved_at || '')} · ${esc(x.note || '')}</div><div class="ai-sec-body">${aiRichText(String(x.system_prompt || '').slice(0, 300))}</div></div>`).join('') : '<div class="empty-state">暂无历史版本</div>';
    }).catch((e) => { box.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`; });
    return;
  }
  if (a === 'ai-skill-builtin') { importBuiltinSkills(); return; }
  if (a === 'skills-toggle') {
    const on = S.settings.skills === false;   // 现在是关 → 点一下开
    S.settings.skills = on; saveSettings();
    if (on) { ensureBuiltinSkills(true).then((n) => toast(n ? `已装回内置技能（${n} 套）` : '内置技能已是最新')).catch(() => {}); }
    else toast('内置技能已关闭，已装的仍留在技能库里');
    render(); return;
  }
  if (a === 'ai-skill-import') { openSkillImport(); return; }
  if (a === 'ai-skill-save') {
    const name = ($('#sk-name')?.value || '').trim();
    const text = ($('#sk-text')?.value || '').trim();
    if (!name || !text) { toast('技能名和内容不能为空'); return; }
    api('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: ($('#sk-desc')?.value || '').trim(), text, files: [{ path: 'SKILL.md', size: 0 }] }) })
      .then(() => { closeSheet(); toast('技能已保存'); openAi(); })
      .catch((e) => toast(e.message));
    return;
  }
  if (a === 'ai-skill-del') {
    const name = act.dataset.name;
    if (!name || !confirm(`删除技能「${name}」？`)) return;
    api('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(() => { toast('已删除'); openAi(); })
      .catch((e) => toast(e.message));
    return;
  }
  const modelChip = e.target.closest('[data-model]');
  if (modelChip) {
    const input = $('#ai-model');
    if (input) input.value = modelChip.dataset.model;
    toast('已选择模型：' + modelChip.dataset.model);
    return;
  }
  if (a === 'weak') {
    const chapter = act.dataset.name;
    if (!chapter) { toast('先完成几道题，系统才能识别薄弱点'); return; }
    const subject = dailySubject();
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(subject)}&chapters=${encodeURIComponent(chapter)}&n=15&mock=0&year=10&difficulty=random`, chapter, subject, 'weak');
    return;
  }
  if (a === 'smart-paper') { openSmartPaper(); return; }
  if (a === 'smart-start') { startSmartPaper(); return; }
  if (a === 'diag-start') { startDiag(false); return; }
  if (a === 'diag-view') {
    S.diagResult = S.diag || loadDiag();
    if (!S.diagResult) { startDiag(false); return; }
    go('exam'); return;
  }
  if (a === 'diag-redo') { startDiag(false); return; }
  if (a === 'diag-close') { S.diagResult = null; go('exam'); return; }
  if (a === 'kp-practice') {
    const kp = act.dataset.kp;
    const subject = act.dataset.subject || S.lib.subject || dailySubject();
    if (!kp) return;
    startPracticeByUrl(`/api/practice?subject=${encodeURIComponent(subject)}&keypoint=${encodeURIComponent(kp)}&n=10&mock=0&year=10&difficulty=random`, kp, subject, 'kp');
    return;
  }
  if (a === 'kp-subject') {
    const subject = act.dataset.subject;
    if (!subject) return;
    S.lib.subject = subject;
    S.lib.kpSubject = (S.lib.kpSubjects || []).some((x) => x.subject === subject) ? subject : subject;
    openKeypoints(subject);
    return;
  }
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'ai-base-preset') {
    const v = e.target.value;
    if (v && v !== '__custom__') {
      const input = $('#ai-base');
      if (input) input.value = v;
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.id === 'search-input') {
    e.preventDefault();
    runSearch();
  }
  if (e.key === 'Enter' && e.target && e.target.id === 'ai-chat-input') {
    e.preventDefault();
    sendAiFollowup();
  }
});

async function reviewTrain() {
  try {
    // 模块筛选（回顾页 chips）选了什么，就只复习那个模块的错题
    const chap = S.review.chapter || '';
    const q = chap ? `&chapter=${encodeURIComponent(chap)}` : '';
    const due = dueIds();
    let ids = due.slice(0, 15);
    if (!ids.length) {
      const d = await api('/api/records/wrong?limit=15' + q + (S.settings.dropFixed === false ? '&keepFixed=1' : ''));
      ids = (d.list || d || []).map((x) => x.questionId || x.question_id || x.id).filter(Boolean).slice(0, 15);
    }
    if (!ids.length) { toast(chap ? `「${chap}」暂时没有需要复习的题` : '暂无需要复习的题'); return; }
    const qs = [];
    for (const id of ids) {
      try { const q = await api('/api/question?id=' + encodeURIComponent(id)); if (q && q.id != null) qs.push(q); } catch { /* skip */ }
    }
    if (!qs.length) { toast('题目加载失败'); return; }
    startPractice(qs, chap ? `复习 · ${chap}` : (due.length ? '今日复习' : '错题训练'), qs[0].subject || '', 'review');
  } catch (e) { toast(e.message); }
}
async function startNewDaily() {
  const n = Math.min(dailyRemaining(), 15);
  if (n <= 0) { toast('今日任务已完成'); return; }
  const list = await buildNewQuestions(n);
  if (!list.length) { toast('暂无题目'); return; }
  startPractice(list, `今日新题 · ${list.length} 题`, list[0].subject || dailySubject(), 'new');
}
/**
 * 每日任务里给「复习」留多少额度：
 * 复习最多占目标的 40%、且不超过 10 道。原来的做法是「有到期题就只做复习，
 * 没有才做新题」，等于两件事互相挤——到期一多，新题就永远排不上，
 * 到期少的时候又完全不复习。这里改成同一次任务里按额度混排。
 */
function reviewQuota() {
  const due = dueIds().length;
  const goal = dailyGoal();
  // 每天最多拿 40% 的额度去复习，但积压多的时候要跟着涨：
  // 原来写死上限 10，错题攒到 60 道还是「复习 10 道」，看起来像数字没更新
  const base = Math.round(goal * 0.4);
  const cap = Math.max(10, Math.round(due * 0.5));
  return Math.max(0, Math.min(due, Math.max(base, cap), Math.round(goal * 0.8)));
}
/** 按考试组合配额抽新题（客观题），返回题目数组 */
async function buildNewQuestions(n) {
  // 按考试组合分配额：浙江统考 = 职测 60% + 综应 40%，不会因为公基题多就全推公基
  const plan = quotaFor(n, true);
  const qs = [];
  const seen = new Set();
  let short = [];
  const focus = [];
  for (const p of plan) {
    let hit = 0;
    // 先补最弱的考点：70% 的新题从「你在这正确率最低」的考点里抽，
    // 剩下的随机补齐——全按弱项抽会偏科，考场上一科崩了照样过不了。
    const weak = weakKpList(p.subject).slice(0, 3);
    const wantKp = weak.length ? Math.round(p.n * 0.7) : 0;
    for (const w of weak) {
      if (hit >= wantKp) break;
      const take = Math.max(2, Math.ceil(wantKp / Math.min(weak.length, 3)));
      const band = diffBandForKp(p.subject, w.name, w.rate);
      // 实验版（0.7）：同一个难度档里再挑「最接近目标难度」的那几道。
      // 档位是粗的（易 1–4 / 中 5–6 / 难 7–9），档内随机等于把 1 分题和 4 分题当一样；
      // 这里多取 4 倍池子，按 |estimated - 目标| 排序，并用随机抖动保证每天不完全一样。
      const labTune = !!(window.__LAB__ && window.__ENGINE2__ && w.src === 'engine');
      const wantEst = band === 'easy' ? 3 : band === 'hard' ? 8 : 5;
      const poolN = labTune ? Math.min(Math.max(take * 4, take), 40) : take;
      let rows = w.src === 'engine'
        ? await fetchByChapter(p.subject, w.name, poolN, band)
        : await fetchByKp(p.subject, w.name, poolN, band);
      if (labTune && Array.isArray(rows) && rows.length > take) {
        // 0.7.2：有账本就按「这道题的预测正确率」贴近 ZPD 目标挑（每题带自己的难度估计），
        // 没有账本（新用户/没练过这个章节）才退回按 difficulty_est 的三档目标挑。
        const E2 = window.__ENGINE2__;
        rows = rows
          .map((q) => {
            let oc = 0;
            try { oc = Array.isArray(q.options) ? q.options.length : JSON.parse(q.options || '[]').length; } catch { oc = 0; }
            const p = E2.predict({ sub: p.subject, chapter: q.chapter || w.name, type: q.type, optionCount: oc, qid: q.id });
            const est = Number(q.difficultyEst ?? q.difficulty) || 5;
            const score = p == null
              ? Math.abs(est - wantEst) / 9
              : Math.abs(p - (E2.ZPD_TARGET || 0.75));
            return { q, score: score + Math.random() * 0.06 };
          })
          .sort((a, b) => a.score - b.score)
          .map((x) => x.q);
      }
      let got = 0;
      for (const q of rows) {
        const id = q.id ?? q.questionId;
        if (id == null || seen.has(id)) continue;
        seen.add(id); qs.push(q); hit++; got++;
        if (hit >= wantKp || got >= take) break;
      }
      if (got) focus.push({ name: w.label || w.name, rate: Math.round(w.rate * 100), sub: p.subject, src: w.src });
    }
    if (hit < p.n) {
      try {
        // 只抽客观题（单选/多选/判断）：综应、申论大部分是主观题，抽进每日任务等于给用户发作文题
        const got = await fetchPool(p.subject, p.n - hit);
        for (const q of got || []) {
          const id = q.id ?? q.questionId;
          if (id == null || seen.has(id)) continue;
          seen.add(id); qs.push(q); hit++;
          if (hit >= p.n) break;
        }
      } catch { /* ignore */ }
    }
    if (hit < p.n) short.push({ subject: p.subject, n: p.n - hit });
  }
  S.dailyFocus = focus.slice(0, 3);
  // 某科客观题不够（典型是综应），缺额按权重转给其余科目，别让用户少做题
  for (const s of short) {
    const donors = plan.filter((x) => x.subject !== s.subject);
    if (!donors.length) break;
    for (const d of donors) {
      if (s.n <= 0) break;
      try {
        const got = await api(`/api/practice?subject=${encodeURIComponent(d.subject)}&n=${s.n}&mock=0&year=10&difficulty=random&types=1,2,3`);
        for (const q of got || []) {
          const id = q.id ?? q.questionId;
          if (id == null || seen.has(id)) continue;
          seen.add(id); qs.push(q); s.n--;
          if (s.n <= 0) break;
        }
      } catch { /* ignore */ }
    }
  }
  // 各科都凑不够时，用主科补齐
  if (qs.length < n) {
    try {
      const more = await api(`/api/practice?subject=${encodeURIComponent(dailySubject())}&n=${n - qs.length}&mock=0&year=10&difficulty=random`);
      for (const q of more || []) { const id = q.id ?? q.questionId; if (!seen.has(id)) { seen.add(id); qs.push(q); } }
    } catch { /* ignore */ }
  }
  const list = qs.slice(0, n);
  return list;
}
/* ---------- 基础测评：组卷 ---------- */
// 每个模块（chapter）抽 6 题，按「2 易 + 3 中 + 1 难」分层，
// 目的是排序「哪块最弱」，不是报分数——36 题的样本算不出可信的总分。
async function buildDiagPaper() {
  const subject = dailySubject();
  let chapters = [];
  try { chapters = await api('/api/chapters?subject=' + encodeURIComponent(subject)); } catch { chapters = []; }
  const mods = (chapters || []).filter((g) => g && Number(g.total) > 0).slice(0, 6);
  const qs = [];
  const seen = new Set();
  for (const g of mods) {
    let rows = [];
    try {
      // 用 chapters（数组形式，走 IN 匹配）而不是 chapter：handler 会把 chapters 拆成数组，
      // 顺便修掉了 practice() 里对数组调 .split() 的崩溃（以前只有这个参数会炸）
      rows = await api(`/api/practice?subject=${encodeURIComponent(subject)}&chapters=${encodeURIComponent(g.group)}&n=20&mock=0&year=10&difficulty=random&types=1,2,3`);
    } catch { rows = []; }
    if (!rows.length) continue;
    const easy = rows.filter((q) => (Number(q.difficulty) || 0) <= 3);
    const mid = rows.filter((q) => (Number(q.difficulty) || 0) >= 4 && (Number(q.difficulty) || 0) <= 5);
    const hard = rows.filter((q) => (Number(q.difficulty) || 0) >= 6);
    // 库里难度分布很不均（职测大量题都标 5），按 2/3/1 分层的模块经常凑不满 6 题，
    // 所以先按分层挑，剩下的用其他难度补足——只挑出 3 题的模块，判级会太抖。
    const pick = [...easy.slice(0, 2), ...mid.slice(0, 3), ...hard.slice(0, 1)];
    const used = new Set(pick.map((q) => String(q.id ?? q.questionId)));
    for (const q of rows) {
      if (pick.length >= 6) break;
      const k = String(q.id ?? q.questionId);
      if (used.has(k)) continue;
      used.add(k); pick.push(q);
    }
    let took = 0;
    for (const q of pick) {
      const k = String(q.id ?? q.questionId);
      if (seen.has(k)) continue;
      seen.add(k); qs.push(q); took++;
      if (took >= 6) break;
    }
  }
  return { subject, qs };
}

async function startDiag(fromOnboard) {
  toast('正在按模块抽题，几秒钟…');
  const { subject, qs } = await buildDiagPaper();
  if (!qs.length) { toast('暂时组不出测评题，可以先用每日任务练着'); return; }
  startPractice(qs, '基础测评', subject, 'diag');
  const P = S.practice;
  // 测评走考试态：不即时判分、不做解析卡，交卷后一次性出画像
  P.exam = true;
  P.limitSec = qs.length * 50;
  P.remaining = P.limitSec;
  P.fromOnboard = !!fromOnboard;
  saveSession();
  renderPractice();
}

function buildDiagReport(P, used) {
  const byMod = new Map();
  const byKp = new Map();
  let right = 0;
  P.qs.forEach((q, i) => {
    const ok = !!P.answers[i]?.feedback?.ok;
    if (ok) right++;
    const mod = q.chapter || '未分类';
    const m = byMod.get(mod) || { name: mod, n: 0, ok: 0 };
    m.n++; if (ok) m.ok++; byMod.set(mod, m);
    if (q.kp) {
      const k = byKp.get(q.kp) || { name: q.kp, sub: q.subject || P.subject, n: 0, ok: 0 };
      k.n++; if (ok) k.ok++; byKp.set(q.kp, k);
    }
  });
  const rateOf = (x) => (x.n ? x.ok / x.n : 0);
  const modules = [...byMod.values()]
    .map((m) => ({ ...m, rate: rateOf(m), level: rateOf(m) >= 0.7 ? 'green' : rateOf(m) >= 0.4 ? 'yellow' : 'red' }))
    .sort((a, b) => a.rate - b.rate);
  const kps = [...byKp.values()].map((k) => ({ ...k, rate: rateOf(k) })).sort((a, b) => a.rate - b.rate).slice(0, 8);
  return {
    at: Date.now(), subject: P.subject, used: Math.round(used || 0),
    total: P.qs.length, right, modules, kps,
  };
}

function renderDiagResult() {
  const R = S.diagResult;
  if (!R) return renderExam();
  const pct = Math.round((R.right / Math.max(1, R.total)) * 100);
  const weak = R.modules[0];
  const lvText = { red: '要重点补', yellow: '有漏洞', green: '已掌握' };
  return `
  <div class="topline"><button class="icon-btn" data-act="diag-close">‹</button><span class="eyebrow">基础测评</span></div>
  <h1 class="page-title">你的能力画像</h1>
  <div class="card-sub" style="margin:-8px 0 14px">${esc(R.subject)} · ${R.total} 题 · 答对 ${R.right} · 用时 ${fmtTime(R.used || 0)}</div>
  <div class="card diag-hero">
    <div class="rbig">${pct}<i>%</i></div>
    <div class="rlab">这次测评的正确率</div>
    ${weak ? `<div class="diag-lead">最该补的是 <b>${esc(weak.name)}</b>（${Math.round(weak.rate * 100)}%）。已经按这个调整每日任务：新题会先从这里抽。</div>` : ''}
  </div>
  <div class="section-head"><h2 class="section-title">按模块看</h2><span class="muted" style="font-size:12px">红 = 先补</span></div>
  <div class="card list-card">${R.modules.map((m) => `
    <div class="diag-row">
      <div class="diag-main">
        <div class="diag-name">${esc(m.name)}<span class="tag ${m.level === 'red' ? 'warn' : m.level === 'green' ? 'ok' : ''}">${lvText[m.level]}</span></div>
        <div class="diag-bar"><i class="lv-${m.level}" style="width:${Math.round(m.rate * 100)}%"></i></div>
      </div>
      <div class="diag-pct">${Math.round(m.rate * 100)}%<span>${m.ok}/${m.n}</span></div>
    </div>`).join('')}</div>
  ${R.kps.length ? `<div class="section-head"><h2 class="section-title">最弱的考点</h2><span class="muted" style="font-size:12px">点一下直接练</span></div>
  <div class="card list-card">${R.kps.slice(0, 6).map((k) => `<button class="kp-diag-row" data-act="kp-practice" data-kp="${esc(k.name)}" data-subject="${esc(k.sub || R.subject)}"><span>${esc(k.name)}</span><em>${Math.round(k.rate * 100)}%</em><i class="chev">›</i></button>`).join('')}</div>` : ''}
  <div class="home-alt" style="margin-top:14px"><span>这份测评只用来排序强弱，<b>不预测分数</b></span><span class="home-alt-r">${S.diag ? '已保存' : ''}</span></div>
  <button class="btn btn-ghost btn-block" data-act="diag-redo" style="margin-top:12px">重新测一次</button>
  <button class="btn btn-primary btn-block" data-act="diag-close" style="margin-top:8px">回考试</button>`;
}


async function startDailyTask() {
  const remain = dailyRemaining();
  if (remain <= 0) { toast('今日任务已完成，想多练可以点「继续上次」或随机练习'); return; }
  const qs = [];
  const seen = new Set();
  // 先安排到期复习：错过的题不补，明天只会滚得更大
  const rq = Math.min(reviewQuota(), remain);
  if (rq > 0) {
    for (const id of dueIds().slice(0, rq)) {
      try {
        const q = await api('/api/question?id=' + encodeURIComponent(id));
        if (q && q.id != null && !seen.has(q.id)) { seen.add(q.id); qs.push(q); }
      } catch { /* 单题取不到就跳过 */ }
    }
  }
  const newN = Math.min(remain - qs.length, 15);
  if (newN > 0) {
    const fresh = await buildNewQuestions(newN);
    for (const q of fresh) {
      const id = q.id ?? q.questionId;
      if (id == null || seen.has(id)) continue;
      seen.add(id); qs.push(q);
    }
  }
  if (!qs.length) { toast('暂无题目'); return; }
  const rn = qs.length - Math.min(newN, qs.length);
  const label = rn > 0 ? `复习 ${rn} + 新题 ${qs.length - rn}` : `新题 ${qs.length}`;
  startPractice(qs, `今日任务 · ${label}`, qs[0].subject || dailySubject(), rn > 0 ? 'review' : 'new');
}
function openSmartPaper() {
  const d = S.smart;
  const weak = weakPoints();
  const chip = (key, val, label, active) => `<button class="chip ${active ? 'active' : ''}" data-smart="${key}" data-val="${val}">${label}</button>`;
  const typeActive = d.types.join(',');
  sheet(`<div class="sheet-head"><b>智能组卷</b><button class="sheet-close">✕</button></div>
    <div class="filter-label">范围</div><div class="chips">${chip('scope', 'weak', '薄弱优先', d.scope === 'weak')}${chip('scope', 'all', '全部模块', d.scope === 'all')}</div>
    <div class="card-sub" style="margin:6px 0 12px">${d.scope === 'weak' ? `薄弱：${weak.map((w) => w.label || w.name).slice(0, 3).join(' / ') || '先做几道题才有薄弱数据'}` : '按官方卷型模块配额组卷'}</div>
    <div class="filter-label">题量</div><div class="chips">${[15, 20, 30, 50].map((n) => chip('count', n, `${n} 题`, d.count === n)).join('')}</div>
    <div class="filter-label">难度</div><div class="chips">${[['random', '随机'], ['easy', '基础'], ['balanced', '进阶'], ['hard', '挑战']].map(([v, l]) => chip('difficulty', v, l, d.difficulty === v)).join('')}</div>
    <div class="filter-label">年份</div><div class="chips">${[['all', '全部'], ['3', '近 3 年'], ['5', '近 5 年'], ['10', '近 10 年']].map(([v, l]) => chip('year', v, l, d.year === v)).join('')}</div>
    <div class="filter-label">题型</div><div class="chips">${[['1', '单选'], ['1,2,3', '客观题'], ['2', '多选'], ['3', '判断']].map(([v, l]) => chip('types', v, l, typeActive === v || (v === '1,2,3' && typeActive === '1,2,3'))).join('')}</div>
    <div class="card-sub" style="margin:8px 0 12px">${dailySubject() === '事业编·职测' ? '职测按联考 A 类官方卷型题量生成' : '行测按官方模块配额生成'}</div>
    <button class="btn btn-primary btn-block" data-act="smart-start">生成试卷</button>`);
}
async function startSmartPaper() {
  const d = S.smart;
  const subject = dailySubject();
  closeSheet();
  toast('正在组卷…');
  if (d.year !== 'all') {
    const chapters = d.scope === 'weak' ? weakPoints().map((w) => w.name) : [];
    const url = `/api/practice?subject=${encodeURIComponent(subject)}&n=${d.count}&mock=0&year=${encodeURIComponent(d.year)}&difficulty=${encodeURIComponent(d.difficulty)}${chapters.length ? '&chapters=' + encodeURIComponent(chapters.join(',')) : ''}`;
    await startPracticeByUrl(url, `智能组卷 · 近 ${d.year} 年`, subject, 'smart');
    return;
  }
  try {
    const r = await api('/api/paper/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject, count: d.count, difficulty: d.difficulty, types: d.types,
        weak: d.scope === 'weak' ? weakPoints().map((w) => w.name) : [],
      }),
    });
    if (!r || r.ok === false) { toast(r?.error || '组卷失败'); return; }
    if (!Array.isArray(r.questions) || !r.questions.length) { toast('题库资源不足，换个条件试试'); return; }
    startPractice(r.questions, r.title || '智能组卷', r.subject || subject, 'smart');
    if (r.notice) setTimeout(() => toast(r.notice), 300);
  } catch (e) { toast(e.message); }
}
async function startExam(n = 10, title = '模拟考试') {
  S.examResult = null;
  $('#practice').hidden = false;
  $('#p-body').innerHTML = '<div class="spinner"></div>';
  try {
    // 组卷菜单也走「考试组合」：选的是浙江统考就只出职测题，
    // 不会再因为公基题多就把整场模考刷成公基。主观题不进模考（没法自动判分）。
    const plan = quotaFor(n, true);
    const parts = [];
    const seen = new Set();
    for (const p of plan) {
      if (p.n <= 0) continue;
      const rows = await fetchPool(p.subject, p.n);
      for (const q of rows) {
        const k = String(q.questionId || q.id);
        if (seen.has(k)) continue;
        seen.add(k); parts.push(q);
      }
    }
    const qs = parts;
    if (!qs.length) { $('#practice').hidden = true; toast('暂无题目'); return; }
    const primary = (plan.find((p) => p.n > 0) || {}).subject || dailySubject();
    const sec = secPerQ(primary);
    startPractice(qs, `${title} · ${qs.length} 题`, primary, 'exam');
    const P = S.practice;
    P.exam = true;
    // 用「实际拿到的题数 × 每题秒数」，不用请求的 n：
    // 题池不够时只会给到 15 题，按 n 计时就会出现「10 题却给了 15 分钟」。
    P.limitSec = Math.max(60, Math.round((qs.length * sec) / 10) * 10);
    P.remaining = P.limitSec;
    renderPractice();
    saveSession();
  } catch (e) {
    $('#practice').hidden = true;
    toast(e.message);
  }
}
let examSubmitting = false;
function requestSubmitExam() {
  const P = S.practice;
  saveCurrentAnswer();
  if (!P.open) return;
  const blankIdx = P.qs.map((q, i) => (P.answers[i]?.selected == null ? i : -1)).filter((i) => i >= 0);
  const blanks = blankIdx.length;
  if (!blanks) { submitExam(); return; }
  const fg = P.flagged || {};
  const flagIdx = Object.keys(fg).filter((k) => fg[k]).map(Number).sort((a, b) => a - b);
  const short = (arr, n) => arr.slice(0, n).map((i) => `<span class="nb">${i + 1}</span>`).join('、') + (arr.length > n ? ` 等 ${arr.length} 题` : '');
  sheet(`<div class="sheet-head"><b>确认交卷</b><button class="sheet-close">✕</button></div>
    <div class="card-sub" style="margin:0 0 10px">还有 <b>${blanks}</b> 题未作答，未答题按错题计。</div>
    <div class="submit-blank">未答：${short(blankIdx, 20)}</div>
    ${flagIdx.length ? `<div class="submit-blank flag">待定：${short(flagIdx, 20)}</div>` : ''}
    <button class="btn btn-primary btn-block" style="margin-top:14px" data-act="exam-submit-confirm">确定交卷</button>
    <button class="btn btn-ghost btn-block" style="margin-top:8px" data-act="close-sheet">回去再看两题</button>`);
}
async function submitExam() {
  const P = S.practice;
  if (!P.open || examSubmitting) return;
  examSubmitting = true;
  saveCurrentAnswer();
  tickQCost();
  P.open = false;
  clearInterval(P.timer);
  let right = 0;
  for (let i = 0; i < P.qs.length; i++) {
    const q = P.qs[i];
    const a = P.answers[i];
    if (!a || !hasSel(a.selected)) continue;
    try {
      const r = await api('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, selected: a.selected }) });
      P.answers[i] = { ...a, confirmed: true, feedback: r };
      if (r.ok) right++;
      updateReview(q.id, !!r.ok, Number((P.qCost || {})[i]) || 0, q.difficulty);
      await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, subject: q.subject || P.subject, chapter: q.chapter, type: q.type, selected: selArr(a.selected), correct: r.ok, costMs: Number((P.qCost || {})[i]) || 0, autoDrop: S.settings.dropFixed !== false }) }).catch(() => {});
    } catch { /* 单题判分失败不阻塞交卷 */ }
  }
  P.lastWrongIds = P.qs.filter((q, i) => P.answers[i]?.confirmed && !P.answers[i].feedback?.ok).map((q) => q.id);
  await attachKeypoints(P.qs);
  feedEngine(P);
  const diagUsed = Math.max(0, (P.limitSec || 0) - P.remaining);
  if (P.kind === 'diag') {
    // 测评不进模考历史：它不是一次考试，是给引擎喂的先验
    const rep = buildDiagReport(P, diagUsed);
    saveDiag(rep);
    S.diagResult = rep;
    S.examResult = null;
    clearSession();
    $('#practice').hidden = true;
    try { await refreshStats(); } catch { /* ignore */ }
    go('exam');
    toast('测评完成，已按结果调整每日任务的出题重点');
    return;
  }
  clearSession();
  $('#practice').hidden = true;
  try { await refreshStats(); } catch { /* ignore */ }
  const used = Math.max(0, (P.limitSec || 0) - P.remaining);
  const wrong = P.qs.length - right;
  const answered = P.qs.filter((q, i) => P.answers[i]?.selected != null).length;
  const flaggedIdx = Object.keys(P.flagged || {}).filter((k) => P.flagged[k]).map(Number).sort((a, b) => a - b);
  S.examResult = {
    title: P.title, subject: P.subject, right, total: P.qs.length, used,
    kind: P.paperId ? '整卷' : '随机',
    year: P.paperYear || 0,
    region: P.paperRegion || '',
    flagged: flaggedIdx,
    costs: P.qs.map((_, i) => Number((P.qCost || {})[i]) || 0),
    items: P.qs.map((q, i) => ({ q, a: P.answers[i] || null })),
  };
  reviewFilter = wrong > 0 ? 'wrong' : 'all';
  saveExamHistory({
    ts: Date.now(),
    title: P.title,
    subject: P.subject,
    right,
    total: P.qs.length,
    used,
    kind: P.paperId ? '整卷' : '随机',
    year: P.paperYear || 0,
    region: P.paperRegion || '',
    // 逐题存档：只存 id / 对错 / 选项 / 用时，几十 KB；靠它才能事后回看这一场的逐题解析
    items: P.qs.map((q, i) => ({
      id: q.id,
      ch: q.chapter || '',
      ok: !!P.answers[i]?.feedback?.ok,
      sel: P.answers[i]?.selected == null ? null : Number(P.answers[i].selected),
      ans: q.answerIndex == null ? null : Number(q.answerIndex),
      cost: Number((P.qCost || {})[i]) || 0,
    })),
    mods: [...new Map(P.qs.map((q, i) => {
      const k = q.chapter || '未分类';
      const m = { name: k, total: 0, right: 0 };
      return [k, m];
    })).values()],
  });
  try {
    const hist = loadExamHistory();
    const last = hist[hist.length - 1];
    if (last) {
      const mm = new Map();
      P.qs.forEach((q, i) => {
        const k = q.chapter || '未分类';
        const e = mm.get(k) || { name: k, total: 0, right: 0 };
        e.total++;
        if (P.answers[i]?.feedback?.ok) e.right++;
        mm.set(k, e);
      });
      last.mods = [...mm.values()];
      saveExamHistory(last, true);
    }
  } catch { /* ignore */ }
  sheet(`<div class="sheet-head"><b>交卷完成</b><button class="sheet-close">✕</button></div><div style="text-align:center;padding:8px 0 18px"><div style="font-size:38px;font-weight:750;letter-spacing:-.03em">${right} / ${P.qs.length}</div><div class="card-sub">答对 ${right} 题 · 未答 ${P.qs.length - answered} 题 · 用时 ${fmtTime(used)}</div></div><button class="btn btn-primary btn-block" data-act="exam-review">查看逐题解析</button>${wrong ? `<button class="btn btn-ghost btn-block" data-act="retry-wrong" style="margin-top:8px">错题再练（${wrong} 题${wrong > answered ? '，含未答' : ''}）</button>` : ''}<button class="btn btn-ghost btn-block" data-act="close-sheet" style="margin-top:8px">回到首页</button>`);
  examSubmitting = false;
  loadHome().then(() => { if (S.tab === 'home') go('home'); }).catch(() => {});
}
async function fetchQuestions(ids) {
  const arr = await Promise.all(ids.map((id) => api('/api/question?id=' + encodeURIComponent(id)).catch(() => null)));
  return arr.filter((q) => q && q.id != null);
}
/** 给题目补考点名（question_keypoints 表）。报告要按考点下钻，题面本身不带考点 */
async function attachKeypoints(qs) {
  const ids = (qs || []).map((q) => q && q.id).filter((x) => x != null);
  if (!ids.length) return qs;
  try {
    const map = await api('/api/kp?ids=' + ids.join(','));
    for (const q of qs) { if (q && map && map[q.id] != null) q.kp = map[q.id]; }
  } catch { /* 拿不到考点不影响报告主体 */ }
  return qs;
}
async function resumeSession() {
  const s = loadSession();
  if (!s) { toast('没有可继续的练习'); return; }
  $('#practice').hidden = false;
  $('#p-body').innerHTML = '<div class="spinner"></div>';
  const qs = await fetchQuestions(s.ids);
  if (qs.length !== s.ids.length) { clearSession(); $('#practice').hidden = true; toast('上次练习已失效'); return; }
  startPractice(qs, s.title, s.subject, s.kind, s);
}
/* ---------- 模考历史（本地存档） ---------- */
const EXAM_HIST_KEY = 'sg_exam_history_v1';
// 交卷后复盘页的筛选：all=全部 / wrong=错题（含未答）/ flag=待定
let reviewFilter = 'all';
function loadExamHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(EXAM_HIST_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function saveExamHistory(rec, replaceLast) {
  try {
    const a = loadExamHistory();
    if (replaceLast) a[a.length - 1] = rec; else a.push(rec);
    while (a.length > 50) a.shift();   // 只留最近 50 次
    localStorage.setItem(EXAM_HIST_KEY, JSON.stringify(a));
  } catch { /* ignore */ }
}
function openExamHistory() {
  const a = loadExamHistory().slice().reverse();
  const rows = a.map((r) => {
    const rate = r.total ? Math.round((r.right / r.total) * 100) : 0;
    const score = Math.round((r.right / (r.total || 1)) * 1000) / 10;
    const d = new Date(r.ts);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const canOpen = Array.isArray(r.items) && r.items.length;
    return `<div class="hist-row${canOpen ? ' openable' : ''}"${canOpen ? ` data-act="hist-detail" data-ts="${r.ts}"` : ''}>
      <div class="hist-main"><div class="hist-title">${esc(r.title || '模考')}</div>
      <div class="hist-sub">${when} · ${esc(r.kind || '随机')} · ${r.total} 题 · 用时 ${fmtTime(r.used || 0)}${canOpen ? ' · 点开复盘' : ''}</div></div>
      <div class="hist-score"><b>${score}</b><span>${r.right}/${r.total} · ${rate}%</span></div>
    </div>`;
  }).join('');
  sheet(`<div class="sheet-head"><b>模考成绩单</b><button class="sheet-close">✕</button></div>
    <div style="max-height:62vh;overflow-y:auto">${rows || '<div class="empty-state">还没有模考记录<br><span class="muted">交卷一次就会出现在这里</span></div>'}</div>`);
}
/* 打开某一场的逐题复盘：从本地存档恢复（题目本体从题库按 id 取，不用联网） */
async function openHistDetail(ts) {
  const rec = loadExamHistory().find((x) => Number(x.ts) === Number(ts));
  if (!rec) { toast('这条记录已不在本地'); return; }
  if (!Array.isArray(rec.items) || !rec.items.length) { toast('这次模考没有存逐题记录'); return; }
  const qs = await fetchQuestions(rec.items.map((i) => i.id));
  await attachKeypoints(qs);
  const byId = new Map(qs.map((q) => [String(q.id), q]));
  const items = rec.items.map((it) => {
    const q = byId.get(String(it.id));
    if (!q) return null;
    const ai = it.ans != null ? Number(it.ans) : q.answerIndex != null ? Number(q.answerIndex) : null;
    const a = it.sel == null ? null : { selected: Number(it.sel), confirmed: true, feedback: { ok: !!it.ok, correct: ai == null ? [] : [ai] } };
    return { q, a };
  }).filter(Boolean);
  if (!items.length) { toast('这些题已不在当前题库里'); return; }
  S.examResult = {
    title: rec.title, subject: rec.subject, right: rec.right, total: rec.total, used: rec.used || 0,
    kind: rec.kind || '随机', year: rec.year || 0, region: rec.region || '',
    flagged: [], costs: rec.items.map((i) => Number(i.cost) || 0), items, fromHistory: true,
  };
  reviewFilter = S.examResult.right < S.examResult.total ? 'wrong' : 'all';
  closeSheet();
  go('exam');
}

/* 真题整卷模考：把一份真卷原样做一遍，计时交卷 */
async function startPaperExam(paperId, name, subject) {
  S.examResult = null;
  $('#practice').hidden = false;
  $('#p-body').innerHTML = '<div class="spinner"></div>';
  try {
    const p = await api('/api/papers/' + encodeURIComponent(paperId));
    const qs = p.questions || [];
    if (!qs.length) { $('#practice').hidden = true; toast('这份卷子没有题目'); return; }
    startPractice(qs, p.name || name || '整卷模考', p.subjectName || subject, 'paper');
    const P = S.practice;
    P.exam = true;
    P.paperId = Number(paperId) || 0;
    // 年份/地区记下来，交卷后进成绩单，用来做「按年份 / 按省份」的趋势对比
    const ym = String(p.name || name || '').match(/20\d{2}/);
    P.paperYear = ym ? Number(ym[0]) : 0;
    P.paperRegion = String(p.category || '').trim();
    P.limitSec = Math.max(600, qs.length * 55);   // 行测约 55 秒/题，最少 10 分钟
    P.remaining = P.limitSec;
    renderPractice();
    saveSession();
  } catch (e) {
    $('#practice').hidden = true;
    toast(e.message);
  }
}

function openAnswerCard() {
  const P = S.practice;
  const isDone = (a) => !!a?.confirmed || (P.exam && a?.selected != null);
  const fg = P.flagged || {};
  const cells = P.qs.map((q, i) => {
    const a = P.answers[i];
    const cls = [isDone(a) ? 'done' : '', fg[i] ? 'flag' : '', i === P.idx ? 'cur' : ''].filter(Boolean).join(' ');
    return `<button class="ag-cell ${cls}" data-jump="${i}">${i + 1}</button>`;
  }).join('');
  const answered = P.qs.filter((q, i) => isDone(P.answers[i])).length;
  const nFlag = Object.keys(fg).filter((k) => fg[k]).length;
  const blank = P.qs.length - answered;
  sheet(`<div class="sheet-head"><b>答题卡</b><button class="sheet-close">✕</button></div>
    <div class="ag-legend"><span><i class="ag-dot done"></i>已答 ${answered}</span><span><i class="ag-dot"></i>未答 ${blank}</span><span><i class="ag-dot flag"></i>待定 ${nFlag}</span></div>
    <div class="answer-grid">${cells}</div>
    <div class="card-sub" style="text-align:center;margin-top:12px">点击题号跳转 · 顶栏旗子图标可标记待定</div>
    ${P.exam ? `<button class="btn btn-primary btn-block" style="margin-top:12px" data-act="exam-submit">交卷（还剩 ${fmtTime(P.remaining)}）</button>` : ''}`);
}
function openNoteSearch() {
  const notes = S.review.data.notes || [];
  const render = (kw) => {
    const q = String(kw || '').trim().toLowerCase();
    const list = q ? notes.filter((n) => `${n.content} ${n.note} ${n.chapter}`.toLowerCase().includes(q)) : notes;
    return list.length ? list.map((n) => `<div class="list-item" data-note-qid="${n.questionId}" style="cursor:pointer"><div class="list-main"><div class="item-snippet">${esc(n.note || n.content || '(无内容)')}</div><div class="item-bottom"><span class="tag">${esc(n.subject || '')}</span><span class="tag">${esc(n.chapter || '')}</span></div></div></div>`).join('') : '<div class="empty-state">没有匹配的笔记</div>';
  };
  sheet(`<div class="sheet-head"><b>搜索笔记</b><button class="sheet-close">✕</button></div><input class="field" id="note-search-input" placeholder="输入笔记或题干关键词"><div id="note-search-list" style="max-height:55vh;overflow-y:auto;margin-top:10px">${render('')}</div>`);
  const input = $('#note-search-input');
  input.oninput = () => { $('#note-search-list').innerHTML = render(input.value); };
  $('#note-search-list').onclick = (e) => {
    const b = e.target.closest('[data-note-qid]');
    if (!b) return;
    closeSheet();
    openQuestionById(Number(b.dataset.noteQid), '笔记');
  };
  setTimeout(() => input.focus(), 80);
}

function openCorrection() {
  const q = currentQ();
  if (!q) return;
  sheet(`<div class="sheet-head"><b>题目纠错</b><button class="sheet-close">✕</button></div><div class="card-sub" style="margin:0 0 10px">说明题干、答案或解析哪里有问题；会保存到回顾笔记。</div><textarea class="field" id="correction-text" rows="5" maxlength="500" placeholder="例如：答案应为 C，解析中第二条理由不成立"></textarea><button class="btn btn-primary btn-block" style="margin-top:12px" data-act="correction-save">提交纠错</button>`);
}

async function openNoteEditor() {
  const q = currentQ();
  if (!q) return;
  let note = '';
  try { const d = await api('/api/notes?qid=' + encodeURIComponent(q.id)); note = d.list?.[0]?.note || ''; } catch { /* ignore */ }
  sheet(`<div class="sheet-head"><b>写笔记</b><button class="sheet-close">✕</button></div><textarea class="field" id="note-text" rows="6" maxlength="500" placeholder="记录思路、易错点、口诀…">${esc(note)}</textarea><button class="btn btn-primary btn-block" style="margin-top:12px" data-act="note-save">保存笔记</button>`);
}
function scrollAi(target = 'card') {
  setTimeout(() => {
    const el = document.querySelector(target === 'chat' ? '.ai-chat' : '.ai-card');
    if (el) el.scrollIntoView({ block: 'center' });
  }, 40);
}
/**
 * 主观题（申论/综应）作答 + AI 批改面板。
 * 批改走后端 /api/ai/grade，用的是「申论批改 AI」那个 agent（role=shenlun-grader），
 * 它挂的内置技能就是 shenlun-master，会在 callChat 里自动注入 SKILL.md 全文。
 */
function gradeBox(q) {
  const P = S.practice;
  const saved = P.answers[P.idx] || {};
  const g = saved.grade;
  const sk = S.graderSkill || null;
  const skLine = sk
    ? `技能 ${esc(sk.name)}${sk.loaded ? `（已装载${sk.files ? ' ' + sk.files + ' 个文件' : ''}）` : '（批改时自动注入）'}`
    : '内置技能 shenlun-master';
  const needKey = !!(g && /api_key|未配置/.test(g.content || ''));
  return `<div class="grade-box">
    <div class="grade-h"><b>AI 批改</b><span class="grade-sub">写下你的作答，按阅卷标准逐点给分；用的是${skLine}</span></div>
    <textarea class="field grade-input" id="grade-input" rows="6" placeholder="把作答写在这里（分条、带序号更容易采分）">${esc(saved.text || '')}</textarea>
    <div class="grade-acts">
      <button class="btn btn-ghost btn-sm" data-act="show-answer">看参考答案</button>
      <button class="btn btn-primary btn-sm" data-act="ai-grade" ${P.gradeLoading ? 'disabled style="opacity:.45"' : ''}>${P.gradeLoading ? '批改中…' : '批改这份作答'}</button>
    </div>
    ${P.gradeLoading ? '<div class="ai-loading"><span class="spinner ai-spinner"></span><span>AI 正在按阅卷标准批改…</span></div>' : ''}
    ${g ? `<div class="grade-card">${g.score ? `<div class="grade-score">${esc(g.score)}</div>` : ''}<div class="grade-body">${aiRichText(g.content || '')}</div><div class="grade-foot">${g.fullScore ? `满分 ${g.fullScore} 分 · ` : ''}${skLine}</div>${needKey ? '<button class="btn btn-ghost btn-sm" data-act="ai" style="margin-top:10px">去配 AI Key →</button>' : ''}</div>` : ''}
  </div>`;
}
async function aiGrade() {
  const P = S.practice;
  const q = currentQ();
  if (!q || P.gradeLoading) return;
  const box = document.querySelector('#grade-input');
  const text = (box?.value || '').trim();
  if (text.length < 10) {
    toast('作答太短了，先写几句再批改');
    box?.focus();
    return;
  }
  P.answers[P.idx] = { ...(P.answers[P.idx] || {}), text };
  P.gradeLoading = true;
  renderPractice();
  try {
    // 内置技能没装就先装（装失败也继续：resolveSkillLocal 会直接读 bundle 兜底）
    await ensureBuiltinSkills().catch(() => 0);
    // 记一下批改 agent 挂的是哪套技能、有没有装载成功，渲染在卡片脚注里
    if (!S.graderSkill) {
      const ags = await api('/api/ai/agents').catch(() => []);
      const gd = (ags || []).find((x) => x.role === 'shenlun-grader');
      S.graderSkill = { name: gd?.skill || 'shenlun-master', loaded: !!gd?.skill_loaded, files: gd?.skill_loaded?.files || 0 };
    }
    const r = await api('/api/ai/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.id, content: text }),
    });
    const cur = P.answers[P.idx] || { text };
    // 本地接口返回 { notice, result, fullScore }；服务端返回 { content, fullScore }
    const content = r?.result || r?.content || '';
    if (!content) {
      const why = r?.notice || r?.error || '没有拿到批改结果';
      P.answers[P.idx] = { ...cur, grade: { content: `批改没跑起来：${why}`, score: '' } };
      toast(why);
    } else {
      const m = /【评分】\s*([^\n]{1,40})/.exec(content);
      P.answers[P.idx] = { ...cur, grade: { content, score: m ? m[1].trim() : '', fullScore: r.fullScore || '' } };
      // 批改结果落库（IndexedDB essays），回顾 → 批改 里能回看，也能看分数趋势
      api('/api/essays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: q.id,
          subject: q.subject || '',
          chapter: q.chapter || '',
          answer: text,
          content,
          score: m ? m[1].trim() : '',
          fullScore: r.fullScore || null,
        }),
      }).then(() => { S.review.data.essays = null; delete S.review.data.essayStats; }).catch(() => {});
    }
  } catch (e) {
    P.answers[P.idx] = { ...(P.answers[P.idx] || {}), grade: { content: `批改失败：${e.message}`, score: '' } };
    toast('批改失败：' + e.message);
  } finally {
    P.gradeLoading = false;
    saveCurrentAnswer();
    saveSession();
    renderPractice();
  }
}
async function aiExplain() {
  const q = currentQ();
  const P = S.practice;
  if (!q || P.aiLoading) return;
  P.aiLoading = true;
  P.aiError = '';
  renderPractice();
  scrollAi('card');
  try {
    const r = await api('/api/ai/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, selected: P.selected, correct: P.feedback?.ok ?? null }) });
    P.ai = r.content || r.notice || 'AI 解析失败';
    P.aiCached = !!r.cached;
    P.answers[P.idx] = { ...(P.answers[P.idx] || {}), ai: P.ai, cached: P.aiCached };
    saveSession();
  } catch (e) {
    P.ai = `AI 解析失败：${e.message}`;
  } finally {
    P.aiLoading = false;
    renderPractice();
    scrollAi('card');
    saveCurrentAnswer();
    saveSession();
  }
}
async function sendAiFollowup() {
  const P = S.practice;
  const q = currentQ();
  const input = $('#ai-chat-input');
  const text = (input?.value || '').trim();
  if (!q || !text || P.aiLoading) return;
  P.aiChat.push({ role: 'user', content: text });
  P.aiLoading = true;
  renderPractice();
  scrollAi('chat');
  saveCurrentAnswer();
  saveSession();
  try {
    const r = await api('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: q.id,
        messages: P.aiChat,
        questionData: { content: q.content, options: q.options, answer: q.answer, analysis: q.analysis, material: q.material },
        explanation: P.ai,
      }),
    });
    P.aiChat.push({ role: 'assistant', content: r.content || r.notice || 'AI 没有返回内容' });
  } catch (e) {
    P.aiChat.push({ role: 'assistant', content: `追问失败：${e.message}` });
  }
  P.aiLoading = false;
  saveCurrentAnswer();
  saveSession();
  renderPractice();
  scrollAi('chat');
}
function openProfile() {
  if (!S._draft) S._draft = { ...S.profile };
  const p = S._draft;
  sheet(`<div class="sheet-head"><b>备考档案</b><button class="sheet-close">✕</button></div>
    <div class="filter-label">考试名称</div><input class="field" id="pf-name" value="${esc(p.examName || '')}" placeholder="如 2027 国考">
    <div class="filter-label">考试日期</div><input class="field" id="pf-date" type="date" value="${esc(p.examDate || '')}">
    <div class="filter-label">考试类型</div><div class="chips">${['公务员', '事业编', '三支一扶'].map((x) => `<button class="chip ${p.examType === x ? 'active' : ''}" data-profile-exam="${x}">${x}</button>`).join('')}</div>
    <div class="filter-label">省份</div><div class="chips">${['全国', '山东', '江苏', '浙江', '广东', '河南', '四川'].map((x) => `<button class="chip ${p.province === x ? 'active' : ''}" data-profile-province="${x}">${x}</button>`).join('')}</div>
    <div class="filter-label">每日题量</div><div class="chips">${[15, 20, 30, 50].map((x) => `<button class="chip ${p.dailyGoal === x ? 'active' : ''}" data-profile-goal="${x}">${x} 题</button>`).join('')}</div>
    ${(() => {
      // 考试组合：决定「每日任务抽哪几科、各几道」，不跟着题库题量走
      const sch = p.scheme || currentScheme().name;
      const opts = Object.entries(EXAM_SCHEMES).filter(([, v]) => v.type === (p.examType || '公务员'));
      const cur = EXAM_SCHEMES[sch] || opts[0]?.[1];
      return `<div class="filter-label">考试组合<span class="filter-hint" style="font-weight:400;color:var(--text-3);margin-left:6px">决定每天抽哪几科</span></div>
        <div class="chips">${opts.map(([name]) => `<button class="chip ${name === sch ? 'active' : ''}" data-profile-scheme="${esc(name)}">${esc(name.split('·')[1] || name)}</button>`).join('')}</div>
        ${cur ? `<div class="card-sub" style="margin-top:6px">每日任务按此比例分配：${cur.subs.map(([s, w]) => `${esc(s.split('·')[1])} ${w}`).join(' : ')}</div>` : ''}`;
    })()}
    ${(() => {
      const sch = EXAM_SCHEMES[p.scheme || currentScheme().name];
      if (!sch) return '';
      const off = new Set(p.excluded || []);
      return `<div class="filter-label">我不考（从选题池剔除）</div>
        <div class="chips">${sch.subs.map(([s]) => `<button class="chip ${off.has(s) ? 'active' : ''}" data-profile-exclude="${esc(s)}">${esc(s.split('·')[1])}</button>`).join('')}</div>
        <div class="card-sub" style="margin-top:6px">选中的科目不会被每日任务和随机练习抽到，题库里仍可手动进入</div>`;
    })()}
    <button class="btn btn-primary btn-block" style="margin-top:14px" data-act="profile-save">保存</button>`);
}
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') { localStorage.removeItem('theme'); root.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  else { localStorage.setItem('theme', mode); root.setAttribute('data-theme', mode); }
  if (S.tab === 'me') go('me');
}

document.addEventListener('click', (e) => {
  const ex = e.target.closest('[data-profile-exam]');
  const pr = e.target.closest('[data-profile-province]');
  const gl = e.target.closest('[data-profile-goal]');
  const sc = e.target.closest('[data-profile-scheme]');
  const exd = e.target.closest('[data-profile-exclude]');
  if (ex) { S._draft = { ...(S._draft || S.profile), examType: ex.dataset.profileExam }; openProfile(); return; }
  if (pr) { S._draft = { ...(S._draft || S.profile), province: pr.dataset.profileProvince }; openProfile(); return; }
  if (gl) { S._draft = { ...(S._draft || S.profile), dailyGoal: Number(gl.dataset.profileGoal) }; openProfile(); return; }
  if (sc) { S._draft = { ...(S._draft || S.profile), scheme: sc.dataset.profileScheme, excluded: [] }; openProfile(); return; }
  if (exd) {
    const cur = new Set((S._draft || S.profile).excluded || []);
    const k = exd.dataset.profileExclude;
    if (cur.has(k)) cur.delete(k); else cur.add(k);
    const arr = [...cur];
    // 不能把科目全剔了，否则每日任务无题可抽
    const sch = EXAM_SCHEMES[(S._draft || S.profile).scheme || currentScheme().name];
    if (sch && arr.length >= sch.subs.length) { toast('至少要留一科'); return; }
    S._draft = { ...(S._draft || S.profile), excluded: arr }; openProfile(); return;
  }
  const obExam = e.target.closest('[data-ob-exam]');
  const obProv = e.target.closest('[data-ob-province]');
  const obDate = e.target.closest('[data-ob-date]');
  const obGoal = e.target.closest('[data-ob-goal]');
  if (obExam) { S.ob.draft.examType = obExam.dataset.obExam; const ds = OB_DATES[S.ob.draft.examType]; S.ob.draft.examName = ds[0].name; S.ob.draft.examDate = ds[0].date; renderOnboarding(); return; }
  if (obProv) { S.ob.draft.province = obProv.dataset.obProvince; renderOnboarding(); return; }
  if (obDate) { S.ob.draft.examDate = obDate.dataset.obDate; S.ob.draft.examName = obDate.dataset.obName; renderOnboarding(); return; }
  if (obGoal) { S.ob.draft.dailyGoal = Number(obGoal.dataset.obGoal); renderOnboarding(); return; }
  if (e.target.closest('[data-ob-skills]')) { S.ob.draft.skills = S.ob.draft.skills === false; renderOnboarding(); return; }
  if (e.target.closest('[data-ob-next]')) { S.ob.step = Math.min(3, S.ob.step + 1); renderOnboarding(); return; }
  if (e.target.closest('[data-ob-back]')) { S.ob.step = Math.max(0, S.ob.step - 1); renderOnboarding(); return; }
  if (e.target.closest('[data-ob-skip]')) { saveProfile(DEFAULT_PROFILE); S.ob = null; $('#onboard').hidden = true; loadHome().then(() => go('home')).catch(() => go('home')).then(() => setTimeout(maybeAiOnboard, 700)); return; }
  if (e.target.closest('[data-ob-finish-skip]') || e.target.closest('[data-ob-finish]')) {
    const skipDiag = !!e.target.closest('[data-ob-finish-skip]');
    const want = S.ob.draft.skills !== false;
    saveProfile(S.ob.draft);
    S.settings.skills = want;
    saveSettings();
    S.ob = null; $('#onboard').hidden = true;
    if (want) setTimeout(() => { ensureBuiltinSkills(true).catch(() => {}); }, 1200);
    if (skipDiag) {
      try { localStorage.setItem(DIAG_SKIP_KEY, String(Date.now())); } catch { /* ignore */ }
      toast('先跳过测评。随时可以在「考试 → 基础测评」里补做', 4200);
    }
    loadHome().then(() => go('home')).catch(() => go('home')).then(() => setTimeout(maybeAiOnboard, 700));
    return;
  }
  if (e.target.closest('[data-ob-diag]')) {
    const want = S.ob.draft.skills !== false;
    saveProfile(S.ob.draft);
    S.settings.skills = want;
    saveSettings();
    S.ob = null; $('#onboard').hidden = true;
    if (want) setTimeout(() => { ensureBuiltinSkills(true).catch(() => {}); }, 1200);
    loadHome().catch(() => {}).then(() => {
      go('exam');
      setTimeout(() => { startDiag(true).catch(() => toast('测评没组出来，可以在「考试 → 基础测评」再试')); }, 400);
    });
    return;
  }
  /* AI 配置引导 */
  if (S.aiOb) {
    if (e.target.closest('[data-ai-ob-skip]')) { localStorage.setItem(AI_OB_KEY, 'skip'); S.aiOb = null; $('#onboard').hidden = true; return; }
    if (e.target.closest('[data-ai-ob-next]')) { S.aiOb.step = 1; renderAiOnboard(); return; }
    if (e.target.closest('[data-ai-ob-back]')) { S.aiOb.step = 1; S.aiOb.state = 'idle'; renderAiOnboard(); return; }
    if (e.target.closest('[data-ai-ob-test]')) { aiOnboardTest(); return; }
    if (e.target.closest('[data-ai-ob-done]')) { S.aiOb = null; $('#onboard').hidden = true; toast('AI 已就绪，做题时会用到'); return; }
    const gwBtn = e.target.closest('[data-ai-ob-gw]');
    if (gwBtn) {
      const i = Number(gwBtn.dataset.aiObGw);
      S.aiOb.key = ($('#ai-ob-key')?.value || '').trim() || S.aiOb.key;
      S.aiOb.gw = i;
      S.aiOb.model = AI_GATEWAYS[i].model || '';
      S.aiOb.base = AI_GATEWAYS[i].url || '';
      renderAiOnboard();
      return;
    }
  }
  const pt = e.target.closest('[data-plan-target]');
  const pm = e.target.closest('[data-plan-min]');
  if (pt) { S.profile = { ...S.profile, targetScore: Number(pt.dataset.planTarget) }; saveProfile(S.profile); go('exam'); return; }
  if (pm) { S.profile = { ...S.profile, minutes: Number(pm.dataset.planMin) }; saveProfile(S.profile); go('exam'); return; }
  if (e.target.closest('[data-act="profile-save"]')) {
    const p = {
      ...S.profile,
      ...(S._draft || {}),
      examName: ($('#pf-name')?.value || '').trim() || S.profile.examName,
      examDate: $('#pf-date')?.value || S.profile.examDate,
    };
    saveProfile(p); S._draft = null; closeSheet(); loadHome().then(() => go('home')).catch(() => go('home'));
  }
});


/* ---------- 首次引导 ---------- */
const OB_DATES = {
  '公务员': [{ name: '2027 国考', date: '2026-11-29' }, { name: '2026 山东省考', date: '2026-12-20' }, { name: '2027 省考联考', date: '2027-03-21' }],
  '事业编': [{ name: '2027 事业单位联考', date: '2027-03-15' }, { name: '2026 山东事业单位统考', date: '2026-12-06' }],
  '三支一扶': [{ name: '2027 三支一扶', date: '2027-05-15' }],
};
// 题库里 31 个省都有卷（联考卷覆盖十几省，另有省属/市属单独招考），
// 之前只列了 12 个，陕西、山西、江西、辽宁这些考生在引导页选不到自己的省份。
const PROVINCES = [
  '全国',
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南',
  '四川', '贵州', '云南', '陕西', '甘肃', '青海',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
];
function openOnboarding() {
  S.ob = { step: 0, draft: { examType: '公务员', province: '山东', examName: '2027 国考', examDate: '2026-11-29', dailyGoal: 20, targetScore: 70, minutes: 90, skills: true } };
  renderOnboarding();
}
function renderOnboarding() {
  const ob = S.ob; const d = ob.draft; const el = $('#onboard'); el.hidden = false;
  const dates = OB_DATES[d.examType] || OB_DATES['公务员'];
  if (ob.step === 0) {
    el.innerHTML = `<div class="ob-body"><div class="ob-kicker">第一次见面</div><div class="ob-title">你准备考什么？</div><div class="ob-sub">选好方向，题库、试卷和推荐都会跟着变</div><div class="ob-cards">${['公务员', '事业编', '三支一扶'].map((x) => `<button class="ob-card ${d.examType === x ? 'active' : ''}" data-ob-exam="${x}"><b>${x}</b><span>${x === '公务员' ? '国考 / 省考' : x === '事业编' ? '职测 / 综应 / 公基' : '公基 / 行测'}</span></button>`).join('')}</div></div><div class="ob-foot"><button class="btn btn-ghost" data-ob-skip>先随便逛逛</button><button class="btn btn-primary" data-ob-next>下一步</button></div>`;
  } else if (ob.step === 1) {
    el.innerHTML = `<div class="ob-body"><div class="ob-kicker">第 2 步 / 共 4 步</div><div class="ob-title">目标省份</div><div class="ob-sub">省考、事业单位统考的卷子按省份区分</div><div class="ob-grid">${PROVINCES.map((x) => `<button class="ob-chip ${d.province === x ? 'active' : ''}" data-ob-province="${x}">${x}</button>`).join('')}</div></div><div class="ob-foot"><button class="btn btn-ghost" data-ob-back>上一步</button><button class="btn btn-primary" data-ob-next>下一步</button></div>`;
  } else if (ob.step === 2) {
    el.innerHTML = `<div class="ob-body"><div class="ob-kicker">第 3 步 / 共 4 步</div><div class="ob-title">目标和节奏</div><div class="ob-sub">用来算倒计时、每日任务和组卷难度</div><div class="ob-label">考试</div><div class="ob-list">${dates.map((x) => `<button class="ob-row ${d.examName === x.name ? 'active' : ''}" data-ob-date="${x.date}" data-ob-name="${x.name}"><span>${x.name}</span><span class="muted">${x.date}</span></button>`).join('')}</div><div class="ob-label">每日目标</div><div class="ob-grid four">${[15, 20, 30, 50].map((n) => `<button class="ob-chip ${d.dailyGoal === n ? 'active' : ''}" data-ob-goal="${n}">${n} 题</button>`).join('')}</div><div class="ob-label">AI 技能</div><button class="ob-row ${d.skills !== false ? 'active' : ''}" data-ob-skills><span>内置技能：申论批改 · 花生十三</span><span class="muted">${d.skills !== false ? '默认开启' : '已关闭'}</span></button><div class="ob-sub" style="margin-top:6px">技能是给 AI 用的答题规范，不配 Key 也能先装着，配了就直接生效。后面在「我的 → AI 助手」随时能改</div></div><div class="ob-foot"><button class="btn btn-ghost" data-ob-back>上一步</button><button class="btn btn-primary" data-ob-next>下一步</button></div>`;
  } else {
    el.innerHTML = `<div class="ob-body"><div class="ob-kicker">第 4 步 / 共 4 步 · 可跳过</div><div class="ob-title">先做个基础测评？</div><div class="ob-sub">六个模块各抽几道题，约 25 分钟。测完不用自己判断强弱 —— 每日任务会先补错得多的那几块。</div>
      <div class="ob-ai-list">
        <div class="ob-ai-row"><b>测什么</b><span>六个模块各 6 题，由易到难</span></div>
        <div class="ob-ai-row"><b>测完给你</b><span>模块强弱排序 + 最该补的考点</span></div>
        <div class="ob-ai-row"><b>有什么用</b><span>新装的头几天没有做题记录，先有它，推题才不是瞎抽</span></div>
      </div>
      <div class="ob-hint">跳过的后果只是头几天推题更随机；随时可以在「考试 → 基础测评」里补做。</div></div><div class="ob-foot"><button class="btn btn-ghost" data-ob-finish-skip>先跳过</button><button class="btn btn-primary" data-ob-diag>开始测评</button></div>`;
  }
}

/* ---------- AI 配置引导 ---------- */
const AI_OB_KEY = 'sg_ai_onboard';

async function maybeAiOnboard() {
  if (localStorage.getItem(AI_OB_KEY)) return;
  let need = true;
  try {
    const agents = await api('/api/ai/agents');
    S.agents = agents || [];
    need = !(agents || []).some((a) => a.enabled && a.api_key_masked);
  } catch { need = false; }
  if (need) openAiOnboard();
}

function openAiOnboard() {
  S.aiOb = { step: 0, gw: 0, key: '', model: AI_GATEWAYS[0].model, base: AI_GATEWAYS[0].url, state: 'idle', msg: '' };
  renderAiOnboard();
}

function renderAiOnboard() {
  const ob = S.aiOb;
  if (!ob) return;
  const el = $('#onboard');
  const g = AI_GATEWAYS[ob.gw] || AI_GATEWAYS[0];
  el.hidden = false;
  if (ob.step === 0) {
    el.innerHTML = `<div class="ob-body">
      <div class="ob-kicker">可跳过</div>
      <div class="ob-title">让 AI 讲清楚每道错题</div>
      <div class="ob-sub">上岸里有几处 AI 能力，接上你自己的大模型 Key 才会真正生效。</div>
      <div class="ob-ai-list">
        <div class="ob-ai-row"><b>讲题</b><span>做完题看不懂解析，让它换个说法讲一遍</span></div>
        <div class="ob-ai-row"><b>申论批改</b><span>写完大作文，按采分点逐条给分</span></div>
        <div class="ob-ai-row"><b>生成计划</b><span>按基础、目标分、备考天数排四阶段计划</span></div>
      </div>
      <div class="ob-hint">Key 只存在这台手机上。也可以稍后在「我的 → AI 设置」里配置。</div>
    </div>
    <div class="ob-foot"><button class="btn btn-ghost" data-ai-ob-skip>先跳过</button><button class="btn btn-primary" data-ai-ob-next>去配置</button></div>`;
  } else if (ob.step === 1) {
    el.innerHTML = `<div class="ob-body">
      <div class="ob-kicker">第 1 步 / 共 2 步</div>
      <div class="ob-title">选一个服务商</div>
      <div class="ob-sub">本质是按量买 token。讲一道题的成本大约几厘钱。</div>
      <div class="ob-list">${AI_GATEWAYS.map((x, i) => `<button class="ob-row ${ob.gw === i ? 'active' : ''}" data-ai-ob-gw="${i}"><span>${esc(x.label)}${x.tip ? `<br><span class="muted" style="font-size:12px">${esc(x.tip)}</span>` : ''}</span><span class="muted">${ob.gw === i ? '已选' : ''}</span></button>`).join('')}</div>
      <div class="ob-label">API Key</div>
      <input class="field" id="ai-ob-key" type="password" value="${esc(ob.key)}" placeholder="粘贴 Key，一般以 sk- 开头">
      ${g.signup ? `<div class="ob-hint">还没有？去 <a href="${esc(g.signup)}" target="_blank" class="link">${esc(g.label)} 控制台</a> 建一个。</div>` : ''}
      <div class="ob-label">模型</div>
      <input class="field" id="ai-ob-model" value="${esc(ob.model)}" placeholder="例如 deepseek-chat">
      <div class="ob-label">接口地址（一般不用改）</div>
      <input class="field" id="ai-ob-base" value="${esc(ob.base || g.url)}" placeholder="https://api.deepseek.com/v1">
      <div class="ob-hint">默认填好的是 ${esc(g.label)} 官方地址；用中转/代理时改成你自己的。</div>
    </div>
    <div class="ob-foot"><button class="btn btn-ghost" data-ai-ob-skip>跳过</button><button class="btn btn-ghost" data-ai-ob-back>上一步</button><button class="btn btn-primary" data-ai-ob-test>保存并测试</button></div>`;
  } else {
    const ok = ob.state === 'ok';
    const testing = ob.state === 'testing';
    el.innerHTML = `<div class="ob-body">
      <div class="ob-kicker">第 2 步 / 共 2 步</div>
      <div class="ob-title">${testing ? '正在测试连接…' : ok ? '接通了' : '没连上'}</div>
      <div class="ob-sub">${testing ? '发一条最短的消息，看模型是否应答。' : ok ? `${esc(g.label)} · ${esc(ob.model)} 已经就绪。` : '检查 Key 是否正确、账户是否有余额、网络是否能访问这个服务。'}</div>
      ${testing ? '<div class="spinner"></div>' : ''}
      ${ob.state === 'fail' ? `<div class="card" style="border-color:#e5484d"><div class="card-sub" style="margin:0">${esc(humanAiError(ob.msg))}</div>${ob.msg && ob.msg !== humanAiError(ob.msg) ? `<div class="card-sub" style="margin:8px 0 0;opacity:.6;font-size:12px">原始信息：${esc(String(ob.msg).slice(0, 300))}</div>` : ''}</div>` : ''}
      ${ok && ob.reply ? `<div class="card"><div class="card-sub" style="margin:0">模型回复：${esc(ob.reply)}</div></div>` : ''}
      ${ok ? `<div class="card"><div class="card-sub" style="margin:0">想换模型或改 Key，随时到「我的 → AI 设置」。</div></div>` : ''}
    </div>
    <div class="ob-foot">${ok ? '<button class="btn btn-primary btn-block" data-ai-ob-done>开始使用</button>' : testing ? '<span></span>' : '<button class="btn btn-ghost" data-ai-ob-skip>先跳过</button><button class="btn btn-ghost" data-ai-ob-back>返回修改</button><button class="btn btn-primary" data-ai-ob-test>再试一次</button>'}</div>`;
  }
}

function humanAiError(msg) {
  const m = String(msg || '');
  const st = (m.match(/API 错误 (\d+)/) || [])[1];
  if (st === '401' || st === '403') return `这个 Key 被服务商拒绝了（${st}）。检查是否复制完整、有没有过期。`;
  if (st === '402' || st === '550') return `Key 有效，但账户余额不足（${st}）。去服务商后台充值后再试。`;
  if (st === '429') return '请求太频繁被限流（429），等一会儿再试。';
  if (st && /^5\d\d$/.test(st)) return `服务商那边出错了（${st}），稍后重试。`;
  if (m.includes('网络请求失败')) return '连不上这个服务。确认手机能正常访问该域名（部分服务商需要代理）。';
  if (!m) return '未知错误';
  return m.slice(0, 200);
}

async function aiOnboardTest() {
  const ob = S.aiOb;
  if (!ob) return;
  const keyEl = $('#ai-ob-key');
  const modelEl = $('#ai-ob-model');
  const baseEl = $('#ai-ob-base');
  if (keyEl) ob.key = keyEl.value.trim();
  if (modelEl) ob.model = modelEl.value.trim();
  if (baseEl) ob.base = baseEl.value.trim();
  const g = AI_GATEWAYS[ob.gw];
  const baseUrl = (ob.base || g.url || '').replace(/\/+$/, '');
  if (!ob.key) { toast('先填 API Key'); return; }
  if (!ob.model) { toast('先填模型名'); return; }
  if (!/^https?:\/\//i.test(baseUrl)) { toast('接口地址要以 http(s):// 开头'); return; }
  ob.step = 2; ob.state = 'testing'; ob.msg = '';
  renderAiOnboard();
  try {
    // 等本地 API（含 CapacitorHttp 注入）就绪再发请求。
    // 引导页在启动后 900ms 就弹出，此时 bootstrap 可能还没完成，
    // 直接用原生 fetch 会被 WebView 的 CORS 拦掉，表现成「连不上」。
    if (window.__LOCAL_API_PROMISE__) { try { await window.__LOCAL_API_PROMISE__; } catch { /* ignore */ } }
    // 关键：一个服务商的 Key 要写进「所有用这个服务商的智能体」。
    // 之前取 S.agents[0]，顺序不保证是 id=1，可能把 DeepSeek 的 Key 写进了智谱的智能体，
    // 然后拿智谱地址 + DeepSeek Key 去测，必然失败 —— 这就是引导页死活过不去、进设置页却没事的原因。
    const ids = (g.agents && g.agents.length) ? g.agents.slice()
      : ((S.agents || []).map((a) => a.id).filter((x) => x != null));
    const idList = ids.length ? ids : [1];
    let okId = null;
    for (const id of idList) {
      try {
        await api(`/api/ai/agents/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_url: baseUrl, model: ob.model, api_key: ob.key }),
        });
        if (okId == null) okId = id;
      } catch { /* 某个 id 不存在就跳过 */ }
    }
    if (okId == null) { ob.state = 'fail'; ob.msg = '没有可写入的智能体'; renderAiOnboard(); return; }
    const r = await api(`/api/ai/agents/${okId}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '只回复两个字：可用' }),
    });
    if (r && r.ok && r.content) { ob.state = 'ok'; ob.reply = String(r.content).slice(0, 120); localStorage.setItem(AI_OB_KEY, 'done'); }
    else { ob.state = 'fail'; ob.msg = (r && r.error) || '模型没有返回内容'; }
  } catch (e) { ob.state = 'fail'; ob.msg = e.message; }
  renderAiOnboard();
}

/* ---------- 启动 ---------- */
async function ensureReviewBackfill() {
  if (localStorage.getItem('sg_review_backfilled')) return;
  const d = await api('/api/records/wrong?limit=300');
  const m = loadReviewState();
  for (const it of (d.list || d || [])) {
    const id = it.questionId || it.question_id || it.id;
    if (id != null && !m[id]) m[id] = { level: 1, next: Date.now() + 86400000, wrong: 1, streak: 0, mastered: false };
  }
  saveReviewState(m);
  localStorage.setItem('sg_review_backfilled', '1');
}

/* ---------- 安卓物理返回键 ---------- */
/**
 * 按优先级逐层后退：弹层 → 练习/考试 → 我的子页 → 非首页 tab → 首页（返回 false 交给系统退出）
 * 之前完全没监听，返回键会直接从任何页面退出 App。
 */
/* ---------- 返回：记住「从哪来」，别把用户丢到不相干的地方 ---------- */
// 这些动作会把用户带到下一层页面，点之前记一下当前位置
const NAV_DOWN = new Set([
  'keypoints', 'search', 'papers', 'politics', 'stats', 'report', 'ai', 'backup',
  'plan', 'smart-paper', 'exam', 'library-exam', 'search-open', 'paper', 'politics-detail',
]);

// 打开子页前调用，记下当前层级
function rememberFrom() {
  S.from = { tab: S.tab, libView: (S.lib && S.lib.view) || 'subjects', meView: S.meView || 'main' };
}

// 各页「‹」统一走这里：优先回来源，其次回兜底 tab
function goBackSmart(fallback) {
  const f = S.from;
  S.from = null;
  // 这些标记会让 renderXxx() 继续渲染子页，返回前必须清掉
  S.planView = false;
  S.examResult = null;
  S.examPapers = false;
  if (f && f.tab) {
    S.tab = f.tab;
    if (S.lib) S.lib.view = f.libView || 'subjects';
    S.meView = f.meView || 'main';
    go(f.tab);
    return;
  }
  const t = fallback || 'home';
  S.tab = t;
  go(t);
}

function handleAndroidBack() {
  const sh = $('#sheet');
  if (sh && !sh.hidden) { closeSheet(); return true; }
  if (S.practice && S.practice.open) {
    saveCurrentAnswer();
    saveSession();
    S.practice.open = false;
    clearInterval(S.practice.timer);
    const el = $('#practice');
    if (el) el.hidden = true;
    toast('已保存，可在首页继续');
    return true;
  }
  if (S.tab === 'me' && S.meView && S.meView !== 'main') { S.meView = 'main'; go('me'); return true; }
  if (S.tab === 'library' && S.lib && S.lib.view && S.lib.view !== 'subjects') { S.lib.view = 'subjects'; go('library'); return true; }
  if (S.examResult) { S.examResult = null; go('exam'); return true; }
  if (S.planView) { S.planView = false; go('exam'); return true; }
  if (S.from) { goBackSmart(); return true; }
  if (S.tab !== 'home') { go('home'); return true; }
  return false;   // 首页：交给系统退出
}

/* ---------- 用户偏好（即时判定 / 字号） ---------- */
const SETTINGS_KEY = 'sg_settings_v1';
const DEF_SETTINGS = { instant: true, fs: 'm', autoNext: true, recite: false, dropFixed: true, skills: true };
function loadSettings() {
  try { return Object.assign({}, DEF_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { return Object.assign({}, DEF_SETTINGS); }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch { /* ignore */ } }
function applyFontSize(mode) {
  const m = ['s', 'm', 'l'].includes(mode) ? mode : 'm';
  S.settings.fs = m;
  document.documentElement.dataset.fs = m;
  saveSettings();
}
/* 左右滑动切题：地铁上一只手拿手机时比点按钮舒服 */
function bindSwipe() {
  const body = $('#p-body');
  if (!body || body.dataset.swipe) return;
  body.dataset.swipe = '1';
  let x0 = 0; let y0 = 0; let t0 = 0;
  body.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    // 图片/宽表格上按下就不当切题手势：图形推理的大图、资料分析的宽表要横向拖才能看全，
    // 以前一拖就跳题，等于「看不了图」。
    const t = e.target;
    if (t && t.closest && t.closest('img, .q-figure, table, .table-wrap, .q-src-none')) { x0 = NaN; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!S.practice.open) return;
    if (Number.isNaN(x0)) { x0 = 0; return; }
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - x0; const dy = t.clientY - y0;
    if (Date.now() - t0 > 700) return;                       // 长按不算滑
    if (Math.abs(dx) < 70) return;                           // 位移太小不触发
    if (Math.abs(dy) > Math.abs(dx) * 1.4) return;            // 上下滚材料不算
    if (dx < 0) nextQuestion(); else prevQuestion();
  }, { passive: true });
  // 题干/材料里的图点一下放大：手机屏上横排的图形推理选项经常挤成一条线
  body.addEventListener('click', (e) => {
    const im = e.target.closest && e.target.closest('.q-stem img, .q-material-body img');
    if (!im || !im.src) return;
    e.preventDefault();
    openImageView(im.src);
  });
}
function openImageView(src) {
  let el = document.getElementById('img-view');
  if (!el) {
    el = document.createElement('div');
    el.id = 'img-view';
    el.innerHTML = '<img alt="题目图片"><button class="iv-close" aria-label="关闭">✕</button><div class="iv-tip">点图切换「适应屏幕 / 原始大小」· 双指可缩放</div>';
    document.body.appendChild(el);
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('iv-close')) { el.classList.remove('on'); return; }
      if (ev.target.tagName === 'IMG') { el.classList.toggle('actual'); return; }
      el.classList.remove('on');
    });
  }
  el.classList.remove('actual');
  el.querySelector('img').src = src;
  el.classList.add('on');
}
function bindAndroidBack() {
  // 暴露给原生层：MainActivity.onBackPressed 会调它，返回 "handled" 表示已消费
  window.__handleBack = () => (handleAndroidBack() ? 'handled' : 'pass');
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!App || typeof App.addListener !== 'function') return;
  App.addListener('backButton', () => {
    if (handleAndroidBack() === false) {
      try { App.exitApp(); } catch { /* ignore */ }
    }
  });
}

(async function boot() {
  const T0 = performance.now();
  // 启动耗时打点：logcat 里 grep "boot" 就能看到每一段花了多久
  const mark = (k) => { try { const t = Math.round(performance.now() - T0); (window.__BOOT__ = window.__BOOT__ || []).push([k, t]); console.log('[boot]', k, t + 'ms'); } catch { /* ignore */ } };
  mark('start');
  const saved = localStorage.getItem('theme');
  document.documentElement.setAttribute('data-theme', saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  S.plan = loadPlan();
  S.settings = loadSettings();
  S.diag = loadDiag();
  applyFontSize(S.settings.fs);

  // 先用上一次的首屏数字直出，不等任何桥、不发任何请求。
  // 这一步只读 localStorage + 渲染，实测 50ms 量级；放在这里，
  // 启动图就能在第一帧之后立刻撤掉，而不是等 __LOCAL_API_PROMISE__ 解析完（那要 1.9 秒）。
  let painted = false;
  try {
    const snap = JSON.parse(localStorage.getItem('sg_home_snap') || 'null');
    if (snap && snap.stats && localStorage.getItem('sg_profile')) {
      S.stats = snap.stats;
      if (Array.isArray(snap.subjects) && snap.subjects.length) S.subjects = snap.subjects;
      go('home');
      painted = true;
      mark('snap-paint');
      // 首屏一出来就撤启动图，不让用户对着图标等
      try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // 等 local-bootstrap 装好 fetch / NativeDB 桥再发请求。
  // 不等的话第一轮 api() 会打空，Promise.all 直接 reject，
  // renderHome 拿着空数据渲染出一片白，看起来就是「白屏三四秒」。
  if (window.__LOCAL_API_PROMISE__) {
    try { await window.__LOCAL_API_PROMISE__; } catch { /* ignore */ }
  }
  mark('bridge-ready');
  // 0.7 实验版：能力引擎首次使用前把历史作答回放一遍（正式版没有这个对象，直接跳过）
  if (window.__LAB__ && window.__ENGINE2__) {
    window.__ENGINE2__.ensure().then((k) => { if (k) console.info('[engine2] 回放历史作答', k, '条'); }).catch(() => {});
  }

  // 分类题量预计算表（tools/build-qc-counts.mjs 生成，11 KB）：
  // 读进来之后 /api/chapters 不用再查 9 万行 question_categories（手机上 13–103 秒）。
  // 失败也不要紧，local-queries 会退回查库，只是慢。
  try {
    const r = await fetch('qc-counts.json');
    if (r.ok) {
      const j = await r.json();
      if (j && j.subjects) {
        window.__QC_COUNTS__ = j;
        mark('qc-counts');
      }
    }
  } catch { /* ignore */ }

  // 首屏只等最少的数据。错题回填和摊平都能挪到后台，
  // 它们要读几百条记录，卡在前面会让白屏多两三秒。
  // loadHome 成功才切首页；失败就留着骨架，别渲染出一片白。
  try { await loadHome(); go('home'); painted = true; } catch (e) { if (!painted) toast(e.message); }
  mark('home-rendered');
  // 存一份首屏快照，下次冷启先拿它画第一帧
  try { localStorage.setItem('sg_home_snap', JSON.stringify({ stats: S.stats, subjects: S.subjects, t: Date.now() })); } catch { /* ignore */ }

  // 首屏渲染完了，可以撤掉原生启动图了；浏览器里没有这个桥，忽略即可
  try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ }

  // 下面两件是历史数据迁移，用户看不见，放到下一帧慢慢做
  setTimeout(async () => {
    try { await ensureReviewBackfill(); } catch { /* ignore */ }
    try { spreadLegacyReviews(15); } catch { /* ignore */ }
    // 收藏状态：做题页的「☆ 收藏 / ★ 已收藏」靠它，取一次就够（几百条）
    try {
      const d = await api('/api/favorites?limit=800');
      const list = d.list || d || [];
      S.favIds = new Set((Array.isArray(list) ? list : []).map((f) => String(f.questionId ?? f.id)));
    } catch { /* ignore */ }
  }, 0);

  setTimeout(() => { try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ } }, 1500);
  bindAndroidBack();
  bindSwipe();
  if (!localStorage.getItem('sg_profile')) openOnboarding();
  else setTimeout(maybeAiOnboard, 900);

  // 内置技能：只要开关是开的、且这台机器还没灌过，就静默装一次。
  // 放在 6 秒后，别和首屏抢 IO；装的是文本（两套合计约 330 KB），失败不打扰用户。
  setTimeout(() => { ensureBuiltinSkills().catch(() => {}); }, 6000);

  // 覆盖安装后内置题库可能落后，静默看一眼有没有增量（几 MB），不打断用户
  setTimeout(silentTikuCheck, 6000);
})();

/**
 * 启动后静默检查题库版本。只在发现新版本时提示一句，不弹全屏。
 * 之所以需要：覆盖安装时不再整块重拷 320MB 的库（要几十秒），改走增量。
 */
async function silentTikuCheck() {
  // 只查版本、不下载。以前这里直接 AppUpdate.start()，会真的开始下增量包，
  // 于是「首次启动」就弹「允许上岸发送通知？」—— 用户还不知道这 App 是干嘛的。
  // 现在只比版本号，用户点了「更新」才下载、才申请通知权限。
  if (!window.AppUpdate) return;
  const last = Number(localStorage.getItem('sg_silent_check') || 0);
  if (Date.now() - last < 6 * 3600 * 1000) return;
  localStorage.setItem('sg_silent_check', String(Date.now()));
  let local = null;
  try { local = JSON.parse(AppUpdate.status()); } catch { return; }
  if (!local) return;
  const ts = Date.now();
  const urls = manifestUrls(ts).filter((u) => !u.includes('jsdelivr'));   // 静默检查只用无缓存源
  for (const u of urls) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(u, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const m = await r.json();
      const remoteTiku = String((m.tiku && m.tiku.dbVersion) || '');
      const remoteApp = String((m.app && (m.app.versionName || m.app.version)) || '');
      const localTiku = String(local.localVersion || '');
      const localName = String(local.currentVersionName || APP_VERSION);
      const num = (v) => Number(String(v).replace(/\./g, '')) || 0;
      const tikuNew = !!(localTiku && remoteTiku && remoteTiku !== localTiku);
      const appNew = !!(remoteApp && num(remoteApp) > num(localName));
      if (!tikuNew && !appNew) return;                        // 都是最新，安静退出
      S.updateHint = { tiku: tikuNew ? remoteTiku : '', app: appNew ? remoteApp : '' };
      if (S.tab === 'home') go('home');
      return;
    } catch { /* 换下一个源 */ }
  }
}
