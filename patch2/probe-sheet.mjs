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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  S.meView = 'backup'; go('me');
  await wait(500);
  const btn = [...document.querySelectorAll('[data-act]')].find((e) => /导出备份/.test(e.textContent));
  btn && btn.click();
  await wait(400);
  const opened = !document.getElementById('sheet').hidden;
  const title = document.querySelector('.sheet-head b')?.textContent;
  go('home');
  await wait(300);
  return JSON.stringify({ exportSheetOpened: opened, title, sheetHiddenAfterGo: document.getElementById('sheet').hidden });
})()`));
ws.close();
