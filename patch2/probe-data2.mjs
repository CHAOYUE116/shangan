import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 200); return r.result?.result?.value; };

console.log(await ev(`(async () => {
  const t0 = performance.now();
  S.meView = 'backup'; go('me');
  const wait = () => new Promise((r) => setTimeout(r, 100));
  let ms = -1;
  for (let i = 0; i < 100; i++) {
    const host = document.getElementById('bk-host');
    if (host && !host.querySelector('.spinner') && host.querySelector('.data-hero')) { ms = Math.round(performance.now() - t0); break; }
    await wait();
  }
  return JSON.stringify({ filledAfterMs: ms, html: (document.getElementById('bk-host')||{}).innerHTML?.length });
})()`));
ws.close();
