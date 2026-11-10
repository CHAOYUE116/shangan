#!/usr/bin/env node
/**
 * tools/backfill-solutions.mjs —— 把已采集的粉笔解析回填进题库
 *
 * 背景：解析只存在于交卷后的 /combine/static/solution 响应里，采集脚本把整卷存成了
 * research/fenbi-solutions/<course>/*.json（{name, solutions:[{content,correctAnswer,solution,...}]}）。
 * 但当年导入时按题匹配有漏，库里仍有一批题 analysis 为空。
 *
 * 匹配规则（防错配，宁可漏不可错）：
 *   1. 先在同一个卷内配（卷名归一化后比对），跨卷一律不认 —— 图形推理那种
 *      「请从所给的四个选项中选择最合适的一个填入问号处…」全卷甚至全库都长一样，
 *      只按题干前 30 字匹配会把别题的解析写到这题上。
 *   2. 卷内指纹 = 题干前 40 字 + 选项前 30 字（选项去掉标签）。
 *   3. 选项为空的题（纯图形题）只在题干长度 > 40 且卷内唯一时才允许配。
 *
 * 只填空值，绝不覆盖已有解析。
 *
 * 用法：
 *   node tools/backfill-solutions.mjs --course syzc            # dry run
 *   node tools/backfill-solutions.mjs --course syzc --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSE = arg('course', 'syzc');
const APPLY = argv.includes('--apply');
const SUBJECT = arg('subject', '事业编·职测');
const DIR = path.resolve(ROOT, '..', 'research', 'fenbi-solutions', COURSE);

const strip = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/[（(]\s*[）)]/g, '（　）')
  .replace(/\s+/g, '')
  .trim();

// 卷名归一化：去掉括号里的来源说明、书名号与标点，只留主干
const normPaper = (s) => String(s || '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[《》\s·,，.。:：、\-—_\/|]/g, '')
  .slice(0, 26);

const fpOf = (content, options) => `${strip(content).slice(0, 40)}||${strip(options).slice(0, 30)}`;

// 粉笔的选项不在 solution.options，而在 accessories[0].options（字符串数组）
const optionsOf = (s) => {
  const acc = Array.isArray(s.accessories) ? s.accessories : [];
  for (const a of acc) if (Array.isArray(a && a.options) && a.options.length) return a.options.join('|');
  return s.options || '';
};

if (!fs.existsSync(DIR)) { console.error('没有数据目录:', DIR); process.exit(1); }

// ---------- 1) 建索引：卷 → 指纹 → 解析 ----------
const byPaper = new Map();   // paperKey -> Map(fp -> {text, html, answer})
const dupInPaper = new Map(); // 同卷内重复指纹，标记成不可用
let files = 0, sols = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json') || f.includes('.meta.') || f.includes('.side.')) continue;
  let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(j.solutions) || !j.name) continue;
  files++;
  const pk = normPaper(j.name);
  if (!byPaper.has(pk)) byPaper.set(pk, new Map());
  const m = byPaper.get(pk);
  for (const s of j.solutions) {
    const text = strip(s.solution);
    if (!text || text.length < 10) continue;
    const options = optionsOf(s);
    const k = fpOf(s.content, options);
    const stemLen = strip(s.content).length;
    if (stemLen < 12) continue;
    // 题干很短且没有选项 → 太容易撞，直接不收录
    if (stemLen <= 40 && strip(options).length < 10) continue;
    if (m.has(k)) { dupInPaper.set(pk + '|' + k, true); } else { m.set(k, { text, html: s.solution, answer: s.correctAnswer || '' }); }
    sols++;
  }
}
console.log(`解析文件 ${files} 个 / 解析条目 ${sols} 条 / 涉及卷 ${byPaper.size} 份`);

// ---------- 2) 库里缺解析的题 ----------
const db = new DatabaseSync(path.join(ROOT, 'app-assets', 'tiku_app.db'));
const rows = db.prepare(`
  SELECT q.id, q.questionId, q.content, q.answer, q.options, p.name AS paper
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE p.subjectName = ? AND (q.analysis IS NULL OR TRIM(q.analysis) = '')`).all(SUBJECT);
console.log(`库里「${SUBJECT}」缺解析 ${rows.length} 题`);

const hits = [];
const stat = { noPaper: 0, noFp: 0, dup: 0, ok: 0 };
for (const r of rows) {
  const m = byPaper.get(normPaper(r.paper));
  if (!m) { stat.noPaper++; continue; }
  const k = fpOf(r.content, r.options);
  const s = m.get(k);
  if (!s) { stat.noFp++; continue; }
  if (dupInPaper.get(normPaper(r.paper) + '|' + k)) { stat.dup++; continue; }
  stat.ok++;
  hits.push({ ...r, sol: s });
}
console.log('匹配结果:', JSON.stringify(stat));

for (const h of hits.slice(0, 6)) {
  console.log(`  · ${h.paper.slice(0, 34)} | ${strip(h.content).slice(0, 30)} | ${h.sol.text.slice(0, 30)}`);
}

if (!APPLY) { console.log('\n（dry run，加 --apply 才会写库）'); db.close(); process.exit(0); }
if (!hits.length) { console.log('没有可回填的题'); db.close(); process.exit(0); }

const upd = db.prepare(`UPDATE questions SET analysis = ?, analysisHtml = ?,
  answer = CASE WHEN answer IS NULL OR TRIM(answer) = '' THEN ? ELSE answer END
  WHERE id = ?`);
db.exec('BEGIN');
try {
  for (const h of hits) upd.run(h.sol.text, h.sol.html || null, String(h.sol.answer || '').trim(), h.id);
  db.exec('COMMIT');
  console.log(`✓ 已回填 ${hits.length} 题`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗ 回滚:', e.message);
  process.exitCode = 1;
}
db.close();
