#!/usr/bin/env node
/**
 * tools/unify-analyses.mjs — 用「同题最完整解析」补全被截断的解析
 *
 * 问题：linfukai 源数据由 PDF 提取，同一道题在不同年份的卷里重复出现，
 *       每次截断位置还不一样（「A项正确：…」的开头被吃掉）。
 *       而我们库里同一道题的其它副本（如粉笔原始题）往往解析完整。
 *
 * 做法：按「题干指纹 + 选项指纹」分组 → 每组取解析最长的那条 →
 *       组内其它条目若解析更短，就用最长的那条覆盖（只改 analysis 字段，不动题目本身）。
 *
 * 判据参考《蒸馏方法参考》§3.3：宁可漏补，不要用短解析覆盖长解析。
 *
 * 用法：
 *   node tools/unify-analyses.mjs --dry-run
 *   node tools/unify-analyses.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DB = path.join(ROOT, 'tiku.db');
const MIN_GAIN = 30;   // 至少多 30 字才覆盖

const db = new DatabaseSync(DB, { timeout: 10000 });

const norm = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[（）()【】\[\]“”"'’‘]/g, '');
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
const hasImg = (s) => /<img\b/i.test(String(s || ''));

const rows = db.prepare(`
  SELECT questionId, content, options, analysis, analysisHtml, LENGTH(TRIM(COALESCE(analysis,''))) alen
  FROM questions
  WHERE TRIM(COALESCE(content,'')) <> ''
  GROUP BY questionId
`).all();
console.log(`全库唯一题：${rows.length}`);

// 分组：题干 + 选项（图标题跳过，无法区分）
const groups = new Map();
let skipped = 0;
for (const r of rows) {
  const c = norm(r.content);
  if (c.length < 12) { skipped += 1; continue; }
  if (/图形|问号处|如下图|六个图形/.test(c)) { skipped += 1; continue; }
  let opts = [];
  try { opts = JSON.parse(r.options || '[]'); } catch { opts = []; }
  const optText = opts.map(strip).filter(Boolean).join('|');
  const key = c.length >= 40 ? c : `${c}::${optText.slice(0, 40)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

let multi = 0, fixable = 0, fixableGain = 0;
const plan = [];
for (const [, g] of groups) {
  if (g.length < 2) continue;
  multi += 1;
  const best = g.slice().sort((a, b) => b.alen - a.alen)[0];
  if (best.alen < 20) continue;               // 最好的也太短，放弃
  for (const r of g) {
    if (r.questionId === best.questionId) continue;
    if (best.alen - r.alen < MIN_GAIN) continue;
    plan.push({
      id: r.questionId,
      from: r.alen,
      to: best.alen,
      analysis: best.analysis,
      analysisHtml: best.analysisHtml || null,
      src: best.questionId,
    });
    fixable += 1;
    fixableGain += best.alen - r.alen;
  }
}

console.log(`重复组：${multi}（跳过 ${skipped} 题无法判重）`);
console.log(`可补全解析：${fixable} 题，合计补 ${fixableGain} 字（平均每题 +${fixable ? Math.round(fixableGain / fixable) : 0} 字）`);

console.log('\n样例：');
for (const p of plan.slice(0, 6)) {
  console.log(`  qid=${p.id}  ${p.from} 字 → ${p.to} 字（取自 qid=${p.src}）`);
}

if (!APPLY) { console.log('\n[dry-run] 未写入。确认后加 --apply。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
fs.copyFileSync(DB, `${DB}.bak-ana-${stamp}`);
const upd = db.prepare('UPDATE questions SET analysis = ?, analysisHtml = COALESCE(NULLIF(?, \'\'), analysisHtml) WHERE questionId = ?');
db.exec('BEGIN');
let n = 0;
try {
  for (const p of plan) n += upd.run(p.analysis, p.analysisHtml ? p.analysisHtml : '', p.id).changes;
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('失败：', e.message); process.exit(1); }
try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
db.exec('VACUUM');

console.log(`\n✓ 更新 ${n} 行`);
const after = db.prepare("SELECT COUNT(DISTINCT questionId) c FROM questions WHERE LENGTH(TRIM(COALESCE(analysis,''))) = 0").get().c;
console.log(`  仍无解析：${after} 题`);
db.close();
