#!/usr/bin/env node
/**
 * import-gongkao-tiku.mjs — 把 zzcc-nb/gongkao-tiku 的申论/综应题清洗后并入现有题库
 *
 * 用法：
 *   node tools/import-gongkao-tiku.mjs                         # dry-run，只输出报告
 *   node tools/import-gongkao-tiku.mjs --apply                 # 写入 tiku.db / practice.db
 *   node tools/import-gongkao-tiku.mjs --src D:/dev/gk-tiku    # 指定外部仓库目录
 *
 * 规则：
 *   - 跳过综应 B/C/D 类题型（材料作文/论证评价/校阅改错/概念分析/材料分析/短文加工/科技实务/科技文献）
 *   - 兼容汉字归一（27 个）
 *   - 同一内容（题干+材料）只保留 1 个 questionId，多套卷保留多条 paper 关联
 *   - 材料按内容哈希归组，写入 q_materials/q_material_map
 *   - 题型映射到现有申论/综应树
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = process.argv.includes('--src')
  ? process.argv[process.argv.indexOf('--src') + 1]
  : 'D:/dev/gk-tiku';
const APPLY = process.argv.includes('--apply');

const COMPAT = {
  '⺠': '民', '⻋': '车', '⻓': '长', '⻔': '门', '⻛': '风', '⻘': '青', '⻝': '食', '⻅': '见',
  '⻆': '角', '⻄': '西', '⻩': '黄', '⻢': '马', '⻰': '龙', '⻬': '齐', '⻜': '飞', '⻥': '鱼',
  '⻣': '骨', '⻨': '麦', '⻉': '贝', '⻤': '鬼', '⻙': '韦', '⺎': '兀', '⻁': '虎', '⻮': '齿',
  '⻚': '页', '⻦': '鸟', '⻧': '卤',
};

function cleanText(s) {
  let t = String(s || '');
  t = t.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF\u31C0-\u31EF]/g, (c) => COMPAT[c] || c);
  t = t.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
/** 外部 Markdown 是硬换行（约 40 字一行），需要还原成自然段，否则会碎成一行一段 */
function textToParagraphs(text) {
  const lines = cleanText(text).split('\n');
  const paras = [];
  let cur = '';
  const flush = () => { if (cur.trim()) paras.push(cur.trim()); cur = ''; };
  for (const line of lines) {
    const l = line.trim();
    if (!l) { flush(); continue; }
    const isHeading = /^(材料|给定资料)\s*\d+/.test(l)
      || /^第[一二三四五六七八九十百0-9]{1,3}题/.test(l)
      || /^(要求|作答要求)[：:]/.test(l)
      || /^【[^】]+】/.test(l);
    if (isHeading) { flush(); cur = l; continue; }
    if (!cur) { cur = l; continue; }
    // 中文硬换行直接拼接；英文/数字之间补一个空格
    if (/[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(l)) cur += ' ' + l;
    else cur += l;
  }
  flush();
  return paras;
}
function toHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return textToParagraphs(text).map((p) => `<p>${esc(p)}</p>`).join('');
}
function field(s, key) {
  const m = s.match(new RegExp(key + '\\*\\*[：:][ \\t]*([^\\n]*)'));
  return m ? m[1].trim() : '';
}
function section(s, heading) {
  const i = s.indexOf(heading);
  if (i < 0) return '';
  const rest = s.slice(i + heading.length);
  const n = rest.search(/\n## /);
  return (n < 0 ? rest : rest.slice(0, n)).trim();
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
function stripAnswerBleed(ans) {
  const m = ans.match(/\n\s*第[一二三四五六七八九十百0-9]{1,3}题/);
  if (m && m.index > 200) return ans.slice(0, m.index).trim();
  return ans;
}

const PROVINCES = ['北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '内蒙古', '广西', '西藏', '宁夏', '新疆'];
function provinceOf(s) {
  for (const p of PROVINCES) if (String(s).includes(p)) return p;
  return '';
}

// 申论题型 → 树
function mapShenlun(type) {
  const t = String(type);
  if (/文章写作/.test(t)) return { group: '文章写作题', sub: '全部' };
  if (/公文写作/.test(t)) {
    if (/总结/.test(t)) return { group: '贯彻执行题', sub: '总结汇报类' };
    if (/宣传/.test(t)) return { group: '贯彻执行题', sub: '宣传倡议类' };
    if (/方案/.test(t)) return { group: '贯彻执行题', sub: '方案提纲类' };
    if (/评论/.test(t)) return { group: '贯彻执行题', sub: '简报短评类' };
    if (/发言/.test(t)) return { group: '贯彻执行题', sub: '讲话发言类' };
    return { group: '贯彻执行题', sub: '总结汇报类' };
  }
  if (/对策/.test(t)) return { group: '提出对策题', sub: '单一对策类' };
  if (/概括措施|经验启示/.test(t)) return { group: '归纳概括题', sub: '概括做法经验类' };
  if (/问题/.test(t)) return { group: '归纳概括题', sub: '概括问题类' };
  if (/原因/.test(t)) return { group: '归纳概括题', sub: '概括原因类' };
  if (/变化|特点/.test(t)) return { group: '归纳概括题', sub: '概括变化特点类' };
  if (/语句解释|词句解释|填空/.test(t)) return { group: '综合分析题', sub: '词句理解类' };
  if (/观点|现象/.test(t)) return { group: '综合分析题', sub: '观点评析类' };
  if (/对比/.test(t)) return { group: '综合分析题', sub: '关系分析类' };
  return { group: '归纳概括题', sub: '综合概括类' };
}
// 综应只保留 A 类可映射题型；返回 null 表示跳过（B/C/D）
function mapZongying(type) {
  const t = String(type);
  if (/公文写作/.test(t)) return { group: 'A类·综合管理', sub: '应用文写作题' };
  if (/案例分析/.test(t)) return { group: 'A类·综合管理', sub: '案例分析题' };
  if (/应急处理/.test(t)) return { group: 'A类·综合管理', sub: '应急处理题' };
  return null;
}
function paperMeta(source, subjectName, type) {
  const s = source || '';
  let category = '外部补充';
  if (/模考|联考大赛/.test(s)) category = '模考';
  else if (/国考/.test(s)) category = '国考';
  else if (/事业单位|事业编|综应/.test(s)) category = provinceOf(s) || '事业单位';
  else if (provinceOf(s)) category = provinceOf(s);
  else if (!s) category = '外部补充';
  // 未标注来源：按题型归入补充题库
  let name = s || `${subjectName.replace('·', '')}补充题库·${String(type).split(' · ')[0] || '未分类'}`;
  // App 侧按试卷名前四位筛“近十年”；无年份/日期的来源补上收录年份，避免新题被过滤掉
  if (!/^(19|20)\d{2}/.test(name)) name = `${new Date().getFullYear()} ${name}`;
  return { category, name };
}

// ---------- 读取现有库 ----------
const TIKU = path.join(ROOT, 'tiku.db');
const PRACTICE = path.join(ROOT, 'practice.db');
const tiku = new DatabaseSync(TIKU, { readOnly: !APPLY });
const practice = new DatabaseSync(PRACTICE, { readOnly: !APPLY });
const existingIds = new Set(tiku.prepare('SELECT DISTINCT questionId q FROM questions').all().map((r) => Number(r.q)));

const SOURCE_KEY = 'zzcc-nb/gongkao-tiku';
if (APPLY) {
  tiku.exec(`CREATE TABLE IF NOT EXISTS import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    questions INTEGER,
    papers INTEGER,
    note TEXT
  )`);
  const done = tiku.prepare('SELECT * FROM import_runs WHERE source = ? LIMIT 1').get(SOURCE_KEY);
  if (done && !process.argv.includes('--force')) {
    console.error(`该数据源已于 ${done.imported_at} 导入过（${done.questions} 题 / ${done.papers} 套）。`);
    console.error('如需强制重跑：先恢复数据库备份，再加 --force。');
    process.exit(1);
  }
}

// ---------- 解析外部文件 ----------
const files = [...walk(path.join(SRC, '申论题库')), ...walk(path.join(SRC, '综应题库'))];
const rows = [];
const skipped = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const qid = Number((s.match(/编号\*\*[：:]\s*(\d+)/) || [])[1]);
  if (!qid || existingIds.has(qid)) continue;
  const isShenlun = f.includes('申论题库');
  const subjectName = isShenlun ? '公务员·申论' : '事业编·综应';
  const rawType = field(s, '类型');
  const map = isShenlun ? mapShenlun(rawType) : mapZongying(rawType);
  if (!map) { skipped.push({ qid, type: rawType, file: path.basename(f) }); continue; }
  const source = cleanText(field(s, '来源'));
  const content = cleanText(section(s, '## 📌 题目'));
  const material = cleanText(section(s, '## 📖 给定材料'));
  let analysis = cleanText(section(s, '## ✅ 参考答案'));
  analysis = stripAnswerBleed(analysis);
  if (!content) { skipped.push({ qid, type: rawType, file: path.basename(f), reason: 'empty-content' }); continue; }
  rows.push({
    qid, isShenlun, subjectName, subject: isShenlun ? 'shenlun' : 'sydw',
    rawType, typeGroup: map.group, typeSub: map.sub,
    source, content, material, analysis, file: path.basename(f),
    contentHash: createHash('sha1').update((content + '\u0000' + material).replace(/\s+/g, '')).digest('hex'),
  });
}

// ---------- 去重：同内容取最小 qid ----------
const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.contentHash)) groups.set(r.contentHash, []);
  groups.get(r.contentHash).push(r);
}
const canonical = new Map(); // qid -> canonical qid
for (const list of groups.values()) {
  const min = Math.min(...list.map((x) => x.qid));
  for (const x of list) canonical.set(x.qid, min);
}
// 用组内最小 qid 作为规范 id，保证 categories/materials 与 questions 行使用同一个 id
const unique = [...groups.values()].map((list) => {
  const min = Math.min(...list.map((x) => x.qid));
  return { ...list[0], qid: min };
});

