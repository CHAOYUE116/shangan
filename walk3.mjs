import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const OUT = 'C:/Users/admin/Documents/deepseek-harness/default-workspace/walk3';
fs.mkdirSync(OUT, { recursive: true });

const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 140);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); return true; }
  return false;
};
const RESET = `(()=>{ const c=document.querySelector('#p-close'); if(c && getComputedStyle(document.querySelector('#practice')).display!=='none') c.click(); const s=document.querySelector('#sheet'); if(s && !s.hidden) { const x=s.querySelector('[data-close],.sheet-x,#sheet-close'); if(x) x.click(); } return 'ok'; })()`;
const metrics = `(() => {
  const de = document.documentElement;
  const pr = document.querySelector('#practice');
  const prOn = pr ? getComputedStyle(pr).display !== 'none' : false;
  const taps = [...document.querySelectorAll('button,[data-act]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(e => ({ t: (e.dataset.act || e.id || e.textContent.trim().slice(0,10)), h: Math.round(e.getBoundingClientRect().height) }));
  return { overflowX: de.scrollWidth - de.clientWidth, practiceOn: prOn, small: taps.filter(x=>x.h<40).slice(0,5),
           text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,140) };
})()`;

const steps = [
  ['01-home', `(async()=>{ await loadHome(); go('home'); })()`],
  ['02-lib-xc', `(async()=>{ await openLibrary('公务员·行测'); })()`],
  ['03-lib-gj', `(async()=>{ await openLibrary('事业编·公基'); })()`],
  ['04-papers', `(async()=>{ await openLibrary('公务员·行测'); S.lib.view='papers'; await loadPapers('公务员·行测'); go('library'); })()`],
  ['05-paper-sheet', `(()=>{ const el=document.querySelector('[data-act="paper"]'); if(el){el.click(); return 'clicked';} return 'no-el'; })()`],
  ['06-practice', `(async()=>{ const r=await api('/api/practice?subject='+encodeURIComponent('公务员·行测')+'&n=6'); startPractice(r,'随机练习','公务员·行测','random'); return 'n='+(r||[]).length; })()`],
  ['07-answered', `(()=>{ const o=document.querySelector('[data-opt]'); return o? (o.click(), 'clicked') : 'no-opt'; })()`],
  ['08-answercard', `(()=>{ const b=document.querySelector('#p-card-btn'); if(b){b.click(); return 'opened';} return 'no-btn'; })()`],
  ['09-exam', `(async()=>{ S.examResult=null; S.planView=false; await refreshStats(); go('exam'); })()`],
  ['10-exam-hist', `(()=>{ const el=document.querySelector('[data-act="exam-history"]'); if(el){el.click(); return 'clicked';} return 'no-el'; })()`],
  ['11-plan', `(async()=>{ S.planView=true; go('exam'); })()`],
  ['12-review', `(async()=>{ S.planView=false; await loadReview('wrong'); go('review'); })()`],
  ['13-review-fav', `(async()=>{ await loadReview('fav'); go('review'); })()`],
  ['14-me', `(async()=>{ S.meView='main'; await refreshStats(); go('me'); })()`],
  ['15-stats', `(async()=>{ S.meView='stats'; go('me'); })()`],
  ['16-report', `(async()=>{ S.meView='report'; go('me'); })()`],
  ['17-politics', `(async()=>{ S.meView='main'; go('home'); await loadPolitics(true); openPolitics(); })()`],
  ['18-pol-detail', `(()=>{ const el=document.querySelector('[data-act="politics-open"]'); if(el){el.click(); return 'clicked';} return 'no-el'; })()`],
  ['19-search', `(async()=>{ openSearch(); })()`],
  ['20-ai', `(async()=>{ await openAi(); })()`],
  ['21-data', `(async()=>{ S.meView='backup'; go('me'); })()`],
];

const report = {};
for (const [name, js] of steps) {
  await ev(RESET); await sleep(350);
  const r = await ev(js); await sleep(900);
  const m = await ev(metrics); await shot(name);
  report[name] = { nav: String(r).slice(0, 44), ...(typeof m === 'object' ? m : { err: m }) };
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
for (const [k, v] of Object.entries(report)) console.log(k.padEnd(16), v.practiceOn ? 'P' : '·', '|', v.text);
ws.close();
