// 扫描粉笔题库分类树：逐个点分类节点，捕获 examcatid + 该分类的卷数
// 用法：node tools/scan-fenbi-cats.mjs --course=syzc
// 输出：research/fenbi-cats-{course}.json
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const COURSE = arg('course', 'syzc');
const OUT = path.resolve(`D:/Projects/上岸APP/research/fenbi-cats-${COURSE}.json`);
const COOKIE_FILE = 'D:/Projects/上岸APP/kaogong-shuati/cookie.txt';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LIST_URL = `https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${COURSE}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
const cookies = raw.split(';').map((kv) => {
  const i = kv.indexOf('=');
  return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: '.fenbi.com', path: '/' };
});
console.log(`注入 ${cookies.length} 条 cookie`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});
await ctx.addCookies(cookies);
const page = await ctx.newPage();

// 拦截 papers/v2 响应，记录 examcatid → total
let lastCats = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('/papers/v2')) return;
  try {
    const j = await res.json();
    const q = new URL(u).searchParams;
    lastCats.push({
      examcatid: q.get('examcatid') || '',
      labelId: q.get('labelId') || '',
      total: j?.pageInfo?.total ?? (Array.isArray(j?.list) ? j.list.length : null),
      names: (j?.list || []).slice(0, 3).map((x) => x.name),
    });
  } catch { /* 非 JSON 忽略 */ }
});

await page.goto(`${LIST_URL}?redirect=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.categories-item', { timeout: 30000 }).catch(() => {});
await sleep(3000);

const labels = await page.$$eval('.categories-item', (els) => els.map((e) => e.innerText.trim()));
console.log(`分类节点 ${labels.length} 个:`, labels.join(' / '));

const result = [];
for (let i = 0; i < labels.length; i++) {
  const name = labels[i];
  lastCats = [];
  try {
    const btn = page.locator('.categories-item').nth(i);
    await btn.click({ timeout: 8000 });
    await sleep(3200);
  } catch (e) {
    console.log(`  [${i}] ${name} 点击失败: ${e.message.slice(0, 60)}`);
    continue;
  }
  const hit = lastCats.filter((x) => x.total != null).sort((a, b) => (b.total || 0) - (a.total || 0))[0];
  result.push({ name, examcatid: hit?.examcatid || '', total: hit?.total ?? null, sample: hit?.names || [] });
  console.log(`  [${i}] ${name.padEnd(12)} examcatid=${hit?.examcatid || '-'}  total=${hit?.total ?? '-'}`);
}

fs.writeFileSync(OUT, JSON.stringify({ course: COURSE, scannedAt: new Date().toISOString(), items: result }, null, 2), 'utf8');
console.log(`\n写出 ${OUT}`);
console.log('按卷数排序：');
for (const r of [...result].sort((a, b) => (b.total || 0) - (a.total || 0))) {
  console.log(`  ${String(r.total ?? '-').padStart(5)}  ${r.name}  (examcatid=${r.examcatid})`);
}
await browser.close();
