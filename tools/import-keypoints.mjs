#!/usr/bin/env node
/**
 * tools/import-keypoints.mjs — 把已采粉笔卷里的「考点」全量落到数据库
 *
 * 背景：import-fenbi-papers.mjs 只用了 keypoints[0].name 当章节，其余全丢了。
 *       粉笔每题 keypoints 往往有 1~3 个（一级/二级考点），是做筛选的现成材料。
 *
 * 用法：
 *   node tools/import-keypoints.mjs            只统计
 *   node tools/import-keypoints.mjs --apply    写库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.resolve(ROOT, '..');
const SRC = path.join(APP, 'research', 'fenbi-solutions');
const apply = process.argv.includes('--apply');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json') && !e.name.includes('.side') && !e.name.includes('.meta')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
console.log(`扫描 ${files.length} 份试卷 JSON`);

/** questionId -> [{ id, name, rank }] */
const kpMap = new Map();
/** questionId -> paperName */
const qPaper = new Map();
let solTotal = 0;

for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const sols = j.solutions || [];
  if (!sols.length) continue;
  for (const s of sols) {
    // 注意：solutions[].globalId 是字符串（如 "3_3e_gp17g"），
    // 数字题号在 solutions[].id，与 questions.questionId 对得上
    const qid = Number(s.id || 0);
    if (!qid) continue;
    solTotal++;
    qPaper.set(qid, j.name || '');
    const kps = (s.keypoints || []).filter((k) => k && k.name);
    if (!kps.length) continue;
    if (!kpMap.has(qid)) kpMap.set(qid, []);
    const arr = kpMap.get(qid);
    kps.forEach((k) => {
      if (!arr.some((x) => x.name === k.name)) arr.push({ id: k.id || 0, name: String(k.name).slice(0, 60), rank: arr.length });
    });
  }
}

const withKp = kpMap.size;
const multi = [...kpMap.values()].filter((a) => a.length > 1).length;
const allKp = new Set();
for (const a of kpMap.values()) for (const k of a) allKp.add(k.name);

console.log(`题目 ${solTotal} 条（去重 ${qPaper.size}）`);
console.log(`带考点 ${withKp} 题，其中多考点 ${multi} 题（${((multi / (withKp || 1)) * 100).toFixed(1)}%）`);
console.log(`不同考点名 ${allKp.size} 个`);

const top = [...allKp].map((n) => {
  let c = 0;
  for (const a of kpMap.values()) if (a.some((k) => k.name === n)) c++;
  return { n, c };
}).sort((a, b) => b.c - a.c).slice(0, 25);
console.log('考点 Top25：');
for (const t of top) console.log(`  ${String(t.c).padStart(4)}  ${t.n}`);

if (!apply) {
  console.log('\n（只统计，加 --apply 写库）');
  process.exit(0);
}

const db = new DatabaseSync(path.join(ROOT, 'tiku.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS question_keypoints (
    questionId INTEGER NOT NULL,
    kpId INTEGER DEFAULT 0,
    kpName TEXT NOT NULL,
    rank INTEGER DEFAULT 0,
    PRIMARY KEY (questionId, kpName)
  );
  CREATE INDEX IF NOT EXISTS idx_qkp_name ON question_keypoints (kpName);
`);

const ins = db.prepare('INSERT OR REPLACE INTO question_keypoints (questionId, kpId, kpName, rank) VALUES (?, ?, ?, ?)');
db.exec('BEGIN');
let n = 0;
for (const [qid, arr] of kpMap) {
  for (const k of arr) { ins.run(qid, k.id, k.name, k.rank); n++; }
}
db.exec('COMMIT');
console.log(`\n✓ 写入 question_keypoints ${n} 行 / ${kpMap.size} 题`);
db.close();
