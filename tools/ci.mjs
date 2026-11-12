/**
 * ci.mjs —— 最小 CI：语法、JSON、题库 schema、查询冒烟、发版清单一致性
 *
 * 目的不是「测试覆盖率」，而是拦住我们踩过的这几类事故：
 *   1. 改 app.js 改出语法错（真发生过：edit 吃掉函数头 → Unexpected token）
 *   2. 题库重建后表/列缺失（difficulty_est、question_keypoints_ext 是新增列，漏了就静默降级）
 *   3. local-queries 的 SQL 跟库对不上（chapters.split is not a function 那类）
 *   4. manifest 与 db-version.txt 版本号不一致（会出现「版本更高但 code 更小」不提示更新）
 *
 * 用法：
 *   node tools/ci.mjs            全部检查（没有题库文件时跳过 DB 相关）
 *   node tools/ci.mjs --fast     只查语法 + JSON（秒级，提交前跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAST = process.argv.includes('--fast');
const R = (p) => path.join(ROOT, p);

let pass = 0;
const fails = [];
const skips = [];
const ok = (msg) => {
  pass += 1;
  console.log(`  ✓ ${msg}`);
};
const bad = (msg) => {
  fails.push(msg);
  console.log(`  ✗ ${msg}`);
};
const skip = (msg) => {
  skips.push(msg);
  console.log(`  – ${msg}（跳过）`);
};
const section = (t) => console.log(`\n${t}`);

// ── 1. JS 语法 ──────────────────────────────────────────────
section('1. JS 语法（node --check）');
const jsFiles = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(ent.name)) jsFiles.push(full);
  }
};
for (const d of ['public/next', 'public/lib', 'public', 'tools']) {
  const abs = R(d);
  if (fs.existsSync(abs)) walk(abs);
}
const uniq = [...new Set(jsFiles)];
for (const f of uniq) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad(`语法错误 ${path.relative(ROOT, f)}：${String(e.stderr || e.message).split('\n')[0]}`);
  }
}
if (!fails.length) ok(`${uniq.length} 个 JS 文件语法通过`);

// ── 2. JSON / 版本文件 ──────────────────────────────────────
section('2. JSON 与版本文件');
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(R(p), 'utf8'));
  } catch (e) {
    bad(`${p} 解析失败：${e.message}`);
    return null;
  }
};
const qc = readJson('public/next/qc-counts.json');
if (qc && qc.subjects) {
  const subs = Object.keys(qc.subjects);
  const kpTotal = subs.reduce((s, k) => s + (qc.subjects[k].kps || []).length, 0);
  ok(`qc-counts.json：${subs.length} 个科目 / ${kpTotal} 条考点预计算`);
  if (!kpTotal) bad('qc-counts.json 里没有 kps（考点预计算丢了，按考点练会退回 11 秒的库查询）');
} else if (qc) bad('qc-counts.json 缺少 subjects');

const manifest = readJson('release/manifest.json');
if (manifest && manifest.app && manifest.tiku) {
  const a = manifest.app;
  if (!a.version || !a.versionCode) bad('manifest.app 缺少 version / versionCode');
  else ok(`manifest.app ${a.version}(${a.versionCode})`);
  if (a.code !== a.versionCode) bad(`manifest.app.code(${a.code}) 与 versionCode(${a.versionCode}) 不一致 —— 会出现「版本更高但 code 更小」不提示更新`);
  const apkName = path.basename(new URL(a.url).pathname);
  if (!apkName.includes(a.version)) bad(`manifest.app.url 里的 APK 名(${apkName}) 不含版本号 ${a.version}`);
  else ok(`APK 资产名 ${apkName}`);
  if (!Array.isArray(a.sources) || a.sources.length < 2) bad('manifest.app.sources 少于 2 个源（弱网/被墙时容易全部失败）');
  const full = manifest.tiku.full || {};
  if (!full.size || !full.sha256 || !full.gzSha256) bad('manifest.tiku.full 缺少 size / sha256 / gzSha256');
  else ok(`manifest.tiku ${manifest.tiku.dbVersion}（${manifest.tiku.questions} 题，${(manifest.tiku.delta || []).length} 条增量）`);
} else if (manifest) bad('release/manifest.json 缺少 app 或 tiku 段');

// ── 3. 题库文件（可选）─────────────────────────────────────
section('3. 题库 schema 与查询冒烟');
const DB = R('app-assets/tiku_app.db');
const VER = R('app-assets/db-version.txt');
if (FAST || !fs.existsSync(DB)) {
  skip(FAST ? '--fast 模式' : 'app-assets/tiku_app.db 不存在');
} else {
  const dbSize = fs.statSync(DB).size;
  ok(`题库文件 ${(dbSize / 1048576).toFixed(1)} MB`);
  if (fs.existsSync(VER)) {
    const [ver, rows, qcRows] = fs.readFileSync(VER, 'utf8').trim().split(/\s+/);
    if (!/^\d+\.\d+\.\d+-\d{8}-\d{4}$/.test(ver || '')) bad(`db-version.txt 版本号格式不对：${ver}`);
    else ok(`db-version.txt ${ver} ${rows} 行 ${qcRows} 分类行`);
    if (manifest && manifest.tiku && ver && manifest.tiku.dbVersion !== ver) {
      // 本地重建但还没发布的库（例如实验版先跑）属于正常；危险方向是 manifest 声称了库里没有的版本
      const cmp = String(manifest.tiku.dbVersion).localeCompare(String(ver), "en", { numeric: true });
      if (cmp > 0) bad(`manifest.tiku.dbVersion(${manifest.tiku.dbVersion}) 比本地库(${ver}) 新 —— 客户端会拉一个不存在的增量`);
      else ok(`本地库 ${ver} 尚未发布（manifest 仍是 ${manifest.tiku.dbVersion}）`);
    }
  } else bad('缺少 app-assets/db-version.txt');

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['questions', 'papers', 'materials', 'question_keypoints', 'question_categories', 'q_materials', 'q_material_map']) {
    if (!tables.includes(t)) bad(`缺表 ${t}`);
  }
  const cols = db.prepare('PRAGMA table_info(questions)').all().map((r) => r.name);
  for (const c of ['questionId', 'paperId', 'chapter', 'type', 'content', 'options', 'answer', 'answerIndex', 'analysis']) {
    if (!cols.includes(c)) bad(`questions 缺列 ${c}`);
  }
  const estCols = ['difficulty_est', 'difficulty_b', 'difficulty_src'].filter((c) => cols.includes(c));
  if (estCols.length === 3) ok('questions 有 difficulty_est / difficulty_b / difficulty_src');
  else skip(`difficulty 新列只有 ${estCols.length}/3（老库正常，0.7 起才写）`);

  const integ = db.prepare('PRAGMA integrity_check').get();
  const integVal = integ ? Object.values(integ)[0] : '';
  if (integVal === 'ok') ok('PRAGMA integrity_check = ok');
  else bad(`integrity_check = ${integVal}`);

  const counts = {
    questions: db.prepare('SELECT COUNT(*) c FROM questions').get().c,
    qids: db.prepare('SELECT COUNT(DISTINCT questionId) c FROM questions').get().c,
    papers: db.prepare('SELECT COUNT(*) c FROM papers').get().c,
  };
  ok(`questions ${counts.questions} 行 / ${counts.qids} 题 / papers ${counts.papers} 卷`);
  if (counts.qids < 1000) bad(`唯一题数 ${counts.qids} 异常（重建断了？）`);

  // 空答案 / answerIndex 越界（历史教训：反推写入要校验）
  const noAns = db
    .prepare("SELECT COUNT(*) c FROM questions WHERE type IN (1,2,3,5) AND (answerIndex IS NULL OR answerIndex < 0) AND (answer IS NULL OR answer = '')")
    .get().c;
  if (noAns > 3000) bad(`客观题缺答案 ${noAns} 条（基线 ~237，异常升高说明回填被覆盖）`);
  else ok(`客观题缺答案 ${noAns} 条`);

  // local-queries 冒烟：适配器注入
  const tiku = {
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
  };
  globalThis.__QC_COUNTS__ = qc;
  const { createLocalApi } = await import('../public/lib/local-queries.js');
  const api = createLocalApi(tiku, tiku, {});
  const subs = api.subjects();
  if (!Array.isArray(subs) || !subs.length) bad('subjects() 返回空');
  else ok(`subjects() ${subs.length} 个科目（${subs.map((s) => s.name || s.subjectName).join(' / ')}）`);
  for (const subject of ['事业编·职测', '事业编·公基']) {
    if (!subs.some((s) => (s.name || s.subjectName) === subject)) continue;
    const ch = api.chapters(subject); // 返回数组（章节树），不是 { groups }
    if (!Array.isArray(ch) || !ch.length) bad(`chapters(${subject}) 返回空`);
    else ok(`chapters(${subject}) ${ch.length} 组（${ch.slice(0, 3).map((g) => g.group).join(" / ")}）`);
    if (Array.isArray(ch) && ch.length && !ch.some((g) => g.total > 0)) bad(`chapters(${subject}) 每组题量都是 0`);
    const kps = api.keypoints(subject);
    ok(`keypoints(${subject}) ${kps.length} 个考点`);
    if (subject === '事业编·公基' && !kps.length) bad('公基考点为空（question_keypoints_ext 丢了？）');
    const list = api.practice(subject, { n: 5, types: [1, 2, 3] }); // 返回题目数组
    if (!Array.isArray(list) || !list.length) bad(`practice(${subject}) 抽不到题`);
    else {
      const noOpt = list.filter((q) => !q.options || !q.options.length).length;
      ok(`practice(${subject}) ${list.length} 题（${noOpt} 题无选项）`);
      if (noOpt === list.length) bad(`practice(${subject}) 抽到的题全无选项`);
    }
  }
  db.close();
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n${fails.length ? 'FAILED' : 'OK'} · ${pass} 项通过${skips.length ? ` · ${skips.length} 项跳过` : ''}${fails.length ? ` · ${fails.length} 项失败` : ''}`);
if (fails.length) {
  for (const f of fails) console.log(`  ! ${f}`);
  process.exit(1);
}
