import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "shots");
const OUT = path.join(ROOT, "report", "APP测试报告-2026-11-13.html");

const img = (name, cap) => {
  const p = path.join(SHOTS, name);
  if (!fs.existsSync(p)) return `<figure><div class="miss">缺图 ${name}</div><figcaption>${cap}</figcaption></figure>`;
  const b64 = fs.readFileSync(p).toString("base64");
  return `<figure><img src="data:image/png;base64,${b64}" alt="${cap}"><figcaption>${cap}</figcaption></figure>`;
};

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>上岸 App 全功能测试报告 · 2026-11-13</title>
<style>
  :root { --ink:#1b1f2a; --sub:#6b7280; --line:#e5e7eb; --bg:#f7f8fa; --red:#d94a3d; --amber:#b7791f; --green:#2f855a; --blue:#3c7cfc; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:900px; margin:0 auto; padding:36px 20px 80px; }
  h1 { font-size:30px; margin:0 0 6px; letter-spacing:-.5px; }
  .meta { color:var(--sub); font-size:13.5px; margin-bottom:26px; }
  h2 { font-size:20px; margin:38px 0 12px; padding-bottom:8px; border-bottom:2px solid var(--ink); }
  h3 { font-size:16.5px; margin:26px 0 8px; }
  p.lead { font-size:15.5px; color:#374151; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:18px 0 8px; }
  .kpi { background:#fff; border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .kpi b { display:block; font-size:22px; }
  .kpi span { color:var(--sub); font-size:12.5px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:14px 0 26px; }
  .tag { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; margin-right:6px; vertical-align:2px; }
  .p0 { background:#fdecea; color:var(--red); }
  .p1 { background:#fdf3e3; color:var(--amber); }
  .p2 { background:#eef2f7; color:#475569; }
  .ok { background:#e8f5ee; color:var(--green); }
  code { background:#f1f3f6; padding:1px 5px; border-radius:5px; font-size:13px; }
  pre { background:#0f172a; color:#e2e8f0; padding:12px 14px; border-radius:10px; overflow:auto; font-size:12.5px; line-height:1.55; }
  figure { margin:14px 0 6px; }
  figure img { width:100%; max-width:380px; display:block; border:1px solid var(--line); border-radius:12px; background:#fff; }
  figcaption { color:var(--sub); font-size:12.5px; margin-top:6px; }
  .miss { padding:20px; border:1px dashed var(--line); border-radius:12px; color:var(--sub); }
  table { width:100%; border-collapse:collapse; font-size:14px; margin:10px 0; }
  th, td { border-bottom:1px solid var(--line); padding:8px 6px; text-align:left; vertical-align:top; }
  th { color:var(--sub); font-weight:600; font-size:13px; }
  ul { padding-left:20px; }
  li { margin:4px 0; }
  .quote { border-left:3px solid var(--blue); padding:2px 0 2px 12px; color:#374151; margin:10px 0; }
</style></head><body><div class="wrap">

<h1>上岸 App 全功能测试报告</h1>
<div class="meta">2026-11-13 · 版本 0.9.9（149）· 题库 0.5.37-20261113-1720 · 模拟器 shangan_test 1080×2400 · 真机逐屏操作（不是看代码）</div>

<p class="lead">这次是真做的：首页点进「今日复习」把 2 道到期题做完 → 点「完成本轮」；回首页点「再练 10 题」把 10 道做完 → 再点「完成本轮」；然后收藏一道题、写一条笔记、切到回顾页看收藏和笔记、进试卷列表、进背题模式、打开检查更新。下面每条问题都带图，图就是当时屏幕。</p>

<div class="kpis">
  <div class="kpi"><b>7</b><span>P0 功能/数据错误</span></div>
  <div class="kpi"><b>6</b><span>P1 体验问题</span></div>
  <div class="kpi"><b>4</b><span>P2 数据质量</span></div>
  <div class="kpi"><b>0</b><span>崩溃 / 白屏</span></div>
</div>

<h2>一、最严重：做完一整轮，看不到成绩</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>结算弹层被自己关掉了</b></p>
  <p>把「加练 10 题」10 道全部做完，最后一题的按钮变成「完成本轮」，点下去以后：练习页关闭，直接回到首页，<b>没有「本轮完成」结算页</b>——正确率、用时、答对几道、考点、错题再练，一个都看不到。</p>
  ${img("qa-21-round-done.png", "点完「完成本轮」之后的屏幕：直接回首页，没有结算")}
  <p>代码上定位到了，不是没做结算，是弹出来立刻被关：</p>
  <pre>// public/next/app.js  finishPractice()
sheet('&lt;div class="sheet-head"&gt;&lt;b&gt;本轮完成&lt;/b&gt;…正确率 / 用时 / 考点 / 错题再练…');
loadHome().then(() =&gt; { if (S.tab === 'home') go('home'); });

// public/next/app.js:3137  go()
function go(tab) {
  // 切页时先收掉弹层
  try { if (document.querySelector('.sheet-wrap:not([hidden])')) closeSheet(); } catch {}
  …
}</pre>
  <p>实测：<code>finishPractice()</code> 返回后 <code>#sheet</code> 是 <code>hidden:true, len:0</code>（被清空）；手动调 <code>sheet('&lt;b&gt;TEST&lt;/b&gt;')</code> 则正常显示（<code>len:42</code>）。也就是说结算页 100% 不会出现。</p>
  <p><b>影响</b>：用户做完一轮没有任何正反馈，也不知道自己错了哪几道 —— 这是留存最低的一环。</p>
  <p><b>改法</b>：<code>go('home')</code> 前不要弹 sheet；或给 <code>go()</code> 加参数 <code>go('home', {keepSheet:true})</code>；或把结算改成页面级视图而不是弹层。</p>
</div>

<h2>二、同一个用户，三处「最弱」三个答案</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>口径不统一</b></p>
  <table>
    <tr><th>页面</th><th>说法</th></tr>
    <tr><td>首页</td><td>最弱的一块：<b>判断推理 10%</b></td></tr>
    <tr><td>学习统计</td><td>最该补：<b>资料分析 0%</b></td></tr>
    <tr><td>学习报告</td><td>先把最弱的「<b>数量关系</b>」补到 50%</td></tr>
  </table>
  ${img("qa-01-home.png", "首页：最弱的一块 判断推理 10%")}
  ${img("qa-09-stats.png", "学习统计：最该补 资料分析 0%（同一时刻）")}
  ${img("qa-10-report.png", "学习报告：先把最弱的「数量关系」补到 50%")}
  <p><b>原因</b>：三处各算一套 —— 统计页按模块正确率取最低（资料分析样本 0 题 → 0%），首页按考点/章节，报告页又是另一套权重。</p>
  <p><b>改法</b>：抽一个 <code>weakestModule()</code>（带最小样本门槛，比如 ≥10 题才参评），三处都调它；样本不足时文案写「样本太少，先做 10 道」。</p>
</div>

<h2>三、雷达图少一根轴，文案还写「六维」</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>政治理论 0 题 → 轴被丢掉</b></p>
  ${img("qa-09-stats.png", "六边形变五边形：只剩 常识/言语/数量/判断/资料；而入口写「六维能力图」")}
  <p><b>改法</b>：六根轴恒定在，没数据的那根画到圆心并把标签置灰；文案与图一致。</p>
</div>

<h2>四、按考点练：一级模块和考点混在一层</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>层级错乱</b></p>
  ${img("qa-04-keypoints.png", "「职测·判断推理 2746 题」和「对应关系 1459 题」平铺同级，只按题量排序；每条都有进度条但不标已做/总数")}
  <p><b>改法</b>：模块当分组标题（或做筛选 chip），下面只挂考点；进度条要么去掉，要么标「已做/总数」。</p>
</div>

<h2>五、题目分类错标</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>片段阅读被标成常识判断</b></p>
  ${img("qa-13-practice.png", "这题是标准言语·片段阅读（「这段文字意在说明」），标签写「常识判断／判断」")}
  <p><b>原因</b>：扫描 id 入库那批按 <code>source</code> 文本正则猜科目，猜不到就落「常识判断」。</p>
  <p><b>改法</b>：强特征题干直接改章节（含「这段文字意在／填入划横线／依次填入」→ 言语理解）。</p>
</div>

<h2>六、判完题解析区是空白</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>没解析时静默留白</b></p>
  ${img("qa-16-analysis.png", "对错、正确答案、考点正确率、易错项都在，解析正文整块不存在")}
  <p>全库可用题 <b>151,402</b> 道里 <b>3,160 道无解析（2.1%）</b>。</p>
  <p><b>改法</b>：解析为空时渲染「本题暂无解析 · 让 AI 讲一遍 →」（AI 入口已有）。</p>
</div>

<h2>七、检查更新：版本比较是反的</h2>
<div class="card">
  <p><span class="tag p0">P0</span><b>本地比清单新，却弹「本地题库版本更新」并给出倒退箭头</b></p>
  ${img("qa-28-update.png", "题库版本：0.5.37-20261113-1720 → 0.5.30-20261113-0235（从新到旧），文案「无需更新」")}
  <p><b>改法</b>：按语义化版本逐段比较（0.5.37 &gt; 0.5.30），本地更新时只提示「已是最新」并隐藏箭头。</p>
</div>

<h2>八、P1 体验问题</h2>
<div class="card">
  <table>
    <tr><th>#</th><th>问题</th><th>证据</th></tr>
    <tr><td>P1-1</td><td>同一句话出现两次：Hero「复习 4 道到期题」+ 下面黄条「再复习 4 道到期题」</td><td>${img("qa-01-home.png", "首页：上下两条讲同一件事")}</td></tr>
    <tr><td>P1-2</td><td>「最弱的一块：判断推理」与「今日重点：判断推理、数量关系」信息重叠</td><td>同上</td></tr>
    <tr><td>P1-3</td><td>Hero 标题说「复习 4 道」，副行是「今日 21 题 · 目标已完成」，进度条满格 —— 语义冲突</td><td>同上</td></tr>
    <tr><td>P1-4</td><td>复习页模块 chip 换行（「判断推理」折两行），四张卡高度不齐</td><td>${img("qa-05-review.png", "回顾页 chips")}</td></tr>
    <tr><td>P1-5</td><td>试卷筛选：地区/年份 chips 溢出屏幕，无横滑提示，末尾被切</td><td>${img("qa-03-papers.png", "筛选试卷")}</td></tr>
    <tr><td>P1-6</td><td>「背题」模式题量 31,020，与「做题」46,873 差距大且无说明（大概率是只算有解析的题）</td><td>${img("qa-26-recite.png", "背题模式头部：共 31020 题")}</td></tr>
  </table>
</div>

<h2>九、P2 数据质量</h2>
<div class="card">
  <ul>
    <li>可用题 <b>151,402</b> 中无解析 <b>3,160（2.1%）</b></li>
    <li>图形推理可做只剩 <b>103 道</b>（选项图是 A/B/C/D 的 4,303 道已隔离，粉笔源头无图）</li>
    <li>「其他」桶仍偏大：言语 3,488 / 判断 289 / 公基各模块数百～3,000+</li>
    <li>启动时控制台：<code>sw-local.js 404</code> → ServiceWorker 注册失败（弱网/离线时图片可能取不到）</li>
  </ul>
</div>

<h2>十、这些是真正常工作的（我逐个点过）</h2>
<div class="card">
  <p><span class="tag ok">已验证</span></p>
  <ul>
    <li><b>做完复习并回首页</b>：2 道到期题做完后首页变「今天的任务完成了 / 今天做了 25 题，超额完成 / 再练 10 题」—— 状态流转正确，只是缺结算页（见第一节）</li>
    <li><b>加练 10 题</b>：能正常出 10 题并逐题作答</li>
    <li><b>收藏</b>：点一下变 <code>★ 已收藏</code> 且高亮；回顾→收藏能看到（我用 <code>[data-review-tab="fav"]</code> 点进去，列表里出现两道）${img("qa-24-review-fav.png", "回顾 → 收藏：能看到刚收藏的题")}</li>
    <li><b>笔记</b>：弹层输入 → 保存 → toast「笔记已保存」→ 回顾→笔记里能搜到 ${img("qa-25-review-notes.png", "回顾 → 笔记：能看到刚写的笔记")}</li>
    <li><b>练习页判题</b>：点选项即判，正确项绿、错项红，底部「上一题/收藏/笔记/下一题」，考点行显示「你在该考点正确率 X%（N 题）· 易错项」</li>
    <li><b>图片</b>：题干公式、示意图、分数（1/8）全部本地渲染正常</li>
    <li><b>导航</b>：首页→题库→试卷→考点→回顾→考试→我的→统计→报告→设置 全链路无死链；返回键逐层回退正确</li>
    <li><b>数据与备份 / 我的页</b>：数字与统计一致（35 题 / 17% / 29 错题）</li>
  </ul>
</div>

<h2>十一、建议修复顺序</h2>
<div class="card">
  <ol>
    <li><b>结算页</b>（P0-1）—— 改 3 行，影响最大，先做</li>
    <li><b>最弱口径统一 + 雷达六轴</b>（P0-2/3）—— 同一处改动，1 小时</li>
    <li><b>无解析兜底</b>（P0-6）—— 30 分钟</li>
    <li><b>更新弹层版本比较</b>（P0-7）—— 20 分钟</li>
    <li><b>按考点练分组</b>（P0-4）—— 半天</li>
    <li><b>分类错标</b>（P0-5）—— 写规则跑一遍，2 小时</li>
    <li><b>P1 六条</b> —— 1 小时打包处理</li>
  </ol>
  <p class="quote">按你要求，这一轮<b>一行代码都没改</b>，只记录。你说开始，我按上面顺序动。</p>
</div>

</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log("written", OUT, (html.length / 1024).toFixed(0) + " KB");
