import fs from 'fs';
const f = 'D:/Projects/上岸APP/kaogong-shuati/public/next/app.js';
let s = fs.readFileSync(f, 'utf8');
const done = [];
const must = (from, to, label) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`[${label}] 命中 ${n} 次，应为 1`);
  s = s.replace(from, to);
  done.push(label);
};

// A. 首页三个数字统一口径：标题=剩余，副标题=已做，进度条=today/goal
must(
  "    title = `今天做 <em>${Math.min(remain, 15)}</em> 道新题`;\n    sub = `今日还差 <b>${remain}</b> 题 · 从<b>${esc(topWeak)}</b>开始`;",
  "    title = `今天还剩 <em>${remain}</em> 道`;\n    sub = `今天已做 <b>${today}</b> 题 · 从<b>${esc(topWeak)}</b>开始`;",
  'A 首页数字'
);

// B. 「继续上次」少于 3 题的会话不占首页
must(
  '  ${resume ? `<button class="continue-card"',
  '  ${resume && (resume.ids || []).length >= 3 ? `<button class="continue-card"',
  'B 继续上次过滤'
);

// C. 时政摘要：剥掉重复标题与「时政汇总|」前缀，取第一句有意义的正文
must(
  "function polSummary(s) {\n  return String(s || '').replace(/^时政热点\\s*\\d+\\s*/, '').replace(/\\s+/g, ' ').trim();\n}",
  `function polSummary(s) {
  let t = String(s || '').replace(/\\s+/g, ' ').trim();
  // 卡片摘要原来直接取正文开头，而正文开头是「时政汇总| 标题 时政汇总| 标题 1 标题 …」的重复，
  // 于是十张卡的摘要长得一模一样。这里剥掉前缀、跳过重复标题，取第一个成句的片段。
  t = t.replace(/^(时政(汇总|热点)\\s*[|｜]\\s*)+/g, '');
  const head = (t.match(/^[^。！？]{4,40}/) || [''])[0];
  if (head) {
    let guard = 0;
    while (guard++ < 4 && t.indexOf(head) === 0 && t.indexOf(head, head.length) === head.length) {
      t = t.slice(head.length).trim().replace(/^(时政(汇总|热点)\\s*[|｜]\\s*)+/g, '');
    }
  }
  const segs = t
    .split(/(?<=[。！？])/)
    .map((x) => x.replace(/^(时政(汇总|热点)\\s*[|｜]\\s*)+/g, '').trim())
    .filter((x) => x.length >= 18 && !/^\\d+\\s*$/.test(x));
  const pick = (segs[0] || t).replace(/^[|｜\\s]+/, '');
  return pick.slice(0, 90);
}`,
  'C 时政摘要'
);

// D. 时政卡片显示「练一练 N 题」
must(
  '        return `<div class="pol-card" data-act="politics-open" data-idx="${idx}">',
  '        const pq = (x.practice || []).length;\n        return `<div class="pol-card" data-act="politics-open" data-idx="${idx}">',
  'D1 时政题数变量'
);
must(
  "          ${sum ? `<div class=\"pol-card-s\">${esc(sum)}</div>` : ''}",
  "          ${sum ? `<div class=\"pol-card-s\">${esc(sum)}</div>` : ''}\n          ${pq ? `<div class=\"pol-card-q\">练一练 ${pq} 题</div>` : ''}",
  'D2 时政题数标签'
);

// E. 备考档案自洽
must(
  "function loadProfile() {\n  try { return JSON.parse(localStorage.getItem('sg_profile') || 'null'); } catch { return null; }\n}",
  `const DEFAULT_EXAM_BY_TYPE = {
  '事业编': { name: '2027 事业单位联考', date: '2027-03-15' },
  '三支一扶': { name: '2027 三支一扶', date: '2027-05-15' },
};
// 档案自洽：类型不是公务员、考试名却还是默认的「2027 国考」时按类型换掉，
// 否则首页、考试页会写「事业编考生在准备国考」，自相矛盾。
function fixProfile(p) {
  if (!p || !p.examType || p.examType === '公务员') return p;
  if (p.examName && p.examName !== DEFAULT_PROFILE.examName && !/国考/.test(p.examName)) return p;
  const d = DEFAULT_EXAM_BY_TYPE[p.examType];
  if (!d) return p;
  return { ...p, examName: d.name, examDate: d.date };
}
function loadProfile() {
  try { return fixProfile(JSON.parse(localStorage.getItem('sg_profile') || 'null')); } catch { return null; }
}`,
  'E 档案自洽'
);

fs.writeFileSync(f, s, 'utf8');
console.log('已改：' + done.join(' / '));
