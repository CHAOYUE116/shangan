// test-backup-browser.mjs — 真实 Chrome 端到端测试（备份导出/导入/撤销）
// 前置：仓库根目录起静态服务 `python -m http.server 8899`，且本机有 Chrome
// 运行：node test-backup-browser.mjs
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8899';

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`${BASE}/public/`, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const { createIdbStore } = await import('/public/idb-store.js');
  const bk = await import('/public/backup.js');
  const dbName = 'backup-e2e-' + Date.now();
  const store = createIdbStore({ dbName });
  const out = {};
  const now = Date.now();

  await store.putMany('records', [1, 2, 3].map((i) => ({
    id: 'r' + i, question_id: 100 + i, paper_id: 1, subject: 'S', chapter: 'C',
    is_correct: i === 1 ? 1 : 0, created_at: now - i * 60000,
  })));
  await store.putMany('favorites', [{ question_id: 101, subject: 'S', chapter: 'C', created_at: now }]);
  await store.putMany('notes', [{ question_id: 102, subject: 'S', chapter: 'C', note: 'n1', created_at: now, updated_at: now }]);
  await store.putMany('custom_batches', [{ id: 1, name: 'B', subject: 'S' }]);
  await store.putMany('custom_questions', [{ id: 1, batch_id: 1, prompt: 'P', options: ['A'], answer: 'A', images: [] }]);
  localStorage.setItem('ai_agents_v1', JSON.stringify({ 1: { id: 1, name: 'a', api_key: 'secret' } }));

  const payload = await bk.buildPayload(store, { includeImages: true, includeKeys: false });
  out.counts = payload.counts;
  out.agentMasked = payload.data.agents[0].api_key === '' && payload.data.agents[0]._has_key === true;
  out.valid = !!(await bk.validatePayload(payload));

  const text = JSON.stringify(payload);
  const file = new File([text], 'b.json', { type: 'application/json' });
  const read = await bk.readBackupFile(file);
  out.fileRoundtrip = read.checksum === payload.checksum;

  const bad = JSON.parse(text);
  bad.data.records[0].is_correct = 9;
  let tamperRejected = false;
  try { await bk.validatePayload(bad); } catch { tamperRejected = true; }
  out.tamperRejected = tamperRejected;

  const plan = await bk.planImport(store, payload.data, 'merge');
  out.mergeSame = { recAdd: plan.records.add, recSkip: plan.records.skip, noteSkip: plan.notes.skip, qAdd: plan.questions.add };

  // 合并导入（数据相同 → 全部跳过）后撤销：应恢复导入前快照（含本机 key）
  await bk.applyImport(store, payload, 'merge');
  out.afterMerge = {
    records: (await store.getAll('records')).length,
    questions: (await store.getAll('custom_questions')).length,
  };
  await bk.undoLastImport(store);
  out.afterUndo = { records: (await store.getAll('records')).length };
  const agentsAfterUndo = JSON.parse(localStorage.getItem('ai_agents_v1') || '{}');
  out.undoRestoresKey = !!(agentsAfterUndo[1] && agentsAfterUndo[1].api_key === 'secret');

  // 覆盖导入：用备份内容重建（key 为脱敏值）
  await bk.applyImport(store, payload, 'replace');
  out.afterReplace = {
    records: (await store.getAll('records')).length,
    favorites: (await store.getAll('favorites')).length,
    notes: (await store.getAll('notes')).length,
    batches: (await store.getAll('custom_batches')).length,
    questions: (await store.getAll('custom_questions')).length,
  };

  await store.close();
  await new Promise((resolve) => { const r = indexedDB.deleteDatabase(dbName); r.onsuccess = r.onerror = r.onblocked = resolve; });
  return out;
});

console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log('PAGE ERRORS:', errors);
await browser.close();

const ok = result.valid && result.fileRoundtrip && result.tamperRejected
  && result.mergeSame.recAdd === 0 && result.mergeSame.qAdd === 0
  && result.afterReplace.records === 3 && result.afterReplace.questions === 1
  && result.afterMerge.records === 3 && result.afterMerge.questions === 1
  && result.afterUndo.records === 3 && result.undoRestoresKey && result.agentMasked
  && errors.length === 0;
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
