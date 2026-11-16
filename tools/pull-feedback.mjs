#!/usr/bin/env node
/**
 * 拉取 App 端「纠错」上报（ntfy.sh 公共话题）。
 *
 *   node tools/pull-feedback.mjs                # 拉最近 12 小时的
 *   node tools/pull-feedback.mjs --since 24h    # 指定时间窗
 *   node tools/pull-feedback.mjs --json         # 原样输出 JSON
 *   node tools/pull-feedback.mjs --append feedback/feedback.jsonl   # 追加落盘（按消息 id 去重，长期留档）
 *
 * 话题名跟 public/next/app.js 里的 FEEDBACK_TOPIC 保持一致（用 --topic 覆盖）。
 * ntfy 公共服务器默认只缓存 12 小时 → 用 --append + 定时任务（.github/workflows/feedback-collect.yml）
 * 把它变成永久档案：每半小时搬一次，git 历史就是数据库。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (k) => args.includes('--' + k);

const TOPIC = arg('topic', 'shangan-fb-9d41k7');
const SINCE = arg('since', '12h');
const BASE = arg('base', 'https://ntfy.sh');

const url = `${BASE}/${TOPIC}/json?poll=1&since=${encodeURIComponent(SINCE)}`;
const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
if (!res.ok) {
  console.error('拉取失败：HTTP', res.status);
  process.exit(1);
}
const text = await res.text();
const rows = text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
const msgs = rows.filter((r) => r.event === 'message');

if (flag('json')) {
  console.log(JSON.stringify(msgs, null, 2));
  process.exit(0);
}

const out = [];
const raw = [];
for (const m of msgs) {
  const body = String(m.message || '');
  let payload = null;
  try {
    payload = body.includes('\n---\n') ? JSON.parse(body.split('\n---\n').pop()) : null;
  } catch { payload = null; }
  raw.push({ id: m.id, time: m.time, title: m.title, payload });
  out.push({
    time: new Date((m.time || 0) * 1000).toISOString(),
    questionId: payload?.questionId || '',
    reasons: (payload?.reasons || []).join('|'),
    note: payload?.note || '',
    expect: payload?.expect || '',
    chapter: payload?.question?.chapter || '',
    source: payload?.question?.source || '',
    version: payload?.version || '',
    dbVersion: payload?.dbVersion || '',
  });
}

if (!out.length) {
  console.log(`话题 ${TOPIC} 最近 ${SINCE} 没有新纠错。`);
  if (!arg('append')) process.exit(0);
}

// 长期留档：按 ntfy 消息 id 去重追加到 jsonl（git 历史即数据库）
const appendTo = arg('append');
if (appendTo && raw.length) {
  fs.mkdirSync(path.dirname(appendTo), { recursive: true });
  const seen = new Set();
  if (fs.existsSync(appendTo)) {
    for (const l of fs.readFileSync(appendTo, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { seen.add(JSON.parse(l).id); } catch { /* ignore */ }
    }
  }
  const fresh = raw.filter((r) => r.id && !seen.has(r.id));
  if (fresh.length) {
    fs.appendFileSync(appendTo, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`新增 ${fresh.length} 条 → ${appendTo}（累计 ${seen.size + fresh.length} 条）`);
  } else {
    console.log(`没有新条目（累计 ${seen.size} 条）`);
  }
}

if (!out.length) process.exit(0);

const dir = 'report';
fs.mkdirSync(dir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const csv = path.join(dir, `feedback-${day}.csv`);
const head = '时间,题号,原因,期望,说明,模块,来源,版本,题库\n';
const line = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const body = out.map((o) => [o.time, o.questionId, o.reasons, o.expect, o.note, o.chapter, o.source, o.version, o.dbVersion].map(line).join(',')).join('\n');
fs.writeFileSync(csv, head + body + '\n');

console.log(`共 ${out.length} 条，已写入 ${csv}`);
const byQ = new Map();
for (const o of out) byQ.set(o.questionId, (byQ.get(o.questionId) || 0) + 1);
console.log('重复最多的题目：', [...byQ.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([q, n]) => `${q}×${n}`).join('  '));
console.log('原因分布：', [...out.reduce((m, o) => m.set(o.reasons || '(未选)', (m.get(o.reasons || '(未选)') || 0) + 1), new Map())].map(([k, v]) => `${k}:${v}`).join('  '));
