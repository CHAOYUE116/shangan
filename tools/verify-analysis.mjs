#!/usr/bin/env node
/**
 * tools/verify-analysis.mjs — 回填质量抽检（只读）
 *
 * 四个维度：
 *   A 覆盖：已回填题的解析非空率、平均长度
 *   B 答案一致：解析里若出现「正确答案 X / 答案为 X / 故选 X」，与库内 answerIndex 对不上就记冲突
 *   C 串题：同一段解析被写进多道题干完全不同的题（错配的最强信号）
 *   D 空壳：解析长度 < 15 字或只有「略」「见解析」之类
 *
 * 用法：node tools/verify-analysis.mjs [--course syzc] [--limit 200]
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSE = arg('course', null);
const LIMIT = Number(arg('limit', 400));

const db = new DatabaseSync(path.resolve(ROOT, 'tiku.db'));
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const subOf = { syzc: '事业编·职测', sydw: '事业编·公基', zhyynl: '事业编·综应', shenlun: '公务员·申论', xingce: '公务员·行测' };
const SUB = COURSE ? subOf[COURSE] : null;

const where = SUB ? `p.subjectName = '${SUB}'` : `p.subjectName IN ('事业编·职测','事业编·公基')`;
const rows = db.prepare(`
  SELECT q.id, q.questionId, q.content, q.answer, q.answerIndex, q.type, q.analysis, p.name AS paper
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE ${where} AND q.analysis IS NOT NULL AND TRIM(q.analysis) <> ''
`).all();

console.log(`已回填题数 ${rows.length}`);
if (!rows.length) process.exit(0);

const lens = rows.map((r) => String(r.analysis).trim().length).sort((a, b) => a - b);
const q = (p) => lens[Math.floor(lens.length * p)];
console.log(`解析长度 中位数 ${q(0.5)} / P10 ${q(0.1)} / P90 ${q(0.9)}`);

// D 空壳
const shell = rows.filter((r) => {
  const t = String(r.analysis).trim();
  return t.length < 15 || /^(略|见解析|无|暂无|解析略)[。.]?$/.test(t);
});
console.log(`D 空壳解析 ${shell.length}（${(shell.length / rows.length * 100).toFixed(1)}%）`);
shell.slice(0, 3).forEach((r) => console.log('   ', r.questionId, JSON.stringify(String(r.analysis).slice(0, 30))));

// B 答案一致
let checked = 0, conflict = 0;
const conflicts = [];
for (const r of rows) {
  const t = String(r.analysis);
  const m = t.match(/(?:正确答案|答案为|故选|应选|选择)\s*[:：]?\s*([A-H])/);
  if (!m) continue;
  if (r.type === 3 || r.answerIndex == null || r.answerIndex < 0) continue;
  checked += 1;
  const mine = LETTERS[r.answerIndex];
  if (mine && m[1] !== mine) { conflict += 1; conflicts.push({ id: r.questionId, paper: r.paper, said: m[1], is: mine, head: String(r.content).slice(0, 40) }); }
}
console.log(`B 答案一致 抽查 ${checked} 题 / 冲突 ${conflict}（${checked ? (conflict / checked * 100).toFixed(2) : '-'}%）`);
conflicts.slice(0, 5).forEach((c) => console.log(`    #${c.id} 解析说 ${c.said} 库里是 ${c.is} · ${c.head}`));

// C 串题：同解析多题 + 题干差异大
const byText = new Map();
for (const r of rows.slice(0, 20000)) {
  const key = String(r.analysis).trim().slice(0, 120);
  if (key.length < 30) continue;
  if (!byText.has(key)) byText.set(key, []);
  byText.get(key).push(r);
}
let dupGroups = 0, dupSuspicious = 0;
for (const [, arr] of byText) {
  if (arr.length < 2) continue;
  dupGroups += 1;
  const heads = new Set(arr.map((r) => String(r.content).replace(/[\s\u3000]/g, '').slice(0, 30)));
  if (heads.size > 1) dupSuspicious += 1;
}
console.log(`C 串题 相同解析被复用 ${dupGroups} 组 / 其中题干不同的可疑组 ${dupSuspicious}`);
[...byText.entries()].filter(([, a]) => a.length > 1).slice(0, 2).forEach(([, a]) => {
  console.log(`    组内 ${a.length} 题：` + a.slice(0, 3).map((r) => String(r.content).slice(0, 22)).join(' | '));
});

// A 抽样人工看
const sample = [];
for (let i = 0; i < Math.min(LIMIT, rows.length); i++) sample.push(rows[Math.floor(Math.random() * rows.length)]);
console.log('\nA 随机 3 条目视：');
[...new Set(sample.map((r) => r.id))].slice(0, 3).forEach((id) => {
  const r = rows.find((x) => x.id === id);
  console.log(`  · ${String(r.paper).slice(0, 24)}`);
  console.log(`    题干: ${String(r.content).replace(/<[^>]+>/g, '').slice(0, 50)}`);
  console.log(`    解析: ${String(r.analysis).replace(/\n/g, ' ').slice(0, 90)}`);
});

const verdict = (conflict / Math.max(1, checked) < 0.01) && (dupSuspicious / Math.max(1, dupGroups) < 0.05) && (shell.length / rows.length < 0.05);
console.log(`\n结论：${verdict ? '通过' : '需要人工复核'}`);
