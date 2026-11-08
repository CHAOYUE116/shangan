#!/usr/bin/env node
/**
 * tools/audit-fenbi-solutions.mjs — 质检粉笔采集的解析数据
 *
 * 判据参考《蒸馏方法参考》§3.3：
 *   结论层优先（"故正确答案为X" / "答案为X" / "故选X"），弱判据兜底且加否定守卫
 *
 * 用法：node tools/audit-fenbi-solutions.mjs [--course syzc] [--sample 5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COURSE = arg('course', 'syzc');
const SAMPLE = Number(arg('sample', 4));
const DIR = path.resolve(ROOT, '..', 'research', 'fenbi-solutions', COURSE);

if (!fs.existsSync(DIR)) { console.error('没有数据目录:', DIR); process.exit(1); }

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// 按试卷名去重（同一卷可能被抓多次，exerciseKey 不同）
const byName = new Map();
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.includes('.side.'))) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (!j.solutions) continue;
  if (!byName.has(j.name)) byName.set(j.name, { file: f, data: j });
}
console.log(`文件 ${fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.includes('.side.')).length} 个，去重后 ${byName.size} 份试卷\n`);

let total = 0, noStem = 0, noOpt = 0, optNot4 = 0, noAns = 0, noSol = 0, thinSol = 0, noKp = 0, htmlLeft = 0;
const strongConflicts = [], weakConflicts = [], noSolList = [];
const solLens = [];
const samples = [];

for (const [name, { file, data }] of byName) {
  for (const s of data.solutions || []) {
    total += 1;
    const content = strip(s.content);
    const opts = (s.accessories || []).find((a) => Array.isArray(a.options))?.options || [];
    const solText = strip(s.solution);
    const ansIdx = s.correctAnswer?.choice != null ? Number(s.correctAnswer.choice) : -1;
    const ansLetter = ansIdx >= 0 && ansIdx < opts.length ? 'ABCDEFGH'[ansIdx] : null;

    if (!content) noStem += 1;
    if (!opts.length) noOpt += 1;
    else if (opts.length !== 4) optNot4 += 1;
    if (ansLetter == null) noAns += 1;
    if (!solText) { noSol += 1; noSolList.push({ id: s.id, name }); }
    else {
      solLens.push(solText.length);
      if (solText.length < 20) thinSol += 1;
    }
    if (!(s.keypoints || []).length) noKp += 1;
    // 二次转义的 HTML（&lt;p&gt;）才算残留；正常的 <p> 是内容本身
    if (/&lt;\/?p&gt;|&amp;lt;/.test(String(s.content || ''))) htmlLeft += 1;

    // 答案一致性（结论层）
    if (solText && ansLetter) {
      const neg = /选非|不正确|错误的是|不属于|不能|除哪项外|不符合/.test(content);
      const m = solText.match(/(?:故正确答案为|正确答案是|答案为|故答案选|应选|故选)\s*[:：]?\s*([A-H])/);
      if (m && m[1] !== ansLetter) strongConflicts.push({ id: s.id, said: m[1], field: ansLetter, neg, snip: solText.slice(-90) });
      else if (!m) {
        const w = solText.match(/([A-H])\s*项(?:正确|说法正确|当选)/);
        if (w && w[1] !== ansLetter && !neg) weakConflicts.push({ id: s.id, said: w[1], field: ansLetter });
      }
    }
    if (samples.length < SAMPLE && s.id) samples.push({ s, content, opts, solText, ansLetter, name });
  }
}

const p = (x) => `${x} (${(x / total * 100).toFixed(2)}%)`;
console.log(`总题数 ${total}`);
console.log('\n【字段完备率】');
console.log(`  题干缺失        ${p(noStem)}`);
console.log(`  无选项          ${p(noOpt)}    选项数≠4 ${p(optNot4)}`);
console.log(`  无答案          ${p(noAns)}`);
console.log(`  无解析          ${p(noSol)}    解析过短(<20字) ${p(thinSol)}`);
console.log(`  无考点          ${p(noKp)}`);
console.log(`  题干残留HTML    ${p(htmlLeft)}`);
if (solLens.length) {
  solLens.sort((a, b) => a - b);
  console.log(`  解析字数 中位 ${solLens[Math.floor(solLens.length / 2)]} / P90 ${solLens[Math.floor(solLens.length * 0.9)]}`);
}

console.log('\n【答案一致性】');
console.log(`  结论层冲突（需人工看）  ${strongConflicts.length}`);
for (const c of strongConflicts.slice(0, 6)) console.log(`    qid=${c.id} 解析说 ${c.said} / 字段 ${c.field} 选非=${c.neg}`);
console.log(`  弱判据冲突（多为误报）  ${weakConflicts.length}`);

if (noSolList.length) {
  console.log('\n【无解析的题（前 8）】');
  for (const x of noSolList.slice(0, 8)) console.log(`    qid=${x.id}  ${String(x.name).slice(0, 40)}`);
}

console.log(`\n【抽检 ${samples.length} 题】`);
for (const x of samples) {
  console.log(`\n  ── qid=${x.s.id} 答案=${x.ansLetter} 考点=${(x.s.keypoints || []).map((k) => k.name).join('/') || '—'}`);
  console.log(`  题干: ${x.content.slice(0, 120)}`);
  x.opts.forEach((o, i) => console.log(`    ${'ABCDEFGH'[i]}. ${strip(o).slice(0, 60)}`));
  console.log(`  解析: ${x.solText.slice(0, 180)}`);
}
