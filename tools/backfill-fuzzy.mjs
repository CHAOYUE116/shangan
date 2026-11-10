/**
 * 解析回填 · 模糊第二轮
 *
 * 背景：`backfill-from-api.mjs` 用「题干前 60 字归一化后完全相等」做判定，
 * 严格但会漏掉一批「同一道题、题干有细微差异」的情况（数字全半角、标点、图片占位）。
 * 这批题在库里有 5,000 多道，粉笔解析文件里其实有对应答案，只是字面不 100% 相同。
 *
 * 这一轮用「题干前 N 字公共前缀」做候选，再加两道闸门，避免串题：
 *   1) 前缀 >= 24 字 且 正确答案字母一致
 *   2) 前缀 >= 40 字（长前缀本身就足够区分）
 * 图形推理那种通用题干（「请从所给的四个选项中选择最合适的一个…」）前缀虽长但
 * 多处重复，靠「答案一致」这道闸门挡住；只走第 2 条时会误命中，所以第 2 条额外
 * 要求「该前缀在解析文件里唯一」。
 *
 *   node tools/backfill-fuzzy.mjs            # 干跑，只看能补多少
 *   node tools/backfill-fuzzy.mjs --apply    # 写库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOLUTIONS = path.resolve(ROOT, '..', 'research', 'fenbi-solutions');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = (() => { const i = argv.indexOf('--course'); return i >= 0 ? argv[i + 1] : null; })();

function richToText(raw) {
  if (!raw) return '';
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return s.replace(/<[^>]+>/g, ' ');
    try { node = JSON.parse(s); } catch { return s; }
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.name === 'txt' && typeof n.value === 'string') { out.push(n.value); return; }
    if (n.name === 'img') { out.push('[图]'); return; }
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (['p', 'div', 'li', 'tr', 'br'].includes(n.name)) out.push('\n');
  };
  walk(node);
  return out.join('');
}

const norm = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\[图\]/g, '')
  .replace(/[\s\u3000\u00a0]+/g, '')
  .replace(/[\uFF3F_]+/g, '')
  .replace(/（[\s\u3000]*）/g, '')
  .replace(/[，。、；：？！“”‘’（）()《》〈〉·\-—…\[\]【】]/g, '')
  .replace(/^\d+[、.]/, '');

const commonPrefix = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
};

/** 粉笔 correctAnswer 是 { choice: "1", type: 201 }，choice 从 0 开始 —— 0→A、1→B */
const solLetter = (v) => {
  if (!v) return '';
  let ch = v;
  if (typeof v === 'string' && v.trim().startsWith('{')) { try { ch = JSON.parse(v); } catch { /* 当作字符串 */ } }
  if (ch && typeof ch === 'object') ch = ch.choice ?? ch.index ?? '';
  const n = Number(ch);
  if (Number.isFinite(n) && n >= 0 && n < 8) return String.fromCharCode(65 + n);
  return letter(ch);
};
const letter = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  if (/^[A-H]$/.test(s)) return s;
  const m = /(?:^|[^A-Z])([A-H])(?:[^A-Z]|$)/.exec(s);
  return m ? m[1] : '';
};

const db = new DatabaseSync(path.resolve(ROOT, 'tiku.db'));
const upd = db.prepare('UPDATE questions SET analysis = ? WHERE id = ?');
const cols = new Set(db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name));
const answerCol = cols.has('answer') ? 'answer' : (cols.has('correctAnswer') ? 'correctAnswer' : null);

const courses = ONLY ? [ONLY] : fs.readdirSync(SOLUTIONS).filter((d) => fs.statSync(path.join(SOLUTIONS, d)).isDirectory());
const total = { papers: 0, miss: 0, filled: 0, byAnswer: 0, byPrefix: 0 };

for (const course of courses) {
  const dir = path.join(SOLUTIONS, course);
  let c = { papers: 0, miss: 0, filled: 0, byAnswer: 0, byPrefix: 0 };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.includes('.meta.') && !x.includes('.side.'))) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = rec.paperId || Number(f.replace('.json', ''));
    const sols = (rec.solutions || []).map((s) => ({
      h: norm(richToText(s.content)),
      text: richToText(s.solution),
      ans: solLetter(s.correctAnswer),
    })).filter((s) => s.h && s.text);
    if (!sols.length) continue;

    const rows = db.prepare(
      `SELECT id, questionId, content${answerCol ? ', ' + answerCol + ' AS ans' : ''} FROM questions
       WHERE paperId = ? AND (analysis IS NULL OR TRIM(analysis) = '') ORDER BY id`
    ).all(pid);
    if (!rows.length) continue;
    c.papers += 1;

    // 前缀唯一性：同一个前缀出现多次时，只能靠答案区分，不能靠「最长前缀」硬套
    const prefixCount = new Map();
    for (const s of sols) {
      const key = s.h.slice(0, 40);
      prefixCount.set(key, (prefixCount.get(key) || 0) + 1);
    }

    for (const r of rows) {
      c.miss += 1;
      const head = norm(r.content);
      if (head.length < 12) continue;
      let best = null;
      let bestLen = 0;
      for (const s of sols) {
        const k = commonPrefix(head, s.h);
        if (k > bestLen) { bestLen = k; best = s; }
      }
      if (!best || bestLen < 24) continue;

      const dbAns = letter(r.ans);
      const sameAnswer = dbAns && best.ans && dbAns === best.ans;
      const uniqueLong = bestLen >= 40 && (prefixCount.get(best.h.slice(0, 40)) || 0) === 1;

      if (!sameAnswer && !uniqueLong) continue;
      if (APPLY) upd.run(best.text, r.id);
      c.filled += 1;
      if (sameAnswer) c.byAnswer += 1; else c.byPrefix += 1;
    }
  }
  console.log(`${course}: 卷 ${c.papers} / 缺 ${c.miss} / 本轮补 ${c.filled}（答案一致 ${c.byAnswer} + 长前缀唯一 ${c.byPrefix}）`);
  for (const k of Object.keys(total)) total[k] += c[k];
}

console.log(`\n${APPLY ? '已写入' : 'dry run'}  合计：卷 ${total.papers} / 缺 ${total.miss} / 补 ${total.filled}（答案一致 ${total.byAnswer} + 长前缀唯一 ${total.byPrefix}）`);
