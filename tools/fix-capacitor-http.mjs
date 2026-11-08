// 修 capacitor 配置：CapacitorHttp 默认关闭，不开启会导致 WebView 里 fetch 被 CORS 拦截 → AI 连不上
import fs from 'node:fs';
const p = 'D:/Projects/上岸APP/app-shangan/capacitor.config.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
cfg.plugins = cfg.plugins || {};
cfg.plugins.CapacitorHttp = { enabled: true };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
console.log(JSON.stringify(cfg, null, 2));