// ---------- 分配 paper / material ----------
let nextPaperId = Number(tiku.prepare('SELECT MAX(id) m FROM papers').get().m) + 1;
let nextMaterialId = Number(practice.prepare('SELECT MAX(material_id) m FROM q_materials').get().m) + 1;
const paperMap = new Map(); // key -> {id,name,category,subject,subjectName,count}
const materialMap = new Map(); // hash -> id
const materialIdOf = (r) => {
  if (!r.material) return null;
  const h = createHash('sha1').update(r.material.replace(/\s+/g, '')).digest('hex');
  // q_materials 唯一键是 (material_id, subject)，不同科目同文材料要分开编号
  const key = `${r.subjectName}|${h}`;
  if (!materialMap.has(key)) materialMap.set(key, nextMaterialId++);
  return materialMap.get(key);
};

// 每一条文件记录都挂到自己来源对应的 paper（同题多卷会保留多条 paper 关联）
for (const r of rows) {
  const meta = paperMeta(r.source, r.subjectName, r.rawType);
  const key = `${r.subjectName}|${meta.name}`;
  if (!paperMap.has(key)) {
    paperMap.set(key, { id: nextPaperId++, name: meta.name, category: meta.category, subject: r.subject, subjectName: r.subjectName, count: 0 });
  }
  const p = paperMap.get(key);
  r.paperId = p.id;
  p.count++;
}
// 材料只给唯一题分配（重复题的题干/材料完全一致）
for (const u of unique) u.materialId = materialIdOf(u);

