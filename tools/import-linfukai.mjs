#!/usr/bin/env node
/**
 * tools/import-linfukai.mjs — 导入 linfukai186-arch/gongkao-tiku 的事业编题库
 *
 * 数据来源：https://linfukai186-arch.github.io/gongkao-tiku/data/shiyebian-{gongji,zongying}/
 *   （先跑 tools/fetch-linfukai.mjs 下载到 research/linfukai/）
 *
 * 实测质量（2026-11-08）：
 *   公基 9,588 题：PDF 残留 0.4%、无解析 5%、与我方重复 63.9% → 净新增约 3,460
 *   综应   860 题：全部无选项/无答案（主观题），与我方重复 28.3% → 净新增约 617，价值有限
 *
 * 写入约定：
 *   - 只写 tiku.db 的 papers/questions，以及 practice.db 的 question_categories（题库树要它）
 *   - questionId 用 910,000,000 起（9亿段已被「公基种子题」占用，避开）
 *   - 按题干指纹（去空白前 40 字）去重，重复跑不会重复插入
 *
 * 用法：
 *   node tools/import-linfukai.mjs --dry-run         只看会导入多少（默认）
 *   node tools/import-linfukai.mjs --apply           实际写入（自动备份）
 *   node tools/import-linfukai.mjs --module gongji --apply
 *   node tools/import-linfukai.mjs --module zongying --apply --allow-no-answer
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ROOT, '..', 'research', 'linfukai');
const TIKU = path.join(ROOT, 'tiku.db');
const PRACTICE = path.join(ROOT, 'practice.db');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const APPLY = flag('apply');
const MODULE = arg('module', 'gongji');
const ALLOW_NO_ANSWER = flag('allow-no-answer');
const ID_BASE = 910000000;

const SUBJECT = MODULE === 'zongying' ? '事业编·综应' : '事业编·公基';
const PREFIX = `shiyebian-${MODULE}`;

const norm = (s) => String(s || '').replace(/[\s\u3000]/g, '').slice(0, 40);
const clean = (s) => String(s || '').replace(/\(cid:\d+\)/g, '').replace(/\r\n?/g, '\n').trim();

// ---------- 读源 ----------
const files = fs.readdirSync(SRC).filter((f) => f.startsWith(PREFIX + '-y') && f.endsWith('.json'));
if (!files.length) {
  console.error(`✗ 找不到 ${PREFIX}-y*.json，先跑：node tools/fetch-linfukai.mjs --module shiyebian-${MODULE}`);
  process.exit(1);
}

const papers = [];
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\uFEFF/, ''));
  for (const [key, arr] of Object.entries(data)) {
    if (!Array.isArray(arr) || !arr.length) continue;
    papers.push({ key, questions: arr });
  }
}
console.log(`源：${files.length} 个年份文件，${papers.length} 份试卷`);

// ---------- 目标库 ----------
const tiku = new DatabaseSync(TIKU, { timeout: 10000 });
const practice = new DatabaseSync(PRACTICE, { timeout: 10000 });

const existing = new Set(
  tiku.prepare('SELECT substr(content, 1, 60) f FROM questions').all().map((r) => norm(r.f))
);
const maxQid = tiku.prepare('SELECT MAX(questionId) m FROM questions').get().m;
const maxPaperId = tiku.prepare('SELECT MAX(id) m FROM papers').get().m;
console.log(`目标库：现有唯一题干指纹 ${existing.size}，questionId max=${maxQid}，paperId max=${maxPaperId}`);

// ---------- 规划 ----------
let seq = 0;
let nextPaperId = maxPaperId + 1;
let skippedDup = 0, skippedNoAns = 0, skippedBad = 0;
const plan = [];

for (const p of papers) {
  const rows = [];
  for (const q of p.questions) {
    const content = clean(q.q);
    const analysis = clean(q.e);
    const answer = String(q.a || '').trim();
    const options = Array.isArray(q.o) ? q.o.map(clean).filter(Boolean) : [];

    if (content.length < 8) { skippedBad += 1; continue; }
    if (!answer && !ALLOW_NO_ANSWER) { skippedNoAns += 1; continue; }
    const fp = norm(content);
    if (existing.has(fp)) { skippedDup += 1; continue; }
    existing.add(fp);

    rows.push({
      questionId: ID_BASE + (++seq),
      chapter: clean(q.t) || '未分类',
      type: answer.length > 1 ? 2 : 1,
      content,
      material: clean(q.s),
      options: JSON.stringify(options),
      answer,
      analysis,
    });
  }
  if (rows.length) plan.push({ paperId: nextPaperId++, name: p.key, rows });
}

const totalQ = plan.reduce((a, p) => a + p.rows.length, 0);
console.log(`\n可导入：${plan.length} 份试卷 / ${totalQ} 题`);
console.log(`跳过：重复 ${skippedDup}，无答案 ${skippedNoAns}，无效 ${skippedBad}`);

const byChapter = {};
for (const p of plan) for (const r of p.rows) byChapter[r.chapter] = (byChapter[r.chapter] || 0) + 1;
console.log('本章节分布：', Object.entries(byChapter).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join('  '));

if (!totalQ) { console.log('\n没有可导入的题。'); process.exit(0); }

if (!APPLY) {
  console.log('\n[dry-run] 未写入。确认后加 --apply。');
  console.log('  样例：', JSON.stringify(plan[0].rows[0]).slice(0, 300));
  process.exit(0);
}

// ---------- 写入 ----------
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
for (const f of [TIKU, PRACTICE]) {
  try { new DatabaseSync(f, { timeout: 5000 }).prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
  const bak = `${f}.bak-linfukai-${stamp}`;
  fs.copyFileSync(f, bak);
  console.log(`备份 → ${path.basename(bak)} (${(fs.statSync(bak).size / 1024 / 1024).toFixed(0)} MB)`);
}

const insPaper = tiku.prepare(`
  INSERT INTO papers (id, subject, subjectName, category, name, questionCount, time, difficulty, exerciseId, chapters, crawledAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insQ = tiku.prepare(`
  INSERT INTO questions (questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType, answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insCat = practice.prepare(`
  INSERT INTO question_categories (question_id, subject, category, sub, updated_at) VALUES (?, ?, ?, ?, ?)
`);

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
let nP = 0, nQ = 0;

tiku.exec('BEGIN');
practice.exec('BEGIN');
try {
  for (const p of plan) {
    insPaper.run(p.paperId, SUBJECT, SUBJECT, '事业单位', p.name, p.rows.length, 0, 0, null, '[]', now);
    nP += 1;
    for (const r of p.rows) {
      insQ.run(
        r.questionId, p.paperId, r.chapter, r.type, null,
        r.content, null, r.material || null, r.options, null,
        r.answer, -1, 0, 'linfukai',
        r.analysis, null, 0
      );
      insCat.run(r.questionId, SUBJECT, r.chapter, '', now);
      nQ += 1;
    }
  }
  tiku.exec('COMMIT');
  practice.exec('COMMIT');
} catch (e) {
  tiku.exec('ROLLBACK');
  practice.exec('ROLLBACK');
  console.error('写入失败，已回滚：', e.message);
  process.exit(1);
}

console.log(`\n✓ 写入 ${nP} 份试卷 / ${nQ} 题`);
console.log(`  备份：tiku.db.bak-linfukai-${stamp} / practice.db.bak-linfukai-${stamp}`);
console.log('  下一步：node build-app-assets.mjs app-assets --skip-download → 再 npx cap copy android');
