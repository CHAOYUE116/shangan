#!/usr/bin/env node
/**
 * tools/fix-answer-conflicts.mjs — 用粉笔语料修正「答案与解析互相矛盾」的题
 *
 * 判定：拿题目的解析里明确写出的答案（强信号句式），跟粉笔语料 correctAnswer 比。
 *   两个都指向同一组选项、而库里存的答案不是这一组 → 说明库里答案错了，用粉笔的覆盖。
 *   解析和粉笔也对不上 → 不动（留人工/屏蔽）。
 *
 * 用法：
 *   node tools/fix-answer-conflicts.mjs            # dry-run
 *   node tools/fix-answer-conflicts.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PARENT = path.resolve(ROOT, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DB = path.resolve(ROOT, 'app-assets/tiku_app.db');

const CORPUS_DIRS = [
  path.join(PARENT, 'research/fenbi-solutions/sydw'),
  path.join(PARENT, 'research/fenbi-solutions/syzc'),
  path.join(PARENT, 'research/fenbi-keypoint/syzc'),
];

const byId = new Map();
let files = 0;
for (const dir of CORPUS_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    files += 1;
    for (const s of (j.solutions || j.questions || [])) {
      if (!s || s.id == null || !s.correctAnswer || s.correctAnswer.choice == null) continue;
      if (!byId.has(String(s.id))) byId.set(String(s.id), s.correctAnswer);
    }
  }
}
console.log(`语料 ${files} 个文件 / ${byId.size} 条带答案`);

const LETTERS = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7 };
const norm = (v, type) => {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\d+(\s*,\s*\d+)*$/.test(s)) return s.split(',').map((x) => Number(x.trim())).sort((a, b) => a - b);
  if (Number(type) === 5) return s.split('').filter((c) => LETTERS[c] != null).map((c) => LETTERS[c]);
  return s.replace(/[^A-Z]/g, '').split('').filter((c) => LETTERS[c] != null).map((c) => LETTERS[c]).sort((a, b) => a - b);
};

/** 解析里明确写出的答案 */
const saidAnswer = (text, type) => {
  const t = String(text || '');
  const pats = [
    /(?:故)?正确答案(?:是|为|应选|选)\s*[:：]?\s*([A-H](?:\s*[、,，和与]\s*[A-H])*)/,
    /(?:正确选项|答案)(?:是|为|应选|选)\s*[:：]?\s*([A-H](?:\s*[、,，和与]\s*[A-H])*)/,
    /(?:故选|应选|答案选|本题选)\s*[:：]?\s*([A-H](?:\s*[、,，和与]\s*[A-H])*)/,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m && m[1]) {
      const s = norm(m[1], type);
      if (s && s.length) return s;
    }
  }
  if (Number(type) === 5) {
    if (/故(?:本题)?(?:说法)?正确|表述正确/.test(t)) return [0];
    if (/故(?:本题)?(?:说法)?错误|表述错误/.test(t)) return [1];
  }
  return null;
};

const db = new DatabaseSync(DB);
const rows = db.prepare(`SELECT id, questionId, type, answer, answerIndex, analysis, options, q_bad_reason
  FROM questions WHERE q_bad_reason LIKE '%不符%' AND id IN (SELECT MAX(id) FROM questions GROUP BY questionId)`).all();

const fixes = [];
const skipped = { noCorpus: 0, analysisMismatch: 0, same: 0 };
for (const r of rows) {
  const ca = byId.get(String(r.questionId));
  if (!ca) { skipped.noCorpus += 1; continue; }
  const theirs = norm(ca.choice, r.type);
  const said = saidAnswer(r.analysis, r.type);
  if (!theirs || !theirs.length) { skipped.noCorpus += 1; continue; }
  if (!said || said.join(',') !== theirs.join(',')) { skipped.analysisMismatch += 1; continue; }
  const ours = norm(r.answer, r.type);
  if (ours && ours.join(',') === theirs.join(',')) { skipped.same += 1; continue; }
  const opts = (() => { try { const a = JSON.parse(r.options || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();
  if (opts.length && theirs.some((i) => i >= opts.length)) { skipped.analysisMismatch += 1; continue; }
  const isMulti = theirs.length > 1 || [2, 3].includes(Number(r.type));
  fixes.push({
    questionId: r.questionId,
    from: String(r.answer || ''),
    to: isMulti ? theirs.join(',') : String.fromCharCode(65 + theirs[0]),
    answerIndex: isMulti ? -1 : theirs[0],
  });
}

console.log(JSON.stringify({ flagged: rows.length, fixable: fixes.length, skipped, samples: fixes.slice(0, 5) }, null, 1));
if (!APPLY) { console.log('dry-run：加 --apply 才写库'); db.close(); process.exit(0); }

const upd = db.prepare('UPDATE questions SET answer = ?, answerIndex = ? WHERE questionId = ?');
db.exec('BEGIN');
for (const f of fixes) upd.run(f.to, f.answerIndex, f.questionId);
db.exec('COMMIT');
console.log(`已修正 ${fixes.length} 道题的答案（按 questionId 覆盖全部重复行）`);
console.log('integrity:', db.prepare('PRAGMA integrity_check').get()?.integrity_check);
db.close();
