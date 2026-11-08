#!/usr/bin/env node
/**
 * tools/import-fenbi-papers.mjs — 把粉笔采集的整卷解析导入 tiku.db
 *
 * 数据来源：research/fenbi-solutions/{course}/*.json（tools/fenbi-fetch-solutions.mjs 产出）
 * 字段映射：
 *   solutions[].id          → questions.questionId（粉笔题号，与现有库同体系）
 *   card 树（nodeType=1 模块 → nodeType=2 题节点 key=globalId）→ questions.chapter
 *   accessories[].options   → questions.options（JSON 数组）
 *   correctAnswer.choice    → answerIndex（0 基）
 *   solution（HTML）        → analysis（去标签后存纯文本）
 *   keypoints[]             → question_categories.sub
 *
 * 用法：
 *   node tools/import-fenbi-papers.mjs --course syzc --dry-run
 *   node tools/import-fenbi-papers.mjs --course syzc --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const COURSE = arg('course', 'syzc');
const DIR = path.resolve(ROOT, '..', 'research', 'fenbi-solutions', COURSE);

const SUBJECT = { syzc: '事业编·职测', zhyynl: '事业编·综应', sydw: '事业编·公基', xingce: '公务员·行测', shenlun: '公务员·申论' }[COURSE] || '事业编·职测';

const strip = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/\n{3,}/g, '\n\n').trim();

/** 保留 HTML 原文，但把协议相对的图片地址补成 https（粉笔给的是 //fb.fbstatic.cn/...） */
const normImg = (h) => String(h || '')
  .replace(/src="\/\//g, 'src="https://')
  .replace(/src='\/\//g, "src='https://")
  .trim();

/** 选项/解析里是否含公式图或真图 */
const hasImg = (h) => /<img\b/i.test(String(h || ''));

/**
 * 事业单位联考 B/C/D/E 类有自己的一套模块名，FENBI_TREE 里没有，
 * 不归树就会在「按方向练习」里漏掉（2026-11 实测漏 133 题）。
 * 这里统一映射到树内 group，原模块名保留在 question_categories.sub。
 */
const TREE_GROUPS = new Set(['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析']);
const GROUP_ALIAS = {
  策略选择: '判断推理',   // D/E 类
  综合分析: '资料分析',   // B/C 类
  数量分析: '数量关系',   // B/C/D/E 类
  数学运算: '数量关系',   // 子考点被误当模块
  综合知识: '常识判断',   // 江苏专技岗
  专业知识: '常识判断',   // 江苏专技岗
  // 常识判断下的子考点被误当模块（2026-11 实测漏 2,991 题）
  科技常识: '常识判断',
  经济常识: '常识判断',
  人文常识: '常识判断',
  法律常识: '常识判断',
  地理国情: '常识判断',
  综合常识: '常识判断',
  常识应用: '常识判断',
  公共基础知识: '常识判断',
  公基多选题: '常识判断',
  公基单选题: '常识判断',
  公基判断题: '常识判断',
  公文写作: '常识判断',
};
const toTreeGroup = (ch) => {
  const name = String(ch || '').trim();
  if (!name) return '未分类';
  if (TREE_GROUPS.has(name)) return name;
  return GROUP_ALIAS[name] || name;
};

if (!fs.existsSync(DIR)) { console.error('没有采集数据:', DIR); process.exit(1); }

// ---------- 读源（按试卷名去重） ----------
const papers = new Map();
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.includes('.side.'))) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (!j.solutions?.length || !j.name) continue;
  if (!papers.has(j.name)) papers.set(j.name, j);
}
console.log(`源：${papers.size} 份试卷`);

// ---------- 目标库 ----------
const tiku = new DatabaseSync(path.join(ROOT, 'tiku.db'), { timeout: 10000 });
const practice = new DatabaseSync(path.join(ROOT, 'practice.db'), { timeout: 10000 });

const existingIds = new Set(tiku.prepare('SELECT DISTINCT questionId id FROM questions').all().map((r) => Number(r.id)));
// 已存在但解析缺失/过短的题 → 用粉笔解析回填
const weakAnalysis = new Map();
for (const r of tiku.prepare(`
  SELECT q.questionId id, LENGTH(TRIM(COALESCE(q.analysis,''))) n
  FROM questions q WHERE LENGTH(TRIM(COALESCE(q.analysis,''))) < 30 GROUP BY q.questionId
`).all()) weakAnalysis.set(Number(r.id), Number(r.n));
let maxPaperId = tiku.prepare('SELECT MAX(id) m FROM papers').get().m;

