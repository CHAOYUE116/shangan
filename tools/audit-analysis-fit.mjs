#!/usr/bin/env node
/**
 * tools/audit-analysis-fit.mjs — 找出「解析与题干明显不是一回事」的题（只读）
 *
 * 判据（字面重合，不依赖模型）：
 *   把题干去掉标点后切成 2-gram，统计其中有多少出现在解析里。
 *   正常解析会大量复述题干关键词（覆盖率通常 > 45%）；
 *   错配的解析（如题干问「公务员处分」，解析讲「空气质量指数」）覆盖率会极低。
 *
 * 只统计「有解析」的题，输出覆盖率分布与可疑样本，供人工确认后再决定清空。
 *
 * 用法：node tools/audit-analysis-fit.mjs [--course syzc] [--min 0.18] [--limit 30]
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSE = arg('course', null);
const MIN = Number(arg('min', 0.18));
const LIMIT = Number(arg('limit', 30));
const subOf = { syzc: '事业编·职测', sydw: '事业编·公基', zhyynl: '事业编·综应', shenlun: '公务员·申论', xingce: '公务员·行测' };

const db = new DatabaseSync(path.resolve(ROOT, 'tiku.db'));
const where = COURSE ? `p.subjectName = '${subOf[COURSE]}'` : `1=1`;
const rows = db.prepare(`
  SELECT q.questionId, q.content, q.answerIndex, q.analysis, p.subjectName AS sub
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE ${where} AND q.analysis IS NOT NULL AND TRIM(q.analysis) <> ''
`).all();

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\u3000]+/g, '').replace(/[，。、；：？！“”‘’（）()《》〈〉·\-—…\[\]【】]/g, '');
const grams = (s) => { const out = new Set(); for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2)); return out; };

const buckets = { '0-10%': 0, '10-20%': 0, '20-30%': 0, '30-45%': 0, '45%+': 0 };
const bad = [];
for (const r of rows) {
  const head = clean(r.content).slice(0, 160);
  if (head.length < 20) continue;
  const g = grams(head);
  const a = clean(r.analysis);
  let hit = 0;
  for (const x of g) if (a.includes(x)) hit += 1;
  const cov = g.size ? hit / g.size : 1;
  if (cov < 0.10) buckets['0-10%'] += 1;
  else if (cov < 0.20) buckets['10-20%'] += 1;
  else if (cov < 0.30) buckets['20-30%'] += 1;
  else if (cov < 0.45) buckets['30-45%'] += 1;
  else buckets['45%+'] += 1;
  if (cov < MIN) bad.push({ id: r.questionId, sub: r.sub, cov: Number(cov.toFixed(3)), head: String(r.content).replace(/<[^>]+>/g, '').slice(0, 42), ana: a.slice(0, 60) });
}

console.log(`有解析 ${rows.length} 题，题干 2-gram 覆盖率分布：`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(7)} ${String(v).padStart(6)}  ${(v / rows.length * 100).toFixed(1)}%`);
console.log(`\n覆盖率 < ${MIN} 的可疑 ${bad.length} 题（${(bad.length / rows.length * 100).toFixed(2)}%）`);
bad.sort((a, b) => a.cov - b.cov).slice(0, LIMIT).forEach((b) => {
  console.log(`  #${b.id} [${b.sub}] cov=${b.cov}`);
  console.log(`     题干 ${b.head}`);
  console.log(`     解析 ${b.ana}`);
});
