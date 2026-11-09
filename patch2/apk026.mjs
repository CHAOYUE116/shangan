import fs from 'fs';

const F = 'D:/Projects/上岸APP/kaogong-shuati/public/next/app.js';
let s = fs.readFileSync(F, 'utf8');
const hits = [];
function must(from, to, label) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`[${label}] 命中 ${n} 次，应为 1`);
  s = s.replace(from, to);
  hits.push(label);
}

/* 1) go() 切页时关掉残留弹层：否则弹层会盖在新页面上，用户只能靠 ✕ 退出 */
must(
  `function go(tab) {`,
  `function go(tab) {
  // 切页时先收掉弹层：弹层是全局的，页面换了它还挂着会盖住新页面
  try { if (document.querySelector('.sheet-wrap:not([hidden])')) closeSheet(); } catch { /* ignore */ }`,
  'go 关弹层',
);

/* 2) 学习报告：日期区间在同一天时只写一天 */
must(
  `const range = last.length ? \`\${last[0].d} - \${last[last.length - 1].d}\` : '近 7 天';`,
  `const d0 = last.length ? String(last[0].d) : '';
  const d1 = last.length ? String(last[last.length - 1].d) : '';
  const range = !last.length ? '近 7 天' : (d0 === d1 ? d0 : \`\${d0} ~ \${d1}\`);`,
  '报告日期区间',
);

/* 3) 学习报告：只有一两天数据时柱子会撑成一整块大色块 —— 限宽 + 头顶标数值 */
must(
  `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;margin-top:12px">\${last.length ? last.map((x) => \`<div style="flex:1;text-align:center"><div style="height:\${Math.max(6, Math.round((Number(x.c) || 0) / max * 88))}px;background:var(--primary);border-radius:6px 6px 2px 2px"></div><div style="font-size:10px;color:var(--text-3);margin-top:5px">\${esc(String(x.d).slice(5))}</div></div>\`).join('') : '<div class="empty-state">暂无记录</div>'}</div>`,
  `<div class="rep-bars">\${last.length ? last.map((x) => \`<div class="rep-col"><div class="rep-v">\${Number(x.c) || 0}</div><div class="rep-bar" style="height:\${Math.max(6, Math.round((Number(x.c) || 0) / max * 82))}px"></div><div class="rep-d">\${esc(String(x.d).slice(5))}</div></div>\`).join('') : '<div class="empty-state">暂无记录</div>'}</div>`,
  '报告柱状图',
);

/* 4) 学习统计：2 题 1 对 = 50% 与 47 题 23 对 = 49% 并列会误导，样本少的打个标记 */
must(
  `\${by.length ? by.map((x) => \`<div class="plan-stage"><div class="subject-main"><div class="subject-title">\${esc(x.chapter)}</div><div class="subject-sub">做 \${x.c} 题 · 对 \${x.ok} 题</div></div><div class="weak-pct">\${x.c ? Math.round((x.ok / x.c) * 100) : 0}%</div></div>\`).join('') : '<div class="empty-state">还没有做题记录</div>'}`,
  `\${by.length ? by.map((x) => \`<div class="plan-stage"><div class="subject-main"><div class="subject-title">\${esc(x.chapter)}\${x.c < 5 ? ' <span class="tag">样本少</span>' : ''}</div><div class="subject-sub">做 \${x.c} 题 · 对 \${x.ok} 题</div></div><div class="weak-pct">\${x.c ? Math.round((x.ok / x.c) * 100) : 0}%</div></div>\`).join('') : '<div class="empty-state">还没有做题记录</div>'}`,
  '统计样本少',
);

fs.writeFileSync(F, s, 'utf8');
console.log('app.js 改动', hits.length, '处：', hits.join(' / '));

/* CSS */
const C = 'D:/Projects/上岸APP/kaogong-shuati/public/next/style.css';
let css = fs.readFileSync(C, 'utf8');
if (css.includes('/* ===== 0.2.6 可点区域 / 状态色 ===== */')) {
  console.log('CSS 已存在，跳过');
} else {
  css += `
/* ===== 0.2.6 可点区域 / 状态色 ===== */
/* 选错时「你选了 X」标签此前没有样式，和普通中性标签一模一样 */
.tag.bad { color: var(--red); background: var(--red-soft); }

/* 真机上 chip / seg / 图标按钮只有 30~38px，拇指容易点空 */
.chip { min-height: 40px; display: inline-flex; align-items: center; }
.seg { min-height: 42px; }
.icon-btn { width: 42px; height: 42px; }
.ai-sw { min-height: 34px; }
.section-more, .home-week-more { min-height: 40px; display: inline-flex; align-items: center; padding: 0 2px; }
.home-week-foot > button { min-height: 40px; }

/* 学习报告的每日柱：只有一两天数据时原来会撑成一整块大色块 */
.rep-bars { display: flex; align-items: flex-end; justify-content: space-between; gap: 6px; height: 124px; margin-top: 12px; }
.rep-col { flex: 1 1 0; min-width: 0; max-width: 56px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
.rep-v { font-size: 10.5px; color: var(--text-3); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.rep-bar { width: 100%; max-width: 40px; background: var(--primary); border-radius: 6px 6px 2px 2px; }
.rep-d { font-size: 10px; color: var(--text-3); margin-top: 5px; }
`;
  fs.writeFileSync(C, css, 'utf8');
  console.log('CSS 已追加');
}
