import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 200); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造点真数据，好让各页面都有内容可看
const seed = await ev(`(async()=>{
  const subj='公务员·行测';
  for (let k=0;k<6;k++){
    const qs = await api('/api/practice?subject='+encodeURIComponent(subj)+'&n=8&mock=0&year=10&difficulty=random');
    for (let i=0;i<qs.length;i++){
      const q=qs[i];
      const ok = (i + k) % 3 !== 0;
      try {
        await api('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:q.questionId,subject:subj,chapter:q.chapter,correct:ok,cost:42000,selected:[0],answer:q.answer})});
      } catch(e){}
    }
  }
  try { await api('/api/favorites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:'1001'})}); } catch(e){}
  localStorage.setItem('sg_exam_history_v1', JSON.stringify([
    {ts:Date.now()-3e7,title:'2024年江苏省公务员录用考试《行测》题',subject:'公务员·行测',right:72,total:130,used:6900,kind:'整卷',year:2024,region:'江苏',mods:[]},
    {ts:Date.now()-2e7,title:'2025年江苏省公务员录用考试《行测》题',subject:'公务员·行测',right:85,total:130,used:6600,kind:'整卷',year:2025,region:'江苏',mods:[]},
    {ts:Date.now()-1e7,title:'2025年浙江省公务员录用考试《行测》题',subject:'公务员·行测',right:91,total:130,used:6500,kind:'整卷',year:2025,region:'浙江',mods:[]}
  ]));
  await loadHome();
  go('home');
  return 'seeded';
})()`);
console.log('seed:', seed);
await sleep(1200);
console.log('stats:', await ev(`JSON.stringify(S.stats && {d:S.stats.done,w:S.stats.wrong,rate:S.stats.rate,last7:S.stats.last7})`));
ws.close();
