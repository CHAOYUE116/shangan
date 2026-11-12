// 把「缺答案但解析里写死了答案」的题补上：只认强信号（正是…答案为 X），
// 不认逐项点评里的「X 项正确」，避免把「A、B 选项会产生负面影响」读成答案 A/B。
//
//   node tools/backfill-answers.mjs --dry
//   node tools/backfill-answers.mjs --apply
//   node tools/backfill-answers.mjs --dry --limit 20   # 只抽查前 20 条
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APPLY = !!arg('apply', false);
const LIMIT = Number(arg('limit', 0)) || 0;
const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = path.join(ROOT, 'report');
fs.mkdirSync(OUT, { recursive: true });

const LETTERS = 'ABCDEFGH';
const OBJ = '(1,2,3,5)';
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** 只取强信号；返回 'CD' 这样的字母串 */
function strongLetters(analysis, optionCount) {
  const t = stripHtml(analysis);
  if (!t) return '';
  const norm = (raw) => {
    const ls = [...new Set(raw.replace(/[^A-H]/g, '').split(''))].sort();
    if (!ls.length) return '';
    if (optionCount && ls.length > optionCount) return '';
    return ls.join('');
  };
  const pats = [
    /(?:故|因此|所以|综上|本题)?\s*正确答案\s*(?:是|为|应选|选|有)?\s*[：:，,]?\s*((?:[A-H][、,，和及与]?){1,4})/,
    /(?:故|因此|所以|综上|本题|此题)?\s*(?:答案|正确选项)\s*(?:是|为|应选|选)\s*[：:，,]?\s*((?:[A-H][、,，和及与]?){1,4})/,
    /(?:故选|应选|答案选)\s*((?:[A-H][、,，和及与]?){1,4})/,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) {
      const v = norm(m[1]);
      if (v) return v;
    }
  }
  return '';
}

const db = new DatabaseSync(DB);
const all = (sql, ...a) => db.prepare(sql).all(...a);

// 每题只取最后入库的那一行作为判据（同 questionId 可能跨卷重复）
const rows = all(
  `SELECT q.id, q.questionId, q.type, q.answer, q.answerIndex, q.options, q.analysis, q.content, p.subjectName
     FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
      AND q.type IN ${OBJ}
      AND (q.answerIndex IS NULL OR q.answerIndex < 0)
    ORDER BY q.id`,
);

const plan = [];
const skipped = { 判断题无解析: 0, 解析里没写死答案: 0, 选项数不够: 0, 字母超出选项: 0 };
for (const r of rows) {
  let opts = [];
  try { opts = JSON.parse(r.options || '[]'); } catch { /* ignore */ }
  const isJudge = String(r.type) === '5';
  const n = isJudge ? 2 : opts.length;
  if (!isJudge && n < 2) { skipped['选项数不够'] += 1; continue; }
  const letters = strongLetters(r.analysis, n);
  if (!letters) { skipped[isJudge ? '判断题无解析' : '解析里没写死答案'] += 1; continue; }
  const idx = [...letters].map((L) => LETTERS.indexOf(L)).filter((i) => i >= 0 && i < n);
  if (!idx.length || idx.length !== letters.length) { skipped['字母超出选项'] += 1; continue; }
  const multi = !isJudge && idx.length > 1;
  plan.push({
    questionId: r.questionId,
    subjectName: r.subjectName,
    type: r.type,
    letters,
    answer: multi ? idx.join(',') : letters,
    answerIndex: multi ? -1 : idx[0],
    stem: stripHtml(r.content).slice(0, 46),
    why: stripHtml(r.analysis).slice(0, 60),
  });
}

const list = LIMIT ? plan.slice(0, LIMIT) : plan;
if (APPLY && list.length) {
  const upd = db.prepare('UPDATE questions SET answer = ?, answerIndex = ? WHERE questionId = ? AND (answerIndex IS NULL OR answerIndex < 0)');
  db.exec('BEGIN');
  try {
    for (const p of list) upd.run(p.answer, p.answerIndex, p.questionId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const csv = ['\ufeff题号,科目,题型,反推答案,题干,解析依据'];
for (const p of list) {
  csv.push([p.questionId, p.subjectName, p.type, p.letters, `"${p.stem.replace(/"/g, '""')}"`, `"${p.why.replace(/"/g, '""')}"`].join(','));
}
const file = path.join(OUT, `answers-backfill-${DAY}.csv`);
fs.writeFileSync(file, csv.join('\n'), 'utf8');

console.log(JSON.stringify({
  db: path.basename(DB),
  apply: APPLY,
  candidates: plan.length,
  written: APPLY ? list.length : 0,
  skipped,
  out: path.relative(ROOT, file),
}, null, 0));
if (!APPLY) {
  for (const p of list.slice(0, 12)) console.log(`  ${p.questionId} [${p.subjectName}] → ${p.letters} | ${p.stem} | …${p.why.slice(-30)}`);
}
