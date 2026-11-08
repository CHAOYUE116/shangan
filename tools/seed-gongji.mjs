#!/usr/bin/env node
/**
 * seed-gongji.mjs — 建立「事业编·公基」种子题库（800 题）
 *
 * 公开渠道没有可靠的大规模公基题库，这里从现有行测「政治理论 + 常识判断」
 * 中精选官方题（题干/选项/答案/解析齐全），复制为新科目「事业编·公基」，
 * 并在试卷名中明确标注「源自行测真题」。
 *
 * 用法：node tools/seed-gongji.mjs [--force]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tiku = new DatabaseSync(path.join(ROOT, 'tiku.db'));
const practice = new DatabaseSync(path.join(ROOT, 'practice.db'));
practice.exec(`ATTACH DATABASE '${path.join(ROOT, 'tiku.db').replace(/\\/g, '/')}' AS tiku`);
const FORCE = process.argv.includes('--force');
const SOURCE_KEY = 'gongji-seed-800';

tiku.exec(`CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  questions INTEGER,
  papers INTEGER,
  note TEXT
)`);
const done = tiku.prepare('SELECT * FROM import_runs WHERE source = ? LIMIT 1').get(SOURCE_KEY);
if (done && !FORCE) {
  console.error(`公基种子已于 ${done.imported_at} 导入过（${done.questions} 题）。`);
  process.exit(1);
}

const GROUPS = [
  {
    group: '政治理论', sub: '全部', category: '政治理论',
    paper: '2026 事业编公基·政治理论精选（源自行测真题）',
    sources: [['政治理论', '新思想', 80], ['政治理论', '时事政治', 50], ['政治理论', '马克思主义', 30], ['政治理论', '毛中特', 20]],
  },
  {
    group: '法律基础', sub: '全部', category: '法律基础',
    paper: '2026 事业编公基·法律基础精选（源自行测真题）',
    sources: [['常识判断', '法律常识', 160]],
  },
  {
    group: '经济管理', sub: '全部', category: '经济管理',
    paper: '2026 事业编公基·经济管理精选（源自行测真题）',
    sources: [['常识判断', '经济常识', 70]],
  },
  {
    group: '科技人文', sub: '科技常识', category: '科技人文',
    paper: '2026 事业编公基·科技常识精选（源自行测真题）',
    sources: [['常识判断', '科技常识', 150]],
  },
  {
    group: '科技人文', sub: '人文历史', category: '科技人文',
    paper: '2026 事业编公基·人文历史精选（源自行测真题）',
    sources: [['常识判断', '人文常识', 160]],
  },
  {
    group: '科技人文', sub: '地理国情', category: '科技人文',
    paper: '2026 事业编公基·地理国情精选（源自行测真题）',
    sources: [['常识判断', '地理国情', 80]],
  },
];

const pickStmt = practice.prepare(`
  SELECT DISTINCT qc.question_id
  FROM question_categories qc
  JOIN tiku.questions q ON q.questionId = qc.question_id
  JOIN tiku.papers p ON p.id = q.paperId
  WHERE qc.subject = '公务员·行测' AND qc.category = ? AND qc.sub = ?
    AND q.answer IS NOT NULL AND q.answer != '' AND q.options NOT IN ('[]', '')
  ORDER BY qc.question_id
  LIMIT ?`);
const srcQ = tiku.prepare(`
  SELECT q.* FROM questions q
  JOIN papers p ON p.id = q.paperId
  WHERE q.questionId = ? AND p.subjectName = '公务员·行测'
  ORDER BY q.id LIMIT 1`);
const srcMat = practice.prepare(`
  SELECT m.material_id, m.content FROM q_materials m
  WHERE m.material_id = (
    SELECT material_id FROM q_material_map WHERE question_id = ? AND subject = '公务员·行测' LIMIT 1
  ) AND m.subject = '公务员·行测' LIMIT 1`);

const used = new Set();
const selected = [];
for (const g of GROUPS) {
  const list = [];
  for (const [cat, sub, quota] of g.sources) {
    for (const r of pickStmt.all(cat, sub, quota)) {
      const qid = Number(r.question_id);
      if (used.has(qid)) continue;
      const q = srcQ.get(qid);
      if (!q) continue;
      used.add(qid);
      list.push(q);
    }
  }
  selected.push({ ...g, questions: list });
}

const total = selected.reduce((a, g) => a + g.questions.length, 0);
if (!total) {
  console.error('没有可用的源题');
  process.exit(1);
}

let nextPaperId = Number(tiku.prepare('SELECT MAX(id) m FROM papers').get().m) + 1;
const nextQid = (srcId) => 900000000 + Number(srcId);
let nextMaterialId = Number(practice.prepare('SELECT MAX(material_id) m FROM q_materials').get().m) + 1;
const materialMap = new Map();

const insPaper = tiku.prepare('INSERT INTO papers (id,subject,subjectName,category,name,questionCount,time,difficulty,exerciseId,chapters,crawledAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insQ = tiku.prepare(`INSERT INTO questions
  (questionId,paperId,chapter,type,questionType,content,contentHtml,material,options,optionType,answer,answerIndex,difficulty,source,analysis,analysisHtml,hasVideo)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insCat = practice.prepare('INSERT OR REPLACE INTO question_categories (question_id,subject,category,sub) VALUES (?,?,?,?)');
const insMat = practice.prepare('INSERT INTO q_materials (material_id,subject,content) VALUES (?,?,?)');
const insMap = practice.prepare('INSERT OR REPLACE INTO q_material_map (question_id,subject,material_id) VALUES (?,?,?)');

const report = [];
tiku.exec('BEGIN');
practice.exec('BEGIN');
try {
  for (const g of selected) {
    if (!g.questions.length) continue;
    const pid = nextPaperId++;
    insPaper.run(pid, 'gongji', '事业编·公基', '公基', g.paper, g.questions.length, null, null, null, null, new Date().toISOString());
    let inserted = 0;
    for (const q of g.questions) {
      const nqid = nextQid(q.questionId);
      if (tiku.prepare('SELECT 1 FROM questions WHERE questionId = ? LIMIT 1').get(nqid)) continue;
      insQ.run(nqid, pid, g.group, q.type ?? 1, q.questionType, q.content, q.contentHtml, '', q.options || '[]', q.optionType, q.answer, q.answerIndex, q.difficulty, g.paper, q.analysis || '', q.analysisHtml || '', 0);
      insCat.run(nqid, '事业编·公基', g.category, g.sub);
      const mat = srcMat.get(q.questionId);
      if (mat && mat.content) {
        const h = createHash('sha1').update(String(mat.content)).digest('hex');
        if (!materialMap.has(h)) materialMap.set(h, nextMaterialId++);
        const mid = materialMap.get(h);
        if (!practice.prepare('SELECT 1 FROM q_materials WHERE material_id = ? AND subject = ? LIMIT 1').get(mid, '事业编·公基')) {
          insMat.run(mid, '事业编·公基', mat.content);
        }
        insMap.run(nqid, '事业编·公基', mid);
      }
      inserted++;
    }
    report.push({ group: g.group, sub: g.sub, paper: g.paper, count: inserted });
  }
  const totalInserted = report.reduce((a, x) => a + x.count, 0);
  tiku.prepare(`INSERT INTO import_runs (source, imported_at, questions, papers, note)
    VALUES (?, datetime('now','localtime'), ?, ?, ?)`)
    .run(SOURCE_KEY, totalInserted, report.length, 'gongji-seed');
  tiku.exec('COMMIT');
  practice.exec('COMMIT');
  console.log(JSON.stringify({ totalInserted, papers: report.length, materials: materialMap.size, report }, null, 1));
  console.log('公基种子写入完成');
} catch (e) {
  tiku.exec('ROLLBACK');
  practice.exec('ROLLBACK');
  console.error('写入失败，已回滚：', e);
  process.exit(1);
}