// 同一套卷内同题只保留一条（questions 表有 UNIQUE(paperId, questionId)）
const insertRows = [];
const seenLink = new Set();
for (const r of rows) {
  const cqid = canonical.get(r.qid);
  const k = `${r.paperId}|${cqid}`;
  if (seenLink.has(k)) continue;
  seenLink.add(k);
  insertRows.push({ ...r, cqid });
}
for (const p of paperMap.values()) p.count = 0;
for (const r of insertRows) paperMap.get(`${r.subjectName}|${paperMeta(r.source, r.subjectName, r.rawType).name}`).count++;

const report = {
  mode: APPLY ? 'apply' : 'dry-run',
  files: files.length,
  candidateRows: rows.length,
  uniqueQuestions: unique.length,
  rowsInserted: insertRows.length,
  skippedRows: skipped.length,
  skippedByType: skipped.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {}),
  bySubject: rows.reduce((m, r) => { m[r.subjectName] = (m[r.subjectName] || 0) + 1; return m; }, {}),
  byTree: rows.reduce((m, r) => { const k = r.subjectName + '|' + r.typeGroup + '|' + r.typeSub; m[k] = (m[k] || 0) + 1; return m; }, {}),
  papers: paperMap.size,
  materials: materialMap.size,
  duplicateGroups: [...groups.values()].filter((x) => x.length > 1).length,
  duplicateRows: [...groups.values()].reduce((a, x) => a + x.length - 1, 0),
};

