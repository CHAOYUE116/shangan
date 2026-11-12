#!/usr/bin/env node
/**
 * 散题采集质量校验（边采边验）
 * ---------------------------------------------------------------
 * 读 research/fenbi-keypoint/<course>/*.json，对每道题做结构体检：
 *   1 空题干 / 题干过短
 *   2 客观题没有选项、或选项里有空串（图片选项会被采成空串）
 *   3 客观题没有答案，或答案下标越界
 *   4 没有解析 / 解析过短
 *   5 题干或材料提到「如图/下表」但整题没有图
 *   6 图片键（formulas?latex=）在 images.db 里查不到
 *   7 与库内已有题或语料内其它题内容指纹重复
 *
 * 用法：
 *   node tools/validate-kp.mjs --course syzc
 *   node tools/validate-kp.mjs --course syzc --since 2026-11-12T21:00   # 只看新采的文件（按文件 mtime）
 *   node tools/validate-kp.mjs --course syzc --csv report/kp-bad-syzc.csv --limit-samples 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const COURSE = arg('course', 'syzc');
const SINCE = arg('since', '');
const CSV = arg('csv', '');
const SAMPLE = Number(arg('limit-samples', '3'));
const DB = arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db'));
const IMG_DB = arg('img-db', path.join(ROOT, 'app-assets', 'images.db'));
const DIR = path.resolve(ROOT, '..', 'research', 'fenbi-keypoint', COURSE);

const IS_OBJ = new Set([1, 2, 3, 5]);
const FIG_HINT = /(\[图\]|（图）|\(图\)|如图|如下图|图中|图\s?\d|下表|上表|表格|折线图|柱状图|饼图)/;
const LATEX = /formulas\?latex=([A-Za-z0-9_-]+)/g;
const IMG_TAG = /<img\b/i;

const bad = [];
const stat = { files: 0, questions: 0, unique: 0, dupInCorpus: 0, dupInDb: 0, withImg: 0, withMat: 0, rules: {} };
const bump = (k) => { stat.rules[k] = (stat.rules[k] || 0) + 1; };
const fp = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\p{P}]/gu, '').slice(0, 120);
const hasImg = (s) => IMG_TAG.test(String(s || ''));

/* ---------- 图片库键集合 ---------- */
let imgKeys = new Set();
try {
  const { DatabaseSync } = await import('node:sqlite');
  const idb = new DatabaseSync(IMG_DB, { readOnly: true });
  for (const r of idb.prepare('SELECT key FROM images').all()) imgKeys.add(String(r.key));
  idb.close();
} catch (e) { console.warn('（images.db 读不到，跳过规则 6）', e.message); }

/* ---------- 库内指纹 ---------- */
let dbFp = new Set();
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  for (const r of db.prepare('SELECT content FROM questions').all()) dbFp.add(fp(r.content));
  db.close();
} catch (e) { console.warn('（tiku_app.db 读不到，跳过跨库去重）', e.message); }

