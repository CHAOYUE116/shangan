import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description||'').slice(0,300); return r.result?.result?.value; };
console.log('一条记录:', await ev(`(async()=>{
  const qs = await api('/api/practice?subject='+encodeURIComponent('公务员·行测')+'&n=3&mock=0&year=10&difficulty=random');
  const q=qs[0];
  try {
    const r = await api('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:q.questionId,subject:'公务员·行测',chapter:q.chapter,type:q.type,selected:[0],correct:true,costMs:42000,paperId:q.paperId})});
    return 'ok ' + JSON.stringify(r).slice(0,120);
  } catch(e) { return 'ERR ' + e.message; }
})()`));
console.log('stats 再读:', await ev(`(async()=>{const s=await api('/api/records/stats'); return JSON.stringify(s).slice(0,200)})()`));
ws.close();
