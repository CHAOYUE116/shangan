#!/usr/bin/env node
/**
 * 按卷重采：从粉笔记解析（按整卷）把缺的图/材料/解析补回来
 *
 *   node tools/fix-from-paper.mjs            # dry-run，打印前几卷会补什么
 *   node tools/fix-from-paper.mjs --apply    # 写库
 *   node tools/fix-from-paper.mjs --apply --limit 20 --gap 4000
 *
 * 为什么按卷而不是按题：
 *   按题取解析要 checkId（搜题接口才给），搜不到就取不了；
 *   按卷只要 paperId，一次能拿整卷 100 道题的正文（含图与材料），
 *   对「图形推理」这种题干没信息量的题是唯一可行路径。
 *
 * 注意：本题库 papers.id 就是粉笔的 paperId（导入时原样保留），
 *   只有「考点散题（粉笔考点 · xx）」这类虚拟卷是自造的，粉笔上不存在，跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const APPLY = has('--apply');
// --papers-file <json>：导入「粉笔有、我们整个卷都没有」的试卷（整卷题目全部插入）
const PAPERS_FILE = arg('papers-file', '');
const IMPORT = !!PAPERS_FILE;
const COURSE_ARG = arg('course', '');
const AUGMENT = has('--augment') || IMPORT; // 顺手把「语料里有、库里没有」的题插进来
const SUBJECT_OF_COURSE = {
  syzc: '事业编·职测',
  sydw: '事业编·公基',
  xingce: '公务员·行测',
  zhyynl: '事业编·综应',
};
const DB_PATH = arg('db', path.join(ROOT, 'app-assets', 'tiku_app.db'));
const IMG_DB = path.join(ROOT, 'app-assets', 'images.db');
const LIMIT = Number(arg('limit', 0));
const GAP = Number(arg('gap', 4000));
const COOLDOWN = Number(arg('cooldown', 180)) * 1000;
const DAY = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 粉笔会话 ---------------- */
const { loadAccounts, Session } = await import('./lib/fenbi.mjs');
const ACCOUNTS = loadAccounts(ROOT);
const sess = new Session(ACCOUNTS);
const COOKIE = sess.acc.cookie;
const UID = sess.uid();
console.log('账号：' + ACCOUNTS.map((a) => a.file + '(' + a.uid + ')').join(' · '));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { cookie: COOKIE, 'user-agent': UA, referer: 'https://www.fenbi.com/', origin: 'https://www.fenbi.com' };
const SPA = { ...H, referer: 'https://spa.fenbi.com/', origin: 'https://spa.fenbi.com' };
const Q0 = 'app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=';
const Q = () => `${Q0}&userId=${sess.uid()}`;
const ST = `routecs=%C&type=1&kav=125&av=127&hav=125&app=web&apcid=0&deviceId=&gav=2`;

const COURSE_OF = {
  '公务员·行测': 'xingce',
  '事业编·职测': 'syzc',
  '事业编·公基': 'sydw',
  '事业编·综应': 'zhyynl',
};

