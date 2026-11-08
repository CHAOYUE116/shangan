// test-backup.mjs — 备份合并/校验纯函数单测
// 运行：node --test test-backup.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, recordKey, questionHash,
  buildPayloadFromData, validatePayload,
  FORMAT, FORMAT_VERSION,
} from './public/backup.js';

const rec = (qid, paperId, sec, correct = 0) => ({
  id: `r-${qid}-${sec}`, question_id: qid, paper_id: paperId,
  is_correct: correct, created_at: sec * 1000,
});

test('recordKey：同题同卷同秒视为同一次作答', () => {
  assert.equal(recordKey(rec(1, 2, 100)), recordKey(rec(1, 2, 100)));
  assert.notEqual(recordKey(rec(1, 2, 100)), recordKey(rec(1, 2, 101)));
  assert.notEqual(recordKey(rec(1, 2, 100)), recordKey(rec(1, 3, 100)));
});

test('buildPlan：记录按 key 去重，不重复计数', () => {
  const current = { records: [rec(1, 2, 100)], favorites: [], notes: [], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {} };
  const plan = buildPlan(current, { records: [rec(1, 2, 100), rec(1, 2, 200)], favorites: [], notes: [], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {} });
  assert.equal(plan.records.add, 1);
  assert.equal(plan.records.skip, 1);
  assert.equal(plan.records.rows[0].question_id, 1);
});

test('buildPlan：笔记较新的 updated_at 覆盖，旧的跳过', () => {
  const current = { records: [], favorites: [], notes: [{ question_id: 'q1', note: 'old', updated_at: 1000 }], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {} };
  const plan = buildPlan(current, {
    records: [], favorites: [], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {},
    notes: [
      { question_id: 'q1', note: 'newer', updated_at: 2000 },
      { question_id: 'q2', note: 'brand new', updated_at: 1500 },
    ],
  });
  assert.equal(plan.notes.update, 1);
  assert.equal(plan.notes.add, 1);
  assert.equal(plan.notes.rows.find((n) => n.question_id === 'q1').note, 'newer');
});

test('buildPlan：自定义题库按 name+subject 合并批次，题目重映射 id 并去重', () => {
  const current = {
    records: [], favorites: [], notes: [],
    customBatches: [{ id: 1, name: '行测错题', subject: '行测' }],
    customQuestions: [{ id: 10, batch_id: 1, prompt: 'P1', options: ['A', 'B'], answer: 'A', images: [] }],
    skills: [], agents: [], prefs: {},
  };
  const data = {
    records: [], favorites: [], notes: [],
    customBatches: [
      { id: 7, name: '行测错题', subject: '行测' },   // 同名 → 复用 id=1
      { id: 8, name: '申论素材', subject: '申论' },   // 新建 → id=2
    ],
    customQuestions: [
      { id: 70, batch_id: 7, prompt: 'P1', options: ['A', 'B'], answer: 'A', images: [] }, // 重复 → 跳过
      { id: 71, batch_id: 7, prompt: 'P2', options: ['A', 'B'], answer: 'B', images: [] }, // 新增
      { id: 80, batch_id: 8, prompt: 'P3', options: [], answer: '', images: [{ role: 'stem', dataUrl: 'data:image/png;base64,xx' }] },
      { id: 81, batch_id: 99, prompt: '孤儿题' }, // 批次不存在 → 跳过
    ],
    skills: [], agents: [], prefs: {},
  };
  const plan = buildPlan(current, data);
  assert.equal(plan.batches.add, 1);
  assert.equal(plan.questions.add, 2);
  assert.equal(plan.questions.skip, 2);
  const p2 = plan.questions.rows.find((q) => q.prompt === 'P2');
  assert.equal(p2.batch_id, 1);
  const p3 = plan.questions.rows.find((q) => q.prompt === 'P3');
  assert.equal(p3.batch_id, 2);
  assert.ok(p3.id > 10, '题目 id 应重新分配且大于现有 id');
});

test('questionHash：题干/答案/选项任一不同即不同', () => {
  const a = { prompt: 'P', answer: 'A', options: ['A', 'B'] };
  assert.equal(questionHash(a), questionHash({ ...a }));
  assert.notEqual(questionHash(a), questionHash({ ...a, answer: 'B' }));
  assert.notEqual(questionHash(a), questionHash({ ...a, options: ['A', 'C'] }));
});

test('validatePayload：正常备份通过，校验值错误被拒', async () => {
  const data = { records: [rec(1, 2, 100)], favorites: [], notes: [], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {} };
  const payload = await buildPayloadFromData(data, {});
  assert.equal(payload.format, FORMAT);
  assert.equal(payload.formatVersion, FORMAT_VERSION);
  await validatePayload(payload);

  const broken = { ...payload, data: { ...data, records: [] } };
  await assert.rejects(() => validatePayload(broken), /校验失败/);
});

test('validatePayload：格式/版本/缺字段被拒', async () => {
  const base = { format: FORMAT, formatVersion: FORMAT_VERSION, checksum: 'x', data: { records: [] } };
  await assert.rejects(() => validatePayload(null), /为空|格式错误/);
  await assert.rejects(() => validatePayload({ ...base, format: 'other' }), /不是/);
  await assert.rejects(() => validatePayload({ ...base, formatVersion: 99 }), /高于当前/);
  await assert.rejects(() => validatePayload({ ...base, checksum: '' }), /缺少校验值/);
  await assert.rejects(() => validatePayload({ ...base, data: { records: 'not-array' } }), /不是数组/);
});
