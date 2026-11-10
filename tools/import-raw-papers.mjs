#!/usr/bin/env node
/**
 * tools/import-raw-papers.mjs — 把 fenbi-raw 整卷采集（tools/fenbi-fetch-all.mjs 的产物）导入 tiku.db
 *
 * 与 import-fenbi-papers.mjs 的区别：
 *   - 那个读的是「交卷后拿到的解析包」（fenbi-solutions，含 analysis）；
 *   - 这个读的是「整卷正文」（fenbi-raw，含题干/选项/答案，**不含解析**）。
 *
 * 字段映射：
 *   paper.name            → papers.name
 *   paper.chapters[]      → papers.chapters（JSON）＋ 按 questionCount 顺序切分每题的 chapter
 *   q.content             → questions.content（去标签）/ contentHtml（有图时保留）
 *   q.options             → questions.options（JSON 数组）
 *   q.answerLetter/Index  → questions.answer / answerIndex
 *   chapter 经 GROUP_ALIAS 归一 → question_categories.category（树内模块），原值进 sub
 *
 * 用法：
 *   node tools/import-raw-papers.mjs --course syzc,sydw,zhyynl --dry
 *   node tools/import-raw-papers.mjs --course syzc,sydw,zhyynl --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const COURSES = String(arg('course', 'syzc,sydw,zhyynl')).split(',').map((s) => s.trim()).filter(Boolean);

const SUBJECT_OF = {
  syzc: '事业编·职测',
  sydw: '事业编·公基',
  zhyynl: '事业编·综应',
  xingce: '公务员·行测',
  shenlun: '公务员·申论',
};

const strip = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const normImg = (h) => String(h || '').replace(/src="\/\//g, 'src="https://').replace(/src='\/\//g, "src='https://").trim();
const hasImg = (h) => /<img\b/i.test(String(h || ''));

/** 与 import-fenbi-papers.mjs 保持一致的模块归一 */
const TREE_GROUPS = new Set(['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析']);
const GROUP_ALIAS = {
  规则解读: '判断推理', 计划编排: '判断推理',
  策略选择: '判断推理', 综合分析: '资料分析',
  数量分析: '数量关系', 数学运算: '数量关系',
  综合知识: '常识判断', 专业知识: '常识判断',
  科技常识: '常识判断', 经济常识: '常识判断', 人文常识: '常识判断',
  法律常识: '常识判断', 地理国情: '常识判断', 综合常识: '常识判断',
  常识应用: '常识判断', 公共基础知识: '常识判断',
  公基多选题: '常识判断', 公基单选题: '常识判断', 公基判断题: '常识判断',
  公文写作: '常识判断',
  // 综应 / 申论类模块：进「常识判断」会让模块树失真，这几类保留原样
};
const SUBJECT_GROUPS = {
  '事业编·综应': new Set(['A类·综合管理', 'B类·社会科学专技', 'C类·自然科学专技', 'D类·中小学教师', 'E类·医疗卫生']),
};
const toTreeGroup = (ch, subject) => {
  const name = String(ch || '').trim();
  if (!name) return '未分类';
  const extra = SUBJECT_GROUPS[subject];
  if (extra && extra.has(name)) return name;
  if (TREE_GROUPS.has(name)) return name;
  return GROUP_ALIAS[name] || name;
};

const tiku = new DatabaseSync(path.join(ROOT, 'tiku.db'), { timeout: 20000 });
const practice = new DatabaseSync(path.join(ROOT, 'practice.db'), { timeout: 20000 });

console.log(`${APPLY ? '【写入】' : '【演练】'} 课程 ${COURSES.join(',')}`);

const insPaper = tiku.prepare(`INSERT OR IGNORE INTO papers
  (id, subject, subjectName, category, name, questionCount, time, difficulty, exerciseId, chapters, crawledAt)
  VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`);