if (!APPLY) {
  console.log(JSON.stringify(report, null, 1));
  console.log('\n样例：');
  for (const r of unique.slice(0, 5)) {
    console.log('-', r.qid, r.subjectName, '|', r.typeGroup, '/', r.typeSub, '|', paperMap.get(`${r.subjectName}|${paperMeta(r.source, r.subjectName, r.rawType).name}`).name);
  }
  process.exit(0);
}

// ---------- 写入 ----------
const insPaper = tiku.prepare('INSERT INTO papers (id,subject,subjectName,category,name,questionCount,time,difficulty,exerciseId,chapters,crawledAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insQ = tiku.prepare(`INSERT INTO questions
  (questionId,paperId,chapter,type,questionType,content,contentHtml,material,options,optionType,answer,answerIndex,difficulty,source,analysis,analysisHtml,hasVideo)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insCat = practice.prepare('INSERT OR REPLACE INTO question_categories (question_id,subject,category,sub) VALUES (?,?,?,?)');
const insMat = practice.prepare('INSERT INTO q_materials (material_id,subject,content) VALUES (?,?,?)');
const insMap = practice.prepare('INSERT OR REPLACE INTO q_material_map (question_id,subject,material_id) VALUES (?,?,?)');

tiku.exec('BEGIN');
practice.exec('BEGIN');
try {
  for (const p of paperMap.values()) {
    insPaper.run(p.id, p.subject, p.subjectName, p.category, p.name, p.count, null, null, null, null, new Date().toISOString());
  }
  for (const r of insertRows) {
    insQ.run(r.cqid, r.paperId, r.typeGroup, 26, null, r.content, toHtml(r.content), '', '[]', null, null, -1, null, r.source || null, r.analysis, toHtml(r.analysis), 0);
  }
  const insertedMaterials = new Set();
  for (const u of unique) {
    insCat.run(u.qid, u.subjectName, u.typeGroup, u.typeSub);
    if (u.materialId) {
      const mk = `${u.materialId}|${u.subjectName}`;
      if (!insertedMaterials.has(mk)) {
        insertedMaterials.add(mk);
        insMat.run(u.materialId, u.subjectName, toHtml(u.material));
      }
      insMap.run(u.qid, u.subjectName, u.materialId);
    }
  }
  if (APPLY) {
    tiku.prepare(`INSERT INTO import_runs (source, imported_at, questions, papers, note)
      VALUES (?, datetime('now','localtime'), ?, ?, ?)`)
      .run(SOURCE_KEY, report.uniqueQuestions, report.papers, 'v1.41');
  }
  tiku.exec('COMMIT');
  practice.exec('COMMIT');
  console.log(JSON.stringify(report, null, 1));
  console.log('写入完成');
} catch (e) {
  tiku.exec('ROLLBACK');
  practice.exec('ROLLBACK');
  console.error('写入失败，已回滚：', e);
  process.exit(1);
}
