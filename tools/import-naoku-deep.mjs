#!/usr/bin/env node
/**
 * tools/import-naoku-deep.mjs — 导入 GongkaoNaoku 的深度解析（考点/识别模型/推理/速杀/陷阱/母题）
 *
 * 背景：research/gongkao-naoku/kaogong.db 的 27,506 道行测题，qid 与我们的 questionId 完全一致，
 *       官方 analysis 文本也一致；增量是每题多出的 6 个结构化讲解字段。
 *       为不改动 questions 原表（避免影响前端与 app-assets 生成），写入独立表 question_deep。
 *
 * 用法：
 *   node tools/import-naoku-deep.mjs --dry-run   只看能导入多少（默认）
 *   node tools/import-naoku-deep.mjs --apply     实际写入（自动备份 tiku.db.bak-*）
 *
 * 说明：
 *   - 幂等：按 questionId upsert，重复跑不会产生重复行。
 *   - 只导入我方库里存在的 questionId，不新增题目。
 *   - 写入前后做 wal_checkpoint(TRUNCATE)，避免 -wal 残留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIKU = path.join(ROOT, 'tiku.db');
const SRC = path.resolve(ROOT, '..', 'research', 'gongkao-naoku', 'kaogong.db');

const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到源库：${SRC}`);
  console.error('  先下载 GongkaoNaoku 的 kaogong.db 分卷并合并，见 docs/粉笔逆向笔记.md');
  process.exit(1);
}

const src = new DatabaseSync(SRC, { readOnly: true });
const tiku = new DatabaseSync(TIKU, { timeout: 10000 });

// ---------- 源数据 ----------
const FIELD_MAX = 8000;
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, FIELD_MAX) : null;
};

const rows = src.prepare(`
  SELECT qid, kadian, ask_model, reasoning, fastest, pitfalls, mother
  FROM questions
`).all();

console.log(`源库题目：${rows.length}`);
const withDeep = rows.filter((r) => clean(r.reasoning) || clean(r.fastest) || clean(r.pitfalls) || clean(r.mother) || clean(r.kadian));
console.log(`其中带深度字段：${withDeep.length}`);

// ---------- 目标库现有题 ----------
const existing = new Set(
  tiku.prepare('SELECT DISTINCT questionId id FROM questions').all().map((r) => String(r.id))
);
console.log(`我方唯一题：${existing.size}`);

const matched = withDeep.filter((r) => existing.has(String(r.qid)));
const unmatched = withDeep.length - matched.length;
console.log(`可导入（qid 命中我方题库）：${matched.length}`);
if (unmatched) console.log(`跳过（我方无此题）：${unmatched}`);

// 现有 question_deep 表状态
const hasTable = tiku.prepare(
  "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='question_deep'"
).get().n > 0;
const already = hasTable ? tiku.prepare('SELECT COUNT(*) n FROM question_deep').get().n : 0;
console.log(`question_deep 现有行：${already}${hasTable ? '' : '（表不存在，将创建）'}`);

// 字段完整度统计
const stat = {
  kadian: matched.filter((r) => clean(r.kadian)).length,
  ask_model: matched.filter((r) => clean(r.ask_model)).length,
  reasoning: matched.filter((r) => clean(r.reasoning)).length,
  fastest: matched.filter((r) => clean(r.fastest)).length,
  pitfalls: matched.filter((r) => clean(r.pitfalls)).length,
  mother: matched.filter((r) => clean(r.mother)).length,
};
console.log('\n字段覆盖：' + Object.entries(stat).map(([k, v]) => `${k}=${v}`).join('  '));

// 抽样
console.log('\n抽样 2 条：');
for (const r of matched.slice(0, 2)) {
  console.log(`  qid=${r.qid}`);
  console.log(`    考点: ${(clean(r.kadian) || '').slice(0, 60)}`);
  console.log(`    速杀: ${(clean(r.fastest) || '').slice(0, 60)}`);
}

if (!apply) {
  console.log('\n[dry-run] 未写入。确认后加 --apply。');
  src.close(); tiku.close();
  process.exit(0);
}

// ---------- 备份 ----------
const bak = `${TIKU}.bak-naoku-${stamp}`;
console.log(`\n备份 → ${path.basename(bak)}`);
try { tiku.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
fs.copyFileSync(TIKU, bak);
console.log(`  完成 ${(fs.statSync(bak).size / 1024 / 1024).toFixed(0)} MB`);

// ---------- 写入 ----------
tiku.exec(`
  CREATE TABLE IF NOT EXISTS question_deep (
    questionId INTEGER PRIMARY KEY,
    kadian     TEXT,
    ask_model  TEXT,
    reasoning  TEXT,
    fastest    TEXT,
    pitfalls   TEXT,
    mother     TEXT,
    source     TEXT NOT NULL DEFAULT 'gongkao-naoku',
    updated_at INTEGER
  )
`);

const upsert = tiku.prepare(`
  INSERT INTO question_deep (questionId, kadian, ask_model, reasoning, fastest, pitfalls, mother, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'gongkao-naoku', ?)
  ON CONFLICT(questionId) DO UPDATE SET
    kadian=excluded.kadian, ask_model=excluded.ask_model, reasoning=excluded.reasoning,
    fastest=excluded.fastest, pitfalls=excluded.pitfalls, mother=excluded.mother,
    source=excluded.source, updated_at=excluded.updated_at
`);

const now = Date.now();
let n = 0;
tiku.exec('BEGIN');
try {
  for (const r of matched) {
    upsert.run(
      Number(r.qid), clean(r.kadian), clean(r.ask_model), clean(r.reasoning),
      clean(r.fastest), clean(r.pitfalls), clean(r.mother), now
    );
    n += 1;
  }
  tiku.exec('COMMIT');
} catch (e) {
  tiku.exec('ROLLBACK');
  console.error('写入失败，已回滚：', e.message);
  src.close(); tiku.close();
  process.exit(1);
}

try { tiku.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } catch {}
const total = tiku.prepare('SELECT COUNT(*) n FROM question_deep').get().n;
console.log(`\n✓ 写入 ${n} 条，question_deep 共 ${total} 行`);
console.log(`  备份保留在 ${bak}`);
console.log('  下一步：重新生成 app-assets（node build-app-assets.mjs app-assets --skip-download）才能进 APK');

src.close(); tiku.close();
