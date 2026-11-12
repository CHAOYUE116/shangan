#!/usr/bin/env node
/**
 * 内容重复审计：同一道题（题干指纹相同）在不同卷里被重复入库。
 * 默认 dry-run，只导出 CSV；--apply 时把「后入库的副本」标记 q_bad=1 / q_bad_reason='重复题（同内容已有一条）'
 * 注意：只标记，不删除，便于回滚。
 *
 *   node tools/audit-dups.mjs                 # 只看分布，写 report/dups-YYYYMMDD.csv
 *   node tools/audit-dups.mjs --apply         # 额外标记副本
 *   node tools/audit-dups.mjs --subject 事业编·职测
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = '') => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes('--' + k);

const DB = arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db'));
const APPLY = has('apply');
const ONLY = arg('subject', '');

const norm = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\p{P}]/gu, '').slice(0, 120);

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 10000');

const rows = db.prepare(`
  SELECT q.id, q.questionId, q.paperId, p.subjectName, p.name AS paperName, q.chapter, q.type, q.content, q.q_bad, q.q_bad_reason
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const groups = new Map();
for (const r of rows) {
  if (ONLY && r.subjectName !== ONLY) continue;
  const fp = norm(r.content);
  if (!fp) continue;
  const g = groups.get(fp);
  if (g) g.push(r); else groups.set(fp, [r]);
}

const dupGroups = [...groups.values()].filter((g) => g.length > 1);
const dupRows = dupGroups.reduce((a, g) => a + g.length - 1, 0);
const bySub = new Map();
for (const g of dupGroups) {
  for (const r of g.slice(1)) {
    const s = bySub.get(r.subjectName) || { dup: 0, groups: new Set() };
    s.dup += 1; s.groups.add(norm(r.content));
    bySub.set(r.subjectName, s);
  }
}
console.log(`唯一的题 ${groups.size} 个内容组 · 重复组 ${dupGroups.length} · 多余副本 ${dupRows} 道`);
for (const [k, v] of bySub) console.log(`  ${k}: 多余 ${v.dup} 道`);

const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const csv = path.join(ROOT, 'report', `dups-${day}.csv`);
fs.mkdirSync(path.dirname(csv), { recursive: true });
const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
const lines = ['保留questionId,保留卷id,重复questionId,重复卷id,科目,卷名,章节,题干前80字'];
for (const g of dupGroups) {
  const keep = g[0];
  for (const r of g.slice(1)) {
    lines.push([
      keep.questionId, keep.paperId, r.questionId, r.paperId, r.subjectName, r.paperName, r.chapter,
      String(r.content || '').replace(/<[^>]+>/g, '').slice(0, 80),
    ].map(esc).join(','));
  }
}
fs.writeFileSync(csv, '\ufeff' + lines.join('\r\n'), 'utf8');
console.log(`明细：${path.relative(ROOT, csv)}（${lines.length - 1} 行）`);

if (APPLY) {
  const upd = db.prepare(`UPDATE questions SET q_bad = 1, q_bad_reason = '重复题（同内容已有一条）' WHERE questionId = ?`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const g of dupGroups) for (const r of g.slice(1)) { upd.run(r.questionId); n += 1; }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`标记重复副本 ${n} 道（q_bad_reason='重复题（同内容已有一条）'）`);
} else {
  console.log('（dry-run：没写库，加 --apply 才会标记）');
}
db.close();
