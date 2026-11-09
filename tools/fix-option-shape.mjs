/**
 * tools/fix-option-shape.mjs —— 清掉主观题里那个空壳 options
 *
 * 问题：2,420 道主观题的 options 长这样
 *   [{"intOptionId":430,"optionDesc":null}]
 * optionDesc 全部是 null，等于没有任何内容。前端把选项当对象渲染时会输出 [object Object]。
 *
 * 这些题全是被 21–26 这几类主观题型（概括 / 大作文 / 公文 / 综合分析），
 * 本来就该没有选项，所以直接重置成 '[]'。
 *
 * 用法：node tools/fix-option-shape.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'tiku.db');
const DRY = process.argv.includes('--dry');

const d = new DatabaseSync(DB);

const before = d.prepare(`SELECT COUNT(*) c FROM questions WHERE options LIKE '[{%'`).get().c;
console.log(`options 是对象数组的题：${before} 道`);

const nonNull = d.prepare(
  `SELECT COUNT(*) c FROM questions WHERE options LIKE '[{%' AND json_extract(options,'$[0].optionDesc') IS NOT NULL`
).get().c;
if (nonNull > 0) {
  console.log(`⚠ 其中 ${nonNull} 道的 optionDesc 不是 null，需要人工确认，先跳过这些`);
}

const targets = d.prepare(
  `SELECT COUNT(*) c FROM questions WHERE options LIKE '[{%' AND json_extract(options,'$[0].optionDesc') IS NULL`
).get().c;
console.log(`可安全重置为 []：${targets} 道`);

if (DRY) {
  console.log('（预演模式，未写库）');
  d.close();
  process.exit(0);
}

const backup = path.join(ROOT, 'tiku.db.bak-optshape');
if (!fs.existsSync(backup)) {
  fs.copyFileSync(DB, backup);
  console.log(`已备份：${path.basename(backup)}`);
}

const upd = d.prepare(
  `UPDATE questions SET options = '[]' WHERE options LIKE '[{%' AND json_extract(options,'$[0].optionDesc') IS NULL`
);
const info = upd.run();
console.log(`✓ 已重置 ${info.changes} 道题的 options`);

const after = d.prepare(`SELECT COUNT(*) c FROM questions WHERE options LIKE '[{%'`).get().c;
console.log(`剩余对象数组 options：${after} 道`);

d.close();
