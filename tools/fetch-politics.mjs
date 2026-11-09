#!/usr/bin/env node
/**
 * tools/fetch-politics.mjs — 抓取粉笔「时政热点」专栏（时政汇总 + 模拟演练题）
 *
 * 为什么不再用浏览器：
 *   旧版用 Playwright 取页面 innerText，结果把评论区（用户名/打卡/时间）和
 *   「下载粉笔App」引导语一起抓进了正文。其实文章 HTML 是服务端直出的，
 *   评论区是 Angular 前端渲染的 —— 直接 HTTP 拿 HTML 再按标签切段落，
 *   既干净又快（10 篇从 ~40 秒降到 ~3 秒），也好做定时任务。
 *
 * 数据源：
 *   1) 分组列表 https://webapi.fenbi.com/doc/api/wwwcms/get/exams_preparation_materials_groups
 *      → datas[] 里 id=12 是「时政热点」，articles[] 每篇带 id / title / contentURL / issueTime
 *   2) 文章正文 https://hera-webapp.fenbi.com/api/article/detail?id=xxx
 *      → 服务端直出 HTML：正文 + 「模拟演练」几道单选 + 「参考答案：A、A、C」
 *
 * 输出：dist/release/politics.json
 *   items[] { id, title, date, summary, text, practice[], url, chars }
 *   practice[] { no, stem, options[], answer }   answer 是 'A'/'B'… 没有就是 ''
 *
 * 用法：
 *   node tools/fetch-politics.mjs                 抓最新 10 篇
 *   node tools/fetch-politics.mjs --limit 30
 *   node tools/fetch-politics.mjs --merge         与已有文件合并（按 id 去重）
 *   node tools/fetch-politics.mjs --dry            只在终端打印，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', 'dist', 'release', 'politics.json');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 10));
const MERGE = argv.includes('--merge');
const DRY = argv.includes('--dry');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const Q = 'app=web&av=100&hav=100&kav=100&apcid=0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTML → 干净的行 ---------- */
function htmlToLines(html) {
  let s = html;
  // 先把「模拟演练」之前的正文和之后分开处理，这里只做通用清洗
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<img[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|section|div|h1|h2|h3|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”');
  return s
    .split('\n')
    .map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    // 评论区是 Angular 前端渲染的，HTML 里只剩模板占位符，清掉免得混进正文
    .map((x) => x.replace(/\{\{[\s\S]*?\}\}/g, '').trim())
    .filter((x) => x && !/^\d+">$/.test(x));
}

/* ---------- 正文里那些没用的行 ---------- */
const DROP = [
  /^最新评论$/,
  /^下载粉笔App/,
  /^查看更多/,
  /^展开全文$/,
  /^时政热点$/,
];

/* ---------- 解析「模拟演练」 ---------- */
function parsePractice(lines) {
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^参考答案/.test(line)) break;
    const qno = line.match(/^(\d{1,2})\s*[.．、]\s*(.*)$/);
    if (qno) {
      if (cur) out.push(cur);
      cur = { no: Number(qno[1]), stem: qno[2].trim(), options: [], answer: '' };
      continue;
    }
    const opt = line.match(/^([A-H])\s*[.．、]\s*(.*)$/);
    if (opt && cur) {
      cur.options.push(opt[2].trim());
      continue;
    }
    if (cur && !cur.options.length) {
      // 题干被拆成多行（【单选】很长时常见）
      cur.stem = (cur.stem ? cur.stem + ' ' : '') + line;
    }
  }
  if (cur) out.push(cur);
  for (const q of out) q.stem = q.stem.replace(/^【(单选|多选|判断)】\s*/, '').trim();
  // 参考答案
  const ansLine = lines.find((l) => /^参考答案/.test(l)) || '';
  const letters = (ansLine.match(/[A-H]/g) || []);
  out.forEach((q, i) => { if (letters[i]) q.answer = letters[i]; });
  return out.filter((q) => q.stem && q.options.length >= 2);
}

/* ---------- 单篇 ---------- */
async function fetchOne(a) {
  const url = a.contentURL || `https://hera-webapp.fenbi.com/api/article/detail?id=${a.id}`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const lines = htmlToLines(html).filter((l) => !DROP.some((re) => re.test(l)));

  const cut = lines.indexOf('模拟演练');
  const bodyLines = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\d{1,3}$/.test(l) || true);
  const practice = cut >= 0 ? parsePractice(lines.slice(cut + 1)) : [];

  // 第一行通常是「时政热点 1 xxx」，把栏目标题去掉
  const title = String(a.title || '').trim();
  let body = bodyLines.join('\n');
  body = body.replace(/^时政热点\s*\d*\s*\n?/, '').trim();

  return {
    id: String(a.id),
    title,
    date: a.issueTime ? new Date(a.issueTime).toISOString().slice(0, 10) : '',
    summary: body.slice(0, 120).replace(/\s+/g, ' '),
    text: body,
    practice,
    url,
    chars: body.length,
  };
}

/* ---------- main ---------- */
console.log('① 拉分组列表…');
const gr = await fetch(`https://webapi.fenbi.com/doc/api/wwwcms/get/exams_preparation_materials_groups?${Q}`, { headers: { 'User-Agent': UA } });
const gj = await gr.json();
const group = (gj.datas || []).find((g) => g.id === 12) || (gj.datas || []).find((g) => /时政/.test(g.name));
if (!group) { console.error('✗ 没找到时政分组'); process.exit(1); }
const arts = (group.articles || []).slice(0, LIMIT);
console.log(`   分组「${group.name}」 取 ${arts.length} 篇`);

console.log('② 逐篇取正文（纯 HTTP）…');
const items = [];
for (let i = 0; i < arts.length; i++) {
  const a = arts[i];
  try {
    const it = await fetchOne(a);
    if (!it.text || it.text.length < 100) { console.log(`  [${i + 1}/${arts.length}] 正文过短，跳过 ${it.title.slice(0, 30)}`); continue; }
    items.push(it);
    const pq = it.practice.length ? ` + ${it.practice.length} 题` : '';
    console.log(`  [${i + 1}/${arts.length}] ✓ ${it.title.slice(0, 34)}  ${it.chars} 字${pq}`);
  } catch (e) {
    console.log(`  [${i + 1}/${arts.length}] ✗ ${String(a.title).slice(0, 30)} —— ${e.message.slice(0, 60)}`);
  }
  await sleep(300);
}

let merged = items;
if (MERGE && fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const byId = new Map();
    for (const x of old.items || []) byId.set(String(x.id), x);
    for (const x of items) byId.set(String(x.id), x);
    merged = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    console.log(`\n合并旧数据：${(old.items || []).length} 篇 → 共 ${merged.length} 篇`);
  } catch { /* 忽略 */ }
}

if (DRY) {
  console.log('\n--- dry run，不写文件 ---');
  const first = merged[0];
  if (first) {
    console.log('标题', first.title);
    console.log('尾部 300 字:', JSON.stringify(first.text.slice(-300)));
    console.log('练习:', JSON.stringify(first.practice.slice(0, 2), null, 1));
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  schema: 2,
  updatedAt: new Date().toISOString(),
  source: 'fenbi.com 时政热点',
  count: merged.length,
  items: merged,
}, null, 1));

const withP = merged.filter((x) => (x.practice || []).length).length;
console.log(`\n✓ 写入 ${OUT}  ${merged.length} 篇（${withP} 篇带模拟演练）`);
if (merged[0]) console.log(`  最新：${merged[0].date} ${merged[0].title}`);
