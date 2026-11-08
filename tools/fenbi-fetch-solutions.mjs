#!/usr/bin/env node
/**
 * tools/fenbi-fetch-solutions.mjs — 通过"交卷"获取粉笔解析（含原始解析文本）
 *
 * 逆向结论（2026-11-08 实测）：
 *   做题页只给题干+选项；答案在 /{c}/questions?ids= 的 correctAnswer；
 *   **解析只在交卷后**：交卷 → 跳 /ti/exam/solution/{exerciseKey}
 *   → 页面请求 /combine/static/solution?key=... → { solutions: [ {solution, correctAnswer, keypoints, source} ] }
 *
 * 风控注意（实测反馈）：
 *   - 交卷会写入账号做题记录（报告页显示用时/得分），交卷过快可能触发异常
 *   - 本脚本：每题随机作答（模拟真人）+ 页内随机停顿 + 卷间长间隔
 *   - 建议：单次运行 ≤ 30 套，两次运行间隔 ≥ 1 小时；跑完可用 /{c}/exercises/del 清理
 *
 * 用法：
 *   node tools/fenbi-fetch-solutions.mjs --course syzc --label 0 --limit 3 --gap 45
 *   node tools/fenbi-fetch-solutions.mjs --course syzc --label 9170 --limit 20 --gap 60 --pages 2
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.resolve(ROOT, '..', 'research', 'fenbi', 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const COURSE = arg('course', 'syzc');
const LABEL = arg('label', '0');
const PAGES = Number(arg('pages', 1));
const LIMIT = Number(arg('limit', 3));
const GAP = Number(arg('gap', 45));         // 卷间间隔（秒）
const ANSWER_N = Number(arg('answer', 5));  // 每套随机作答几题
const OUT = path.resolve(ROOT, arg('out', `../research/fenbi-solutions/${COURSE}`));
const CAT = arg('cat', null);   // 分类按钮文本：模拟题 / 联考A类 / 联考B类 …（不传=默认分类）
const DEBUG = argv.includes('--debug');    // 保存交卷页 HTML 快照（调 DOM 抓取用）
// 综应走 shenlunList 入口，其余走 realTest
const LIST_URL = arg('list',
  (COURSE === 'zhyynl' || COURSE === 'shenlun')
    ? `https://www.fenbi.com/spa/tiku/guide/shenlunList/${COURSE}/1000`
    : `https://www.fenbi.com/spa/tiku/guide/realTest/sydw/${COURSE}`);

fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,                 // 有头，降低行为检测风险
  viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

// 交卷后要抓的全套：题目解析 / 作答记录 / 报告 / 讲解视频 / 卡片开关
let caps = {};
const CAP_PATTERNS = [
  ['staticSolution', /\/combine\/static\/solution/],
  ['getSolution', /\/combine\/exercise\/getSolution/],
  ['getReport', /\/combine\/exercise\/getReport/],
  ['episodes', /tiku_episodes_with_multi_type/],
  ['cards', /report_display_cards/],
  ['meta', /\/combine\/question\/getMeta/],
];
page.on('response', async (res) => {
  const u = res.url();
  const hit = CAP_PATTERNS.find(([, re]) => re.test(u));
  if (!hit) return;
  try {
    const b = await res.body();
    if (b.length < 80) return;
    caps[hit[0]] = b.toString('utf8');
  } catch {}
});

// 列表项选择器：职测/公基是 .paper-item，综应是 .list-item-container
const ITEM_SEL = '.paper-item, .list-item-container';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从卷名推断类别 / 日期 / 地区（粉笔卷名格式很稳定，正则够用） */
const PROVINCES = ['北京', '天津', '上海', '广东', '重庆', '福建', '海南', '广西', '贵州', '甘肃', '河北', '河南', '安徽', '黑龙江', '西藏', '湖北', '湖南', '吉林', '江苏', '江西', '辽宁', '内蒙古', '宁夏', '青海', '山东', '山西', '陕西', '四川', '新疆', '云南', '浙江'];
function inferMeta(name) {
  const s = String(name || '');
  const out = { name: s, category: '其他', region: '', year: null, month: null, day: null };
  const cat = s.match(/联考\s*([A-E])\s*类/);
  if (cat) out.category = `联考${cat[1]}类`;
  else if (/模拟/.test(s)) out.category = '模拟题';
  else if (/辅警/.test(s)) out.category = '辅警';
  const provs = PROVINCES.filter((p) => s.includes(p));
  if (provs.length) { out.region = provs.slice(0, 3).join('/'); if (out.category === '其他') out.category = provs[0]; }
  const d = s.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (d) { out.year = Number(d[1]); out.month = Number(d[2]); out.day = Number(d[3]); }
  const t = s.match(/《([^》]+)》/);
  if (t) out.subject = t[1];
  return out;
}
const jitter = (base, spread = 0.4) => base * (1 + (Math.random() - 0.5) * spread);

