#!/usr/bin/env node
/**
 * tools/audit-quality.mjs — 题库质量体检 + 人工审核清单
 *
 * 输出：
 *   report/quality-audit-<日期>.csv   一条问题一行，给人工审核用
 *   report/quality-audit-<日期>.md    汇总（按问题类型 × 科目）
 *
 * 判定维度（都是「客观题」口径，申论/综应这类主观题另算）：
 *   A. 缺答案      answer 空 且 answerIndex < 0
 *   B. 缺解析      analysis 空 或 < 20 字
 *   C. 缺选项      客观题 options 为空
 *   D. 答案与解析矛盾 解析里写「正确答案是 X / 故选 X」，与库里的答案不一致
 *   E. 缺材料      题干含「根据材料/根据以下资料/阅读下文」但 material 为空
 *   F. 缺图片      题干/材料含 [图]/见下图/如下图 但内容里没有 <img> 且没有 q_material_map 图片
 *   G. 题干过短    content 去标签后 < 8 字
 *   H. 解析疑似截断 解析首字是虚词/标点（采集截断特征）
 *
 * 对 A 与 D，脚本会尝试从解析正文里反推「参考答案」：
 *   「故正确答案为 C」「正确答案是 AB」「答案选 D」「A 项正确」…
 *
 * 用法：node tools/audit-quality.mjs [--db app-assets/tiku_app.db] [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const DB = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const LIMIT = Number(arg('limit', 0)); // 0 = 不截断
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_DIR = path.join(ROOT, 'report');
fs.mkdirSync(OUT_DIR, { recursive: true });
const CSV = path.join(OUT_DIR, `quality-audit-${day}.csv`);
const MD = path.join(OUT_DIR, `quality-audit-${day}.md`);

const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

/**
 * 客观题题型：1 单选 / 2 多选 / 3 不定项 / 5 判断。
 * 21/22/23/24/25/26 是申论、综应的主观题（材料分析、公文、大作文…），本来就没有「答案」和「选项」，
 * 不能按客观题口径挑错，否则 4,000+ 道申论会全被标成「缺答案」。
 */
const OBJ = '(1,2,3,5)';

