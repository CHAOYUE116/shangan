/**
 * 读粉笔试卷列表页的「分类」按钮，列出所有可采集的 cat 名。
 * 用法：node tools/fenbi-list-cats.mjs --course syzc
 */
import { chromium } from 'playwright-core';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const ROOT = path.resolve(import.meta.dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const COURSE = arg('course', 'syzc');
const LIST_URL = `https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${COURSE}`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(`${LIST_URL}?redirect=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const cats = await page.$$eval('.categories-item', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
console.log(`course=${COURSE}  共 ${cats.length} 个分类：`);
cats.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c}`));

await ctx.close();
