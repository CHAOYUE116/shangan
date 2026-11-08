// 修 AI 默认配置：deepseek-flash 不是合法模型名（DeepSeek 只有 deepseek-chat / deepseek-reasoner）
import fs from 'node:fs';

const agentsPath = 'D:/Projects/上岸APP/kaogong-shuati/public/ai-agents.default.json';
const agents = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
let fixed = 0;
for (const a of agents) {
  if (a.model === 'deepseek-flash') { a.model = 'deepseek-chat'; fixed++; }
  if (/^https:\/\/api\.deepseek\.com\/v1\/?$/.test(a.base_url || '')) {
    a.base_url = 'https://api.deepseek.com/v1';
  }
}
fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf8');
console.log('默认智能体修正 model 条数:', fixed);
for (const a of agents) console.log(' ', a.id, a.name, '|', a.base_url, '|', a.model);

// ai-local.js：把第 111 行那条「自动覆盖 model」删掉，改成反向迁移（旧存量的 deepseek-flash → deepseek-chat）
const aiPath = 'D:/Projects/上岸APP/kaogong-shuati/public/ai-local.js';
let s = fs.readFileSync(aiPath, 'utf8');
const bad = `    if (merged.base_url === 'https://api.deepseek.com/v1' && merged.model === 'deepseek-chat') merged.model = d.model;`;
const good = `    // deepseek-flash 不是合法模型名（官方只有 deepseek-chat / deepseek-reasoner），存量配置自动纠正
    if (merged.model === 'deepseek-flash') merged.model = 'deepseek-chat';`;
if (s.includes(bad)) {
  s = s.replace(bad, good);
  fs.writeFileSync(aiPath, s, 'utf8');
  console.log('ai-local.js 已修正模型迁移逻辑');
} else {
  console.log('ai-local.js 未找到目标行，跳过');
}