const LETTERS = 'ABCDEFGH';
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const brief = (s, n = 60) => {
  const t = stripHtml(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const letterOfIndex = (i) => (i >= 0 && i < LETTERS.length ? LETTERS[i] : '');

/**
 * 从解析正文反推正确答案。
 * 返回 { letters: 'CD', strong: true }：
 *   strong = 解析里明确写了「正确答案是 / 故答案为 / 答案选」，可以直接拿去核对；
 *   非 strong 的（逐项点评里某一项「正确」）只用于「缺答案」参考，不用来判「答案矛盾」，
 *   否则「A、B 选项会产生负面影响」这种句子会被误读成答案是 A/B。
 */
function answerFromAnalysis(analysis, optionCount) {
  const t = stripHtml(analysis);
  if (!t) return { letters: '', strong: false };
  const norm = (raw) => {
    const ls = [...new Set(raw.replace(/[^A-H]/g, '').split(''))].sort();
    if (!ls.length) return '';
    if (optionCount && ls.length > optionCount) return '';
    return ls.join('');
  };
  const strongPats = [
    /(?:故|因此|所以|综上|本题)?\s*正确答案\s*(?:是|为|应选|选|有)?\s*[：:，,]?\s*((?:[A-H][、,，和及与]?){1,4})/,
    /(?:故|因此|所以|综上|本题|此题)?\s*(?:答案|正确选项)\s*(?:是|为|应选|选)\s*[：:，,]?\s*((?:[A-H][、,，和及与]?){1,4})/,
    /(?:故选|应选|答案选)\s*((?:[A-H][、,，和及与]?){1,4})/,
  ];
  for (const p of strongPats) {
    const m = t.match(p);
    if (m) {
      const v = norm(m[1]);
      if (v) return { letters: v, strong: true };
    }
  }
  // 弱信号：逐项点评里说「X 项正确」
  const corrects = [];
  for (let i = 0; i < (optionCount || 4); i++) {
    const L = LETTERS[i];
    const re = new RegExp(`${L}\\s*(?:项|选项)?\\s*(?:说法|描述|表述)?\\s*(?:是)?\\s*(?:正确|对的|符合题意)`);
    const wrongRe = new RegExp(`${L}\\s*(?:项|选项)?\\s*(?:说法|描述|表述)?\\s*(?:是)?\\s*(?:错误|不正确|不符合)`);
    if (re.test(t) && !wrongRe.test(t)) corrects.push(L);
  }
  return { letters: corrects.sort().join(''), strong: false };
}

const rows = [];
const stat = { total: 0, obj: 0 };
const addRow = (r) => rows.push(r);

const sql = `
  SELECT q.id, q.questionId, q.paperId, q.chapter, q.type, q.questionType,
         q.content, q.material, q.options, q.answer, q.answerIndex, q.analysis, q.difficulty,
         p.subjectName, p.name AS paperName
  FROM questions q
  JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
  ORDER BY q.questionId`;

const seen = new Set();
for (const r of db.prepare(sql).iterate()) {
  if (LIMIT && stat.total >= LIMIT) break;
  if (seen.has(r.questionId)) continue;
  seen.add(r.questionId);
  stat.total += 1;

  const isObj = OBJ.includes(String(r.type));
  if (isObj) stat.obj += 1;

  let opts = [];
  try { opts = JSON.parse(r.options || '[]'); } catch { opts = []; }
  const ans = String(r.answer || '').trim().toUpperCase();
  const ansFromIdx = letterOfIndex(r.answerIndex);
  const hasAns = !!ans || r.answerIndex >= 0;
  const analysis = stripHtml(r.analysis);
  const content = stripHtml(r.content);
  const material = stripHtml(r.material);
  const derived = answerFromAnalysis(r.analysis, opts.length || 4);

  const issues = [];
  if (isObj && !hasAns) issues.push(['A', '缺答案']);
  if (isObj && analysis.length < 20) issues.push(['B', '缺解析']);
  if (isObj && String(r.type) !== '5' && !opts.length) issues.push(['C', '缺选项']);
  if (isObj && hasAns && derived.strong && derived.letters) {
    const cur = ans || ansFromIdx;
    // 多选题库里 answer 可能是 "0,1,3"，先归一成字母串（排序后比较）
    let curL = cur;
    if (/^[\d,]+$/.test(cur)) curL = cur.split(',').map((n) => letterOfIndex(Number(n))).filter(Boolean).sort().join('');
    if (curL && curL !== derived.letters) issues.push(['D', '答案与解析矛盾']);
  }
  if (/根据(以下|上述|给定)?(资料|材料)|阅读(以下|下面)文字|根据以下资料/.test(content) && material.length < 30 && !r.material) {
    issues.push(['E', '缺材料']);
  }
  if (/\[图|见下图|如下图|图\d|图片/.test(content + material) && !/<img/i.test(String(r.contentHtml || '') + String(r.analysisHtml || ''))) {
    issues.push(['F', '缺图片']);
  }
  if (content.length > 0 && content.length < 8) issues.push(['G', '题干过短']);
  if (analysis && /^[的了是所上而与之其并但且或及以用对为在从由于，。、；：]/.test(analysis)) issues.push(['H', '解析疑似截断']);

  if (!issues.length) continue;
  for (const [code, label] of issues) {
    addRow({
      code, label,
      questionId: r.questionId,
      subject: r.subjectName,
      chapter: r.chapter || '',
      type: r.type,
      paper: r.paperName,
      stem: brief(r.content, 80),
      options: opts.map((o, i) => LETTERS[i] + '.' + brief(o, 18)).join(' | '),
      curAnswer: ans || ansFromIdx || '',
      refAnswer: code === 'A' || code === 'D' ? derived.letters : '',
      analysis: brief(r.analysis, 100),
      action:
        code === 'A' ? (derived.letters ? '看解析像 ' + derived.letters + '，核对后回填' : '需人工给答案')
        : code === 'D' ? `库里 ${ans || ansFromIdx}，解析说 ${derived.letters}，二选一`
        : code === 'B' ? '缺解析，需补'
        : code === 'C' ? '客观题无选项，需补选项或改判题型'
        : code === 'E' ? '材料没关联上，需回原卷补'
        : code === 'F' ? '题干提到图但没图，需补图或删'
        : code === 'G' ? '题干过短，疑似残缺'
        : '解析开头像被截断，需重采',
    });
  }
}

db.close();

// ---------- 输出 CSV ----------
const header = ['问题码', '问题类型', '题号(questionId)', '科目', '章节', '题型', '来源卷', '题干摘要', '选项', '库里答案', '参考答案(从解析推)', '解析摘要', '建议动作'];
const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const lines = [header.map(esc).join(',')];
for (const r of rows) {
  lines.push([r.code, r.label, r.questionId, r.subject, r.chapter, r.type, r.paper, r.stem, r.options, r.curAnswer, r.refAnswer, r.analysis, r.action].map(esc).join(','));
}
fs.writeFileSync(CSV, '\ufeff' + lines.join('\r\n'), 'utf8');

// 再拆两份给人看的清单：答案类（A/D，能直接核对回填）与缺陷类（其余）
const ANSWER_CSV = path.join(OUT_DIR, `quality-answers-${day}.csv`);
const ERROR_CSV = path.join(OUT_DIR, `quality-errors-${day}.csv`);
const writeCsv = (file, list) => {
  const out = [header.map(esc).join(',')];
  for (const r of list) {
    out.push([r.code, r.label, r.questionId, r.subject, r.chapter, r.type, r.paper, r.stem, r.options, r.curAnswer, r.refAnswer, r.analysis, r.action].map(esc).join(','));
  }
  fs.writeFileSync(file, '\ufeff' + out.join('\r\n'), 'utf8');
};
const answerRows = rows.filter((r) => r.code === 'A' || r.code === 'D');
const errorRows = rows.filter((r) => r.code !== 'A' && r.code !== 'D');
writeCsv(ANSWER_CSV, answerRows);
writeCsv(ERROR_CSV, errorRows);

// ---------- 输出 MD 汇总 ----------
const byCode = new Map();
const bySubXCode = new Map();
for (const r of rows) {
  byCode.set(r.code, (byCode.get(r.code) || 0) + 1);
  const k = r.code + '|' + r.subject;
  bySubXCode.set(k, (bySubXCode.get(k) || 0) + 1);
}
const subjSet = [...new Set(rows.map((r) => r.subject))].sort();
const codes = [...new Set(rows.map((r) => r.code))].sort();
const labelOf = Object.fromEntries(rows.map((r) => [r.code, r.label]));
const canFill = rows.filter((r) => (r.code === 'A' || r.code === 'D') && r.refAnswer).length;

const md = [];
md.push(`# 题库质量体检（${day}）`, '');
md.push(`- 库文件：\`${path.relative(ROOT, DB)}\``);
md.push(`- 唯一题：**${stat.total}**（其中客观题 ${stat.obj}）`);
md.push(`- 有问题：**${rows.length}** 条（一题可命中多类）`);
md.push(`- 可从解析反推参考答案：**${canFill}** 条`);
md.push('');
md.push('| 代码 | 问题 | 条数 |');
md.push('|---|---|---|');
for (const c of codes) md.push(`| ${c} | ${labelOf[c]} | ${byCode.get(c)} |`);
md.push('');
md.push('## 按科目 × 问题');
md.push('');
md.push('| 科目 | ' + codes.join(' | ') + ' |');
md.push('|---|' + codes.map(() => '---').join('|') + '|');
for (const s of subjSet) {
  md.push(`| ${s} | ` + codes.map((c) => bySubXCode.get(c + '|' + s) || 0).join(' | ') + ' |');
}
md.push('');
md.push('## 文件');
md.push('');
md.push('| 文件 | 内容 | 行数 |');
md.push('|---|---|---|');
md.push(`| \`${path.basename(ANSWER_CSV)}\` | **答案类**（A 缺答案 / D 与解析矛盾），带「参考答案(从解析推)」列，核对后可直接回填 | ${answerRows.length} |`);
md.push(`| \`${path.basename(ERROR_CSV)}\` | **缺陷类**（缺解析 / 缺选项 / 缺材料 / 缺图 / 题干残缺 / 解析截断） | ${errorRows.length} |`);
md.push(`| \`${path.basename(CSV)}\` | 全量合并（两份的并集，一题可命中多类） | ${rows.length} |`);
md.push('');
md.push('## 怎么用这份清单');
md.push('');
md.push('1. `quality-answers-*.csv` 先用：「参考答案(从解析推)」有值的（**' + canFill + '** 条）基本是解析里自己写了「故正确答案为 X」，核对一眼就能回填；空的要人工判');
md.push('2. `quality-errors-*.csv` 按「问题码」筛：B 缺解析、C 缺选项（客观题）、E 缺材料、F 缺图、G 题干过短、H 解析截断，前四类多半要回原卷或重采');
md.push('3. 每行都有 `题号(questionId)`，可以直接按 id 定位重采或修库');
fs.writeFileSync(MD, md.join('\n'), 'utf8');

console.log(`唯一题 ${stat.total}（客观 ${stat.obj}），问题行 ${rows.length}`);
for (const c of codes) console.log(`  ${c} ${labelOf[c]}: ${byCode.get(c)}`);
console.log(`可反推参考答案：${canFill}（答案类 ${answerRows.length} 行 / 缺陷类 ${errorRows.length} 行）`);
console.log('答案清单 →', path.relative(ROOT, ANSWER_CSV));
console.log('缺陷清单 →', path.relative(ROOT, ERROR_CSV));
console.log('全量 CSV →', path.relative(ROOT, CSV));
console.log('MD  →', path.relative(ROOT, MD));
