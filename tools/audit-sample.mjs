/**
 * tools/audit-sample.mjs —— 题库抽检
 *
 * 之前做过的是「统计审计」（有多少题没解析、多少题干空），那是看表。
 * 这个脚本是「内容抽检」——真的把题捞出来逐条看，检查：
 *   1. 题干是否完整（不是半截、不是只有「如图所示」）
 *   2. 选项是否齐全（单选必须 4 个，多选至少 2 个）
 *   3. 答案格式是否合法（A/B/C/D 或 ABC）
 *   4. 解析是否真的在讲这道题（不是套话、不是别的题的解析）
 *   5. HTML 残留（未闭合标签、裸 &nbsp;、公式图丢失的 `；；；`）
 *
 * 用法：
 *   node tools/audit-sample.mjs                    # 每科抽 6 题
 *   node tools/audit-sample.mjs --n 20             # 每科抽 20 题
 *   node tools/audit-sample.mjs --subject 事业编·职测 --n 30
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.resolve(__dirname, '..', 'app-assets', 'tiku_app.db');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Number(arg('n', 6));
const ONLY = arg('subject', null);

const d = new DatabaseSync(DB, { readOnly: true });

const stripHtml = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<\/(p|div|li|tr)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/* ---------- 检查规则 ---------- */

const problems = [];

function check(q) {
  const p = [];
  const stem = stripHtml(q.content);
  const opts = safeJson(q.options);
  const ans = String(q.answer || '').trim().toUpperCase();
  const ana = stripHtml(q.analysis);

  // 1. 题干
  if (stem.length < 8) p.push(`题干过短(${stem.length}字): ${stem.slice(0, 40)}`);
  if (/^(如图|如下图|见图|根据图|根据下图)/.test(stem) && !/https?:\/\/|data:image/.test(String(q.contentHtml || q.content))) {
    p.push('题干只有「如图」但没有图片');
  }
  if (/；；；|;;;/.test(ana)) p.push('解析里有公式图被剥离后的连续分号');

  // 2. 选项
  const kind = q.type;
  if ([21, 24, 25, 26].includes(kind)) {
    // 主观题，ptions 空是正常的
  } else if (!Array.isArray(opts) || opts.length === 0) {
    p.push('无选项(客观题)');
  } else if (opts.length < 2) {
    p.push(`选项只有 ${opts.length} 个`);
  } else {
    const empty = opts.filter((o) => !stripHtml(o).length).length;
    if (empty) p.push(`${empty} 个选项内容为空`);
    // 单选题应该 4 个
    if (ans.length === 1 && opts.length !== 4) p.push(`单选但 ${opts.length} 个选项`);
  }

  // 3. 答案
  if (!ans) {
    if (![21, 24, 25, 26].includes(kind)) p.push('无答案');
  } else if (!/^[A-H]+$/.test(ans)) {
    p.push(`答案格式异常: ${ans}`);
  } else if (Array.isArray(opts) && opts.length && ans.split('').some((c) => c.charCodeAt(0) - 65 >= opts.length)) {
    p.push(`答案 ${ans} 超出选项范围(${opts.length}个)`);
  }

  // 4. 解析
  if (!ana) {
    if (kind !== 21 && kind !== 24 && kind !== 25 && kind !== 26) p.push('无解析');
  } else {
    if (ana.length < 15) p.push(`解析过短(${ana.length}字)`);
    // 解析里通常会重复答案字母，若完全没有该字母，可疑
    if (ans.length && !ana.includes(ans[0]) && ana.length > 40) {
      p.push(`解析里没提到答案 ${ans}，可能解析错配`);
    }
  }

  return p;
}

function safeJson(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

/* ---------- 抽样 ---------- */

const subjects = ONLY
  ? [{ subject: ONLY }]
  : d.prepare(`SELECT p.subject, COUNT(DISTINCT q.questionId) n FROM questions q JOIN papers p ON p.id=q.paperId GROUP BY p.subject ORDER BY n DESC`).all();

let total = 0;
let flagged = 0;

for (const { subject } of subjects) {
  const rows = d.prepare(`
    SELECT q.questionId, q.type, q.content, q.contentHtml, q.options, q.answer, q.analysis, q.chapter, p.name AS paper
    FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subject = ?
    ORDER BY RANDOM() LIMIT ?
  `).all(subject, N);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${subject} —— 抽查 ${rows.length} 题`);
  console.log('='.repeat(70));

  for (const q of rows) {
    total++;
    const p = check(q);
    if (p.length) flagged++;

    const stem = stripHtml(q.content);
    const opts = safeJson(q.options) || [];
    console.log(`\n[q${q.questionId}] ${q.chapter || '(无章节)'} · 类型 ${q.type}`);
    console.log(`  卷：${q.paper}`);
    console.log(`  题：${stem.slice(0, 90)}${stem.length > 90 ? '…' : ''}`);
    if (opts.length) {
      console.log(`  项：${opts.map((o, i) => String.fromCharCode(65 + i) + '.' + stripHtml(o).slice(0, 18)).join('  ')}`);
    }
    console.log(`  答：${q.answer || '(空)'}`);
    const ana = stripHtml(q.analysis);
    console.log(`  析：${ana.slice(0, 70)}${ana.length > 70 ? '…' : ''}`);
    if (p.length) console.log(`  ⚠ ${p.join(' | ')}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`合计抽查 ${total} 题，可疑 ${flagged} 题（${(flagged / total * 100).toFixed(1)}%）`);
console.log('='.repeat(70));

d.close();