async function createExercise(course, paperId) {
  const r = await sess.fetch(`https://tiku.fenbi.com/api/${course}/exercises?${Q()}&type=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `type=1&paperId=${paperId}&exerciseTimeMode=2`,
    signal: AbortSignal.timeout(20000),
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* html */ }
  return { status: r.status, json: j, text: txt };
}

async function submitAndGetStatic(course, key) {
  await sess.fetch(`https://tiku.fenbi.com/combine/exercise/submit?key=${key}&routecs=${course}&${Q()}`, {
    method: 'POST',
    spa: true, headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  const gr = await sess.fetch(`https://tiku.fenbi.com/combine/exercise/getSolution?format=json&key=${key}&routecs=${course}&${Q()}`, {
    spa: true,
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!gr || gr.status !== 200) return { status: gr?.status || 0, json: null };
  const gj = await gr.json();
  const url = gj?.data?.staticUrl?.urls?.[0]
    || (gj?.data?.switchVO?.requestKey ? `https://tiku.fenbi.com/combine/static/solution?key=${gj.data.switchVO.requestKey}` : null);
  if (!url) return { status: 0, json: null };
  const full = url + (url.includes('?') ? '&' : '?') + ST.replace('%C', course);
  const st = await sess.fetch(full, { spa: true, signal: AbortSignal.timeout(25000) }).catch(() => null);
  if (!st || st.status !== 200) return { status: st?.status || 0, json: null };
  const sj = await st.json().catch(() => null);
  return { status: 200, json: sj };
}

/* ---------------- 富文本 → HTML ---------------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TEX_HOST = 'https://fb.fenbike.cn/api/planet/accessories/formulas?latex=';

function texKey(v) {
  return String(v || '').split('?')[0].split('/').pop();
}

function richToHtml(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return '';
    if (s.startsWith('{') || s.startsWith('[')) { try { return richToHtml(JSON.parse(s)); } catch { /* 当纯文本 */ } }
    return s;
  }
  if (Array.isArray(raw)) return raw.map(richToHtml).join('');
  const name = raw.name || '';
  if (name === 'txt') return esc(raw.value || '');
  if (name === 'tex') return `<img flag="tex" src="${TEX_HOST}${texKey(raw.value)}" />`;
  if (name === 'img' || name === 'image') {
    const u = raw.value || raw.src || '';
    return u ? `<img src="${u}" />` : '';
  }
  const kids = raw.children ? richToHtml(raw.children) : '';
  if (name === 'p' || name === 'div') return kids ? `<p>${kids}</p>` : '';
  if (name === 'br') return '<br />';
  if (name === 'li') return `<li>${kids}</li>`;
  if (name === 'ul' || name === 'ol') return `<${name}>${kids}</${name}>`;
  if (name === 'b' || name === 'strong') return `<b>${kids}</b>`;
  if (name === 'i' || name === 'em') return `<i>${kids}</i>`;
  if (name === 'u') return `<u>${kids}</u>`;
  if (name === 'table' || name === 'tr' || name === 'td' || name === 'th' || name === 'tbody') return `<${name}>${kids}</${name}>`;
  return kids || esc(raw.value || '');
}

