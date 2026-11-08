/**
 * tools/fenbi-browser-fetch.mjs — 用已登录的受控浏览器采集（绕 WAF）
 *
 * 为什么需要：直接 curl/PowerShell 请求会返回 453（粉笔 WAF 校验 TLS/指纹），
 * 在浏览器上下文里 fetch 同域接口则完全正常。
 *
 * 前置：先跑 tools/fenbi-login-watch.mjs 完成登录（profile 已持久化）
 *
 * 用法：
 *   node tools/fenbi-browser-fetch.mjs --course sydw --label 0 --pages 5 --size 20 --sheet
 *   node tools/fenbi-browser-fetch.mjs --course sydw --paper 123456
 *   node tools/fenbi-browser-fetch.mjs --course sydw --probe      # 只探规模
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const all = (n) => { const o = []; argv.forEach((v, i) => { if (v === '--' + n && argv[i + 1]) o.push(argv[i + 1]); }); return o; };

const COURSE = arg('course', 'sydw');
const LABEL = arg('label', '0');
const PAGES = Number(arg('pages', 5));
const SIZE = Number(arg('size', 20));
const DELAY = Number(arg('delay', 1200));
const OUT = path.resolve(ROOT, arg('out', `../research/fenbi-raw/${COURSE}`));
const SHEET_ONLY = flag('sheet');
const PROBE = flag('probe');
const PAPERS = all('paper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(OUT, 'papers'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.fenbi.com/spa/tiku', { waitUntil: 'domcontentloaded', timeout: 60000 });

/** 在页面上下文里请求接口（带 cookie，指纹合法） */
async function api(pathAndQuery) {
  const url = 'https://tiku.fenbi.com/api' + pathAndQuery;
  const res = await page.evaluate(async (u) => {
    const r = await fetch(u, {
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' },
    });
    const text = await r.text();
    return { status: r.status, text };
  }, url);
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = { __raw: res.text }; }
  return { status: res.status, json };
}

const common = `app=web&kav=131&av=134&hav=128&apcid=0`;

// ---------- probe ----------
if (PROBE) {
  console.log(`探针 course=${COURSE} label=${LABEL}`);
  const r1 = await api(`/${COURSE}/comptroller/papers?toPage=0&pageSize=1&labelId=${LABEL}&${common}`);
  console.log('  comptroller/papers →', r1.status, 'total=', r1.json?.pageInfo?.totalItem);
  const r2 = await api(`/${COURSE}/papers/v2?labelId=${LABEL}&toPage=0&pageSize=1&${common}`);
  console.log('  papers/v2          →', r2.status, 'total=', r2.json?.pageInfo?.totalItem ?? r2.json?.total ?? '-');
  const r3 = await api(`/${COURSE}/papers?labelId=${LABEL}&toPage=0&pageSize=1&${common}`);
  console.log('  papers             →', r3.status, 'total=', r3.json?.pageInfo?.totalItem ?? r3.json?.total ?? '-');
  await ctx.close();
  process.exit(0);
}

// ---------- 列表 ----------
const index = [];
for (let p = 0; p < PAGES; p++) {
  const { status, json } = await api(`/${COURSE}/comptroller/papers?toPage=${p}&pageSize=${SIZE}&labelId=${LABEL}&${common}`);
  const list = json?.list || [];
  console.log(`  第 ${p} 页 status=${status} 条数=${list.length} 总计=${json?.pageInfo?.totalItem ?? '?'}`);
  for (const x of list) index.push({ paperId: x.id, name: x.name, date: x.date, questions: x.paperMeta?.exerciseCount });
  if (!list.length) break;
  await sleep(DELAY);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n清单：${index.length} 份 → ${OUT}/index.json`);

// ---------- 试卷 ----------
const targets = PAPERS.length ? PAPERS.map((id) => ({ paperId: Number(id) })) : index;

let ok = 0, fail = 0;
for (const t of targets) {
  const id = t.paperId;
  const sDest = path.join(OUT, 'sheets', `${id}.json`);
  if (!fs.existsSync(sDest)) {
    const { status, json } = await api(`/${COURSE}/comptroller/papers/${id}/sheet?${common}`);
    if (status === 200) fs.writeFileSync(sDest, JSON.stringify(json, null, 1));
    else console.log(`  sheet ${id} status=${status}`);
    await sleep(DELAY);
  }
  if (SHEET_ONLY) { ok += 1; continue; }

  const pDest = path.join(OUT, 'papers', `${id}.json`);
  if (fs.existsSync(pDest)) continue;
  let { status, json } = await api(`/${COURSE}/papers/${id}?${common}`);
  if (status !== 200) {
    const alt = await api(`/${COURSE}/universal/questions?paperId=${id}&${common}`);
    if (alt.status === 200) json = { paperId: id, __questions: alt.json };
    status = alt.status;
  }
  if (status === 200) {
    fs.writeFileSync(pDest, JSON.stringify(json, null, 1));
    ok += 1;
  } else {
    fail += 1;
    console.log(`  paper ${id} status=${status}`);
  }
  await sleep(DELAY);
}

console.log(`\n完成 ok=${ok} fail=${fail} → ${OUT}`);
await ctx.close();
