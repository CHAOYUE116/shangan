#!/usr/bin/env node
/**
 * tools/fix-empty-answer.mjs — 用解析里的「A项正确 / B项错误」把空答案补回来
 *
 * 背景：139 道事业编·职测题（江苏专技计算机类、经济类、广东基本能力测试等）
 * 选项都在、解析也都在，唯独 answer 是空的 —— 用户点开能选，但判不了分。
 * 这些解析是逐项点评的写法：
 *     A项正确，打印速度是激光打印机的核心性能指标之一……
 *     B项错误，字体并非……
 *     C项正确，输出幅面决定……
 * 所以正确答案 = 所有标为「正确」的项。
 *
 * 规则（宁缺毋滥，任何一条对不上就跳过并在报告里列出）：
 *   - 只在 answer 为空、options 是合法 JSON 数组时动手
 *   - 解析里必须能抽到至少 1 个「X项正确/X正确」，且抽到「错误」的项也必须覆盖到选项范围内
 *   - 抽到的字母必须都在选项数以内
 *   - 1 个正确项 → type=1、answer=选项原文、answerIndex=下标
 *   - 多个正确项 → type=3、answer="0,2,3"、answerIndex=-1（与库内多选格式一致）
 *
 * 用法：
 *   node tools/fix-empty-answer.mjs          # dry run，只报告
 *   node tools/fix-empty-answer.mjs --apply  # 写回 tiku.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');
const DB = path.resolve(ROOT, 'tiku.db');

const db = new DatabaseSync(DB);
const rows = db.prepare(`
  SELECT id, questionId, options, analysis, type, answer, answerIndex
  FROM questions
  WHERE (answer IS NULL OR TRIM(answer) = '')
    AND options IS NOT NULL AND LENGTH(TRIM(options)) > 10
`).all();

console.log(`待处理 ${rows.length} 题（answer 为空且有选项）`);

const L = 'ABCDEFGH';
const fixes = [];
const skipped = [];

for (const r of rows) {
  let opts;
  try { opts = JSON.parse(r.options); } catch { skipped.push([r.id, 'options 不是 JSON']); continue; }
  if (!Array.isArray(opts) || !opts.length) { skipped.push([r.id, 'options 不是数组']); continue; }

  const an = String(r.analysis || '');
  const right = new Set();
  const wrong = new Set();
  // 「A项正确」「A正确」「选项A正确」「A项说法正确」
  for (const m of an.matchAll(/([A-H])\s*项?\s*(?:说法|表述|理解)?\s*(正确|符合题意|错误|不正确|不符合)/g)) {
    const ch = m[1];
    const ok = /正确|符合题意/.test(m[2]);
    (ok ? right : wrong).add(ch);
  }
  // 兜底：显式的「正确答案：ABD」
  if (!right.size) {
    const m = an.match(/正确答案[是为：:\s]*([A-H]{1,8})/);
    if (m) for (const ch of m[1]) right.add(ch);
  }
  if (!right.size) { skipped.push([r.id, '解析里找不到「正确」项']); continue; }

  const idxs = [...right].map((c) => L.indexOf(c)).filter((i) => i >= 0 && i < opts.length).sort((a, b) => a - b);
  if (!idxs.length) { skipped.push([r.id, '正确项全在选项范围外']); continue; }
  // 抽到的「错误」项若越界，说明字母识别跑偏，放弃
  if ([...wrong].some((c) => L.indexOf(c) >= opts.length)) { skipped.push([r.id, '错误项越界，判定不可信']); continue; }

  if (idxs.length === 1) {
    fixes.push({ id: r.id, type: 1, answer: String(opts[idxs[0]]), answerIndex: idxs[0], letters: L[idxs[0]] });
  } else {
    fixes.push({ id: r.id, type: 3, answer: idxs.join(','), answerIndex: -1, letters: idxs.map((i) => L[i]).join('') });
  }
}

console.log(`可修 ${fixes.length} 题，跳过 ${skipped.length} 题`);
const multi = fixes.filter((f) => f.type === 3).length;
console.log(`  单选 ${fixes.length - multi} 题 / 多选 ${multi} 题`);
fixes.slice(0, 6).forEach((f) => console.log(`  #${f.id} → ${f.letters}  type=${f.type}  answer=${String(f.answer).slice(0, 40)}`));
if (skipped.length) {
  console.log('跳过示例：');
  skipped.slice(0, 8).forEach(([id, why]) => console.log(`  #${id} ${why}`));
}

if (!APPLY) {
  console.log('\n（dry run，未写库；确认无误后加 --apply）');
  process.exit(0);
}

const bak = path.join(ROOT, `tiku.db.bak-answer-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`);
fs.copyFileSync(DB, bak);
console.log(`已备份 → ${path.basename(bak)}`);

const upd = db.prepare('UPDATE questions SET answer = ?, answerIndex = ?, type = ? WHERE id = ?');
db.exec('BEGIN');
try {
  for (const f of fixes) upd.run(f.answer, f.answerIndex, f.type, f.id);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log(`已写回 ${fixes.length} 题`);
