#!/usr/bin/env node
/**
 * enrich-analyses-github.mjs — 用 GitHub 公开题库补全缺失解析（申论/综应）
 *
 * 数据源：zzcc-nb/gongkao-tiku（个人备考用途；仅补“参考答案”，不抓粉笔 App）
 * 原理：题目文件头部 **编号** 就是 questionId；按题干前缀找文件，再用编号精确校验。
 *
 * 用法：
 *   node tools/enrich-analyses-github.mjs --dry-run --limit 50
 *   node tools/enrich-analyses-github.mjs --apply --concurrency 8
 *
 * 说明：
 *   - 只更新 analysis 为空的行，不改已有解析，不覆盖人工内容。
 *   - 修改 tiku.db 前自动备份到 tiku.db.bak-<时间戳>。
 *   - 补完后需重建 app-assets：node build-app-assets.mjs --skip-download
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'tiku.db');
const TREE_CACHE = path.join(ROOT, '..', 'research', 'zzcc-tree.json');
const INDEX_FILE = path.join(ROOT, '..', 'research', 'zzcc-questions-index.jsonl');
const REPO = 'zzcc-nb/gongkao-tiku';
const BRANCH = 'master';
const RAW = `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const APPLY = has('--apply');
const USE_INDEX = has('--index');
const LIMIT = Number(val('--limit', 0)) || Infinity;
const CONCURRENCY = Math.max(1, Number(val('--concurrency', 8)) || 8);
const TIMEOUT = Math.max(5000, Number(val('--timeout', 20000)) || 20000);

const norm = (s) => {
  let x = String(s || '')
    .replace(/\[materialid\][^[]*\[\/materialid\]/g, '')
    .replace(/[“”‘’"'（）()《》〈〉，,。.、；;：:！!？?\s【】[\]—…·]/g, '');
  for (const [a, b] of [['⻆', '角'], ['⻓', '长'], ['⻜', '飞'], ['⻄', '西'], ['⻅', '见'], ['⺠', '民'], ['⻔', '门'], ['⻋', '车']]) x = x.split(a).join(b);
  return x;
};
const core = (s) => norm(s)
  .replace(/^(请)?(根据|结合|阅读|认真阅读)?(给定|所给)(资料|材料)[0-9一二三四五六七八九十]*[，,、]?/, '')
  .replace(/^(请)?(根据|结合|阅读|认真阅读)[^，,。]{0,12}[，,]/, '');

async function loadTree() {
  if (fs.existsSync(TREE_CACHE)) {
    const j = JSON.parse(fs.readFileSync(TREE_CACHE, 'utf8'));
    if (Array.isArray(j) && j.length > 100) return j;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: { 'User-Agent': 'kaogong-shuati-enrich' },
  });
  if (!r.ok) throw new Error(`GitHub tree ${r.status}`);
  const j = await r.json();
  const tree = (j.tree || []).map((x) => x.path);
  fs.mkdirSync(path.dirname(TREE_CACHE), { recursive: true });
  fs.writeFileSync(TREE_CACHE, JSON.stringify(tree));
  return tree;
}

function makeDbRows() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(`
    SELECT q.questionId AS qid, MIN(q.content) AS content, MIN(p.subjectName) AS subject
    FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subjectName IN ('公务员·申论', '事业编·综应')
      AND TRIM(COALESCE(q.analysis, '')) = ''
    GROUP BY q.questionId
  `).all();
  db.close();
  return rows;
}

function parseFile(text, qid) {
  const idm = text.match(/\*\*编号\*\*[：:]\s*(\d+)/);
  if (!idm) return { error: '无编号' };
  if (Number(idm[1]) !== Number(qid)) return { error: `编号不符 ${idm[1]} != ${qid}` };
  const m = text.match(/##\s*✅\s*参考答案\s*([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  if (!m) return { error: '无参考答案' };
  const analysis = m[1].replace(/\r\n/g, '\n').trim();
  if (analysis.length < 20) return { error: '参考答案过短' };
  return { analysis };
}

async function fetchOne(file) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RAW + encodeURI(file), {
        headers: { 'User-Agent': 'kaogong-shuati-enrich' },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

async function main() {
  console.log(`\n${APPLY ? '补齐' : '预演'} 缺失解析 · 数据源 ${REPO} · 并发 ${CONCURRENCY}${USE_INDEX ? ' · 索引模式' : ''}`);
  const rows = makeDbRows();
  console.log(`tiku.db 中申论/综应缺解析题目：${rows.length}`);

  let index = null;
  if (USE_INDEX) {
    if (!fs.existsSync(INDEX_FILE)) throw new Error(`缺少索引文件：${INDEX_FILE}`);
    index = new Map();
    for (const line of fs.readFileSync(INDEX_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); index.set(String(j.fenbi_id), j); } catch { /* skip */ }
    }
    console.log(`题目索引：${index.size} 条`);
  }

  const tree = (await loadTree()).filter((p) => p.endsWith('.md') && (p.startsWith('申论题库/') || p.startsWith('综应题库/')));
  const files = tree.map((p) => ({ p, n: core(p.split('/').pop().replace(/^\d+_/, '').replace(/（[^）]*）\.md$/, '')) }));
  console.log(`仓库题目文件：${files.length}`);

  const byFile = new Map();
  let unmatched = 0;
  for (const r of rows) {
    let c;
    if (USE_INDEX) {
      const j = index.get(String(r.qid));
      if (!j || !j.has_rubric) { unmatched++; continue; }
      c = core(j.stem_preview || '');
    } else {
      c = core(r.content);
    }
    if (c.length < 14) { unmatched++; continue; }
    const snippet = c.slice(0, USE_INDEX ? 14 : 16);
    const hit = files.find((f) => f.n.includes(snippet));
    if (!hit) { unmatched++; continue; }
    if (!byFile.has(hit.p)) byFile.set(hit.p, []);
    byFile.get(hit.p).push(r);
  }
  const jobs = [...byFile.entries()].slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`候选文件：${byFile.size}（先处理 ${jobs.length} 个；题干过短/未匹配 ${unmatched}）`);

  const updates = new Map(); // qid -> analysis
  const errors = [];
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const [file, list] = jobs[cursor++];
      try {
        const text = await fetchOne(file);
        for (const r of list) {
          const parsed = parseFile(text, r.qid);
          if (parsed.analysis) updates.set(r.qid, parsed.analysis);
          else errors.push({ file, qid: r.qid, error: parsed.error });
        }
      } catch (e) {
        errors.push({ file, error: e.message });
      }
      done++;
      if (done % 50 === 0 || done === jobs.length) console.log(`  已抓取 ${done}/${jobs.length} · 命中 ${updates.size}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const bySubject = {};
  for (const r of rows) if (updates.has(r.qid)) bySubject[r.subject] = (bySubject[r.subject] || 0) + 1;
  console.log(`\n结果：候选 ${jobs.length} 个文件，命中 ${updates.size} 道题 ${JSON.stringify(bySubject)}，失败 ${errors.length}`);
  if (errors.length) {
    const reasons = {};
    for (const e of errors) reasons[e.error] = (reasons[e.error] || 0) + 1;
    console.log('失败原因：', reasons);
    fs.writeFileSync(path.join(ROOT, 'tools', 'enrich-errors.json'), JSON.stringify(errors.slice(0, 300), null, 2));
  }
  if (!updates.size) return;

  if (!APPLY) {
    const sample = [...updates.entries()].slice(0, 3);
    console.log('\n预演样例（不写库）：');
    for (const [qid, text] of sample) console.log(`  ${qid}: ${text.slice(0, 100).replace(/\n/g, ' ')}…`);
    console.log('\n加 --apply 写库。');
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const backup = `${DB}.bak-${stamp}`;
  {
    const ck = new DatabaseSync(DB);
    ck.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    ck.close();
  }
  console.log(`\n备份 ${backup} …`);
  fs.copyFileSync(DB, backup);

  const db = new DatabaseSync(DB);
  const upd = db.prepare("UPDATE questions SET analysis = ? WHERE questionId = ? AND TRIM(COALESCE(analysis, '')) = ''");
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const [qid, analysis] of updates) changed += Number(upd.run(analysis, qid).changes) || 0;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  console.log(`已更新 ${changed} 行（${updates.size} 个 questionId）。`);
  console.log('下一步：node build-app-assets.mjs --skip-download');
}

main().catch((e) => { console.error(e); process.exit(1); });