console.log(`粉笔解析采集  course=${COURSE} label=${LABEL} limit=${LIMIT} gap=${GAP}s`);
console.log(`输出 ${OUT}\n`);

// ---------- 收集试卷 ----------
const papers = [];
for (let p = 0; p < PAGES; p++) {
  const r = await page.goto(`${LIST_URL}?redirect=true`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!r) { console.log('列表页打开失败'); break; }
  await page.waitForSelector(ITEM_SEL, { timeout: 25000 }).catch(() => {});
  await sleep(1500);
  // 切分类（模拟题 / 联考A类 …）
  if (CAT) {
    const catBtn = page.locator('.categories-item', { hasText: CAT }).first();
    if (await catBtn.count()) {
      await catBtn.click({ timeout: 5000 }).catch(() => {});
      await sleep(jitter(3500));
      await page.waitForSelector(ITEM_SEL, { timeout: 15000 }).catch(() => {});
      console.log(`  已切到分类「${CAT}」`);
    } else {
      console.log(`  未找到分类「${CAT}」`);
    }
  }
  await sleep(1000);
  // 分类只切一次；后续翻页在同一个页面里点「下一页」，不 reload（reload 会回到第 1 页）
  const seenLabels = new Set();
  for (let q = 0; q < PAGES; q++) {
    if (q > 0) {
      const next = page.locator('text=下一页').first();
      if (!(await next.count())) { console.log('  没有下一页了'); break; }
      await next.click({ timeout: 5000 }).catch(() => {});
      await sleep(2200);
    }
    const items = await page.$$eval(ITEM_SEL, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 80)));
    const fresh = items.filter((t) => !seenLabels.has(t));
    fresh.forEach((t) => seenLabels.add(t));
    console.log(`第 ${q + 1} 页 ${items.length} 份（新增 ${fresh.length}）`);
    for (const t of fresh) papers.push(t);
    if (papers.length >= LIMIT) break;
  }
  break;
}
console.log(`候选 ${papers.length} 份\n`);

