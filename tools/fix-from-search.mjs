#!/usr/bin/env node
/**
 * 用粉笔「搜题」接口定位每一道坏题，再按题拉解析补回来。
 *
 * 两条接口（2026-11-12 实测可用）：
 *   1) 搜题  GET https://algo.fenbi.com/api/fenbi-question-search/question
 *            ?q=<关键词>&coursePrefix=<syzc|xingce|sydw|zhyynl>&offset=0&length=15&format=json
 *            &sourceType=0&app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=..&gav=2&apcId=0&userId=..
 *      → items[]: { questionId, source, type, materialId, stemSnippet, score, encodeCheckInfo }
 *      注意 questionId 与我们库里的 questions.questionId 是同一空间（实测同一道题 score=1.000 且 id 相同）
 *   2) 取解析 GET https://tiku.fenbi.com/combine/question/auth/getSolution
 *            ?questionIds=<id>&routecs=<course>&type=6&checkId=<encodeCheckInfo>&format=<json|html>
 *            &kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2
 *      → 题干/材料/选项/解析（与按卷重采相比不消耗「创建练习」额度，但同样有频率限制：
 *        403 {"msg":"您拉取解析的频率过高，请稍候再试"}）
 *
 * 用法：
 *   node tools/fix-from-search.mjs --probe 2065320        # 抓一条原始响应存到 report/，用于确认字段
 *   node tools/fix-from-search.mjs                        # dry-run：只搜不写库
 *   node tools/fix-from-search.mjs --apply --limit 50     # 真写库（--limit 省略则全量）
 *   可选：--gap 4000 --cooldown 600 --db app-assets/tiku_app.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DB = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const APPLY = flag('apply');
const LIMIT = Number(arg('limit', '0')) || 0;
const GAP = Number(arg('gap', '4000'));
const COOLDOWN = Number(arg('cooldown', '600')) * 1000;
const PROBE = arg('probe', null);

const COOKIE = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim();
const UID = (COOKIE.match(/userid=(\d+)/) || [])[1] || '';
const DEV = (COOKIE.match(/deviceId=([^;]+)/) || [])[1] || '';
const BASE_Q = `app=web&kav=131&av=134&hav=128&version=3.0.0.0&deviceId=${DEV}&gav=2&apcId=0&userId=${UID}`;
const HEADERS = {
  cookie: COOKIE,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://www.fenbi.com/',
  origin: 'https://www.fenbi.com',
};

const SPA_HEADERS = { ...HEADERS, referer: 'https://spa.fenbi.com/', origin: 'https://spa.fenbi.com' };
const COURSE_OF = { '公务员·行测': 'xingce', '事业编·职测': 'syzc', '事业编·公基': 'sydw', '事业编·综应': 'zhyynl' };
const IMG_BASE = 'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/* ---------------- 富文本 → HTML（与 fill-from-corpus 同口径） ---------------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function richToHtml(raw) {
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { html: '', text: '', imgs: 0 };
    if (s.startsWith('{') || s.startsWith('[')) {
      try { node = JSON.parse(s); } catch { return { html: esc(s), text: s, imgs: 0 }; }
    } else if (s.startsWith('<')) {
      const imgs = (s.match(/<img/gi) || []).length;
      return { html: s, text: s.replace(/<[^>]+>/g, ''), imgs };
    } else {
      return { html: esc(s).replace(/\n/g, '<br>'), text: s, imgs: 0 };
    }
  }
  let imgs = 0;
  const walk = (n) => {
    if (n == null) return '';
    if (typeof n === 'string') return esc(n);
    if (Array.isArray(n)) return n.map(walk).join('');
    const name = n.name || 'txt';
    const val = n.value == null ? '' : String(n.value);
    const kids = () => (Array.isArray(n.children) ? n.children.map(walk).join('') : '');
    switch (name) {
      case 'doc': return kids();
      case 'p': return `<p>${kids()}</p>`;
      case 'br': return '<br>';
      case 'li': return `<li>${kids()}</li>`;
      case 'ul': return `<ul>${kids()}</ul>`;
      case 'ol': return `<ol>${kids()}</ol>`;
      case 'table': return `<table>${kids()}</table>`;
      case 'tr': return `<tr>${kids()}</tr>`;
      case 'td': return `<td>${kids()}</td>`;
      case 'b': case 'strong': return `<strong>${kids()}</strong>`;
      case 'i': case 'em': return `<em>${kids()}</em>`;
      case 'u': return `<u>${kids()}</u>`;
      case 'tex': {
        imgs += 1;
        const key = val.split('?')[0];
        return `<img flag="tex" src="${IMG_BASE}${key}">`;
      }
      case 'img': {
        imgs += 1;
        const src = val || (n.src || '');
        return `<img src="${esc(src)}">`;
      }
      default: return kids() || esc(val);
    }
  };
  const html = walk(node);
  const text = html.replace(/<img[^>]*>/gi, '[图]').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return { html, text, imgs };
}

/* ---------------- 搜题 ---------------- */
function stemQuery(stem) {
  const s = String(stem || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[【】《》「」“”"'’‘]/g, '')
    .replace(/\s+/g, '');
  const parts = s.split(/[，。；：、？！,.;:?!]/).map((x) => x.trim()).filter((x) => x.length >= 8 && x.length <= 40);
  if (parts.length) {
    // 选最长的一段（通常最独特）；同样长取靠中间的
    parts.sort((a, b) => b.length - a.length);
    return parts[0].slice(0, 30);
  }
  return s.slice(0, 26);
}

function snippetText(raw) {
  try {
    const t = richToHtml(raw).text;
    return t.replace(/\s+/g, '');
  } catch { return ''; }
}

function overlap(a, b) {
  const x = String(a || '').replace(/[\s\p{P}]/gu, '');
  const y = String(b || '').replace(/[\s\p{P}]/gu, '');
  if (!x || !y) return 0;
  const set = new Set(y);
  let hit = 0;
  for (const ch of new Set(x)) if (set.has(ch)) hit += 1;
  return hit / new Set(x).size;
}

async function search(course, q) {
  const url = `https://algo.fenbi.com/api/fenbi-question-search/question?q=${encodeURIComponent(q)}`
    + `&coursePrefix=${course}&offset=0&length=15&format=json&sourceType=0&${BASE_Q}`;
  const r = await fetch(url, { headers: HEADERS });
  const txt = await r.text();
  if (!r.ok) throw new Error(`search HTTP ${r.status}: ${txt.slice(0, 120)}`);
  const j = JSON.parse(txt);
  return j?.data?.items || [];
}

/* ---------------- 取解析 ---------------- */
async function getSolution(course, questionId, checkId, format = 'json') {
  const url = `https://tiku.fenbi.com/combine/question/auth/getSolution?questionIds=${questionId}`
    + `&routecs=${course}&type=6&checkId=${encodeURIComponent(checkId || '')}&format=${format}`
    + '&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2';
  const r = await fetch(url, { headers: SPA_HEADERS });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* html */ }
  return { status: r.status, text: txt, json };
}

/** getSolution 只给 staticUrl，正文要再取一次；static 少了这几个参数会 404 */
async function getStatic(json) {
  const u = json?.data?.staticUrl?.urls?.[0];
  if (!u) return null;
  const full = u + (u.includes('?') ? '&' : '?')
    + 'routecs=' + ST_COURSE + '&type=1&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2';
  const r = await fetch(full, { headers: SPA_HEADERS });
  const txt = await r.text();
  if (r.status !== 200) return { status: r.status, text: txt };
  try { return { status: 200, json: JSON.parse(txt) }; } catch { return { status: 200, text: txt }; }
}

let ST_COURSE = 'syzc';
function rateLimited(res) {
  return res.status === 403 && /频率过高|稍候/.test(res.text || '');
}

/** 归一化粉笔 HTML 里的图片：
 *  - //fb.fbstatic.cn/api/planet/accessories/formulas?latex=KEY  →  https://fb.fenbike.cn/…（App 端按 latex 取 images.db）
 *  - //fb.fbstatic.cn/api/tarzan/images/xxx.png                 →  下载后内联成 data: URI（否则离线打不开）
 */
const _imgCache = new Map();
function normFormula(html) {
  return String(html || '')
    .replace(/src="\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=([^"&]+)[^"]*"/g,
      (_m, k) => `src="${IMG_BASE}${k}"`)
    .replace(/src="https?:\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=([^"&]+)[^"]*"/g,
      (_m, k) => `src="${IMG_BASE}${k}"`);
}

