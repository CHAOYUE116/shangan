// 生成「修复验证」单页：把几张验收截图内嵌进 HTML，方便直接打开看
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (p) => path.join(ROOT, 'shots', p);
const img = (p) => {
  try {
    return 'data:image/png;base64,' + fs.readFileSync(file(p)).toString('base64');
  } catch {
    return '';
  }
};

const rows = [
  ['P0-1 结算页', 'qa-33-sheet-real.png', '点「完成本轮」后弹层留在页面上，正确率/做题/答对/答错/用时/最该记住的一点都在；修前是弹出来立刻被 go(\'home\') 关掉。'],
  ['P0-2 最弱口径', 'qa-34-radar6.png', '「最该补」改成跟首页同一个函数（weakestModule），这里是数量关系 0%（5 题），首页也是数量关系 0%。'],
  ['P0-3 雷达六轴', 'qa-34-radar6.png', '政治理论没做过也保留一根轴，标签写「政治·未做」，不再是五边形。'],
  ['P0-4 按考点练分组', 'qa-35-kpgroup.png', '一级模块做分组头（言语理解与表达 62 个考点 · 14213 题），点一下收起/展开；考点按题量排在组内，不再和模块平铺混排。'],
  ['P0-5 分类错标', 'qa-37-review-wrong.png', '333 道「这段文字意在…」被挂到常识判断的题已搬回言语理解与表达（这里错题列表能看到科目/章节都对了）。'],
  ['P0-6 占位题', 'qa-30-noanalysis.png', '题干和四个选项都是「缺失」的 77 道已被 R10 规则拦住，练习抽不到；没解析的题本来就有那句提示和 AI 入口。'],
  ['P0-7 版本比较', 'qa-28-update.png', '本地比清单新时不再画「0.5.37 → 0.5.30」的倒退箭头，文案统一成「题库已是最新」。'],
  ['首页去重', 'qa-38-home-fixed.png', '「再复习 N 道到期题」那张重复卡删了；Hero 底行按状态只说一句；「最弱的一块」带题量，且不再和「今日重点」重复同一模块。'],
  ['错题不再藏组合外科目', 'qa-37-review-wrong.png', '公基/其他科目的错题也列出来（34 道），不再出现「错题本 0 道 · 另有 34 道属于组合外」。'],
];

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>修复验证 · 2026-11-13</title>
<style>
:root{--bd:#e6e8ee;--tx:#1b1f2a;--mut:#6b7280}
*{box-sizing:border-box}
body{margin:0;background:#f5f6f8;color:var(--tx);font:15px/1.65 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:26px;margin:0 0 6px}
.sub{color:var(--mut);font-size:13px;margin-bottom:22px}
.item{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:16px 18px;margin:0 0 18px}
.h{font-size:16px;font-weight:700;margin:0 0 6px;display:flex;align-items:center;gap:8px}
.tag{font:600 11px/1 -apple-system,sans-serif;padding:4px 7px;border-radius:6px;background:#eef3ff;color:#2f5fe0}
.d{color:#3d4453;font-size:14px;margin:0 0 12px}
.shot{border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:#fafbfc}
.shot img{display:block;width:100%;height:auto}
</style></head><body><div class="wrap">
<h1>上岸 App · 报告里的问题，逐条修完的验证</h1>
<div class="sub">2026-11-13 · 版本 0.9.13(153) · 题库 0.5.38-20261113-1915 · 下面每张图都是改完之后在模拟器上现拍的</div>
${rows.map(([h, p, d]) => `<div class="item"><div class="h"><span class="tag">已修</span>${h}</div><p class="d">${d}</p><div class="shot"><img src="${img(p)}" alt="${h}"></div></div>`).join('')}
</div></body></html>`;

fs.writeFileSync(path.join(ROOT, 'docs', 'APP修复验证-2026-11-13.html'), html);
fs.writeFileSync(path.join(ROOT, 'report', 'APP修复验证-2026-11-13.html'), html);
console.log('ok', Math.round(html.length / 1024), 'KB');