const IMG_ANY = /<img/;
const TARZAN = /\/api\/tarzan\/images\/[^"'\s)]+/g;

/** 归一域名 + 去协议相对 */
function normLinks(html) {
  return String(html)
    .replace(/src="\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=/g, `src="${TEX_HOST}`)
    .replace(/src="\/\/fb\.fbstatic\.cn\//g, 'src="https://fb.fbstatic.cn/')
    .replace(/src='([^']+)'/g, 'src="$1"');
}

/** 把 tarzan 真图下载下来内联成 data URI（离线可用）；并发 8 */
async function inlineTarzan(html) {
  if (!APPLY) return arguments[0]; // dry-run 不下载图，只看逻辑
  const urls = [...new Set(String(html).match(TARZAN) || [])];
  if (!urls.length) return html;
  const map = new Map();
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        const abs = 'https://fb.fbstatic.cn' + u;
        const r = await fetch(abs, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = r.headers.get('content-type') || 'image/png';
        map.set(u, `data:${mime.split(';')[0]};base64,${buf.toString('base64')}`);
      } catch { /* 忽略单张失败 */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  let out = html;
  for (const [u, d] of map) out = out.split(u).join(d);
  return out;
}

/* ---------------- 合并（只补空的/更差的） ---------------- */
const txt = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function planFix(row, sol, materials) {
  const patch = {};
  const why = [];

  // 1) 题干：我们没图 → 粉笔有图才换（整段换，保留粉笔原排版）
  const theirStem = normLinks(richToHtml(sol.content));
  const ourStem = normLinks(row.contentHtml || '');
  const theirHasImg = IMG_ANY.test(theirStem);
  const ourHasImg = IMG_ANY.test(ourStem);
  if (theirStem && (theirHasImg && !ourHasImg)) {
    patch.contentHtml = await inlineTarzan(theirStem);
    why.push('题干图');
  }

  // 2) 材料：我们没有 / 太短 → 用粉笔的
  const mat = (materials || []).find((m) => String(m.id) === String(sol.materialId));
  if (mat) {
    const theirMat = normLinks(richToHtml(mat.content));
    if (theirMat && (!row.material || txt(row.material).length < 20)) {
      patch.material = await inlineTarzan(theirMat);
      why.push('材料');
    }
  }

  // 3) 解析：我们太短或没图而粉笔有 → 换
  const theirSol = normLinks(richToHtml(sol.solution));
  const ourSol = normLinks(row.analysis || '');
  if (theirSol && (txt(theirSol).length > txt(ourSol).length + 10
    || (IMG_ANY.test(theirSol) && !IMG_ANY.test(ourSol)))) {
    patch.analysis = await inlineTarzan(theirSol);
    if (txt(theirSol).length > 20) why.push('解析');
  }

  // 4) 选项：我们空 → 粉笔有（且全非空）
  let opts = [];
  for (const a of sol.accessories || []) if (Array.isArray(a?.options) && a.options.length) { opts = a.options; break; }
  const theirOpts = opts.map((o) => String(o || '').trim());
  if (theirOpts.length && theirOpts.every(Boolean)) {
    let ours = [];
    try { ours = JSON.parse(row.options || '[]'); } catch { /* ignore */ }
    if (!ours.length) { patch.options = JSON.stringify(theirOpts); why.push('选项'); }
  }

  return { patch, why };
}

/* ---------------- 主流程 ---------------- */
const db = new DatabaseSync(DB_PATH);
const dbImg = fs.existsSync(IMG_DB) ? new DatabaseSync(IMG_DB) : null;
db.exec('PRAGMA busy_timeout = 8000');

// 跨卷去重用的「内容指纹」：去掉标签、空白、标点后取前 120 字
const SEEN_FP = new Set();
{
  const norm = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\p{P}]/gu, '').slice(0, 120);
  for (const r of db.prepare('SELECT content FROM questions WHERE id IN (SELECT MAX(id) FROM questions GROUP BY questionId)').all()) {
    const fp = norm(r.content);
    if (fp) SEEN_FP.add(fp);
  }
  console.log(`内容指纹库 ${SEEN_FP.size} 条（跨卷去重用）`);
}

const BAD_WHERE = `COALESCE(q.q_bad, 0) = 1`;
const HAVE_IDS = new Set(db.prepare('SELECT id FROM papers').all().map((x) => String(x.id)));
let papers;
if (IMPORT) {
  const ids = JSON.parse(fs.readFileSync(path.resolve(ROOT, PAPERS_FILE), 'utf8'));
  papers = ids
    .map((x) => (typeof x === 'object' ? x : { id: x }))
    .filter((x) => !HAVE_IDS.has(String(x.id)))
    .map((x) => ({ id: Number(x.id), name: x.name || `粉笔试卷 ${x.id}`, subjectName: SUBJECT_OF_COURSE[COURSE_ARG] || '', n: 0 }));
} else {
  papers = db.prepare(`
    SELECT p.id, p.name, p.subjectName, COUNT(DISTINCT q.questionId) AS n
    FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE ${BAD_WHERE} AND p.name NOT LIKE '%考点散题%'
    GROUP BY p.id ORDER BY n DESC, p.id DESC
  `).all();
}

const todo = LIMIT ? papers.slice(0, LIMIT) : papers;
console.log(IMPORT
  ? `导入模式：目标卷 ${papers.length} 个${LIMIT ? `（本次跑前 ${todo.length} 个）` : ''}${APPLY ? '' : '（dry-run）'}`
  : `含坏题的真题卷 ${papers.length} 个${LIMIT ? `（本次跑前 ${todo.length} 个）` : ''}${APPLY ? '' : '（dry-run）'}`);

const log = [];
const SKIP = { blank: 0, opt: 0, ans: 0, img: 0, mat: 0, dup: 0 };
let consecutive429 = 0;
let papersOk = 0, papersFail = 0, fixed = 0, skipped = 0, cooled = 0, added = 0;

for (let pi = 0; pi < todo.length; pi += 1) {
  const p = todo[pi];
  const course = COURSE_ARG || COURSE_OF[p.subjectName] || 'syzc';
  const isNew = !HAVE_IDS.has(String(p.id));
  let ex = await createExercise(course, p.id);
  // 只有「频率过高」才值得冷却重试；「无权/未购买」这类 403 直接跳过
  while (ex.status === 403 && /频率/.test(String(ex.text || '')) && cooled < 8) {
    cooled += 1;
    console.log(`  403 限流（建练习），冷却 ${Math.round(COOLDOWN / 1000)}s（第 ${cooled} 次）`);
    await sleep(COOLDOWN);
    ex = await createExercise(course, p.id);
  }
  if (ex.status === 403 && /频率/.test(String(ex.text || ''))) {
    consecutive429 += 1;
    if (consecutive429 >= 3) {
      console.log('连续 3 卷都在限流，先退出，过一会儿再跑（已修好的会跳过）');
      break;
    }
  } else consecutive429 = 0;
  if (ex.status !== 200 || !ex.json) {
    papersFail += 1;
    console.log(`  ✗ 卷 ${p.id} ${p.name.slice(0, 24)} 建练习 HTTP ${ex.status} ${String(ex.text).slice(0, 60)}`);
    await sleep(GAP);
    continue;
  }
  const key = ex.json.key || ex.json?.data?.key || (ex.json.data && ex.json.data.key);
  if (!key) {
    papersFail += 1;
    console.log(`  ✗ 卷 ${p.id} 没有 key：${JSON.stringify(ex.json).slice(0, 120)}`);
    await sleep(GAP);
    continue;
  }
  const st = await submitAndGetStatic(course, key);
  if (st.status !== 200 || !st.json) {
    papersFail += 1;
    console.log(`  ✗ 卷 ${p.id} 取解析 HTTP ${st.status}`);
    await sleep(GAP);
    continue;
  }
  papersOk += 1;
  const sols = st.json.solutions || [];
  const mats = st.json.materials || [];
  if (isNew) {
    const subjectName = p.subjectName || SUBJECT_OF_COURSE[course] || '';
    const name = String(st.json.name || p.name || `粉笔试卷 ${p.id}`);
    if (APPLY) {
      db.prepare(`INSERT OR REPLACE INTO papers (id, subject, subjectName, category, name, questionCount, time, difficulty, exerciseId, chapters, crawledAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.id, subjectName, subjectName, '粉笔导入', name, sols.length, null, null, null, null, new Date().toISOString());
    }
    HAVE_IDS.add(String(p.id));
    console.log(`  ＋ 新卷 ${p.id} ${name.slice(0, 26)}（${sols.length} 题）`);
  }
  const rows = db.prepare(`
    SELECT q.id AS rowId, q.questionId, q.contentHtml, q.material, q.analysis, q.options, q.q_bad_reason, q.type
    FROM questions q WHERE q.paperId = ? AND q.id IN (SELECT MAX(id) FROM questions GROUP BY questionId)
      AND COALESCE(q.q_bad, 0) = 1
  `).all(p.id);

  let pFixed = 0;
  for (const row of rows) {
    const sol = sols.find((s) => Number(s.id) === Number(row.questionId));
    if (!sol) { skipped += 1; continue; }
    const { patch, why } = await planFix(row, sol, mats);
    if (!why.length) { skipped += 1; continue; }
    if (APPLY) {
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
      sets.push('q_bad = 0', 'q_bad_reason = NULL');
      vals.push(row.questionId);
      db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE questionId = ?`).run(...vals);
    }
    fixed += 1; pFixed += 1;
    log.push({ paperId: p.id, questionId: row.questionId, why });
  }
  let pAdded = 0;
  let pSkipped = 0;
  if (AUGMENT) {
    const have = new Set(db.prepare('SELECT DISTINCT questionId FROM questions WHERE paperId = ?').all(p.id).map((x) => Number(x.questionId)));
    let nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM questions').get().n;
    for (const sol of sols) {
      const qid = Number(sol.id);
      if (!qid || have.has(qid)) continue;
      const stemHtml = normLinks(richToHtml(sol.content));
      const stemTxt = txt(stemHtml);
      if (!stemTxt && !IMG_ANY.test(stemHtml)) { pSkipped += 1; SKIP.blank += 1; continue; }      // 空题不要
      const type = Number(sol.type || 1);
      const opt = (sol.accessories || []).find((a) => Array.isArray(a?.options) && a.options.length)?.options || [];
      // ---- 入库前的质量闸门（宁缺勿滥） ----
      // 1) 客观题必须有选项，且不能「有空的选项」（那是图片选项没抓下来，用户会看到 4 个空白）
      if ([1, 2, 3, 5].includes(type) && type !== 5) {
        const blank = opt.filter((o) => !txt(o) && !IMG_ANY.test(String(o || '')));
        if (!opt.length || blank.length) { pSkipped += 1; SKIP.opt += 1; continue; }
      }
      // 2) 客观题必须有答案
      const ch = String(sol.correctAnswer?.choice ?? '');
      if ([1, 2, 3, 5].includes(type) && ch === '') { pSkipped += 1; SKIP.ans += 1; continue; }
      // 3) 题干说要图但整题没有任何图/公式 → 做不了，不入库
      if (/(如图|如下图|图中|图示|图\s?\d|下列图形|图形推理)/.test(stemTxt) && !IMG_ANY.test(stemHtml)) {
        pSkipped += 1;
        SKIP.img += 1;
        log.push({ paperId: p.id, questionId: qid, why: ['跳过：缺图'], skipped: true });
        continue;
      }
      // 4) 题干说「根据材料/资料/下表」但没材料也没图 → 做不了
      const mat = (mats || []).find((m) => String(m.id) === String(sol.materialId));
      const matRaw = mat ? normLinks(richToHtml(mat.content)) : '';
      if (/^(根据|阅读|结合)(以下|如下)?(材料|资料|上文|下表|上表|图表)/.test(stemTxt)
        && txt(matRaw).length < 20 && !IMG_ANY.test(matRaw)) {
        pSkipped += 1;
        SKIP.mat += 1;
        log.push({ paperId: p.id, questionId: qid, why: ['跳过：缺材料'], skipped: true });
        continue;
      }
      // 5) 内容指纹去重（同一道题常出现在多张卷里，questionId 不同）
      const fp = `${stemTxt.replace(/[\s\p{P}]/gu, '')}`.slice(0, 120);
      if (fp && SEEN_FP.has(fp)) { pSkipped += 1; SKIP.dup += 1; continue; }
      let answer = ''; let answerIndex = -1;
      if (ch !== '') {
        if (sol.correctAnswer?.type === 201 || /^\d+$/.test(ch)) {
          const idx = Number(ch);
          if (type === 2) { answer = String(idx); answerIndex = -1; }
          else { answer = String(idx); answerIndex = idx; }
        } else answer = ch;
      }
      const kps = Array.isArray(sol.keypoints) ? sol.keypoints : [];
      const kpName = String(kps[kps.length - 1] || kps[0] || '').split('/').filter(Boolean).pop() || null;
      const solHtml = normLinks(richToHtml(sol.solution));
      const matHtml = matRaw ? await inlineTarzan(matRaw) : '';
      const row = {
        id: nextId++, questionId: qid, paperId: p.id,
        chapter: kpName || null,
        type,
        questionType: sol.type === 5 ? 'judge' : null,
        content: stemTxt, contentHtml: await inlineTarzan(stemHtml),
        material: matHtml, options: opt.length ? JSON.stringify(opt.map(String)) : '',
        optionType: opt.length ? '101' : null,
        answer, answerIndex,
        difficulty: 5, source: 'fenbi-paper',
        analysis: txt(solHtml), analysisHtml: await inlineTarzan(solHtml),
        hasVideo: 0, q_bad: 0, q_bad_reason: null,
      };
      if (APPLY) {
        db.prepare(`INSERT INTO questions (id, questionId, paperId, chapter, type, questionType, content, contentHtml, material, options, optionType, answer, answerIndex, difficulty, source, analysis, analysisHtml, hasVideo, q_bad, q_bad_reason)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          row.id, row.questionId, row.paperId, row.chapter, row.type, row.questionType, row.content || ' ', row.contentHtml,
          row.material, row.options, row.optionType, row.answer, row.answerIndex, row.difficulty, row.source, row.analysis, row.analysisHtml, 0, 0, null);
        if (fp) SEEN_FP.add(fp);
      }
      pAdded += 1; added += 1;
      log.push({ paperId: p.id, questionId: qid, why: ['新增'], added: true });
    }
  }
  if (pFixed || pAdded || pSkipped) {
    console.log(`  ✓ 卷 ${p.id} ${p.name.slice(0, 22)} 补 ${pFixed} 道 / 新增 ${pAdded} 道 / 跳过 ${pSkipped} 道（题 ${sols.length} 解析 ${mats.length} 材料）`);
  }
  await sleep(GAP);
}

const out = path.join(ROOT, 'report', `fix-from-paper-${DAY}.json`);
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), apply: APPLY, augment: AUGMENT, papersOk, papersFail, fixed, added, skipped, skipDetail: SKIP, log }, null, 1));
console.log(`\n完成：卷成功 ${papersOk} / 失败 ${papersFail} · 补题 ${fixed} 道 · 新增 ${added} 道 · 跳过 ${skipped} 道${APPLY ? '（已写库）' : '（dry-run，未写库）'}`);
console.log(`跳过明细：空题 ${SKIP.blank} / 选项空 ${SKIP.opt} / 无答案 ${SKIP.ans} / 缺图 ${SKIP.img} / 缺材料 ${SKIP.mat} / 重复 ${SKIP.dup}`);
console.log(`明细：${path.relative(ROOT, out)}`);
if (APPLY) console.log('提示：再跑 node tools/fetch-missing-images.mjs --apply 把新出现的公式图下载进 images.db');
db.close();
if (dbImg) dbImg.close();
