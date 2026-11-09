import fs from 'fs';
const F = 'D:/Projects/上岸APP/kaogong-shuati/public/next/app.js';
let s = fs.readFileSync(F, 'utf8');
const from = `function startPractice(qs, title, subject, kind = '', restore = null, kp = '') {
  const P = S.practice;`;
const to = `function startPractice(qs, title, subject, kind = '', restore = null, kp = '') {
  // /api/practice 回来的是 id，POST /api/records 要的是 questionId —— 在这一层统一好，
  // 免得每条调用链各自记得该用哪个字段（两侧都传，兼容老数据）
  qs = (qs || []).map((q) => (q && q.questionId == null && q.id != null) ? Object.assign({}, q, { questionId: q.id }) : q);
  const P = S.practice;`;
const n = s.split(from).length - 1;
if (n !== 1) throw new Error('hits ' + n);
s = s.replace(from, to);
fs.writeFileSync(F, s, 'utf8');
console.log('ok');
