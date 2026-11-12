#!/usr/bin/env node
/**
 * 分科目体检：公务员·行测/申论、事业编·职测/公基/综应
 * 只看「能不能做题」的四件事：题干图、材料、解析、答案；顺带统计坏题与难度覆盖。
 *
 *   node tools/audit-subjects.mjs           # 打印 + 写 report/audit-<day>.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB = path.join(ROOT, 'app-assets', 'tiku_app.db');
const IMGDB = path.join(ROOT, 'app-assets', 'images.db');
const DAY = new Date().toISOString().slice(0, 10);

const db = new DatabaseSync(DB, { readOnly: true });
const img = fs.existsSync(IMGDB) ? new DatabaseSync(IMGDB, { readOnly: true }) : null;

const SUBJECTS = [
  ['公务员·行测', 'xingce', '公务员'],
  ['公务员·申论', 'shenlun', '公务员'],
  ['事业编·职测', 'syzc', '事业编'],
  ['事业编·公基', 'gongji', '事业编'],
  ['事业编·综应', 'zongying', '事业编'],
];

const rows = db.prepare(`
  SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.material,
         q.options, q.answer, q.answerIndex, q.analysis, q.analysisHtml,
         q.difficulty_est, q.diff_band, q.q_bad, q.q_bad_reason, p.subjectName
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
`).all();

const keysUsed = new Set();
const keyRe = /latex=([A-Za-z0-9_-]+)/g;
for (const r of rows) {
  for (const f of [r.contentHtml, r.analysisHtml, r.material]) {
    if (!f) continue;
    let m;
    while ((m = keyRe.exec(f))) keysUsed.add(m[1]);
  }
}
let haveKeys = new Set();
if (img) {
  const all = img.prepare('SELECT key FROM images').all();
  haveKeys = new Set(all.map((x) => x.key));
}
const missingKeys = [...keysUsed].filter((k) => !haveKeys.has(k));

const IMG_MARK = /\[图\]|（图）|\(图\)|如图|下图|上图|图中|折线图|柱状图|饼图|表格|下表|上表/;
const ASK_MAT = /^(根据|阅读|结合)(以下|如下)?(材料|资料|上文|下表|上表|图表)/;
const isObj = (t) => [1, 2, 3, 5].includes(Number(t));
const hasImg = (h) => /<img\b/i.test(String(h || ''));
const txtLen = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;

const out = [];
for (const [name, key, group] of SUBJECTS) {
  const rs = rows.filter((r) => r.subjectName === name);
  const obj = rs.filter((r) => isObj(r.type));
  const withAns = obj.filter((r) => String(r.answer || '').trim() !== '' || Number(r.answerIndex) >= 0);
  const withAna = rs.filter((r) => txtLen(r.analysis) >= 20);
  const anaImg = rs.filter((r) => hasImg(r.analysisHtml));
  const needImg = rs.filter((r) => IMG_MARK.test(String(r.content || '')));
  const needImgOk = needImg.filter((r) => hasImg(r.contentHtml));
  const askMat = rs.filter((r) => ASK_MAT.test(String(r.content || '')));
  const askMatMissing = askMat.filter((r) => txtLen(r.material) < 20 && !hasImg(r.material));
  const matWithImg = rs.filter((r) => hasImg(r.material));
  const bad = rs.filter((r) => Number(r.q_bad) === 1);
  const badBy = {};
  for (const b of bad) {
    const k = String(b.q_bad_reason || '').replace(/[：:].*$/, '');
    badBy[k] = (badBy[k] || 0) + 1;
  }
  const optEmpty = rs.filter((r) => {
    let a = [];
    try { a = JSON.parse(r.options || '[]'); } catch { a = []; }
    return !a.length || a.length < 2;
  });
  const bands = { easy: 0, mid: 0, hard: 0, none: 0 };
  for (const r of rs) {
    if (!r.diff_band) bands.none += 1;
    else if (bands[r.diff_band] != null) bands[r.diff_band] += 1;
  }
  const keyOk = rs.filter((r) => {
    const s = String(r.contentHtml || '') + String(r.analysisHtml || '');
    let m; let ok = true; let any = false;
    while ((m = keyRe.exec(s))) { any = true; if (!haveKeys.has(m[1])) ok = false; }
    return any && !ok;
  });

  out.push({
    name, group, total: rs.length, obj: obj.length,
    有答案: withAns.length, 缺答案: obj.length - withAns.length,
    有解析: withAna.length, 缺解析: rs.length - withAna.length,
    解析带图: anaImg.length,
    题干需图: needImg.length, 图文齐: needImgOk.length,
    需材料: askMat.length, 缺材料: askMatMissing.length, 材料带图: matWithImg.length,
    选项不足: optEmpty.length,
    坏题: bad.length, 坏题原因: badBy,
    图片键缺: keyOk.length,
    难度: bands,
  });
}

/* ------- 控制台 ------- */
const p = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
console.log(`题库体检 ${DAY} · 唯一题 ${rows.length} · images.db ${haveKeys.size} 张 · 引用 ${keysUsed.size} 个键 · 缺 ${missingKeys.length}\n`);
const head = ['科目', '题数', '客观题', '有答案', '缺答案', '有解析', '缺解析', '解析带图', '需图', '图文齐', '需材料', '缺材料', '坏题'];
console.log(head.join('\t'));
for (const r of out) {
  console.log([r.name, r.total, r.obj, r.有答案, r.缺答案, r.有解析, r.缺解析, r.解析带图, r.题干需图, r.图文齐, r.需材料, r.缺材料, r.坏题].join('\t'));
}
console.log('\n图文匹配率 / 解析覆盖率 / 答案覆盖率');
for (const r of out) {
  console.log(`${r.name}: 图 ${p(r.图文齐, r.题干需图)}% · 解析 ${p(r.有解析, r.total)}% · 答案 ${p(r.有答案, r.obj)}% · 坏题 ${p(r.坏题, r.total)}%`);
}

