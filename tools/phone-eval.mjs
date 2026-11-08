#!/usr/bin/env node
/**
 * phone-eval.mjs — 真机 WebView 快速执行 JS（CDP，不截图）
 *
 * 前置：debug APK（WebView debugging 已开启）、adb 连接。
 * 用法：
 *   node tools/phone-eval.mjs "document.title"
 *   node tools/phone-eval.mjs --pkg com.kaogong.shangan "document.querySelectorAll('.subject-row').length"
 *   SERIAL=192.168.31.241:38931 node tools/phone-eval.mjs "(async()=>{...})()"
 */
import { execFileSync } from 'node:child_process';

const ADB = process.env.ADB || 'D:/dev/android/platform-tools/adb.exe';
const SERIAL = process.env.SERIAL || '192.168.31.241:38931';
const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PKG = getArg('--pkg', 'com.kaogong.shangan');
const PORT = Number(getArg('--port', 9224));
const EXPR = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--pkg' && argv[argv.indexOf(a) - 1] !== '--port') || 'document.title';

function adb(args) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).toString();
}

const pid = adb(['shell', 'pidof', PKG]).trim();
if (!pid) { console.error('App 未运行:', PKG); process.exit(1); }
const unix = adb(['shell', 'cat', '/proc/net/unix']);
const sock = (unix.match(/webview_devtools_remote_\d+/) || [])[0];
if (!sock) { console.error('未找到 WebView devtools socket（需要 debug 包）'); process.exit(1); }
try { adb(['forward', `tcp:${PORT}`, `localabstract:${sock}`]); } catch (e) { console.error('adb forward 失败', e.message); process.exit(1); }

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const page = targets.find((t) => t.type === 'page') || targets[0];
if (!page) { console.error('没有可调试页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const result = await new Promise((resolve, reject) => {
  const id = 1;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== id) return;
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  };
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression: EXPR, awaitPromise: true, returnByValue: true, userGesture: true },
  }));
  setTimeout(() => reject(new Error('CDP 超时')), 15000);
});
ws.close();
const r = result && result.result;
if (result && result.exceptionDetails) {
  console.log(JSON.stringify({ ok: false, exception: result.exceptionDetails.text, description: result.exceptionDetails.exception?.description }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify({ ok: true, url: page.url, value: r ? r.value : null }, null, 2));
