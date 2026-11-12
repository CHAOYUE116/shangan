/**
 * 把「图丢了」且确实救不回来的图形推理题移出题库：
 *   1) 先把完整行备份成 JSON（含所有列）到 report/quarantine-graph-<day>.json
 *   2) 再删除 questions 里这些 questionId 的所有行
 *   3) 同时清理 question_keypoints / question_keypoints_ext / question_categories / q_material_map
 * 默认 dry-run，--apply 才动库。
 *
 *   node tools/quarantine-graph-questions.mjs
 *   node tools/quarantine-graph-questions.mjs --apply --chapter 判断推理
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def = '') => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const has = (n) => process.argv.slice(2).includes(`--${n}`);
const APPLY = has('apply');
const DB = arg('db') || path.join(ROOT, 'app-assets', 'tiku_app.db');
const CHAPTERS = String(arg('chapter', '判断推理,图形推理,推理判断')).split(',').map((s) => s.trim()).filter(Boolean);
const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');

if (!fs.existsSync(DB)) { console.error('找不到库：' + DB); process.exit(1); }
const db = new DatabaseSync(DB);

const ph = CHAPTERS.map(() => '?').join(',');
const rows = db.prepare(`
  SELECT * FROM questions
  WHERE COALESCE(q_bad, 0) = 1
    AND COALESCE(q_bad_reason, '') LIKE '%图丢了%'
    AND chapter IN (${ph})
`).all(...CHAPTERS);

const ids = [...new Set(rows.map((r) => Number(r.questionId)))];
console.log(`章节 ${CHAPTERS.join('/')} 里「图丢了」的行 ${rows.length}，涉及题目 ${ids.length} 道`);
if (!ids.length) { db.close(); process.exit(0); }

const sample = rows.slice(0, 5).map((r) => ({ id: r.id, questionId: r.questionId, paperId: r.paperId, stem: String(r.content || '').slice(0, 60) }));
for (const s of sample) console.log(`  · ${s.questionId} (卷 ${s.paperId}) ${s.stem}`);

if (!APPLY) {
  console.log('\n（dry-run）加 --apply 才会写库。会做：备份 JSON → 删 questions / question_keypoints(_ext) / question_categories / q_material_map');
  db.close();
  process.exit(0);
}

const outJson = path.join(ROOT, 'report', `quarantine-graph-${DAY}.json`);
fs.writeFileSync(outJson, JSON.stringify({ at: new Date().toISOString(), db: path.basename(DB), chapters: CHAPTERS, count: ids.length, rows }, null, 1));
console.log(`已备份 ${rows.length} 行 → ${path.relative(ROOT, outJson)}`);

const inList = ids.map(() => '?').join(',');
const tx = db.prepare('SELECT 1'); tx.run();
db.exec('BEGIN');
try {
  const delQ = db.prepare(`DELETE FROM questions WHERE questionId IN (${inList})`).run(...ids);
  const delKp = db.prepare(`DELETE FROM question_keypoints WHERE questionId IN (${inList})`).run(...ids);
  const delKpExt = db.prepare(`DELETE FROM question_keypoints_ext WHERE questionId IN (${inList})`).run(...ids);
  const delCat = db.prepare(`DELETE FROM question_categories WHERE question_id IN (${inList})`).run(...ids);
  const delMap = db.prepare(`DELETE FROM q_material_map WHERE question_id IN (${inList})`).run(...ids);
  db.exec('COMMIT');
  console.log(`已删除：questions ${delQ.changes} 行 / question_keypoints ${delKp.changes} / ext ${delKpExt.changes} / question_categories ${delCat.changes} / q_material_map ${delMap.changes}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('回滚：' + e.message);
  db.close();
  process.exit(1);
}
console.log('integrity_check =', db.prepare('PRAGMA integrity_check').get().integrity_check);
db.close();
