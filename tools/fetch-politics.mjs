#!/usr/bin/env node
/**
 * tools/fetch-politics.mjs — 抓取粉笔「时政热点」专栏（时政汇总）
 *
 * 数据源（纯 HTTP，不需要登录）：
 *   1) 分组列表  https://webapi.fenbi.com/doc/api/wwwcms/get/exams_preparation_materials_groups
 *      → datas[].id=12 是「时政热点」，articles[] 每篇带 contentURL + issueTime
 *   2) 文章正文  https://hera-webapp.fenbi.com/api/article/detail?id=xxx
 *      → 前端渲染的 HTML 页面，需要浏览器取 innerText
 *
 * 输出：dist/release/politics.json（App 通过 manifest 拉取）
 *
 * 用法：
 *   node tools/fetch-politics.mjs             抓最新 10 篇
 *   node tools/fetch-politics.mjs --limit 30
 *   node tools/fetch-politics.mjs --merge     与已有文件合并（按 id 去重，保留历史）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', 'dist', 'release', 'politics.json');
const PROFILE = path.resolve(ROOT, '..', 'research', 'politics-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 10));
const MERGE = argv.includes('--merge');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const Q = 'app=web&av=100&hav=100&kav=100&apcid=0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 分组 → 时政热点 ----------
console.log('① 拉分组列表…');
const gr = await fetch(`https://webapi.fenbi.com/doc/api/wwwcms/get/exams_preparation_materials_groups?${Q}`, { headers: { 'User-Agent': UA } });
const gj = await gr.json();
const group = (gj.datas || []).find((g) => g.id === 12) || (gj.datas || []).find((g) => /时政/.test(g.name));
if (!group) { console.error('✗ 没找到时政分组'); process.exit(1); }

const arts = (group.articles || []).slice(0, LIMIT);
console.log(`   分组「${group.name}」 取 ${arts.length} 篇`);

// ---------- 2. 逐篇取正文 ----------
console.log('② 打开浏览器取正文…');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

const items = [];
for (let i = 0; i < arts.length; i++) {
  const a = arts[i];
  const id = String(a.id);
  try {
    await page.goto(a.contentURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout ? await page.waitForTimeout(1500) : await sleep(1500);
    const got = await page.evaluate(() => {
      let best = null, len = 0;
      document.querySelectorAll('div,article,section').forEach((e) => {
        const t = (e.innerText || '').trim();
        if (t.length > len && t.length < 60000) { len = t.length; best = e; }
      });
      return { text: best ? best.innerText.trim() : '', html: best ? best.innerHTML : '' };
    });
    if (!got.text || got.text.length < 100) {
      console.log(`  [${i + 1}/${arts.length}] ${a.title.slice(0, 30)} —— 正文为空，跳过`);
      continue;
    }
    // 正文第一行通常是标题，去掉重复
    const lines = got.text.split('\n').map((s) => s.trim()).filter(Boolean);
    const title = String(a.title || lines[0] || '').trim();
    const body = lines[0] === title ? lines.slice(1).join('\n') : lines.join('\n');
    items.push({
      id,
      title,
      date: a.issueTime ? new Date(a.issueTime).toISOString().slice(0, 10) : '',
      summary: body.slice(0, 120).replace(/\s+/g, ' '),
      text: body,
      url: a.contentURL,
      chars: body.length,
    });
    console.log(`  [${i + 1}/${arts.length}] ✓ ${title.slice(0, 36)}  ${body.length} 字`);
  } catch (e) {
    console.log(`  [${i + 1}/${arts.length}] ✗ ${a.title.slice(0, 30)} —— ${e.message.slice(0, 50)}`);
  }
  await sleep(800);
}
await ctx.close();

// ---------- 3. 合并 + 写文件 ----------
let merged = items;
if (MERGE && fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const byId = new Map();
    for (const x of old.items || []) byId.set(String(x.id), x);
    for (const x of items) byId.set(String(x.id), x);
    merged = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    console.log(`\n合并旧数据：${(old.items || []).length} 篇 → 共 ${merged.length} 篇`);
  } catch { /* 忽略 */ }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  schema: 1,
  updatedAt: new Date().toISOString(),
  source: 'fenbi.com 时政热点',
  count: merged.length,
  items: merged,
}, null, 1));

console.log(`\n✓ 写入 ${OUT}  ${merged.length} 篇`);
if (merged[0]) console.log(`  最新：${merged[0].date} ${merged[0].title}`);
