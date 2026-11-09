// 全 App 体检：逐屏走真实入口，采集结构化诊断
import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { EXC: String(r.result.exceptionDetails.exception?.description || '').slice(0, 200) }; return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUDIT = `(() => {
  const v = document.getElementById('view');
  const out = { scrollW: v.scrollWidth, clientW: v.clientWidth, overflowX: v.scrollWidth - v.clientWidth, height: v.scrollHeight };
  const tiny = [];
  v.querySelectorAll('button,[data-act],[data-opt]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 40) tiny.push((el.textContent || el.className || '').trim().slice(0, 14) + '@' + Math.round(r.height));
  });
  out.tiny = tiny.slice(0, 8);
  const clip = [];
  v.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' && el.scrollHeight - el.clientHeight > 6 && el.clientHeight > 0) {
      clip.push((el.className || el.tagName) + ':' + (el.scrollHeight - el.clientHeight));
    }
  });
  out.clip = clip.slice(0, 8);
  out.empties = [...v.querySelectorAll('.empty-state')].map((e) => e.textContent.trim().slice(0, 30));
  out.h1 = v.querySelector('h1,.page-title')?.textContent?.trim();
  return out;
})()`;

const steps = [
  ['首页', `(async()=>{closeSheet(); await loadHome(); go('home');})()`],
  ['题库', `(async()=>{closeSheet(); await openLibrary('公务员·行测');})()`],
  ['考点', `(async()=>{closeSheet(); openKeypoints();})()`],
  ['搜索', `(async()=>{closeSheet(); openSearch();})()`],
  ['回顾-错题', `(async()=>{closeSheet(); await loadReview('wrong');})()`],
  ['回顾-收藏', `(async()=>{closeSheet(); await loadReview('fav');})()`],
  ['回顾-笔记', `(async()=>{closeSheet(); await loadReview('notes');})()`],
  ['考试', `(async()=>{closeSheet(); await refreshStats(); go('exam');})()`],
  ['我的', `(async()=>{closeSheet(); await refreshStats(); go('me');})()`],
  ['统计', `(async()=>{closeSheet(); S.meView='stats'; go('me');})()`],
  ['报告', `(async()=>{closeSheet(); S.meView='report'; go('me');})()`],
  ['时政', `(async()=>{closeSheet(); await openPolitics();})()`],
  ['AI', `(async()=>{closeSheet(); await openAi();})()`],
];

const rows = [];
for (const [name, expr] of steps) {
  await ev(expr); await sleep(1400);
  const a = await ev(AUDIT);
  await ev(`closeSheet();`);
  rows.push({ name, ...a });
}
console.log(JSON.stringify(rows, null, 1));
ws.close();
