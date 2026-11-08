#!/usr/bin/env node
/**
 * dev-eval.mjs — 本地 UI 快速查询/点击（不截图、不打包）
 *
 * 自动启动 server.mjs，用 Chrome 打开页面，直接执行 DOM/JS 并返回 JSON。
 *
 * 用法：
 *   node tools/dev-eval.mjs "document.querySelectorAll('.subject-card').length"
 *   node tools/dev-eval.mjs --click-text "事业编·公基" --eval "document.querySelector('#app-title').textContent"
 *   node tools/dev-eval.mjs --text          # 返回当前页面可见文本
 *   node tools/dev-eval.mjs --url http://127.0.0.1:3000 --wait 800 "document.title"
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_PORT || 3000);
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const URL = getArg('--url', `http://127.0.0.1:${PORT}`);
const WAIT = Number(getArg('--wait', 700));
const CLICK = getArg('--click-text', '');
const TEXT = argv.includes('--text');
let EXPR = getArg('--eval', '');
if (!EXPR) {
  for (let i = 0; i < argv.length; i++) {
    if (['--url', '--wait', '--click-text', '--eval'].includes(argv[i])) { i++; continue; }
    if (!argv[i].startsWith('--')) { EXPR = argv[i]; break; }
  }
}
EXPR = EXPR || 'document.title';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

let server = null;
if (!(await alive(URL))) {
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await alive(URL)) break;
  }
  if (!(await alive(URL))) {
    console.error('server 启动失败');
    server.kill();
    process.exit(1);
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(WAIT);

if (CLICK) {
  const loc = page.getByText(CLICK, { exact: false }).first();
  if ((await loc.count()) !== 1) {
    console.error(`点击目标不唯一/不存在: ${CLICK} (count=${await loc.count()})`);
    await browser.close();
    if (server) server.kill();
    process.exit(2);
  }
  await loc.click();
  await page.waitForTimeout(WAIT);
}

let result;
try {
  result = TEXT
    ? await page.evaluate(() => (document.querySelector('#view')?.innerText || document.body.innerText || '').slice(0, 4000))
    : await page.evaluate((expr) => {
      // eslint-disable-next-line no-eval
      const v = eval(expr);
      return v === undefined ? null : v;
    }, EXPR);
} catch (e) {
  result = { error: e.message };
}

console.log(JSON.stringify({
  url: page.url(),
  title: await page.title(),
  result,
  errors,
}, null, 2));
await browser.close();
if (server) server.kill();
process.exit(errors.length ? 1 : 0);