const insQ = tiku.prepare(`INSERT OR IGNORE INTO questions
  (questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType,
   answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
const insQc = practice.prepare(`INSERT OR REPLACE INTO question_categories (question_id, subject, category, sub)
  VALUES (?,?,?,?)`);

const existPaper = tiku.prepare('SELECT 1 FROM papers WHERE id=?');
const existQ = tiku.prepare('SELECT 1 FROM questions WHERE paperId=? AND questionId=?');

const stat = { course: {}, paperNew: 0, paperSkip: 0, qNew: 0, qSkip: 0, qBad: 0, qcNew: 0 };

for (const course of COURSES) {
  const subject = SUBJECT_OF[course];
  const dir = path.resolve(ROOT, '..', 'research', 'fenbi-raw', course, 'papers');
  if (!fs.existsSync(dir)) { console.log(`跳过 ${course}：没有 ${dir}`); continue; }
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
  stat.course[course] = { files: files.length, paperNew: 0, qNew: 0 };

  if (APPLY) tiku.exec('BEGIN');
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!j.paperId || !j.name || !Array.isArray(j.questions) || !j.questions.length) continue;

    // 卷内章节：按 chapters[].questionCount 顺序切
    const chs = Array.isArray(j.chapters) ? j.chapters : [];
    const chNames = [];
    for (const c of chs) {
      const n = Number(c.questionCount || 0);
      for (let i = 0; i < n; i++) chNames.push(c.name);
    }

    const isNewPaper = !existPaper.get(j.paperId);
    if (isNewPaper) {
      if (APPLY) {
        insPaper.run(
          j.paperId, subject, subject, String(j.cat || '').trim() || '未分类', String(j.name).trim(),
          Number(j.questionCount || j.questions.length), Number(j.time || 0), 0, null,
          JSON.stringify(chs.map((c) => ({ name: c.name, desc: c.desc, questionCount: c.questionCount, presetScore: c.presetScore }))),
        );
      }
      stat.paperNew++; stat.course[course].paperNew++;
    } else {
      stat.paperSkip++;
    }

    for (let i = 0; i < j.questions.length; i++) {
      const q = j.questions[i];
      const qid = Number(q.questionId);
      if (!qid) { stat.qBad++; continue; }
      const content = strip(q.content);
      if (!content) { stat.qBad++; continue; }
      const opts = (q.options || []).map((o) => strip(o));
      const chapter = chNames[i] || (chs[0] && chs[0].name) || '未分类';
      if (existQ.get(j.paperId, qid)) { stat.qSkip++; continue; }
      if (APPLY) {
        insQ.run(
          qid, j.paperId, chapter, Number(q.type || 1), null,
          content, hasImg(q.content) ? normImg(q.content) : '',
          q.material ? (hasImg(q.material) ? normImg(q.material) : strip(q.material)) : null,
          JSON.stringify(opts), 1,
          q.answerLetter ? String(q.answerLetter) : (q.answer ? String(q.answer) : ''),
          Number.isFinite(q.answerIndex) ? Number(q.answerIndex) : -1,
          Number(q.difficulty || 0), 'fenbi', '', '',
        );
        insQc.run(qid, subject, toTreeGroup(chapter, subject), chapter);
      }
      stat.qNew++; stat.course[course].qNew++; stat.qcNew++;
    }
  }
  if (APPLY) tiku.exec('COMMIT');
  console.log(`  ${course} (${subject}) 文件 ${stat.course[course].files} → 新卷 ${stat.course[course].paperNew} / 新题 ${stat.course[course].qNew}`);
}

console.log(`\n合计：新卷 ${stat.paperNew}（已存在 ${stat.paperSkip}）· 新题 ${stat.qNew}（已存在 ${stat.qSkip}、无效 ${stat.qBad}）· 分类索引 ${stat.qcNew}`);
if (!APPLY) console.log('这是演练，加 --apply 才写库');
else {
  const q = tiku.prepare('SELECT COUNT(1) c FROM questions').get().c;
  const p = tiku.prepare('SELECT COUNT(1) c FROM papers').get().c;
  console.log(`库内现在：questions ${q} 行 / papers ${p} 卷`);
}
tiku.close(); practice.close();
