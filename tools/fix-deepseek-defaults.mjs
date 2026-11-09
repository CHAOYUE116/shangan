/**
 * 按 DeepSeek 官方文档（2026-11 版）校正默认值：
 *   BASE URL  https://api.deepseek.com          （文档给的是不带 /v1，/v1 也兼容）
 *   MODEL     deepseek-flash                    （主力；deepseek-chat / deepseek-reasoner 已下线）
 *   备选      deepseek-v4-pro
 * legacy 名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍被接受，路由到 V4.1-Flash。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_JSON = path.join(ROOT, 'public', 'ai-agents.default.json');
const AI_LOCAL = path.join(ROOT, 'public', 'ai-local.js');
const APP_JS = path.join(ROOT, 'public', 'next', 'app.js');

const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';

// 1) 默认 agent 配置
const agents = JSON.parse(fs.readFileSync(DEFAULT_JSON, 'utf8'));
let n1 = 0;
const walk = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach(walk);
  if (typeof o.base_url === 'string' && o.base_url.includes('api.deepseek.com')) {
    if (o.base_url !== BASE) { o.base_url = BASE; n1++; }
  }
  if (typeof o.model === 'string' && /^deepseek-(chat|reasoner|v4-flash|flash)$/.test(o.model)) {
    if (o.model !== MODEL) { o.model = MODEL; n1++; }
  }
  Object.values(o).forEach(walk);
};
walk(agents);
fs.writeFileSync(DEFAULT_JSON, JSON.stringify(agents, null, 2) + '\n', 'utf8');
console.log(`default json: ${n1} 处校正`);

// 2) ai-local.js —— 撤掉「deepseek-flash 是非法模型名」那段错误迁移，改成把已下线的名字拉回 flash
let s = fs.readFileSync(AI_LOCAL, 'utf8');
const before = s;
s = s.replace(
  /\n\s*\/\/ deepseek-flash [^\n]*\n\s*if \(merged\.model === 'deepseek-flash'\) merged\.model = 'deepseek-chat';/,
  `\n    // DeepSeek 2026 起只有 deepseek-flash / deepseek-v4-pro，已下线的旧名一律拉回 flash\n    if (['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'].includes(merged.model)) merged.model = 'deepseek-flash';`,
);
if (s === before) console.log('ai-local.js: 未匹配到旧迁移片段（可能已改过）');
else { fs.writeFileSync(AI_LOCAL, s, 'utf8'); console.log('ai-local.js: 迁移逻辑已改为 chat/reasoner → flash'); }

// 3) app.js 的 AI_GATEWAYS
let a = fs.readFileSync(APP_JS, 'utf8');
const b2 = a;
a = a.replace(/url:\s*'https:\/\/api\.deepseek\.com\/v1'/g, `url: '${BASE}'`)
     .replace(/model:\s*'deepseek-chat'/g, `model: '${MODEL}'`);
if (a === b2) console.log('app.js: 未匹配到 AI_GATEWAYS 段');
else { fs.writeFileSync(APP_JS, a, 'utf8'); console.log('app.js: AI_GATEWAYS 已校正'); }

// 4) 校验
const g = JSON.parse(fs.readFileSync(DEFAULT_JSON, 'utf8'));
console.log('\n当前默认：');
g.forEach?.((x) => console.log(`  ${x.id}  ${x.name || ''}  ${x.base_url}  ${x.model}`));
