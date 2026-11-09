import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 300); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('renderDataPage:', await ev(`(() => {
  try {
    const h = renderDataPage();
    const acts = h.match(/data-act="[a-z-]+"/g) || [];
    return JSON.stringify({ len: h.length, acts: acts.slice(0, 10) });
  } catch (e) { return 'ERR ' + e.message; }
})()`));

await ev(`S.meView='backup'; go('me');`);
await sleep(600);
console.log('meView now:', await ev(`S.meView`));
console.log('acts on screen:', await ev(`JSON.stringify([...document.querySelectorAll('[data-act]')].map(e=>e.dataset.act).slice(0,10))`));
console.log('view html len:', await ev(`document.getElementById('view').innerHTML.length`));
ws.close();