async function fetchAsDataUrl(u) {
  const abs = u.startsWith('//') ? 'https:' + u : u;
  for (let t = 0; t < 2; t += 1) {
    try {
      const r = await fetch(abs, { headers: { 'user-agent': HEADERS['user-agent'] } });
      if (!r.ok) { await sleep(400); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { await sleep(400); }
  }
  return null;
}

/** 题图（tarzan）内联成 data: URI：并发下载，否则每题要串行等好几张图，一轮下来几个小时 */
async function inlineTarzan(html) {
  const urls = [...String(html || '').matchAll(/src="((?:\/\/|https?:\/\/)fb\.fbstatic\.cn\/api\/tarzan\/images\/[^"]+)"/g)].map((m) => m[1]);
  if (!urls.length) return html;
  const uniq = [...new Set(urls)].filter((u) => !_imgCache.has(u));
  const CONC = 8;
  for (let i = 0; i < uniq.length; i += CONC) {
    const batch = uniq.slice(i, i + CONC);
    const got = await Promise.all(batch.map((u) => fetchAsDataUrl(u)));
    batch.forEach((u, k) => _imgCache.set(u, got[k]));
  }
  let out = String(html || '');
  for (const u of urls) {
    const d = _imgCache.get(u);
    if (d) out = out.split(`src="${u}"`).join(`src="${d}"`);
  }
  return out;
}

/** 从 static 返回里抠出 { materialHtml, contentHtml, analysisHtml, options, answer } */
async function extract(st, questionId) {
  const j = st?.json;
  if (!j) return null;
  const sols = Array.isArray(j.solutions) ? j.solutions : [];
  const sol = sols.find((x) => Number(x.id) === Number(questionId)) || sols[0];
  if (!sol) return null;
  const mats = Array.isArray(j.materials) ? j.materials : [];
  const mat = mats.find((m) => Number(m.id) === Number(sol.materialId)) || mats[0] || null;
  const rawMat = mat ? (mat.content ?? mat.contentHtml ?? mat.material ?? '') : '';
  const material = richToHtml(rawMat);
  const content = richToHtml(sol.content ?? '');
  const analysis = richToHtml(sol.solution ?? sol.analysis ?? '');
  const acc = Array.isArray(sol.accessories) ? sol.accessories.find((a) => a && Array.isArray(a.options) && a.options.length) : null;
  const opts = acc ? acc.options.map((o) => String(o)) : [];
  const ca = sol.correctAnswer || {};
  let contentHtml = normFormula(content.html);
  let analysisHtml = normFormula(analysis.html);
  let materialHtml = normFormula(material.html);
  contentHtml = await inlineTarzan(contentHtml);
  analysisHtml = await inlineTarzan(analysisHtml);
  materialHtml = await inlineTarzan(materialHtml);
  return {
    materialHtml,
    materialText: String(material.text || ''),
    contentHtml,
    contentText: String(content.text || '').replace(/\[图\]/g, ''),
    analysisHtml,
    analysisText: String(analysis.text || ''),
    options: opts,
    answer: ca.choice == null ? null : String(ca.choice),
    answerType: ca.type == null ? null : Number(ca.type),
    keypoints: sol.keypoints || null,
  };
}

/* ---------------- 主流程 ---------------- */
const db = new DatabaseSync(DB);
if (PROBE) {
  const row = db.prepare(`SELECT q.questionId, p.subjectName, q.content, q.type FROM questions q
    LEFT JOIN papers p ON p.id = q.paperId WHERE q.questionId = ? ORDER BY q.id DESC LIMIT 1`).get(Number(PROBE));
  if (!row) { console.error('库里没有这道题', PROBE); process.exit(1); }
  const course = COURSE_OF[row.subjectName] || 'syzc';
  const q = stemQuery(row.content);
  console.log('搜索词：', q);
  const items = await search(course, q);
  console.log('命中', items.length, '条；前 3：');
  for (const it of items.slice(0, 3)) console.log('  ', it.questionId, it.score?.toFixed?.(3), it.source?.slice(0, 40));
  const best = items.find((it) => Number(it.questionId) === Number(PROBE)) || items[0];
  console.log('选中：', best?.questionId, 'checkId', best?.encodeCheckInfo);
  ST_COURSE = course;
  const res = await getSolution(course, best.questionId, best.encodeCheckInfo, 'json');
  const out = path.join(ROOT, 'report', `probe-sol-${PROBE}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, res.text);
  console.log('HTTP', res.status, '已存', out, res.status === 403 ? `（${res.text.slice(0, 60)}）` : '');
  if (res.status === 200) {
    const st = await getStatic(res.json);
    console.log('static HTTP', st?.status);
    if (st?.json) {
      const out2 = path.join(ROOT, 'report', `probe-static-${PROBE}.json`);
      fs.writeFileSync(out2, JSON.stringify(st.json, null, 1));
      const ex = await extract(st, best.questionId);
      console.log('解析到：材料', (ex?.materialText || '').length, '题干', (ex?.contentText || '').length,
        '解析', (ex?.analysisText || '').length, '选项', ex?.options?.length, '答案', ex?.answer);
      if (ex?.contentText) console.log('题干前 60：', ex.contentText.slice(0, 60));
      if (ex?.analysisText) console.log('解析前 60：', ex.analysisText.slice(0, 60));
    }
  }
  process.exit(0);
}

const rows = db.prepare(`
  SELECT q.id, q.questionId, p.subjectName, q.type, q.content, q.material,
         q.contentHtml, q.analysisHtml, q.analysis, q.q_bad_reason
  FROM questions q
  LEFT JOIN papers p ON p.id = q.paperId
  JOIN (SELECT questionId, MAX(id) AS mid FROM questions GROUP BY questionId) m ON m.mid = q.id
  WHERE COALESCE(q.q_bad, 0) = 1
  ORDER BY q.questionId
`).all();

const todo = LIMIT ? rows.slice(0, LIMIT) : rows;
console.log(`坏题 ${rows.length} 道，本轮处理 ${todo.length} 道${APPLY ? '' : '（dry-run，不写库）'}`);

const upd = db.prepare(`
  UPDATE questions SET material = ?, contentHtml = ?, analysis = ?, analysisHtml = ?, options = ?,
    q_bad = 0, q_bad_reason = NULL
  WHERE questionId = ?
`);

/** 只在「我们缺、粉笔有」的方向上覆盖，绝不把能用的内容换掉 */
function merge(r, ex) {
  const hasImg = (h) => /<img\b/i.test(String(h || ''));
  const pickContent = !r.contentHtml ? ex.contentHtml
    : (!hasImg(r.contentHtml) && hasImg(ex.contentHtml)) ? ex.contentHtml : r.contentHtml;
  const nextAnaHtml = (!r.analysisHtml || !hasImg(r.analysisHtml)) && hasImg(ex.analysisHtml) ? ex.analysisHtml : r.analysisHtml;
  const nextAna = String(ex.analysisText || '').length > String(r.analysis || '').length ? ex.analysisText : r.analysis;
  const nextMat = (!r.material || String(r.material).length < 20) && String(ex.materialHtml || '').length > String(r.material || '').length ? ex.materialHtml : r.material;
  // 选项全空的行不能写：图片选项在 accessories.options 里是空字符串，写进去会显示成 4 个空白
  const safeOpts = Array.isArray(ex.options) && ex.options.length && ex.options.every((o) => String(o || '').trim().length > 0);
  const nextOpts = (!r.options || r.options === '[]') && safeOpts ? JSON.stringify(ex.options) : r.options;
  return { nextContent: pickContent, nextAnaHtml, nextAna, nextMat, nextOpts };
}

const log = [];
let okN = 0, skipN = 0, failN = 0, cooled = 0, noPerm = 0;

for (let i = 0; i < todo.length; i += 1) {
  const r = todo[i];
  const course = COURSE_OF[r.subjectName] || 'syzc';
  const q = stemQuery(r.content);
  if (!q) { failN += 1; log.push({ questionId: r.questionId, ok: false, why: 'no-query' }); continue; }
  let items = [];
  try { items = await search(course, q); } catch (e) { failN += 1; log.push({ questionId: r.questionId, ok: false, why: 'search:' + String(e.message).slice(0, 60) }); continue; }
  const exact = items.find((it) => Number(it.questionId) === Number(r.questionId));
  const byOverlap = items
    .map((it) => ({ it, ov: overlap(r.content, snippetText(it.stemSnippet)) }))
    .sort((a, b) => (b.it.score || 0) - (a.it.score || 0))[0];
  const pick = exact || (byOverlap && byOverlap.ov >= 0.75 ? byOverlap.it : null);
  if (!pick) {
    skipN += 1;
    log.push({ questionId: r.questionId, ok: false, why: 'no-match', best: byOverlap ? Number(byOverlap.ov.toFixed(2)) : 0 });
    await sleep(GAP);
    continue;
  }
  // 「无权查看部分题目」多半是课程对不上（同一道题可能挂在行测/职测/公基），换课程再试
  const courses = [course, ...['syzc', 'xingce', 'sydw', 'zhyynl'].filter((x) => x !== course)];
  let res = null; let usedCourse = course;
  for (const cs of courses) {
    ST_COURSE = cs;
    res = await getSolution(cs, pick.questionId, pick.encodeCheckInfo, 'json');
    if (res.status === 200) { usedCourse = cs; break; }
    if (!(res.status === 403 && /无权/.test(res.text || ''))) break;
    await sleep(300);
  }
  ST_COURSE = usedCourse;
  while (rateLimited(res) && cooled < 6) {
    cooled += 1;
    console.log(`  403 限流，冷却 ${Math.round(COOLDOWN / 1000)}s（第 ${cooled} 次）`);
    await sleep(COOLDOWN);
    res = await getSolution(course, pick.questionId, pick.encodeCheckInfo, 'json');
  }
  if (rateLimited(res)) { console.log('仍然限流，先停下，稍后重跑（已完成的部分已写库）'); break; }
  if (res.status === 403) {
    noPerm += 1;
    log.push({ questionId: r.questionId, ok: false, why: 'no-perm:' + String(res.text).replace(/\s+/g, ' ').slice(0, 60) });
    await sleep(GAP);
    continue;
  }
  if (res.status !== 200) { failN += 1; log.push({ questionId: r.questionId, ok: false, why: 'sol HTTP ' + res.status }); await sleep(GAP); continue; }
  const st = await getStatic(res.json);
  if (!st || st.status !== 200 || !st.json) { failN += 1; log.push({ questionId: r.questionId, ok: false, why: 'static HTTP ' + (st?.status || '?') }); await sleep(GAP); continue; }
  const ex = await extract(st, pick.questionId);
  if (!ex) { failN += 1; log.push({ questionId: r.questionId, ok: false, why: 'parse-empty' }); await sleep(GAP); continue; }
  const optsJson = ex.options.length ? JSON.stringify(ex.options) : '';
  if (APPLY) {
    const mg = merge(r, ex);
    upd.run(mg.nextMat || '', mg.nextContent || '', mg.nextAna || '', mg.nextAnaHtml || '', mg.nextOpts || '', r.questionId);
  }
  okN += 1;
  log.push({ questionId: r.questionId, ok: true, by: exact ? 'exact' : 'overlap', mat: (ex.materialText || '').length, ana: (ex.analysisText || '').length, opts: ex.options.length });
  if ((okN % 10) === 0) console.log(`  … 已完成 ${okN} 道`);
  await sleep(GAP);
}

const outDir = path.join(ROOT, 'report');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `fix-from-search-${day()}.json`), JSON.stringify(log, null, 2));
console.log(`完成：成功 ${okN} / 无权限 ${noPerm} / 未匹配 ${skipN} / 失败 ${failN}`);
if (APPLY) console.log('提示：再跑 node tools/fetch-missing-images.mjs --apply 把新出现的公式图下载进 images.db');
else console.log('dry-run：加 --apply 才写库');
