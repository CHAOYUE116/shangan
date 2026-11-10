import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const OUT = 'C:/Users/admin/Documents/deepseek-harness/default-workspace/walk';
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
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) {
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    return name;
  }
  return 'FAIL:' + name;
};

// 每屏量：横向溢出、可点元素最小高度、被裁内容、可见文案摘要
const metrics = `(() => {
  const de = document.documentElement;
  const taps = [...document.querySelectorAll('button,[data-act],[data-jump],[data-opt]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(e => ({ t: (e.dataset.act || e.id || e.textContent.trim().slice(0, 12)), h: Math.round(e.getBoundingClientRect().height) }));
  const small = taps.filter(x => x.h < 40).slice(0, 6);
  const clipped = [...document.querySelectorAll('*')].filter(e => e.scrollHeight - e.clientHeight > 30 && getComputedStyle(e).overflow === 'hidden').length;
  return { overflowX: de.scrollWidth - de.clientWidth, small, clipped, view: (document.querySelector('#view')||document.body).innerText.trim().slice(0, 120).replace(/\\n+/g, ' | ') };
})()`;

const steps = [
  ['01-home', `(async()=>{closeSheet(); await loadHome(); go('home');})()`],
  ['02-lib-xc', `(async()=>{S.lib.subject='公务员·行测'; await openLibrary('公务员·行测');})()`],
  ['03-lib-gj', `(async()=>{await openLibrary('事业编·公基');})()`],
  ['04-papers', `(async()=>{S.lib.subject='公务员·行测'; S.lib.view='papers'; await loadPapers(); go('library');})()`],
  ['05-paper-sheet', `(()=>{const el=document.querySelector('[data-act="paper"]'); if(el) el.click(); return 'clicked'})()`],
  ['06-practice', `(async()=>{closeSheet(); const qs=await api('/api/practice?subject='+encodeURIComponent('公务员·行测')+'&chapter='+encodeURIComponent('资料分析')+'&n=5'); startPractice(qs,'资料分析','公务员·行测','random');})()`],
  ['07-answercard', `(()=>{openAnswerCard(); return 1})()`],
  ['08-exam', `(async()=>{closeSheet(); S.examResult=null; await refreshStats(); go('exam');})()`],
  ['09-exam-hist', `(()=>{openExamHistory(); return 1})()`],
  ['10-plan', `(async()=>{closeSheet(); S.planView=true; go('exam');})()`],
  ['11-review', `(async()=>{S.planView=false; await loadReview('wrong'); go('review');})()`],
  ['12-me', `(async()=>{S.meView='main'; await refreshStats(); go('me');})()`],
  ['13-stats', `(async()=>{S.meView='stats'; await refreshStats(); go('me');})()`],
  ['14-report', `(async()=>{S.meView='report'; go('me');})()`],
  ['15-politics', `(async()=>{await loadPolitics(true); openPolitics();})()`],
  ['16-pol-detail', `(()=>{const el=document.querySelector('[data-act="politics-open"]'); if(el) el.click(); return 'clicked'})()`],
  ['17-library-kb', `(async()=>{closeSheet(); S.tab='home'; openLibrary('资料库');})()`],
  ['18-search', `(async()=>{closeSheet(); openSearch();})()`],
  ['19-ai', `(async()=>{closeSheet(); await openAi();})()`],
  ['20-data', `(async()=>{S.meView='backup'; go('me');})()`],
];

const report = {};
for (const [name, js] of steps) {
  const r = await ev(js);
  await sleep(900);
  const m = await ev(metrics);
  await shot(name);
  report[name] = { nav: String(r).slice(0, 60), ...(typeof m === 'object' ? m : { err: m }) };
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
ws.close();
