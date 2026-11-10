import WebSocket from 'ws';
const expr = process.argv[2] || '1';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) console.log('EXC', String(r.result.exceptionDetails.exception?.description || '').slice(0, 240));
else { const v = r.result?.result?.value; console.log((v === undefined ? 'undefined' : JSON.stringify(v)).slice(0, 900)); }
ws.close();