console.log(`目标库：现有题 ${existingIds.size}，其中解析缺失/过短 ${weakAnalysis.size}，paperId max=${maxPaperId}`);

// ---------- 规划 ----------
const plan = [];
const backfill = [];   // 已存在但缺解析 → 只更新 analysis
let dup = 0, badRow = 0;
const seqSet = new Set();

// 先学一份「考点 → 模块」映射：用带 card 树的卷（浙江卷等旧模板没有 card）
const kp2mod = new Map();
for (const j of papers.values()) {
  const modOf = new Map();
  for (const mod of j.card?.children || []) {
    for (const node of mod.children || []) if (node.key) modOf.set(node.key, mod.name);
  }
  if (!modOf.size) continue;
  for (const s of j.solutions) {
    const mod = modOf.get(s.globalId);
    const kp = s.keypoints?.[0]?.name;
    if (mod && kp && !kp2mod.has(kp)) kp2mod.set(kp, mod);
  }
}
console.log(`学到考点→模块映射 ${kp2mod.size} 条`);

for (const [name, j] of papers) {
  // globalId → 模块名
  const modOf = new Map();
  for (const mod of j.card?.children || []) {
    for (const node of mod.children || []) {
      if (node.key) modOf.set(node.key, mod.name);
    }
  }
  const rows = [];
  for (const s of j.solutions) {
    const qid = Number(s.id);
    if (!qid) { badRow += 1; continue; }
    const analysis = strip(s.solution);
    const opts = (s.accessories || []).find((a) => Array.isArray(a.options))?.options || [];
    const idx = s.correctAnswer?.choice != null ? Number(s.correctAnswer.choice) : -1;
    if (existingIds.has(qid)) {
      if (seqSet.has(qid)) { dup += 1; continue; }
      seqSet.add(qid);
      // 已存在的题：回填 HTML 字段（只在有图时保留 HTML，避免体积翻倍）
      const optHtml = opts.map((o) => normImg(o));
      const optText = opts.map((o) => strip(o));
      backfill.push({
        questionId: qid,
        contentHtml: hasImg(s.content) ? normImg(s.content) : '',
        options: JSON.stringify(optHtml.some((o) => hasImg(o)) ? optHtml : optText),
        analysisHtml: hasImg(s.solution) ? normImg(s.solution) : '',
        analysis: weakAnalysis.has(qid) && analysis.length > 30 ? analysis : '',
        answer: idx >= 0 ? String.fromCharCode(65 + idx) : '',
      });
      continue;
    }
    if (seqSet.has(qid)) { dup += 1; continue; }
    const content = strip(s.content);
    if (!content || !opts.length) { badRow += 1; continue; }
    seqSet.add(qid);
    const optHtml = opts.map((o) => normImg(o));
    const optText = opts.map((o) => strip(o));
    const rawChapter = modOf.get(s.globalId) || kp2mod.get(s.keypoints?.[0]?.name) || (s.keypoints?.[0]?.name) || '未分类';
    rows.push({
      questionId: qid,
      chapter: toTreeGroup(rawChapter),
      sub: s.keypoints?.[0]?.name || rawChapter,
      type: s.type === 1 ? 1 : (opts.length ? 1 : 26),
      content,
      contentHtml: hasImg(s.content) ? normImg(s.content) : null,
      options: optHtml.some((o) => hasImg(o)) ? optHtml : optText,  // 无图存纯文本
      optionsText: optText,              // 纯文本，用于判空和判重
      answerIndex: idx,
      // 选项是公式图时 strip() 会得到空串 → 统一存字母，前端按 answerIndex 判分
      answer: idx >= 0 ? String.fromCharCode(65 + idx) : '',
      difficulty: s.difficulty || 0,
      analysis,
      analysisHtml: normImg(s.solution),
      source: s.source || '',
    });
  }
  if (rows.length) plan.push({ name, rows, meta: j });
}

