// 通用 CDP 求值：node tools/cdp-eval.mjs "<expression>" [--json]
// 连模拟器里 WebView 的调试端口（先 adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>）
const expr = process.argv[2];
if (!expr) { console.error('用法: node tools/cdp-eval.mjs "<表达式>"'); process.exit(1); }

const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.webSocketDebuggerUrl);
if (!page) { console.error('没有可调试的页面'); process.exit(1); }

const WS = globalThis.WebSocket;
if (!WS) { console.error('当前 Node 没有内置 WebSocket（需要 22+）'); process.exit(1); }
const ws = new WS(page.webSocketDebuggerUrl);

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时')), 60000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 55000 },
    }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id !== 1) return;
    clearTimeout(timer);
    ws.close();
    resolve(msg.result);
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 错误')); };
});

try {
  const r = await done;
  if (r.exceptionDetails) {
    console.log('EXCEPTION:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    process.exit(2);
  }
  const v = r.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(3);
}
