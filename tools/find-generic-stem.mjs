#!/usr/bin/env node
/**
 * 「通用题干」识别：题干本身只是一句指令（如「根据以下材料，回答…」），
 * 正文在材料里，而我们的材料是空的 / 被写坏 / 没有图 —— 这类题打开就是一片空白，
 * 物理上无法作答。用于第 4 条任务：先列清单，人工确认后隔离删除。
 *
 *   node tools/find-generic-stem.mjs                  # 列清单 + 写 CSV
 *   node tools/find-generic-stem.mjs --subject 事业编·职测
 *   node tools/find-generic-stem.mjs --exclude-recoverable   # 只列「连材料原文都没有」的（真删候选）
 *
 * 判定：
 *   题干去标签后 < 60 字，且命中 通用指令正则 (根据|阅读|结合)…(材料|资料|上文|下表|图表)
 *   材料为空 / '[object Object]' / < 20 字 / 纯图题但无 <img>
 *   --exclude-recoverable 时，跳过「能在 q_materials 里找到正文」的（那些用 fix-object-material 就能救）
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
const ONLY = arg('subject', '');
const EXCL_RECOVER = has('exclude-recoverable');

const txt = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const BAD_MAT = /^\s*\[object Object\]\s*$/;
const GEN = /^(?:根据|阅读|结合)[^。]{0,20}?(?:材料|资料|上文|下表|上表|图表|文字)/;

const db = new DatabaseSync(DB, { readOnly: true });
db.exec('PRAGMA busy_timeout = 10000');

// 能救的：q_material_map + q_materials 里能找到正文
const recoverable = new Set();
if (EXCL_RECOVER) {
  const maps = db.prepare('SELECT question_id, material_id FROM q_material_map').all();
  const byId = new Map(db.prepare('SELECT material_id, content FROM q_materials').all().map((r) => [r.material_id, r.content]));
  for (const m of maps) {
    const c = byId.get(m.material_id);
    if (c && txt(c).length >= 20) recoverable.add(m.question_id);
  }
  console.log(`可回填材料池 ${recoverable.size} 道（这些会被跳过）`);
}

const rows = db.prepare(`
  SELECT q.id, q.questionId, q.paperId, p.subjectName, p.name AS paperName, q.chapter, q.type,
         q.content, q.contentHtml, q.material, q.options, q.q_bad, q.q_bad_reason
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const hits = [];
for (const r of rows) {
  if (ONLY && r.subjectName !== ONLY) continue;
  const stem = txt(r.content);
  if (stem.length >= 60) continue;
  if (!GEN.test(stem)) continue;
  const mat = String(r.material || '');
  const matTxt = txt(mat);
  const badMat = !mat || BAD_MAT.test(mat) || matTxt.length < 20;
  const anyImg = /<img/i.test(String(r.contentHtml || '')) || /<img/i.test(mat);
  if (!badMat && anyImg) continue;            // 材料有、图也有 → 没问题
  if (!badMat && matTxt.length >= 20) continue;
  if (EXCL_RECOVER && recoverable.has(r.questionId)) continue;
  hits.push({ ...r, stem, matLen: matTxt.length, anyImg });
}

const bySub = new Map();
for (const h of hits) bySub.set(h.subjectName, (bySub.get(h.subjectName) || 0) + 1);
console.log(`通用题干且没正文：${hits.length} 道`);
for (const [k, v] of bySub) console.log(`  ${k}: ${v}`);

const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const out = path.join(ROOT, 'report', `generic-stem-${day}.csv`);
const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
const lines = ['questionId,卷id,科目,卷名,章节,题型,题干,材料长度,有图,选项数,坏题原因'];
for (const h of hits) {
  const optN = (() => { try { const a = JSON.parse(h.options || '[]'); return a.length; } catch { return 0; } })();
  lines.push([h.questionId, h.paperId, h.subjectName, h.paperName, h.chapter, h.type, h.stem.slice(0, 100), h.matLen,
    h.anyImg ? 1 : 0, optN, h.q_bad_reason || ''].map(esc).join(','));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '\ufeff' + lines.join('\r\n'), 'utf8');
console.log(`明细：${path.relative(ROOT, out)}（${hits.length} 行）`);
db.close();
