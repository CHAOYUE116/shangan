#!/usr/bin/env node
/**
 * tools/backfill-from-api.mjs — 把 fenbi-solutions-api 抓到的解析按 paperId 精确回填
 *
 * 对齐策略（三层，宁缺勿错）：
 *   1) 按卷内位置对齐 + 题干前 24 字校验（正常路径）
 *   2) 位置不中时，按「题干前 40 字归一化」在卷内建 map 再找
 *   3) 都不中就不写，计入 unmatched
 *
 * 只填空值，不覆盖已有解析。
 *
 * 用法：node tools/backfill-from-api.mjs [--apply] [--course syzc] [--limit 50]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** 富文本 → 纯文本（与 fenbi-solutions-api.mjs 里的实现保持一致，这里内联避免 import 触发那边的浏览器启动） */
function richToText(raw) {
  if (!raw) return '';
  let node = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    try { node = JSON.parse(s); } catch { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
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
  return out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOLUTIONS = path.resolve(ROOT, '..', 'research', 'fenbi-solutions');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const ONLY = arg('course', null);
const LIMIT = Number(arg('limit', 99999));

const norm = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。、；：？！“”‘’（）()《》〈〉·\-—…\[\]【】]/g, '')
  .slice(0, 40);

const db = new DatabaseSync(path.resolve(ROOT, 'tiku.db'));
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
let total = { papers: 0, filled: 0, noAnswer: 0, unmatched: 0, already: 0 };
const courses = ONLY ? [ONLY] : fs.readdirSync(SOLUTIONS).filter((d) => fs.statSync(path.join(SOLUTIONS, d)).isDirectory());

const upd = db.prepare('UPDATE questions SET analysis = ? WHERE id = ?');
const pick = db.prepare('SELECT id, questionId, content, analysis FROM questions WHERE paperId = ? ORDER BY id');

for (const course of courses) {
  const dir = path.join(SOLUTIONS, course);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.meta.') && !f.includes('.side.')).slice(0, LIMIT);
  let c = { papers: 0, filled: 0, noAnswer: 0, unmatched: 0, already: 0 };
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = rec.paperId || Number(f.replace('.json', ''));
    const sols = rec.solutions || [];
    if (!sols.length) continue;
    const rows = pick.all(pid);
    if (!rows.length) continue;
    c.papers += 1;

    const byHead = new Map();
    const solTexts = sols.map((s) => ({ head: norm(richToText(s.content)), text: richToText(s.solution), raw: s }));
    solTexts.forEach((s, i) => { if (s.head) byHead.set(s.head, i); });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.analysis && String(r.analysis).trim()) { c.already += 1; continue; }
      const head = norm(r.content);
      let s = solTexts[i] && norm(solTexts[i].head).slice(0, 24) === head.slice(0, 24) ? solTexts[i] : null;
      if (!s) { const idx = byHead.get(head); if (idx != null) s = solTexts[idx]; }
      if (!s) { c.unmatched += 1; continue; }
      if (!s.text) { c.noAnswer += 1; continue; }
      if (APPLY) upd.run(s.text, r.id);
      c.filled += 1;
    }
  }
  console.log(`${course}: 卷 ${c.papers} / 回填 ${c.filled} / 已有 ${c.already} / 无解析文本 ${c.noAnswer} / 对不上 ${c.unmatched}`);
  for (const k of Object.keys(total)) total[k] += c[k];
}

console.log(`\n${APPLY ? '已写入' : 'dry run'}  合计：卷 ${total.papers} / 回填 ${total.filled} / 已有 ${total.already} / 无解析 ${total.noAnswer} / 对不上 ${total.unmatched}`);
if (APPLY) {
  const bak = path.resolve(ROOT, `tiku.db.bak-analysis-${stamp}`);
  console.log(`（写库前请确认已备份；建议先 cp tiku.db ${path.basename(bak)}）`);
}