/* ------- Markdown ------- */
const md = [];
md.push(`# 题库体检报告（分科目）· ${DAY}\n`);
md.push(`口径：按 \`questionId\` 去重（每题取最新一行），科目取自 \`papers.subjectName\`。图片指 HTML 里的 \`<img>\`（公式图按 latex 键查 images.db）。\n`);
md.push('## 总表\n');
md.push('| 科目 | 题数 | 客观题 | 有答案 | 缺答案 | 有解析 | 缺解析 | 解析带图 | 题干提到图 | 图文齐 | 需材料 | 缺材料 | 坏题 |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of out) {
  md.push(`| ${r.name} | ${r.total} | ${r.obj} | ${r.有答案} | ${r.缺答案} | ${r.有解析} | ${r.缺解析} | ${r.解析带图} | ${r.题干需图} | ${r.图文齐} | ${r.需材料} | ${r.缺材料} | ${r.坏题} |`);
}
md.push('\n## 比率\n');
md.push('| 科目 | 答案覆盖 | 解析覆盖 | 图文匹配 | 坏题占比 |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const r of out) {
  md.push(`| ${r.name} | ${p(r.有答案, r.obj)}% | ${p(r.有解析, r.total)}% | ${p(r.图文齐, r.题干需图)}% | ${p(r.坏题, r.total)}% |`);
}
md.push('\n## 坏题原因（按科目）\n');
for (const r of out) {
  const items = Object.entries(r.坏题原因).sort((a, b) => b[1] - a[1]);
  md.push(`- **${r.name}**：${items.length ? items.map(([k, v]) => `${k} ${v}`).join('、') : '无'}`);
}
md.push('\n## 其他\n');
md.push(`- 选项不足（<2 项）：${out.map((r) => `${r.name} ${r.选项不足}`).join('，')}`);
md.push(`- 难度档：${out.map((r) => `${r.name} 易${r.难度.easy}/中${r.难度.mid}/难${r.难度.hard}/未标${r.难度.none}`).join('；')}`);
md.push(`- 图片键缺失（引用但 images.db 没有）：${missingKeys.length} 个`);

const mdPath = path.join(ROOT, 'report', `audit-subjects-${DAY}.md`);
fs.mkdirSync(path.dirname(mdPath), { recursive: true });
fs.writeFileSync(mdPath, md.join('\n'));
fs.writeFileSync(path.join(ROOT, 'report', `audit-subjects-${DAY}.json`), JSON.stringify({ at: new Date().toISOString(), rows: out, missingKeys: missingKeys.length }, null, 1));
console.log(`\n报告：${path.relative(ROOT, mdPath)}`);
db.close();
if (img) img.close();
