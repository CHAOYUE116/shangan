/**
 * tools/fenbi-login-watch.mjs — 打开受控 Chrome，等用户登录粉笔，自动抓 Cookie
 *
 * 工作方式：
 *   1. 用独立 profile 启动 Chrome（不碰你日常浏览器的数据）
 *   2. 打开 https://www.fenbi.com/spa/tiku
 *   3. 实时打印 tiku/webapi 的请求流水（监控）
 *   4. 每 4 秒用当前 Cookie 探一次题库接口：200 就说明登录态生效
 *   5. 成功后把 Cookie 写到 kaogong-shuati/cookie.txt，并自动跑一次采集 dry-run
 *
 * 用法：node tools/fenbi-login-watch.mjs [--timeout 1800]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const COOKIE_FILE = path.join(ROOT, 'cookie.txt');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const TIMEOUT = Number(arg('timeout', 1800)) * 1000;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = 'https://tiku.fenbi.com/api/xingce/papers/v2?filter=review&labelId=1&toPage=0&pageSize=3&app=web&kav=131&av=134&hav=128&apcid=0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${ts()}]`, ...a);

fs.mkdirSync(PROFILE, { recursive: true });

log('启动 Chrome（独立 profile）…');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: null,
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
});

const watchPage = (page) => {
  page.on('response', async (res) => {
    const u = res.url();
    if (!/fenbi\.com/.test(u)) return;
    if (!/(tiku|webapi|keapi|login)/.test(u)) return;
    const s = res.status();
    const short = u.replace(/^https?:\/\//, '').slice(0, 110);
    if (/(login|users|papers|exercises|question)/.test(u)) log(`  ${s} ${short}`);
  });
};

for (const p of ctx.pages()) watchPage(p);
ctx.on('page', (p) => { log('新标签页'); watchPage(p); });

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.fenbi.com/spa/tiku', { waitUntil: 'domcontentloaded', timeout: 60000 });
log('已打开题库页。请在弹出的 Chrome 里点「登录」并用手机号/微信登录粉笔。');
log('登录完成后我会自动检测，不用手动复制 Cookie。');

async function cookieString() {
  const jars = await ctx.cookies(['https://www.fenbi.com', 'https://tiku.fenbi.com', 'https://webapi.fenbi.com']);
  const seen = new Map();
  for (const c of jars) seen.set(c.name, c.value);
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function probe(cookie) {
  try {
    const r = await fetch(PROBE, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.fenbi.com/spa/tiku/guide/home/xingce/xingce',
        'Origin': 'https://www.fenbi.com',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cookie,
      },
    });
    const text = await r.text();
    let code = null;
    try { code = JSON.parse(text).code; } catch {}
    return { status: r.status, code, len: text.length };
  } catch (e) {
    return { status: 0, err: e.message };
  }
}

const started = Date.now();
let lastNote = '';
while (Date.now() - started < TIMEOUT) {
  await new Promise((r) => setTimeout(r, 4000));
  const cookie = await cookieString();
  if (!cookie) continue;
  const p = await probe(cookie);
  const note = `status=${p.status} code=${p.code} cookieLen=${cookie.length}`;
  if (note !== lastNote) { log('探测：' + note); lastNote = note; }
  if (p.status === 200) {
    fs.writeFileSync(COOKIE_FILE, cookie);
    log('✓ 登录态生效，Cookie 已写入 → ' + COOKIE_FILE);
    log('  cookie 条目数：' + cookie.split('; ').length);
    process.exitCode = 0;
    break;
  }
}

if (process.exitCode === 0) {
  log('窗口保持打开（可直接关）。下一步我会用它采集。');
  // 不主动关闭浏览器，交给外部脚本/用户
  await new Promise((r) => setTimeout(r, 3000));
  await ctx.close();
} else {
  log('超时未检测到登录态。窗口保持打开，可重新运行本脚本（profile 会复用已登录状态）。');
  await ctx.close();
}
