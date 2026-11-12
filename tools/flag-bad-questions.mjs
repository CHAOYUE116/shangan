#!/usr/bin/env node
/**
 * 标记「不能给用户做」的题（坏题），写新列 q_bad / q_bad_reason，不改任何原有字段。
 *
 * 为什么要做：题库是爬来的，有些题天生做不了 —— 材料以图片形式存在但图没抓下来、
 * 解析里的公式被吞成「为元」「有名」、答案和解析自相矛盾。这些题出现在练习里，
 * 用户会觉得「这 App 的题是错的」。
 *
 * 用法：
 *   node tools/flag-bad-questions.mjs                 # 只统计，不写库
 *   node tools/flag-bad-questions.mjs --apply         # 写 q_bad / q_bad_reason
 *   node tools/flag-bad-questions.mjs --apply --db app-assets/tiku_app.db
 *   node tools/flag-bad-questions.mjs --list 20       # 每种规则打印 20 条样例
 *
 * 规则（命中任一即 q_bad=1，reason 记第一命中项）：
 *   R1 缺材料：题干以「根据材料/资料/下表」开头但没有 material，HTML 里也没图
 *   R2 图丢了：题干/解析出现「如图/下图/[图]/图中」，但 HTML 里没有 <img>
 *   R3 公式丢了：解析出现「为元 / 有名 / 有本 / 为名 / =名」这类数字被吞的痕迹
 *   R4 答案与解析不符：解析里明确写了「正确答案是 X」但和 answer 不一致
 *   R5 图片键缺失：HTML 里引用的 latex key 在 images.db 里找不到
 *   R6 客观题没答案：type 1/2/3/5 而 answerIndex < 0 且 answer 为空
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DB = path.resolve(ROOT, arg('db', 'app-assets/tiku_app.db'));
const IMGDB = path.resolve(ROOT, arg('images', 'app-assets/images.db'));
const APPLY = flag('apply');
const LIST = Number(arg('list', 0));

const hasImg = (t) => /<img/i.test(t || '');
const TYPE_PREFIX = /^\s*[（(]?(单选题|多选题|判断题|不定项选择题|不定项|材料题)[)）]?\s*/;

function lettersOf(s) {
  const out = new Set();
  // 支持 "A"、"A、C"、"AC"、"A C" 四种写法：连续字母串直接拆开
  const re = /[A-H]{1,8}/g;
  let m;
  while ((m = re.exec(String(s || '')))) for (const ch of m[0]) out.add(ch);
  return [...out].sort();
}

/** 从解析里读「明确的答案声明」，只认强信号，避免把逐项点评误当答案 */
function strongAnswer(analysis) {
  const t = String(analysis || '');
  const m = /(?:正确答案|答案|正确选项)(?:是|为|应选|选)\s*[:：]?\s*([A-H](?:\s*[,、和]\s*[A-H])*)|(?:故选|应选|答案选|本题选)\s*[:：]?\s*([A-H](?:\s*[,、和]\s*[A-H])*)/.exec(t);
  if (!m) return null;
  return lettersOf(m[1] || m[2] || '');
}

function normAnswer(row) {
  const a = String(row.answer == null ? '' : row.answer).trim();
  if (!a) return [];
  if (/^\d+(,\d+)*$/.test(a)) return a.split(',').map((x) => 'ABCDEFGH'[Number(x)]).filter(Boolean).sort();
  return lettersOf(a);
}