const totalQ = plan.reduce((a, p) => a + p.rows.length, 0);
console.log(`\n可导入新题：${plan.length} 份试卷 / ${totalQ} 题`);
console.log(`可回填解析（题目已存在但缺解析）：${backfill.length} 题`);
console.log(`跳过：重复 ${dup}，无效 ${badRow}`);
const byChapter = {};
for (const p of plan) for (const r of p.rows) byChapter[r.chapter] = (byChapter[r.chapter] || 0) + 1;
console.log('模块分布：', Object.entries(byChapter).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

if (!totalQ && !backfill.length) { console.log('\n没有可导入的内容。'); process.exit(0); }

if (!APPLY) {
  console.log('\n[dry-run] 未写入。确认后加 --apply。');
  if (plan[0]) {
    const s = plan[0].rows[0];
    console.log('  新题样例:', JSON.stringify({ ...s, content: s.content.slice(0, 40), analysis: s.analysis.slice(0, 40) }));
  }
  if (backfill[0]) console.log('  回填样例:', `qid=${backfill[0].questionId} analysis=${backfill[0].analysis.slice(0, 50)}…`);
  process.exit(0);
}

// ---------- 写入 ----------
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
for (const f of ['tiku.db', 'practice.db']) {
  const p = path.join(ROOT, f);
  try { new DatabaseSync(p, { timeout: 5000 }).prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
  fs.copyFileSync(p, `${p}.bak-fenbi-${stamp}`);
}
console.log(`\n备份 → *.bak-fenbi-${stamp}`);

const insPaper = tiku.prepare(`
  INSERT INTO papers (id, subject, subjectName, category, name, questionCount, time, difficulty, exerciseId, chapters, crawledAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insQ = tiku.prepare(`
  INSERT INTO questions (questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType, answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// 已存在题的字段回填（contentHtml / options / analysisHtml 之前被 strip 掉了）
const updQ = tiku.prepare(`
  UPDATE questions
  SET contentHtml = COALESCE(NULLIF(?, ''), contentHtml),
      options     = CASE WHEN ? <> '' THEN ? ELSE options END,
      analysis    = CASE WHEN LENGTH(TRIM(COALESCE(analysis,''))) < 30 THEN ? ELSE analysis END,
      analysisHtml= COALESCE(NULLIF(?, ''), analysisHtml),
      answer      = CASE WHEN TRIM(COALESCE(answer,'')) = '' THEN ? ELSE answer END
  WHERE questionId = ?
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
    const pid = ++maxPaperId;
    const j = p.meta;
    insPaper.run(pid, SUBJECT, SUBJECT, '事业单位', p.name, p.rows.length, (j.solutions?.length || 0) > 0 ? 5400 : 0, 0, null, '[]', now);
    nP += 1;
    for (const r of p.rows) {
      insQ.run(r.questionId, pid, r.chapter, r.type, null, r.content, r.contentHtml || null, null,
        JSON.stringify(r.options), null, r.answer, r.answerIndex, r.difficulty, 'fenbi',
        r.analysis, r.analysisHtml || null, 0);
      insCat.run(r.questionId, SUBJECT, r.chapter, r.sub, now);
      nQ += 1;
    }
  }
  tiku.exec('COMMIT');
  practice.exec('COMMIT');
} catch (e) {
  tiku.exec('ROLLBACK'); practice.exec('ROLLBACK');
  console.error('写入失败已回滚：', e.message); process.exit(1);
}
// 回填（HTML 字段 + 缺失解析）
let nBack = 0;
if (backfill.length) {
  tiku.exec('BEGIN');
  try {
    for (const b of backfill) {
      nBack += updQ.run(
        b.contentHtml, b.options, b.options, b.analysis, b.analysisHtml, b.answer, b.questionId
      ).changes;
    }
    tiku.exec('COMMIT');
  } catch (e) { tiku.exec('ROLLBACK'); console.error('回填失败：', e.message); }
}
try { tiku.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}

console.log(`\n✓ 写入 ${nP} 份试卷 / ${nQ} 题，回填解析 ${nBack} 题`);
const after = tiku.prepare(`SELECT COUNT(DISTINCT q.questionId) c FROM questions q JOIN papers p ON p.id=q.paperId WHERE p.subjectName=?`).get(SUBJECT).c;
console.log(`  ${SUBJECT} 现有 ${after} 题`);
tiku.close(); practice.close();