/* ---------- 扫语料 ---------- */
if (!fs.existsSync(DIR)) { console.error('目录不存在：' + DIR); process.exit(1); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const sinceTs = SINCE ? Date.parse(SINCE) : 0;
const corpus = new Map();
for (const f of files) {
  const full = path.join(DIR, f);
  const mt = fs.statSync(full).mtimeMs;
  if (sinceTs && mt < sinceTs) continue;
  stat.files++;
  let j;
  try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { stat.rules.parse = (stat.rules.parse || 0) + 1; continue; }
  for (const q of j.questions || []) {
    stat.questions++;
    const qid = q.questionId != null ? String(q.questionId) : (q.globalId || '?');
    const cHtml = q.contentHtml || q.content || '';
    const sHtml = q.solutionHtml || q.solution || '';
    const mHtml = q.materialHtml || q.material || '';
    if (hasImg(cHtml) || hasImg(sHtml) || hasImg(mHtml)) stat.withImg++;
    if (String(q.material || '').trim()) stat.withMat++;

    const reasons = [];
    const text = String(q.content || '').trim();
    if (!text || text.length < 6) reasons.push('空题干');
    const type = Number(q.type);
    const opts = Array.isArray(q.options) ? q.options : [];
    if (IS_OBJ.has(type)) {
      if (!opts.length) reasons.push('没有选项');
      else if (opts.some((o) => !String(o == null ? '' : o).trim())) reasons.push('选项有空值');
      const ca = q.correctAnswer && (q.correctAnswer.choice != null ? q.correctAnswer.choice : q.correctAnswer.answer);
      if (ca == null || ca === '') reasons.push('没有答案');
      else if (/^\d+$/.test(String(ca)) && Number(ca) >= opts.length) reasons.push('答案下标越界');
    }
    if (!String(q.solution || '').trim() || String(q.solution).trim().length < 10) reasons.push('没有解析');
    if (FIG_HINT.test(text + ' ' + String(q.material || '')) && !hasImg(cHtml) && !hasImg(mHtml)) reasons.push('提到图/表但没有图');
    if (imgKeys.size) {
      const keys = new Set();
      for (const m of (cHtml + sHtml + mHtml).matchAll(LATEX)) keys.add(m[1]);
      const miss = [...keys].filter((k) => !imgKeys.has(k));
      if (miss.length) reasons.push(`图片键缺失(${miss.length})`);
    }
    const k = fp(q.content);
    if (k) {
      if (corpus.has(k)) { stat.dupInCorpus++; reasons.push('语料内重复'); }
      else corpus.set(k, qid);
      if (dbFp.has(k)) { stat.dupInDb++; if (!reasons.includes('语料内重复')) reasons.push('库里已有同题'); }
    }
    if (reasons.length) {
      for (const r of reasons) bump(r.replace(/\(\d+\)/, ''));
      bad.push({ questionId: qid, file: f, reasons: reasons.join('、'), content: text.replace(/\s+/g, ' ').slice(0, 90), options: opts.length, type });
    }
  }
}
stat.unique = corpus.size;

/* ---------- 输出 ---------- */
const pct = (n) => (stat.questions ? ((n / stat.questions) * 100).toFixed(1) + '%' : '-');
console.log(`\n== 散题体检 · ${COURSE} ==`);
console.log(`文件 ${stat.files} 个（${SINCE ? '有改动的' : '全部'}）· 题目 ${stat.questions} 条 · 按题干去重 ${stat.unique} 条`);
console.log(`带图/公式 ${stat.withImg}（${pct(stat.withImg)}）· 带材料 ${stat.withMat}（${pct(stat.withMat)}）`);
console.log(`问题题 ${bad.length}（${pct(bad.length)}）`);
for (const [k, v] of Object.entries(stat.rules).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}（${pct(v)}）`);
if (bad.length) {
  const byReason = new Map();
  for (const b of bad) for (const r of b.reasons.split('、').slice(0, 1)) byReason.set(r, (byReason.get(r) || 0) + 1);
  console.log('\n样例：');
  for (const b of bad.slice(0, SAMPLE)) console.log(`  #${b.questionId} [${b.reasons}] ${b.content}`);
}
if (CSV) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, CSV)), { recursive: true });
  const lines = ['题号,来源文件,问题,题型,选项数,题干'];
  for (const b of bad) lines.push([b.questionId, b.file, b.reasons, b.type, b.options, '"' + b.content.replace(/"/g, '""') + '"'].join(','));
  fs.writeFileSync(path.resolve(ROOT, CSV), '\uFEFF' + lines.join('\n'), 'utf8');
  console.log(`\n明细 → ${CSV}（${bad.length} 行）`);
}
const jsonPath = path.resolve(ROOT, 'report', `validate-kp-${COURSE}.json`);
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify({ course: COURSE, since: SINCE || null, stat, samples: bad.slice(0, 50) }, null, 2));
console.log(`汇总 → report/validate-kp-${COURSE}.json`);
