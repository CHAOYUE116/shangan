import { DatabaseSync } from 'node:sqlite';

const root = 'D:/Projects/上岸APP/kaogong-shuati/';
const tiku = new DatabaseSync(root + 'tiku.db', { readOnly: true });
const img = new DatabaseSync(root + 'app-assets/images.db', { readOnly: true });

const have = new Set(img.prepare('SELECT key FROM images').all().map((r) => r.key));
console.log('images.db 已有图', have.size);

const rows = tiku.prepare(`
  SELECT questionId, subjectName, content, contentHtml, options, analysis, analysisHtml, answer, answerIndex
  FROM (
    SELECT q.questionId, p.subjectName, q.content, q.contentHtml, q.options, q.analysis, q.analysisHtml, q.answer, q.answerIndex
    FROM questions q LEFT JOIN papers p ON p.id = q.paperId
  )
`).all();

console.log('总行', rows.length);

function unesc(s) { return String(s || '').replace(/\\"/g, '"'); }

function imgKeys(html) {
  const out = [];
  for (const m of unesc(html).matchAll(/src="([^"]+)"/g)) {
    const fm = m[1].match(/formulas\?latex=([^&"']+)/);
    if (fm) out.push(decodeURIComponent(fm[1]));
  }
  return out;
}

const stat = {
  emptyOptions: 0,
  optionsAllBlank: 0,
  imgOptionsMissing: 0,
  imgContentMissing: 0,
  emptyContent: 0,
  noAnswer: 0,
};
const seen = new Set();
const samples = { emptyOptions: [], optionsAllBlank: [], imgOptionsMissing: [], imgContentMissing: [], emptyContent: [] };
const bySubject = new Map();

for (const r of rows) {
  const key = `${r.questionId}`;
  const dup = seen.has(key);
  if (!dup) seen.add(key);
  const subj = r.subjectName || '未知';
  if (!bySubject.has(subj)) bySubject.set(subj, { total: 0, bad: 0 });
  const bs = bySubject.get(subj);
  if (!dup) bs.total++;

  let bad = false;
  const qtype = String(r.content || '') + String(r.options || '');
  const isSubjective = !r.options || r.options === '[]' || r.options === 'null' || String(r.options).trim() === '';

  if (!r.content || !String(r.content).trim()) {
    if (!dup) stat.emptyContent++;
    bad = true;
    if (samples.emptyContent.length < 5) samples.emptyContent.push(r.questionId);
  }

  if (Array.isArray(JSON.parse(r.options || '[]'))) { /* noop */ }

  let opts = [];
  try { opts = JSON.parse(unesc(r.options) || '[]'); } catch { opts = []; }
  if (!Array.isArray(opts)) opts = [];

  const blankCount = opts.filter((o) => !String(o || '').replace(/<[^>]+>/g, '').trim() && !String(o || '').includes('<img')).length;

  if (opts.length && blankCount === opts.length) {
    if (!dup) stat.optionsAllBlank++;
    bad = true;
    if (samples.optionsAllBlank.length < 5) samples.optionsAllBlank.push(r.questionId);
  }

  const optImgs = imgKeys(r.options);
  const missOpt = optImgs.filter((k) => !have.has(k));
  if (missOpt.length) {
    if (!dup) stat.imgOptionsMissing++;
    bad = true;
    if (samples.imgOptionsMissing.length < 5) samples.imgOptionsMissing.push(`${r.questionId}(${missOpt.length}/${optImgs.length})`);
  }

  const cImgs = imgKeys(r.contentHtml);
  const missC = cImgs.filter((k) => !have.has(k));
  if (missC.length) {
    if (!dup) stat.imgContentMissing++;
    bad = true;
    if (samples.imgContentMissing.length < 5) samples.imgContentMissing.push(`${r.questionId}(${missC.length}/${cImgs.length})`);
  }

  if (bad && !dup) bs.bad++;
}

console.log('\n=== 坏题统计（按唯一题）===');
console.log('题干空白       ', stat.emptyContent);
console.log('选项全空白     ', stat.optionsAllBlank);
console.log('选项图片缺失   ', stat.imgOptionsMissing);
console.log('题干图片缺失   ', stat.imgContentMissing);
console.log('\n样例：');
for (const [k, v] of Object.entries(samples)) if (v.length) console.log(' ', k, v.join(', '));

console.log('\n=== 按科目 ===');
for (const [k, v] of bySubject) console.log(` ${k}  总 ${v.total}  坏 ${v.bad}  ${(v.bad / Math.max(1, v.total) * 100).toFixed(1)}%`);

tiku.close(); img.close();