// ---------- 逐套：进入 → 作答 → 交卷 → 抓解析 ----------
let ok = 0, fail = 0;
for (let i = 0; i < Math.min(LIMIT, papers.length); i++) {
  const label = papers[i];
  console.log(`[${i + 1}/${Math.min(LIMIT, papers.length)}] ${label.slice(0, 50)}`);
  try {
    await page.goto(`${LIST_URL}?redirect=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(ITEM_SEL, { timeout: 25000 }).catch(() => {});
    await sleep(1200);
    if (CAT) {
      const cb = page.locator('.categories-item', { hasText: CAT }).first();
      if (await cb.count()) { await cb.click({ timeout: 5000 }).catch(() => {}); await sleep(jitter(3000)); }
    }
    await sleep(800);
    // 按卷名定位（第 2 页之后的试卷用 index 会越界）
    let hit = null;
    for (let q = 0; q < PAGES; q++) {
      if (q > 0) {
        const nb = page.locator('text=下一页').first();
        if (!(await nb.count())) break;
        await nb.click({ timeout: 5000 }).catch(() => {});
        await sleep(2200);
      }
      const loc = page.locator(ITEM_SEL, { hasText: label.split(' ')[0] }).first();
      if (await loc.count()) { hit = loc; break; }
    }
    if (!hit) { console.log('  页面上找不到这份卷'); fail += 1; continue; }
    await hit.click();
    await sleep(jitter(5000));

    if (!/\/ti\/exam\/exercise\//.test(page.url())) { console.log('  未进入做题页:', page.url()); fail += 1; continue; }
    const exKey = page.url().match(/exercise\/([^?]+)/)?.[1];
    if (fs.existsSync(path.join(OUT, `${exKey}.json`))) { console.log('  已采集过，跳过'); continue; }

    // 随机作答（模拟真人：点选项 + 停顿）
    // 实测选项是 li.choice-radio，每题 4 个，全卷 90×4=360 个
    const opts = await page.$$('.choice-radio');
    let answered = 0;
    if (opts.length >= 4) {
      for (let k = 0; k < ANSWER_N && k * 4 + 3 < opts.length; k++) {
        const pick = opts[k * 4 + Math.floor(Math.random() * 4)];
        await pick.scrollIntoViewIfNeeded().catch(() => {});
        await pick.click({ timeout: 3000 }).catch(() => {});
        answered += 1;
        await sleep(jitter(1100, 0.7));
      }
    }
    console.log(`  作答 ${answered} 次（共 ${opts.length} 个选项节点），准备交卷`);

    // 交卷 + 确认
    caps = {};
    await page.locator('.submit-btn').click({ timeout: 5000 }).catch(() => {});
    await sleep(jitter(1200));
    await page.locator('.modal-action-btn.btn-submit').first().click({ timeout: 5000 }).catch(() => {});
    await sleep(jitter(9000));
    // 报告页还有异步请求（视频/卡片），再多等一会
    await sleep(jitter(5000));

    if (!caps.staticSolution) { console.log('  ✗ 未捕获解析'); fail += 1; }
    else {
      const j = JSON.parse(caps.staticSolution);
      const rec = {
        exerciseKey: exKey,
        name: j.name,
        capturedAt: new Date().toISOString(),
        materials: j.materials,
        solutions: j.solutions,
        card: j.card,
      };
      // 主文件：题目+解析+考点
      fs.writeFileSync(path.join(OUT, `${exKey}.json`), JSON.stringify(rec, null, 1));

      // 卷元数据：从卷名解析出类别/日期/地区，供后续筛选
      const meta = inferMeta(j.name);
      try {
        const pm = await page.evaluate(async (course) => {
          const r = await fetch(`https://tiku.fenbi.com/api/${course}/papers/v2?labelId=0&toPage=0&pageSize=60&app=web`, { credentials: 'include' });
          if (!r.ok) return null;
          const jj = await r.json();
          return (jj.list || []).map((x) => ({ name: x.name, date: x.date, diff: x.paperMeta?.difficulty, avg: x.paperMeta?.averageScore, cnt: x.paperMeta?.exerciseCount }));
        }, COURSE).catch(() => null);
        if (pm) {
          const hit = pm.find((x) => x.name && j.name && (x.name.includes(j.name.slice(0, 20)) || j.name.includes(x.name.slice(0, 20))));
          if (hit) Object.assign(meta, { difficulty: hit.diff, averageScore: hit.avg, doneCount: hit.cnt, flDate: hit.date });
        }
      } catch {}
      fs.writeFileSync(path.join(OUT, `${exKey}.meta.json`), JSON.stringify(meta, null, 1));

      // 附件：作答记录/报告/视频/卡片开关
      const side = {};
      // 逐题全站正确率：只在 DOM 的 app-solution-overall 里（接口 static/solution 不带）
      try {
        const rates = await page.$$eval('app-solution-overall', (els) => els.map((e) => {
          const m = (e.innerText || '').match(/(\d+(?:\.\d+)?)\s*%/);
          return m ? Number(m[1]) : null;
        }));
        if (rates.length) side.accuracy = rates;
      } catch {}
      if (DEBUG) {
        try { fs.writeFileSync(path.join(OUT, `${exKey}.html`), await page.content()); } catch {}
      }
      if (caps.getSolution) { try { side.userAnswers = JSON.parse(caps.getSolution)?.data?.userAnswers; } catch {} }
      if (caps.getReport) { try { const r = JSON.parse(caps.getReport)?.data; side.subReports = r?.subReports; side.shareVO = r?.switchVO?.shareVO; } catch {} }
      if (caps.episodes) { try { side.episodes = JSON.parse(caps.episodes)?.data; } catch {} }
      if (caps.cards) { try { side.reportCards = JSON.parse(caps.cards)?.data; } catch {} }
      if (Object.keys(side).length) {
        fs.writeFileSync(path.join(OUT, `${exKey}.side.json`), JSON.stringify(side, null, 1));
      }

      const nEp = side.episodes ? Object.keys(side.episodes).length : 0;
      const nAns = side.userAnswers ? Object.keys(side.userAnswers).length : 0;
      console.log(`  ✓ ${String(j.name).slice(0, 34)}  ${(j.solutions || []).length} 题  ${(caps.staticSolution.length / 1024).toFixed(0)} KB`);
      console.log(`     附件：作答记录 ${nAns} 条 / 讲解视频 ${nEp} 题 / 报告分区 ${(side.subReports || []).length} 个`);
      ok += 1;
    }
  } catch (e) {
    console.log('  ✗ 失败:', e.message.slice(0, 90));
    fail += 1;
  }
  const wait = jitter(GAP * 1000, 0.5);
  console.log(`  等待 ${(wait / 1000).toFixed(0)}s …\n`);
  await sleep(wait);
}

console.log(`完成 ok=${ok} fail=${fail} → ${OUT}`);
await ctx.close();
