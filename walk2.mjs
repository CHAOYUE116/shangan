import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const OUT = 'C:/Users/admin/Documents/deepseek-harness/default-workspace/walk2';
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
  if (r.result?.exceptionDetails) return 'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 160);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); return true; }
  return false;
};
const RESET = `(async()=>{ try{closeSheet();}catch(e){} try{ if (typeof closePractice==='function') closePractice(); }catch(e){} try{ document.querySelectorAll('.practice-open,#practice.show').forEach(()=>{}); }catch(e){} return 'reset'; })()`;

const metrics = `(() => {
  const de = document.documentElement;
  const taps = [...document.querySelectorAll('button,[data-act],[data-jump]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(e => ({ t: (e.dataset.act || e.id || e.textContent.trim().slice(0, 10)), h: Math.round(e.getBoundingClientRect().height) }));
  const pr = document.querySelector('#practice');
  const prOn = pr ? getComputedStyle(pr).display !== 'none' && pr.getBoundingClientRect().height > 100 : false;
  return {
    overflowX: de.scrollWidth - de.clientWidth,
    small: taps.filter(x => x.h < 40).slice(0, 5),
    practiceOn: prOn,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 150),
  };
})()`;

const steps = [
  ['01-home', `(async()=>{ await loadHome(); go('home'); })()`],
  ['02-lib-xc', `(async()=>{ S.lib.subject='公务员·行测'; await openLibrary('公务员·行测'); })()`],
  ['03-lib-gj', `(async()=>{ await openLibrary('事业编·公基'); })()`],
  ['04-papers', `(async()=>{ S.lib.subject='公务员·行测'; S.lib.view='papers'; await loadPapers(); go('library'); })()`],
  ['05-paper-sheet', `(()=>{ const el=document.querySelector('[data-act="paper"]'); if(el) el.click(); return el? 'clicked':'no-el'; })()`],
  ['06-practice', `(async()=>{ closeSheet(); const r=await api('/api/practice?subject='+encodeURIComponent('公务员·行测')+'&n=6'); startPractice(r,'随机练习','公务员·行测','random'); return (r||[]).length; })()`],
  ['07-answercard', `(()=>{ openAnswerCard(); return 1; })()`],
  ['08-exam', `(async()=>{ closeSheet(); S.examResult=null; S.planView=false; await refreshStats(); go('exam'); })()`],
  ['09-exam-hist', `(()=>{ openExamHistory(); return 1; })()`],
  ['10-plan', `(async()=>{ closeSheet(); S.planView=true; go('exam'); })()`],
  ['11-review', `(async()=>{ S.planView=false; await loadReview('wrong'); go('review'); })()`],
  ['12-review-fav', `(async()=>{ await loadReview('fav'); go('review'); })()`],
  ['13-me', `(async()=>{ S.meView='main'; await refreshStats(); go('me'); })()`],
  ['14-stats', `(async()=>{ S.meView='stats'; go('me'); })()`],
  ['15-report', `(async()=>{ S.meView='report'; go('me'); })()`],
  ['16-politics', `(async()=>{ S.meView='main'; await loadPolitics(true); openPolitics(); })()`],
  ['17-pol-detail', `(()=>{ const el=document.querySelector('[data-act="politics-open"]'); if(el) el.click(); return el?'clicked':'no-el'; })()`],
  ['18-kb', `(async()=>{ closeSheet(); openLibrary('资料库'); })()`],
  ['19-search', `(async()=>{ openSearch(); })()`],
  ['20-ai', `(async()=>{ closeSheet(); await openAi(); })()`],
  ['21-data', `(async()=>{ S.meView='backup'; go('me'); })()`],
];

const report = {};
for (const [name, js] of steps) {
  await ev(RESET);
  await sleep(300);
  const r = await ev(js);
  await sleep(900);
  const m = await ev(metrics);
  const ok = await shot(name);
  report[name] = { nav: String(r).slice(0, 50), shot: ok, ...(typeof m === 'object' ? m : { err: m }) };
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
for (const [k, v] of Object.entries(report)) console.log(k, '|', v.practiceOn ? 'PRACTICE' : '', '|', v.text);
ws.close();
