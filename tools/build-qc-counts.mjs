/**
 * 生成 public/next/qc-counts.json —— 分类/章节题量的预计算结果。
 *
 * 为什么需要：`/api/chapters` 要按 category/sub 统计题量，SQL 是
 * `question_categories JOIN questions JOIN papers`（9 万行 × 回表），
 * 手机上实测 13–103 秒。这些数字只跟题库版本有关、跟用户无关，
 * 所以在构建时算好、随 Web 资源一起发出去，运行时直接读，不再查库。
 *
 * 用法：node tools/build-qc-counts.mjs [--db app-assets/tiku_app.db]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const dbPath = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const out = path.resolve(ROOT, arg('out', 'public/next/qc-counts.json'));

const NOW = new Date().getFullYear();
const YEAR_FROM = NOW - 18;
const YEAR_TO = NOW + 1;
const YEAR_OF = "CAST(substr(p.name, MAX(1, instr(p.name, '20')), 4) AS INTEGER)";

const db = new DatabaseSync(dbPath, { readOnly: true });
const subjects = db
  .prepare('SELECT DISTINCT subjectName FROM papers ORDER BY subjectName')
  .all()
  .map((r) => r.subjectName);

const out_data = { builtAt: new Date().toISOString(), db: path.basename(dbPath), subjects: {} };
for (const subject of subjects) {
  const idx = {};
  const group = {};
  try {
    for (const r of db
      .prepare(
        `SELECT qc.category, qc.sub, COUNT(DISTINCT qc.question_id) c FROM question_categories qc
         JOIN questions q ON q.questionId = qc.question_id
         JOIN papers p ON p.id = q.paperId AND ${YEAR_OF} BETWEEN ${YEAR_FROM} AND ${YEAR_TO}
         WHERE qc.subject = ? GROUP BY qc.category, qc.sub`
      )
      .all(subject)) {
      idx[`${r.category}|${r.sub || ''}`] = Number(r.c) || 0;
    }
    for (const r of db
      .prepare(
        `SELECT qc.category, COUNT(DISTINCT qc.question_id) c FROM question_categories qc
         JOIN questions q ON q.questionId = qc.question_id
         JOIN papers p ON p.id = q.paperId AND ${YEAR_OF} BETWEEN ${YEAR_FROM} AND ${YEAR_TO}
         WHERE qc.subject = ? GROUP BY qc.category`
      )
      .all(subject)) {
      group[r.category] = Number(r.c) || 0;
    }
  } catch (e) {
    console.error(`  ! ${subject}: ${e.message}`);
    continue;
  }
  // 公基口径：不套年份过滤（公基卷跨 2015-2024，套年份会少一截）
  if (subject === '事业编·公基') {
    const gj = {};
    for (const r of db
      .prepare(
        `SELECT qc.category, COUNT(DISTINCT qc.question_id) c FROM question_categories qc
         WHERE qc.subject = ? GROUP BY qc.category`
      )
      .all(subject)) {
      gj[r.category] = Number(r.c) || 0;
    }
    out_data.subjects[subject] = { group: gj, idx: {}, gongji: true };
  } else {
    out_data.subjects[subject] = { group, idx };
  }
  const n = Object.keys(out_data.subjects[subject].group).length;
  console.log(`  ${subject}: ${n} 个分类`);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(out_data));
const size = fs.statSync(out).size;
console.log(`✓ ${path.relative(ROOT, out)}  ${(size / 1024).toFixed(1)} KB`);
