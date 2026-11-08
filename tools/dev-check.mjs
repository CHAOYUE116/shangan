#!/usr/bin/env node
/**
 * dev-check.mjs — 本地快速 UI 自检（不打包 APK）
 *
 * 自动启动 server.mjs（如果 3000 端口没服务），用 Chrome 移动端视口打开首页，
 * 检查控制台错误、抓关键文本、截图到 dev-screens/。
 *
 * 用法：
 *   node tools/dev-check.mjs
 *   node tools/dev-check.mjs --url http://127.0.0.1:3000
 *   CHROME_PATH=... node tools/dev-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_PORT || 3000);
const URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'dev-screens');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
fs.mkdirSync(OUT, { recursive: true });

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

let server = null;
if (!(await alive(URL))) {
  console.log('启动 server.mjs ...');
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
await page.waitForTimeout(1200);
const home = await page.evaluate(() => ({
  title: document.title,
  h1: document.querySelector('#app-title')?.textContent?.trim() || '',
  text: (document.querySelector('#view')?.innerText || '').slice(0, 400),
}));
await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: true });

// 进入第一个科目
const subject = page.locator('.subject-card:not(.custom-entry)').first();
let subjectInfo = null;
if (await subject.count()) {
  await subject.click();
  await page.waitForTimeout(1000);
  subjectInfo = await page.evaluate(() => ({
    title: document.querySelector('#app-title')?.textContent?.trim() || '',
    text: (document.querySelector('#view')?.innerText || '').slice(0, 300),
  }));
  await page.screenshot({ path: path.join(OUT, 'subject.png'), fullPage: true });
}

console.log(JSON.stringify({ ok: errors.length === 0, errors, home, subject: subjectInfo, out: OUT }, null, 2));
await browser.close();
if (server) server.kill();
process.exit(errors.length ? 1 : 0);
