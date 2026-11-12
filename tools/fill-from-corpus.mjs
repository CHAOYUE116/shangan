#!/usr/bin/env node
/**
 * tools/fill-from-corpus.mjs — 用已采集的粉笔语料补题库缺口（不外网抓题）
 *
 * 语料（离线已有）：
 *   ../research/fenbi-solutions/{sydw,syzc}/*.json   { paperId, materials[], solutions[] }
 *   ../research/fenbi-keypoint/syzc/*.json           { questions[] }
 *   每条 solution/question 结构：{ id, globalId, content, solution, accessories, correctAnswer, quizId }
 *   content / solution 是粉笔富文本树：{"name":"doc","children":[{name:'p',children:[{name:'txt',value}]},{name:'tex',value:'KEY?widthRatio=..'}]}
 *   ★ id 与库里的 questions.questionId 同一 id 空间（globalId 不是）
 *
 * 补什么：
 *   1) material：库 questions.material 为空，但 q_material_map → q_materials 有正文 → 直接搬
 *   2) contentHtml：库里没有 <img> 但语料 content 里有 tex/img → 重建（图会恢复）
 *   3) analysis/analysisHtml：库里解析短（<20字）或为空，语料 solution 有内容 → 重建
 *   4) answer/answerIndex：客观题缺答案，语料 correctAnswer 有 → 补
 *
 * 用法：
 *   node tools/fill-from-corpus.mjs            # dry-run，只报数字
 *   node tools/fill-from-corpus.mjs --apply
 *   node tools/fill-from-corpus.mjs --apply --db app-assets/tiku_app.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PARENT = path.resolve(ROOT, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DB = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const APPLY = argv.includes('--apply');

const CORPUS_DIRS = [
  path.join(PARENT, 'research/fenbi-solutions/sydw'),
  path.join(PARENT, 'research/fenbi-solutions/syzc'),
  path.join(PARENT, 'research/fenbi-keypoint/syzc'),
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IMG_BASE = 'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=';

/** 粉笔富文本树 → { html, text, imgs } */
function richToHtml(raw) {
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return { html: esc(s), text: s, imgs: [] };
    try { node = JSON.parse(s); } catch { return { html: esc(s), text: s, imgs: [] }; }
  }
  const imgs = [];
  const out = [];
  const txt = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    const name = n.name;
    if (name === 'txt' || name === 'text') { out.push(esc(n.value || '')); txt.push(n.value || ''); return; }
    if (name === 'tex') {
      const v = String(n.value || '');
      if (!v) return;
      const key = v.split('?')[0];
      imgs.push(key);
      out.push(`<img flag="tex" src="${IMG_BASE}${esc(key)}">`);
      txt.push('[图]');
      return;
    }
    if (name === 'img' || name === 'image') {
      const src = n.value || n.src || (n.attrs && n.attrs.src) || '';
      if (src) { out.push(`<img src="${esc(src)}">`); txt.push('[图]'); }
      return;
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    switch (name) {
      case 'p': out.push('<p>'); kids.forEach(walk); out.push('</p>'); txt.push('\n'); break;
      case 'br': out.push('<br>'); txt.push('\n'); break;
      case 'li': out.push('<li>'); kids.forEach(walk); out.push('</li>'); txt.push('\n'); break;
      case 'ul': case 'ol': out.push(`<${name}>`); kids.forEach(walk); out.push(`</${name}>`); txt.push('\n'); break;
      case 'tr': out.push('<tr>'); kids.forEach(walk); out.push('</tr>'); txt.push('\n'); break;
      case 'td': case 'th': out.push(`<${name}>`); kids.forEach(walk); out.push(`</${name}>`); txt.push(' '); break;
      case 'table': out.push('<table>'); kids.forEach(walk); out.push('</table>'); txt.push('\n'); break;
      case 'strong': case 'b': out.push('<b>'); kids.forEach(walk); out.push('</b>'); break;
      case 'em': case 'i': out.push('<i>'); kids.forEach(walk); out.push('</i>'); break;
      case 'u': out.push('<u>'); kids.forEach(walk); out.push('</u>'); break;
      default: kids.forEach(walk);
    }
  };
  walk(node);
  const text = txt.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { html: out.join(''), text, imgs };
}

/** 语料 correctAnswer → 库里的 answer / answerIndex 约定 */
function answerOf(ca, type, optCount) {
  if (!ca || ca.choice == null) return null;
  const choice = String(ca.choice).trim();
  const t = Number(type);
  if (t === 5) {
    const i = Number(choice);
    if (i === 0 || i === 1) return { answer: i === 0 ? 'A' : 'B', answerIndex: i };
    if (choice === 'A' || choice === 'B') return { answer: choice, answerIndex: choice === 'A' ? 0 : 1 };
    return null;
  }
  if (choice.includes(',')) {
    const idx = choice.split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x));
    if (!idx.length) return null;
    return { answer: idx.join(','), answerIndex: -1 };
  }
  const i = Number(choice);
  if (!Number.isFinite(i)) return null;
  if (i < 0 || i > 9 || (optCount && i >= optCount)) return null;
  return { answer: String.fromCharCode(65 + i), answerIndex: i };
}

// ---------- 载入语料 ----------
const byId = new Map();
let corpusFiles = 0;
for (const dir of CORPUS_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const arr = j.solutions || j.questions || [];
    if (!Array.isArray(arr)) continue;
    corpusFiles += 1;
    for (const s of arr) {
      if (!s || s.id == null) continue;
      const key = String(s.id);
      const score = (s.solution ? 2 : 0) + (s.content ? 1 : 0) + (s.correctAnswer && s.correctAnswer.choice != null ? 1 : 0);
      const prev = byId.get(key);
      if (!prev || score > prev.score) byId.set(key, { s, score });
    }
  }
}
console.log(`语料：${corpusFiles} 个文件 / ${byId.size} 道唯一题`);

