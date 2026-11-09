import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description||'').slice(0,240); return r.result?.result?.value; };
console.log(await ev(`(async()=>{
  let n=0, err='';
  for (let k=0;k<8;k++){
    const qs = await api('/api/practice?subject='+encodeURIComponent('公务员·行测')+'&n=10&mock=0&year=10&difficulty=random');
    for (let i=0;i<qs.length;i++){
      const q=qs[i];
      const ok=(i+k)%3!==0;
      try{ await api('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:q.id,subject:'公务员·行测',chapter:q.chapter,type:q.type,selected:[0],correct:ok,costMs:40000+Math.random()*30000,paperId:q.paperId})}); n++; }
      catch(e){ err=e.message; }
    }
  }
  const s=await api('/api/records/stats');
  return JSON.stringify({inserted:n, err, total:s.total, correct:s.correct, wrong:s.wrong, rate:s.rate, days:(s.last7||[]).length});
})()`));
ws.close();
