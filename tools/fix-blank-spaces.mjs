/**
 * 修复题干/选项里被清成空格的填空横线。
 *
 * 采集时原文里的下划线（____）被上游抹成了 2 个以上连续空格，渲染出来是「下列　　项是……」，
 * 看起来像排版坏了。这里把「汉字与汉字之间」的连续空格换成横线；
 * 前后是数字的（如资料分析里的 "4579    15%"）保持原样——那是列间距，不是填空。
 *
 * 用法：
 *   node tools/fix-blank-spaces.mjs            # 只统计
 *   node tools/fix-blank-spaces.mjs --apply    # 写库（先自动备份）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const DB = path.resolve('tiku.db');
const BLANK = '＿＿＿＿';

// 只处理「汉字/中文标点」之间夹着的连续空白。
// 注意上游填空横线大量用的是 NBSP（\u00a0）：64,764 题里含 NBSP，其中 4+ 个连续的基本都是填空位置。
// 判定要窄，避免误伤：
//   · 前后都必须是汉字/中文标点（句号、冒号后面多是段落缩进；换行前后是行尾空格）
//   · 至少 3 个宽度的空白才算填空（「网追正能量  担当新时代」这种标题里的两格是排版间隔）
//   · 空白串里的字符可能是混合的（实测有 `a0 20 a0 20 a0 20` 这种 NBSP 与半角空格交替），所以按字符类整段吃掉
const RE = /(?<=[\u4e00-\u9fa5，、“”‘’《》（）])(?:[ \u00a0\u3000]){3,}(?=[\u4e00-\u9fa5，、；：。“”‘’《》（）])/g;

const db = new DatabaseSync(DB);
db.exec("PRAGMA journal_mode=WAL");

const rows = db.prepare(
  "SELECT questionId, content, options FROM questions WHERE instr(content, char(160)) > 0 OR instr(options, char(160)) > 0 OR content LIKE '%  %' OR options LIKE '%  %'"
).all();

let cHit = 0, oHit = 0;
const updates = [];
for (const r of rows) {
  let content = r.content || '';
  let options = r.options || '';
  const c2 = content.replace(RE, BLANK);
  const o2 = options.replace(RE, BLANK);
  const cChanged = c2 !== content;
  const oChanged = o2 !== options;
  if (!cChanged && !oChanged) continue;
  if (cChanged) cHit += 1;
  if (oChanged) oHit += 1;
  updates.push({ id: r.questionId, content: cChanged ? c2 : null, options: oChanged ? o2 : null });
}

console.log(`扫描 ${rows.length} 行 → 题干需修 ${cHit} 题 / 选项需修 ${oHit} 题`);

if (!APPLY) {
  /** 打印改动位置附近的上下文，方便肉眼判断是「填空」还是「缩进/表格间距」 */
  const ctx = (s, re) => {
    const m = String(s || '').match(re) || null;
    if (!m) return '（本字段未改）';
    const i = m.index;
    return JSON.stringify(String(s).slice(Math.max(0, i - 24), i + m[0].length + 24));
  };
  for (const u of updates.slice(0, 12)) {
    console.log(`\n#${u.id}`);
    if (u.content) console.log('  题干片段:', ctx(u.content, /＿＿＿＿/), '\n  原文片段:', ctx(db.prepare('SELECT content FROM questions WHERE questionId = ?').get(u.id)?.content, /\u00a0+| {2,}/));
    if (u.options) console.log('  选项片段:', ctx(u.options, /＿＿＿＿/));
  }
  console.log('\n（未写库，加 --apply 生效）');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const bak = `${DB}.bak-blanks-${stamp}`;
if (!fs.existsSync(bak)) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, bak);
  console.log('备份 →', bak);
}

const upC = db.prepare('UPDATE questions SET content = ? WHERE questionId = ?');
const upO = db.prepare('UPDATE questions SET options = ? WHERE questionId = ?');
db.exec('BEGIN');
for (const u of updates) {
  if (u.content) upC.run(u.content, u.id);
  if (u.options) upO.run(u.options, u.id);
}
db.exec('COMMIT');
console.log(`已写入 ${updates.length} 行`);