const db = new DatabaseSync(DB, { readOnly: !APPLY });
const imgDb = new DatabaseSync(IMGDB, { readOnly: true });
const keyStmt = imgDb.prepare('SELECT 1 FROM images WHERE key = ? LIMIT 1');
const keyCache = new Map();
const keyExists = (k) => {
  if (keyCache.has(k)) return keyCache.get(k);
  let ok = true;
  try { ok = !!keyStmt.get(k); } catch { ok = false; }
  keyCache.set(k, ok);
  return ok;
};
const LATEX = /formulas\?latex=([^&"'\s)]+)/g;

function missingKeys(html) {
  const miss = [];
  if (!html) return miss;
  let m;
  LATEX.lastIndex = 0;
  while ((m = LATEX.exec(html))) {
    let k = m[1];
    try { k = decodeURIComponent(k); } catch { /* keep raw */ }
    if (!keyExists(k)) miss.push(k);
  }
  return miss;
}

if (APPLY) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('questions')").all().map((r) => r.name);
  if (!cols.includes('q_bad')) db.exec('ALTER TABLE questions ADD COLUMN q_bad INTEGER DEFAULT 0');
  if (!cols.includes('q_bad_reason')) db.exec('ALTER TABLE questions ADD COLUMN q_bad_reason TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_questions_qbad ON questions(q_bad)');
  db.exec('UPDATE questions SET q_bad = 0, q_bad_reason = NULL');
}

const rows = db.prepare(`
  SELECT q.id, q.questionId, q.type, q.answer, q.answerIndex, q.content, q.contentHtml,
         q.material, q.analysis, q.analysisHtml, p.subjectName AS subject, q.chapter
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const REASONS = {
  R1: '缺材料',
  R2: '图丢了',
  R3: '公式丢了',
  R4: '答案与解析不符',
  R5: '图片键缺失',
  R6: '客观题没答案',
};
const badRows = [];
const stat = { total: rows.length, bad: 0, by: {}, bySubject: {}, samples: {} };
for (const k of Object.keys(REASONS)) { stat.by[k] = 0; stat.samples[k] = []; }

const upd = APPLY ? db.prepare('UPDATE questions SET q_bad = 1, q_bad_reason = ? WHERE questionId = ?') : null;

for (const r of rows) {
  const stem = String(r.content || '');
  const contentHtml = String(r.contentHtml || '');
  const analysis = String(r.analysis || '');
  const analysisHtml = String(r.analysisHtml || '');
  const material = String(r.material || '');
  const isObj = ['1', '2', '3', '5'].includes(String(r.type));

  let reason = null;
  let detail = '';

  // R1 缺材料：题干要求「根据材料/资料/下表」但材料为空，且题干里也没有图
  if (!reason && isObj
      && /^(根据|阅读|结合)(以下|如下)?(材料|资料|上文|下表|上表|图表)/.test(stem.trim().replace(TYPE_PREFIX, ''))
      && !material.trim() && !hasImg(stem) && !hasImg(contentHtml)) {
    reason = 'R1';
  }

  // R2 图丢了：正文提到图，但 HTML 里没有 <img>
  if (!reason) {
    // 注意别把「拍下图像」「图片」这类词当成引用图
    const mentionsImg = /\[图\]|（图）|\(图\)|如下图|如图|根据下图|如图所示|图中所示|图\s?\d|(?:^|[，。；：、\s])上图|(?:^|[，。；：、\s])下图(?!像)/.test(stem);
    if (mentionsImg && !hasImg(contentHtml) && !hasImg(analysisHtml) && !hasImg(material)) reason = 'R2';
  }

  // R3 公式丢了：数字被吞掉
  if (!reason && isObj && /(为元|有名|有本|为名|=名|元，而|元。故|元，则|个，则|为千克)/.test(analysis)) reason = 'R3';

  // R4 答案与解析不符：只认「硬矛盾」——
  //   单选/判断：解析给的字母 ≠ 库里的答案
  //   多选/不定项：解析给出的字母**不在**库里（多选题解析常常只点评其中一项，不算矛盾）
  if (!reason && isObj) {
    const said = strongAnswer(analysis);
    const mine = normAnswer(r);
    if (said && said.length && mine.length) {
      const mineSet = new Set(mine);
      const equal = said.length === mineSet.size && said.every((x) => mineSet.has(x));
      const hardConflict = !equal && String(r.type) === '1' || !equal && String(r.type) === '5'
        ? !equal
        : !said.every((x) => mineSet.has(x));
      if (hardConflict) {
        reason = 'R4';
        detail = `解析 ${said.join('')} / 库 ${mine.join('')}`;
      }
    }
  }

  // R5 图片键缺失
  if (!reason) {
    const miss = missingKeys(contentHtml).length + missingKeys(analysisHtml).length + missingKeys(material).length;
    if (miss) { reason = 'R5'; detail = `${miss} 个图找不到`; }
  }

  // R6 客观题没答案
  if (!reason && isObj) {
    const a = String(r.answer == null ? '' : r.answer).trim();
    if (!a && Number(r.answerIndex) < 0) reason = 'R6';
  }

  if (!reason) continue;
  badRows.push({ questionId: r.questionId, reason: REASONS[reason] + (detail ? '：' + detail : ''), subject: r.subject, chapter: r.chapter, content: stem });
  stat.bad++;
  stat.by[reason]++;
  stat.bySubject[r.subject] = (stat.bySubject[r.subject] || 0) + 1;
  if (stat.samples[reason].length < (LIST || 3)) {
    stat.samples[reason].push({ qid: r.questionId, chapter: r.chapter, detail, stem: stem.slice(0, 60) });
  }
  if (upd) upd.run(`${REASONS[reason]}${detail ? '：' + detail : ''}`, r.questionId);
}

db.close();
imgDb.close();

const pct = (n) => ((n / stat.total) * 100).toFixed(2) + '%';
console.log(`题库唯一题 ${stat.total}，坏题 ${stat.bad}（${pct(stat.bad)}）${APPLY ? ' —— 已写入 q_bad' : ' —— 只统计，未写库'}`);
for (const [k, name] of Object.entries(REASONS)) {
  console.log(`  ${k} ${name}: ${stat.by[k]}`);
}
console.log('\n按科目：');
for (const [s, n] of Object.entries(stat.bySubject).sort((a, b) => b[1] - a[1])) console.log(`  ${s || '(空)'} ${n}`);
if (LIST) {
  for (const [k, name] of Object.entries(REASONS)) {
    if (!stat.samples[k].length) continue;
    console.log(`\n${k} ${name} 样例：`);
    for (const s of stat.samples[k]) console.log(`  ${s.qid} [${s.chapter}] ${s.detail || ''} ${s.stem}`);
  }
}
// 明细 CSV：让用户能自己抽查
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outDir = path.join(ROOT, 'report');
fs.mkdirSync(outDir, { recursive: true });
const csvPath = path.join(outDir, `bad-questions-${day}.csv`);
const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const lines = ['questionId,问题,科目,章节,题干'];
for (const r of badRows) {
  lines.push([r.questionId, r.reason, r.subject, r.chapter, String(r.content || '').replace(/\s+/g, ' ').slice(0, 90)].map(esc).join(','));
}
fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\r\n'), 'utf8');
console.log(`\n明细：${path.relative(ROOT, csvPath)}（${badRows.length} 行）`);
if (!APPLY) console.log('下一步：加 --apply 写库（只加 q_bad/q_bad_reason 两列，不动原字段）');