const db = new DatabaseSync(DB);
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const rows = q(`SELECT id, questionId, type, answer, answerIndex, options,
  COALESCE(content,'') content, COALESCE(contentHtml,'') chtml,
  COALESCE(analysis,'') analysis, COALESCE(analysisHtml,'') ahtml,
  COALESCE(material,'') material, COALESCE(q_bad,0) bad
  FROM questions WHERE id IN (SELECT MAX(id) FROM questions GROUP BY questionId)`);

const stat = {
  total: rows.length, inCorpus: 0,
  matFill: 0, matKnown: 0,
  contentFill: 0, contentImg: 0,
  analysisFill: 0, analysisImg: 0,
  answerFill: 0,
  matFromQm: 0,
  touched: new Set(),
};
const ops = [];   // { questionId, sets:[] , values:{} }
// 预先一次性把「题目 → 材料正文」装进内存（逐行 join 在 10 万行上要几分钟）
const matMap = new Map();
for (const m of q(`SELECT m.question_id AS qid, x.content AS c FROM q_material_map m
  JOIN q_materials x ON x.material_id = m.material_id
  WHERE length(COALESCE(x.content,'')) > 20 ORDER BY length(x.content) DESC`)) {
  if (!matMap.has(m.qid)) matMap.set(m.qid, m.c);
}
console.log(`材料映射：${matMap.size} 道题可从 q_materials 取正文`);

for (const r of rows) {
  const gid = String(r.questionId);
  const hit = byId.get(gid);
  if (hit) stat.inCorpus += 1;
  const sets = [];
  const vals = {};
  const opts = (() => { try { const a = JSON.parse(r.options || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();

  // 1) material：库里空 → q_materials
  if (!r.material.trim()) {
    const c = matMap.get(Number(r.questionId));
    if (c) { vals.material = c; sets.push('material'); stat.matFromQm += 1; }
  }

  if (hit) {
    const s = hit.s;
    const rich = s.content ? richToHtml(s.content) : null;
    const sol = s.solution ? richToHtml(s.solution) : null;

    // 2) contentHtml：库里没图、语料里有图 → 用语料的题干重建
    const ourImg = /<img/i.test(r.chtml) || /<img/i.test(r.material);
    if (rich && rich.imgs.length && !ourImg && rich.text.length >= 6) {
      vals.contentHtml = rich.html;
      if (!r.content.trim()) vals.content = rich.text;
      sets.push('contentHtml');
      stat.contentImg += rich.imgs.length;
      stat.contentFill += 1;
    }

    // 3) analysis：库里解析太短 → 用语料解析
    if (sol && sol.text.length >= 20 && r.analysis.trim().length < 20) {
      vals.analysisHtml = sol.html;
      vals.analysis = sol.text;
      sets.push('analysis');
      stat.analysisImg += sol.imgs.length;
      stat.analysisFill += 1;
    }

    // 4) answer：客观题缺答案 → 语料正确选项
    const obj = [1, 2, 3, 5].includes(Number(r.type));
    // 多选的 answerIndex 正常就是 -1（答案存在 answer 里，形如 "0,1,3"），所以必须有 answer 才算缺
    const noAns = (r.answerIndex == null || Number(r.answerIndex) < 0) && !String(r.answer || '').trim();
    if (obj && noAns) {
      const a = answerOf(s.correctAnswer, r.type, opts.length);
      if (a) { vals.answer = a.answer; vals.answerIndex = a.answerIndex; sets.push('answer'); stat.answerFill += 1; }
    }
  }

  if (sets.length) { ops.push({ questionId: Number(r.questionId), id: Number(r.id), sets, vals }); sets.forEach((x) => stat.touched.add(x)); }
}

console.log(JSON.stringify({
  total: stat.total, inCorpus: stat.inCorpus,
  materialFromQMaterials: stat.matFromQm,
  contentRebuiltWithImages: stat.contentFill, imagesRestored: stat.contentImg,
  analysisFilled: stat.analysisFill, analysisImages: stat.analysisImg,
  answersFilled: stat.answerFill,
  rowsToUpdate: ops.length,
}, null, 2));

if (!APPLY) {
  console.log('dry-run：加 --apply 才写库');
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
const upd = db.prepare(`UPDATE questions SET
  material = CASE WHEN ?1 IS NULL THEN material ELSE ?1 END,
  content = CASE WHEN ?2 IS NULL THEN content ELSE ?2 END,
  contentHtml = CASE WHEN ?3 IS NULL THEN contentHtml ELSE ?3 END,
  analysis = CASE WHEN ?4 IS NULL THEN analysis ELSE ?4 END,
  analysisHtml = CASE WHEN ?5 IS NULL THEN analysisHtml ELSE ?5 END,
  answer = CASE WHEN ?6 IS NULL THEN answer ELSE ?6 END,
  answerIndex = CASE WHEN ?7 IS NULL THEN answerIndex ELSE ?7 END
  WHERE questionId = ?8`);
let n = 0;
for (const op of ops) {
  upd.run(
    op.vals.material ?? null, op.vals.content ?? null, op.vals.contentHtml ?? null,
    op.vals.analysis ?? null, op.vals.analysisHtml ?? null,
    op.vals.answer ?? null, op.vals.answerIndex ?? null, op.questionId,
  );
  n += 1;
}
db.exec('COMMIT');
console.log(`已更新 ${n} 道题（按 questionId 覆盖全部重复行）`);
console.log('integrity:', one('PRAGMA integrity_check')?.integrity_check);
db.close();
