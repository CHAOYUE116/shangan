#!/usr/bin/env node
/**
 * tools/audit-tiku.mjs — 全库题目质量审查（含重复检测）
 *
 * 三类"重复"要分清：
 *   1. 同题号多卷      —— 正常（一题挂多套卷，questions 按 paperId 存多行），不算脏数据
 *   2. 不同题号同题干  —— 真重复（粉笔不同年份重复收录 / 导入时未查到），本工具重点检测
 *   3. 同卷重复采集    —— 采集侧的问题，见 tools/audit-fenbi-solutions.mjs
 *
 * 用法：
 *   node tools/audit-tiku.mjs                 全库概览 + 重复统计
 *   node tools/audit-tiku.mjs --subject 事业编·职测
 *   node tools/audit-tiku.mjs --dup-sample 5  多打印几组重复样例
 *   node tools/audit-tiku.mjs --export dup.json  导出重复明细
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SUBJECT = arg('subject', null);
const DUP_SAMPLE = Number(arg('dup-sample', 3));
const EXPORT = arg('export', null);

const db = new DatabaseSync('D:/Projects/上岸APP/kaogong-shuati/tiku.db', { readOnly: true });

const where = SUBJECT ? 'WHERE p.subjectName = ?' : '';
const params = SUBJECT ? [SUBJECT] : [];

console.log(`=== 概览${SUBJECT ? '（' + SUBJECT + '）' : '（全库）'} ===\n`);

const rows = db.prepare(`
  SELECT q.questionId, q.paperId, p.subjectName, q.chapter, q.type,
         q.content, q.options, q.answer, q.analysis,
         LENGTH(TRIM(COALESCE(q.content,''))) clen,
         LENGTH(TRIM(COALESCE(q.analysis,''))) alen
  FROM questions q JOIN papers p ON p.id = q.paperId
  ${where}
`).all(...params);

const uniqIds = new Set(rows.map((r) => r.questionId));
const uniqRows = new Map();
for (const r of rows) if (!uniqRows.has(r.questionId)) uniqRows.set(r.questionId, r);
console.log(`题目行数 ${rows.length}，唯一 questionId ${uniqIds.size}（一题多卷比 ${(rows.length / uniqIds.size).toFixed(2)}×）`);

// ---------- 1. 完整性 ----------
const cells = [...uniqRows.values()];
const stat = {
  题干空: cells.filter((r) => !r.clen).length,
  题干过短: cells.filter((r) => r.clen > 0 && r.clen < 8).length,
  无选项: cells.filter((r) => {
    try { return !JSON.parse(r.options || '[]').length; } catch { return true; }
  }).length,
  无答案: cells.filter((r) => !String(r.answer || '').trim()).length,
  无解析: cells.filter((r) => !r.alen).length,
  解析过短: cells.filter((r) => r.alen > 0 && r.alen < 20).length,
  HTML残留: cells.filter((r) => /&lt;\/?p&gt;/.test(String(r.content || ''))).length,
};
console.log('\n【完整性】（按唯一题）');
for (const [k, v] of Object.entries(stat)) {
  console.log(`  ${k.padEnd(8)} ${String(v).padStart(6)}  ${(v / cells.length * 100).toFixed(2)}%`);
}

// ---------- 2. 重复检测 ----------
// 指纹 = 题干(去空白/标点前 60 字) + 选项内容(前 40 字)
// 关键：图形推理题大量共用同一句模板（"从所给的四个选项中…"），题干相同但图不同，
//      必须用选项做二次判据；题干短且无有效选项的直接排除，否则会产生上千条假重复。
const norm = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[（）()【】\[\]“”"'’‘]/g, '')
  .slice(0, 60);

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\u3000]+/g, '').trim();

function fingerprint(r) {
  const c = norm(r.content);
  if (c.length < 12) return null;
  let opts = [];
  try { opts = JSON.parse(r.options || '[]'); } catch { opts = []; }
  const optText = opts.map(strip).filter((o) => o && o !== '无内容').join('|');
  // 图形题的选项常被剥离成 ["A","B","C","D"] 这类占位，总长 <8 视为没有有效文字选项
  const hasRealOpts = optText.length >= 8;
  // 没有文字选项的题（图形题 / 主观题）：
  //   图形推理共用同一句模板（"从所给的四个选项中…" 约 38 字），题干长度不能区分
  //   → 要求题干 ≥60 字才参与判重，否则一律跳过（宁可漏报，不要假重复）
  // 图形推理题（题干提图形/问号处/如图）无法用文字区分，一律不判重
  if (/图形|问号处|如下图|如下图所示|六个图形|四个图形/.test(c)) return null;
  if (!hasRealOpts) return c.length >= 60 ? c : null;
  // 题干短但有文字选项（如"下列正确的是"）→ 题干 + 选项一起做指纹
  return c.length >= 40 ? c : `${c}::${optText.slice(0, 40)}`;
}

const groups = new Map();
let skipped = 0;
for (const r of cells) {
  const k = fingerprint(r);
  if (!k) { skipped += 1; continue; }
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const dups = [...groups.values()].filter((g) => g.length > 1);
const dupRowCount = dups.reduce((a, g) => a + g.length, 0);
const dupExtra = dupRowCount - dups.length;   // 去掉后能省下的题数

console.log('\n【重复检测】（题干指纹 + 选项二次判据）');
console.log(`  参与判重 ${cells.length - skipped} 题（跳过 ${skipped} 题：图形题等无法用文字区分）`);
console.log(`  指纹组 ${groups.size}，其中重复组 ${dups.length}`);
console.log(`  涉及题目 ${dupRowCount} 条，多余重复 ${dupExtra} 条（去重后理论可减 ${(dupExtra / cells.length * 100).toFixed(1)}%）`);

// 按科目组合分类
let sameSubject = 0, crossSubject = 0;
for (const g of dups) {
  const subs = new Set(g.map((x) => x.subjectName));
  if (subs.size > 1) crossSubject += 1; else sameSubject += 1;
}
console.log(`  同科目内重复 ${sameSubject} 组，跨科目重复 ${crossSubject} 组`);

dups.sort((a, b) => b.length - a.length);
console.log(`\n重复最多的 ${Math.min(DUP_SAMPLE, dups.length)} 组：`);
for (const g of dups.slice(0, DUP_SAMPLE)) {
  console.log(`\n  ── ×${g.length}  ${String(g[0].content).replace(/\s+/g, ' ').slice(0, 60)}`);
  for (const x of g.slice(0, 4)) {
    console.log(`     qid=${x.questionId}  [${x.subjectName}/${x.chapter}]  解析 ${x.alen} 字`);
  }
  if (g.length > 4) console.log(`     …共 ${g.length} 条`);
}

// ---------- 3. 导出 ----------
if (EXPORT) {
  const out = dups.map((g) => ({
    fingerprint: norm(g[0].content).slice(0, 30),
    count: g.length,
    items: g.map((x) => ({ questionId: x.questionId, subject: x.subjectName, chapter: x.chapter, alen: x.alen })),
  }));
  fs.writeFileSync(EXPORT, JSON.stringify(out, null, 1));
  console.log(`\n重复明细已导出 → ${EXPORT}`);
}

// ---------- 4. 建议 ----------
console.log('\n【建议】');
if (crossSubject > 0) {
  console.log(`  · ${crossSubject} 组跨科目重复（如行测 → 公基种子题），优先清理这类`);
}
if (dupExtra > 0) {
  console.log(`  · ${dupExtra} 条多余重复：保留解析最长的那条，其余可归档`);
  console.log('  · 注意：同一题号挂多卷是正常的（一题多卷比 ' + (rows.length / uniqIds.size).toFixed(2) + '×），不要误删');
}
db.close();
