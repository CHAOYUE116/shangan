#!/usr/bin/env node
/**
 * tools/fenbi-fetch.mjs — 粉笔题库采集器（Web 端 tikuApi）
 *
 * 逆向依据见 docs/粉笔逆向笔记.md。要点：
 *   - 域名：//tiku.fenbi.com/api/{course}/...
 *   - course 是科目名：xingce / shenlun（**不是** gwy，gwy 只是 webapi 的 app 参数）
 *   - 鉴权：纯 Cookie（withCredentials），无请求签名
 *   - 公开接口（免登录）：/{course}/comptroller/papers（列表）、/{course}/comptroller/papers/{id}/sheet（结构）
 *   - 需登录：/{course}/papers/{id}（含题）、/{course}/universal/questions?paperId=
 *
 * 用法：
 *   1) 浏览器登录 https://www.fenbi.com/spa/tiku（或用 tools/fenbi-login-watch.mjs 自动抓 Cookie）
 *   2) set FENBI_COOKIE=...   或   --cookie-file cookie.txt
 *   3) 先拉公开结构：
 *        node tools/fenbi-fetch.mjs --sheet --pages 6 --size 6
 *      再拉题目（需 Cookie）：
 *        node tools/fenbi-fetch.mjs --pages 3 --size 6 --dry-run
 *        node tools/fenbi-fetch.mjs --pages 3 --size 6
 *
 * 参数：
 *   --course   xingce(行测) | shenlun(申论)    默认 xingce
 *   --sheet    只拉试卷结构（公开，不需要 Cookie）
 *   --pages    拉多少页列表                      默认 2
 *   --size     每页条数                          默认 6（官方接口常用 6）
 *   --label    分类标签 id                       默认 1（历年试卷）
 *   --paper    只拉指定 paperId（可重复）
 *   --delay    请求间隔毫秒                      默认 900
 *   --out      输出目录                          默认 ../research/fenbi-raw
 *   --dry-run  只请求首页验证 Cookie，不批量拉
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes('--' + name);
const argAll = (name) => {
  const out = [];
  argv.forEach((v, i) => { if (v === '--' + name && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
};

const COURSE = arg('course', 'xingce');
const SHEET_ONLY = flag('sheet');
const PAGES = Number(arg('pages', 2));
const SIZE = Number(arg('size', 6));
const LABEL = arg('label', '1');
const DELAY = Number(arg('delay', 900));
const OUT = path.resolve(ROOT, arg('out', '../research/fenbi-raw'));
const DRY = flag('dry-run');
const ONLY_PAPERS = argAll('paper');
const MAX_PAPERS = Number(arg('max', 0));

const HOST = 'https://tiku.fenbi.com/api';
const COMMON = new URLSearchParams({ app: 'web', av: '134', hav: '128', kav: '131', apcid: '0' });

// ---------------- Cookie ----------------
let cookie = process.env.FENBI_COOKIE || '';
const cookieFile = arg('cookie-file', null);
if (!cookie && cookieFile && fs.existsSync(cookieFile)) cookie = fs.readFileSync(cookieFile, 'utf8').trim();
if (!cookie && fs.existsSync(path.join(ROOT, 'cookie.txt'))) cookie = fs.readFileSync(path.join(ROOT, 'cookie.txt'), 'utf8').trim();

if (!cookie && !SHEET_ONLY && !DRY) {
  console.error('✗ 没有 Cookie（拉题目需要登录）。三选一：');
  console.error('    node tools/fenbi-login-watch.mjs        # 打开浏览器登录并自动抓 Cookie');
  console.error('    set FENBI_COOKIE=<浏览器复制的完整 Cookie>');
  console.error('    node tools/fenbi-fetch.mjs --sheet      # 只拉公开结构，不需要 Cookie');
  process.exit(1);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  'Referer': 'https://www.fenbi.com/spa/tiku/guide/home/xingce/xingce',
  'Origin': 'https://www.fenbi.com',
  'Accept': 'application/json, text/plain, */*',
};
if (cookie) HEADERS.Cookie = cookie;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(pathAndQuery, { retry = 2 } = {}) {
  const u = new URL(HOST + pathAndQuery);
  for (const [k, v] of COMMON) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const text = await r.text();
      if (r.status === 401) throw new Error('401 未授权：该接口需要登录态（先跑 fenbi-login-watch.mjs）');
      if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
      try { return JSON.parse(text); } catch { return { __raw: text }; }
    } catch (e) {
      if (String(e.message).startsWith('401') || attempt === retry) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

// ---------------- 主流程 ----------------
fs.mkdirSync(path.join(OUT, 'papers'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });

console.log(`粉笔采集  course=${COURSE} mode=${SHEET_ONLY ? 'sheet(公开)' : 'questions(需登录)'}`);
console.log(`          pages=${PAGES} size=${SIZE} label=${LABEL} delay=${DELAY}ms`);
console.log(`输出：${OUT}${cookie ? `  cookie=${cookie.length}字节` : '  (无 cookie)'}`);

// 1) 试卷列表（comptroller 为公开接口）
const index = [];
let page = 0;
while (page < (DRY ? 1 : PAGES)) {
  try {
    const res = await call(`/${COURSE}/comptroller/papers?toPage=${page}&pageSize=${SIZE}&labelId=${LABEL}`);
    const list = res.list || [];
    const info = res.pageInfo || {};
    console.log(`  第 ${page} 页：${list.length} 份（共 ${info.totalItem ?? '?'} 份 / ${info.totalPage ?? '?'} 页）`);
    for (const p of list) {
      index.push({
        paperId: p.id,
        name: p.name,
        date: p.date,
        questions: p.paperMeta?.exerciseCount,
        type: p.type,
      });
    }
    if (!list.length || page + 1 >= (info.totalPage ?? 0)) break;
  } catch (e) {
    console.error(`  第 ${page} 页失败：${e.message}`);
    break;
  }
  page += 1;
  await sleep(DELAY);
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n试卷清单：${index.length} 份 → index.json`);

if (DRY) {
  console.log('\n[dry-run] 列表接口可用。' + (cookie ? 'Cookie 已带，可去掉 --dry-run 拉题。' : '拉题需要 Cookie。'));
  process.exit(0);
}

// 2) 逐个试卷
const targets = ONLY_PAPERS.length
  ? ONLY_PAPERS.map((id) => ({ paperId: Number(id) }))
  : (MAX_PAPERS ? index.slice(0, MAX_PAPERS) : index);

let ok = 0, skip = 0, fail = 0;
for (let i = 0; i < targets.length; i++) {
  const { paperId } = targets[i];

  // 2a) 结构（公开）
  const sheetDest = path.join(OUT, 'sheets', `${paperId}.json`);
  if (!fs.existsSync(sheetDest)) {
    try {
      const sheet = await call(`/${COURSE}/comptroller/papers/${paperId}/sheet`);
      fs.writeFileSync(sheetDest, JSON.stringify(sheet, null, 1));
    } catch (e) {
      console.error(`  sheet ${paperId} 失败：${e.message}`);
    }
    await sleep(DELAY);
  }

  if (SHEET_ONLY) { ok += 1; continue; }

  // 2b) 题目（需登录）
  const dest = path.join(OUT, 'papers', `${paperId}.json`);
  if (fs.existsSync(dest)) { skip += 1; continue; }
  try {
    let detail = await call(`/${COURSE}/papers/${paperId}`);
    const qs = detail?.data?.questions || detail?.questions || [];
    if (detail?.code === 1 && !qs.length) {
      const extra = await call(`/${COURSE}/universal/questions?paperId=${paperId}`);
      detail = { ...detail, __questions: extra?.data || extra?.datas || extra };
      await sleep(DELAY);
    }
    fs.writeFileSync(dest, JSON.stringify(detail, null, 1));
    ok += 1;
  } catch (e) {
    fail += 1;
    console.error(`  paper ${paperId} 失败：${e.message}`);
    if (String(e.message).startsWith('401')) break;
  }
  await sleep(DELAY);
  if ((i + 1) % 10 === 0) console.log(`  进度 ${i + 1}/${targets.length}  ok=${ok} skip=${skip} fail=${fail}`);
}

console.log(`\n完成：ok=${ok} skip=${skip} fail=${fail}`);
if (SHEET_ONLY) console.log(`结构在 ${OUT}/sheets/`);
else console.log(`题目在 ${OUT}/papers/`);
