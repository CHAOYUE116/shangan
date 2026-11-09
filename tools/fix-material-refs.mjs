/**
 * tools/fix-material-refs.mjs —— 清理题干里裸露的 [materialid]XXX[/materialid] 占位符
 *
 * 问题：3,536 道题（主要是申论、综合应用能力）的题干里留着这类标记：
 *   请概括"给定资料[materialid]186150[/materialid]-[materialid]186156[/materialid]"的主要内容。（10分）
 * 用户实际看到的就是这串数字，没法读。
 *
 * 试过把标记换成材料正文，但数据对不上：
 *   题干引用了 3,905 个不同的 material_id
 *   q_materials 只有 2,976 条，且和题干 id 几乎零重叠（只命中 11 个）
 *   q_material_map 的 10,619 条映射也一条都覆盖不到这 3,536 道题
 * 也就是说这批材料从来没被采集过，补不回来。
 *
 * 所以只能降级处理：把标记连同紧邻的连接符一起删掉，让句子恢复通顺。
 *   请概括"给定资料[materialid]186150[/materialid]-[materialid]186156[/materialid]"的主要内容
 *   → 请概括"给定资料"的主要内容
 *
 * 用法：
 *   node tools/fix-material-refs.mjs --dry     # 预演
 *   node tools/fix-material-refs.mjs           # 写库（默认备份）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'tiku.db');
const DRY = process.argv.includes('--dry');

const REF = /\[materialid\](\d+)\[\/materialid\]/g;

const d = new DatabaseSync(DB);

const rows = d.prepare(
  `SELECT id, questionId, content, contentHtml FROM questions WHERE content LIKE '%[materialid]%' OR contentHtml LIKE '%[materialid]%'`
).all();
console.log(`含占位符的题：${rows.length} 道`);

const samples = [];
for (const q of rows) {
  if (samples.length >= 4) break;
  const before = String(q.content || '');
  const after = clean(before);
  if (after !== before) samples.push({ q, before, after });
}

console.log('\n=== 效果预览 ===');
for (const { q, before, after } of samples) {
  console.log('\nq' + q.questionId);
  console.log('  原：' + before.replace(/\s+/g, ' ').slice(0, 120));
  console.log('  后：' + after.replace(/\s+/g, ' ').slice(0, 120));
}

if (DRY) {
  console.log('\n（预演模式，未写库）');
  d.close();
  process.exit(0);
}

/* ---------- 写库 ---------- */

const backup = path.join(ROOT, 'tiku.db.bak-matrefs');
if (!fs.existsSync(backup)) {
  fs.copyFileSync(DB, backup);
  console.log(`\n已备份：${path.basename(backup)} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
}

const upd = d.prepare('UPDATE questions SET content = ?, contentHtml = ? WHERE id = ?');
let done = 0;

d.exec('BEGIN');
try {
  for (const q of rows) {
    const raw = String(q.content || '');
    const html = String(q.contentHtml || '');
    const nr = clean(raw);
    const nh = html ? clean(html) : html;
    if (nr === raw && nh === html) continue;
    upd.run(nr, nh, q.id);
    done++;
  }
  d.exec('COMMIT');
  console.log(`✓ 已清理 ${done} 道题的题干`);
} catch (e) {
  d.exec('ROLLBACK');
  throw e;
}

const left = d.prepare(`SELECT COUNT(*) c FROM questions WHERE content LIKE '%[materialid]%'`).get();
console.log(`剩余含占位符：${left.c} 道`);

d.close();

/**
 * 删掉 [materialid]X[/materialid] 标记，并清理因此产生的悬空连接符。
 * 连续引用（186150-186156）整组删掉，中间的分隔符也一起走。
 */
function clean(text) {
  if (!text || !text.includes('[materialid]')) return text;

  let out = text;

  // 1. 连续引用整组删除：「A[m1][sep][m2][sep][m3]B」→「AB」
  out = out.replace(
    /\[materialid\]\d+\[\/materialid\](?:[\s\-–—~～至到、和及与]*\[materialid\]\d+\[\/materialid\])+/g,
    '',
  );

  // 2. 单个引用删除
  out = out.replace(REF, '');

  // 3. 清理残留：中文引号里只剩空串的
  out = out.replace(/([“"「『])\s*([”"」』])/g, '');

  // 4. 清理「给定资料」后面孤零零的连接符
  out = out.replace(/给定资料\s*[-–—~～、]\s*(?=[”"」』的主要内])/g, '给定资料');
  out = out.replace(/材料\s*[-–—~～、]\s*(?=[，。；（(])/g, '材料');

  // 5. 连续空白压缩（保留换行结构）
  out = out.replace(/[ \t]{2,}/g, ' ');

  return out.trim();
}
