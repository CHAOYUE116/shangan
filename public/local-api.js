/**
 * public/local-api.js — App 版离线数据层（阶段 2 交付）
 *
 * 在浏览器/WebView 中提供与 server.mjs 等价的查询/记录接口：
 *   查询面  —— 复用 lib/local-queries.mjs（SQL 与 server 逐字段对齐，本文件仅注入引擎适配器）
 *   记录面  —— 收藏/做题记录/错题本/统计（存储适配器；IndexedDB 实现在阶段 3，本文件定义接口 + 纯函数聚合）
 *   图片    —— images.db 公式图查询 + 真图形缓存接口
 *
 * 引擎适配器（调用方按运行环境注入其一）：
 *   - node：node:sqlite（开发/测试，见 test-local-api.mjs）
 *   - App：CapacitorSQLite 插件（阶段 5）
 *   - 浏览器调试：sql.js + gz 资源
 * 记录存储适配器（阶段 3 提供 IndexedDB 实现）：
 *   store.getAll(kind) / store.put(kind, row) / store.deleteBy(kind, key, value)
 *   kind ∈ 'records' | 'favorites'
 */

import { createLocalApi, classifySource, SOURCE_GROUPS, sourceGroupName } from './lib/local-queries.js';
import { createIdbStore } from './idb-store.js';

// ---------- 展示工具 ----------
/** App 端时间戳 → 'YYYY-MM-DD HH:mm'（与 server 端 SQLite datetime 字符串展示一致；非时间戳原样返回） */
function fmtDT(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 来源归档（与 server classifySource 同构，双端同步维护） ----------
/** 题目来源分类：内置题查 tiku（questions JOIN papers），custom- 前缀题直接归「自定义题库」 */
function classifyLocal(store, tiku, questionId) {
  return classifySource(questionId, {
    question(id) {
      return tiku.get(
        'SELECT q.paperId, q.chapter, p.subjectName FROM questions q JOIN papers p ON p.id = q.paperId WHERE q.questionId = ? LIMIT 1',
        id
      ) || null;
    },
  });
}

/** 分组总览组装（与 server buildSourceGroups 同构）：固定 5 大模块 + 未分类（仅 >0 时） */
function buildLocalGroups(rows) {
  const totals = new Map();
  const subs = new Map();
  for (const r of rows) {
    const g = r.group_key || '';
    const s = r.sub_key || '';
    totals.set(g, (totals.get(g) || 0) + 1);
    if (!subs.has(g)) subs.set(g, new Map());
    subs.get(g).set(s, (subs.get(g).get(s) || 0) + 1);
  }
  const list = SOURCE_GROUPS.filter((g) => g.key !== '').map(({ key, name }) => {
    const sm = subs.get(key) || new Map();
    return {
      key, name, count: totals.get(key) || 0,
      subs: [...sm.entries()].map(([k, c]) => ({ key: k, name: k || '未分类', count: c })).sort((a, b) => b.count - a.count),
    };
  });
  const unclassified = totals.get('') || 0;
  if (unclassified > 0) list.push({ key: '', name: '未分类', count: unclassified, subs: [] });
  return list;
}

// ---------- 统计聚合（纯函数，可单测） ----------
/**
 * 由本地做题记录聚合统计。
 * @param {Array} records [{ question_id, subject, chapter, is_correct }]
 * @param {object} tiku 题库引擎（聚合申论/综应索引子项 done 时需查 question_categories）
 * @returns {{ doneBySubject: Map, chapterStats: Map, subStats: Map, catStats: Map }}
 */
export function aggregateStats(records, tiku) {
  const doneBySubject = new Map();
  const chapterStats = new Map();
  const subStats = new Map();
  const catStats = new Map();
  const seenCorrect = new Set();
  for (const r of records) {
    if (!r.subject) continue;
    if (r.is_correct) {
      const k = `${r.subject}|${r.question_id}`;
      if (!seenCorrect.has(k)) { seenCorrect.add(k); doneBySubject.set(r.subject, (doneBySubject.get(r.subject) || 0) + 1); }
    }
    if (r.chapter) {
      if (!chapterStats.has(r.subject)) chapterStats.set(r.subject, new Map());
      const cs = chapterStats.get(r.subject);
      const cur = cs.get(r.chapter) || { c: 0, ok: 0 };
      cur.c += 1;
      if (r.is_correct) cur.ok += 1;
      cs.set(r.chapter, cur);
    }
  }
  // 索引子项统计（question_categories 一次批量查询，同时喂两个口径）：
  //   subStats —— 答对记录数（申论/综应树 done；原口径：按题去重）
  //   catStats —— 全部记录数/答对数 {c, ok}（行测/职测树 done，与 chapterStats 同口径）
  if (tiku && records.length) {
    const correctIds = records.filter((r) => r.is_correct && r.question_id != null).map((r) => r.question_id);
    const subjOf = new Map(records.filter((r) => r.is_correct).map((r) => [r.question_id, r.subject]));
    const recsById = new Map();
    for (const r of records) {
      if (r.question_id == null || !r.subject) continue;
      if (!recsById.has(r.question_id)) recsById.set(r.question_id, []);
      recsById.get(r.question_id).push(r);
    }
    const ids = [...new Set([...correctIds, ...recsById.keys()])];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = tiku.all(
        `SELECT question_id, subject, category, sub FROM question_categories WHERE question_id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk
      );
      for (const qc of rows) {
        if (subjOf.has(qc.question_id)) {
          const subject = subjOf.get(qc.question_id);
          if (!subject) continue;
          if (!subStats.has(subject)) subStats.set(subject, new Map());
          const m = subStats.get(subject);
          m.set(`${qc.category}|${qc.sub}`, (m.get(`${qc.category}|${qc.sub}`) || 0) + 1);
        }
        for (const rec of recsById.get(qc.question_id) || []) {
          if (!catStats.has(rec.subject)) catStats.set(rec.subject, new Map());
          const m = catStats.get(rec.subject);
          const key = `${qc.category}|${qc.sub}`;
          const cur = m.get(key) || { c: 0, ok: 0 };
          cur.c += 1;
          if (rec.is_correct === 1) cur.ok += 1;
          m.set(key, cur);
        }
      }
    }
  }
  return { doneBySubject, chapterStats, subStats, catStats };
}

// ---------- 记录层（存储适配器接口） ----------
/** 题目 id → 考点名。两级来源：
 *  1) question_keypoints（粉笔考点树，行测覆盖满、职测只覆盖约三成）
 *  2) question_categories.sub（导入时按章节归一出来的二级分类，职测/申论/综应都覆盖到）
 *  公基两表都没有（它只有 8 个模块），返回空，报告就停在模块这一层。 */
function keypointMapOf(tiku, ids) {
  const list = (ids || []).map(Number).filter((x) => Number.isFinite(x));
  const out = {};
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const ph = part.map(() => '?').join(',');
    for (const r of tiku.all(`SELECT questionId, kpName FROM question_keypoints WHERE questionId IN (${ph}) ORDER BY rank`, ...part)) {
      if (!out[r.questionId]) out[r.questionId] = r.kpName;
    }
    const missing = part.filter((x) => !out[x]);
    if (missing.length) {
      const ph2 = missing.map(() => '?').join(',');
      for (const r of tiku.all(`SELECT question_id, sub FROM question_categories WHERE question_id IN (${ph2}) AND sub IS NOT NULL AND sub <> '' ORDER BY question_id`, ...missing)) {
        if (!out[r.question_id]) out[r.question_id] = r.sub;
      }
    }
  }
  return out;
}

export function createRecordsApi(store, tiku, onChanged) {
  return {
    /** 收藏列表（与 /api/favorites GET 同构：{list,total,offset,limit,hasMore}；group/sub 按来源归档过滤） */
    async favorites({ limit = 50, offset = 0, group, sub } = {}) {
      let rows = await store.getAll('favorites');
      if (group !== undefined) rows = rows.filter((r) => (r.group_key || '') === group);
      if (sub) rows = rows.filter((r) => (r.sub_key || '') === sub);
      rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      const list = [];
      for (const r of page) {
        // 自定义题：题面从 IndexedDB 取
        let content = null; let type = null;
        if (String(r.question_id).startsWith('custom-')) {
          const all = await store.getAll('custom_questions');
          const cr = all.find((x) => Number(x.id) === Number(String(r.question_id).replace(/^custom-/, '')));
          if (cr) { content = cr.prompt + ((cr.images || []).length ? ' [图]' : ''); type = 'custom'; }
        } else {
          const q = tiku.get('SELECT content, contentHtml, type, answer, answerIndex FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
          content = q?.content ? q.content.slice(0, 80) : (q?.contentHtml ? '（图片题）' : null);
          type = q?.type ?? null;
        }
        list.push({
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          time: fmtDT(r.created_at),
          content: content ? String(content).slice(0, 80) : null,
          type,
        });
      }
      return { list, total, offset, limit, hasMore: offset + list.length < total };
    },
    /** 收藏添加/取消（与 /api/favorites POST/DELETE 同构；添加时即归档来源） */
    async toggleFavorite(questionId, { subject = '', chapter = '' } = {}) {
      if (questionId == null) throw new Error('缺少 questionId');
      const existing = await store.getAll('favorites');
      const found = existing.some((f) => f.question_id === questionId);
      if (found) await store.deleteBy('favorites', 'question_id', questionId);
      else {
        const cls = classifyLocal(store, tiku, questionId);
        await store.put('favorites', { question_id: questionId, subject, chapter, group_key: cls.groupKey, sub_key: cls.subKey, created_at: Date.now() });
      }
      return { ok: true };
    },
    /** 收藏状态（App 启动时批量预载） */
    async favoriteIds() {
      const rows = await store.getAll('favorites');
      return new Set(rows.map((r) => r.question_id));
    },
    /** 笔记列表（与 /api/notes GET 同构：{list,total,offset,limit,hasMore}；按更新/创建时间倒序；qid 指定时查单条；group/sub 按来源归档过滤） */
    async notes({ limit = 50, offset = 0, qid, group, sub } = {}) {
      let rows = await store.getAll('notes');
      if (qid != null) rows = rows.filter((r) => String(r.question_id) === String(qid));
      if (group !== undefined) rows = rows.filter((r) => (r.group_key || '') === group);
      if (sub) rows = rows.filter((r) => (r.sub_key || '') === sub);
      rows.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      const list = [];
      for (const r of page) {
        let content = null; let type = null;
        if (String(r.question_id).startsWith('custom-')) {
          const all = await store.getAll('custom_questions');
          const cr = all.find((x) => Number(x.id) === Number(String(r.question_id).replace(/^custom-/, '')));
          if (cr) { content = cr.prompt + ((cr.images || []).length ? ' [图]' : ''); type = 'custom'; }
        } else {
          const q = tiku.get('SELECT content, contentHtml, type, answer, answerIndex FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
          content = q?.content ? q.content.slice(0, 80) : (q?.contentHtml ? '（图片题）' : null);
          type = q?.type ?? null;
        }
        list.push({
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          note: r.note || '',
          time: fmtDT(r.updated_at || r.created_at),
          content: content ? String(content).slice(0, 80) : null,
          type,
        });
      }
      return { list, total, offset, limit, hasMore: offset + list.length < total };
    },
    /** 笔记添加/修改（与 /api/notes POST 同构；一题一笔记：已存在则更新 note+updated_at；新笔记即归档来源） */
    async upsertNote(questionId, { subject = '', chapter = '', note = '' } = {}) {
      if (questionId == null) throw new Error('缺少 questionId');
      note = String(note || '').trim().slice(0, 500);
      if (!note) throw new Error('笔记内容不能为空');
      const existing = await store.getAll('notes');
      const found = existing.find((f) => String(f.question_id) === String(questionId));
      const now = Date.now();
      if (found) {
        await store.put('notes', { ...found, note, subject, chapter, updated_at: now });
      } else {
        const cls = classifyLocal(store, tiku, questionId);
        await store.put('notes', { question_id: questionId, subject, chapter, note, group_key: cls.groupKey, sub_key: cls.subKey, created_at: now, updated_at: now });
      }
      return { ok: true };
    },
    /** 笔记删除（与 /api/notes DELETE 同构） */
    async deleteNote(questionId) {
      if (questionId == null) throw new Error('缺少 questionId');
      await store.deleteBy('notes', 'question_id', questionId);
      return { ok: true };
    },
    /** 笔记题 id 集合（App 启动时批量预载，供做题页「查看笔记/添加笔记」状态切换） */
    async noteIds() {
      const rows = await store.getAll('notes');
      return new Set(rows.map((r) => String(r.question_id)));
    },
    /** 提交做题记录（与 /api/records POST 同构；同卷同题同日去重，重复则更新；写入即按题目真实来源归档） */
    async addRecord({ questionId, subject, chapter, type, selected, correct, costMs, diff, paperId, autoDrop }) {
      if (questionId == null) throw new Error('缺少 questionId');
      const now = Date.now();
      // 按本地时区（中国 UTC+8）取当天零点：UTC 零点会在上午 8 点前把记录归到前一天，
      // 导致“每天去重”失效与每日统计错位。
      const d = new Date(now);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      // 同日去重只针对非错题记录（正确/主观题记录）；错题记录不参与去重——错题保护：
      // 当天做对不覆盖错题记录（需累计 3 个日期做对才自动移除），做错记录始终保留
      const existing = (await store.getAll('records')).filter(
        (r) => r.question_id === questionId && r.paper_id === (paperId ?? null) && r.created_at >= dayStart && r.is_correct !== 0
      );
      // 主观题（申论/综应，correct=null）is_correct 存 NULL（与 server 同构）：不计入错题本
      const cls = classifyLocal(store, tiku, questionId);
      const row = { question_id: questionId, paper_id: paperId ?? cls.paperId ?? null, subject: subject || '', chapter: chapter || '', question_type: type ?? null, selected: selected ?? null, is_correct: correct == null ? null : (correct ? 1 : 0), cost_ms: costMs ?? null, difficulty: diff ?? null, group_key: cls.groupKey, sub_key: cls.subKey, created_at: now };
      if (existing.length) await store.deleteBy('records', 'id', existing[0].id);
      await store.put('records', row);
      // 订正正确即移出错题本（默认开，跟粉笔「订正正确自动移除错题」一致）：
      // 这次做对就把该题的历史错题记录删掉，错题本不会一直躺着已订正的题。
      // 关掉开关后走老规则：累计 3 个不同日期做对才移除，防「蒙对一次」。
      if (correct === true) {
        const all = await store.getAll('records');
        let drop = autoDrop !== false;
        if (!drop) {
          const okDays = new Set(
            all.filter((r) => r.question_id === questionId && r.is_correct === 1)
              .map((r) => new Date(r.created_at).toDateString())
          );
          drop = okDays.size >= 3;
        }
        if (drop) {
          for (const r of all) {
            if (r.question_id === questionId && r.is_correct === 0) await store.deleteBy('records', 'id', r.id);
          }
        }
      }
      // 提交后刷新统计快照，使首页/章节完成度立即反映本次作答（无需重启 App）
      if (onChanged) await onChanged();
      return { ok: true };
    },
    /**
     * 学情分析用的聚合数据（喂给 AI 用，不含任何题目正文）。
     * 与前端约定：返回 { overall, modules, chapters, difficulty, types, behavior, errors }，
     * meta（考试日期/目标分）由前端补。
     */
    async studyPayload({ days = 21, subject } = {}) {
      const all = await store.getAll('records');
      const base = subject ? all.filter((r) => r.subject === subject) : all;
      const now = Date.now();
      const winStart = now - Number(days) * 86400000;
      const rows = base.filter((r) => Number(r.created_at) >= winStart);

      const dayKey = (ts) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const pct = (ok, n) => (n ? Math.round((ok / n) * 100) : 0);
      const secs = (list) => list.map((r) => Number(r.cost_ms) || 0).filter((s) => s > 500 && s < 1800000);
      const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
      const p90 = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * 0.9))]; };
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

      const graded = rows.filter((r) => r.is_correct === 1 || r.is_correct === 0);
      const rightN = graded.filter((r) => r.is_correct === 1).length;
      const secList = secs(rows);

      // 每日题数（近 N 天，按日期升序）
      const daily = [];
      for (let i = Number(days) - 1; i >= 0; i--) {
        const k = dayKey(now - i * 86400000);
        daily.push(rows.filter((r) => dayKey(r.created_at) === k).length);
      }
      // 连续天数：从今天往回数（今天没做则从昨天起算）
      let streak = 0;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i] > 0) streak++;
        else if (i === daily.length - 1) continue;
        else break;
      }
      let longest = 0; let cur = 0;
      for (const n of daily) { if (n > 0) { cur++; longest = Math.max(longest, cur); } else cur = 0; }

      // 模块（chapter）/ 二级（sub_key）
      const agg = (keyOf) => {
        const m = new Map();
        for (const r of rows) {
          const k = keyOf(r) || '未分类';
          const e = m.get(k) || { name: k, n: 0, ok: 0, secs: [] };
          e.n++;
          if (r.is_correct === 1) e.ok++;
          e.secs.push(Number(r.cost_ms) || 0);
          m.set(k, e);
        }
        return [...m.values()];
      };
      const bandRate = (list, lo, hi) => {
        const sub = list.filter((r) => {
          const d = Number(r.difficulty);
          return d >= lo && d <= hi;
        });
        return { 做: sub.length, 正确率: sub.length ? pct(sub.filter((r) => r.is_correct === 1).length, sub.length) : null };
      };

      const modules = agg((r) => r.chapter)
        .filter((x) => x.n > 0)
        .map((x) => {
          const list = rows.filter((r) => (r.chapter || '未分类') === x.name);
          return {
            模块: x.name, 做: x.n, 对: x.ok, 正确率: pct(x.ok, x.n),
            中位用时秒: Math.round(median(x.secs.filter((s) => s > 0)) / 1000),
            用时P90秒: Math.round(p90(x.secs.filter((s) => s > 0)) / 1000),
            易档正确率: bandRate(list, 1, 3).正确率, 中档正确率: bandRate(list, 4, 6).正确率, 难档正确率: bandRate(list, 7, 9).正确率,
          };
        })
        .sort((a, b) => a.正确率 - b.正确率);

      const subs = agg((r) => r.sub_key)
        .filter((x) => x.n >= 8)
        .map((x) => ({ 章节: x.name, 做: x.n, 正确率: pct(x.ok, x.n), 中位用时秒: Math.round(median(x.secs.filter((s) => s > 0)) / 1000) }))
        .sort((a, b) => a.正确率 - b.正确率);

      const TYPE_NAME = { 1: '单选', 2: '多选', 3: '判断', 5: '不定项' };
      const types = agg((r) => TYPE_NAME[r.question_type] || '其他')
        .map((x) => ({ 题型: x.name, 做: x.n, 正确率: pct(x.ok, x.n) }))
        .sort((a, b) => b.做 - a.做);

      const difficulty = [
        { 档: '易', ...bandRate(rows, 1, 3), 中位用时秒: Math.round(median(secs(rows.filter((r) => Number(r.difficulty) <= 3))) / 1000) },
        { 档: '中', ...bandRate(rows, 4, 6), 中位用时秒: Math.round(median(secs(rows.filter((r) => Number(r.difficulty) >= 4 && Number(r.difficulty) <= 6))) / 1000) },
        { 档: '难', ...bandRate(rows, 7, 9), 中位用时秒: Math.round(median(secs(rows.filter((r) => Number(r.difficulty) >= 7))) / 1000) },
      ];

      // 错题：每题只认最近一次；重复错 = 同一题错了 ≥2 次；二次答对率 = 错过之后又做对的题占比
      const lastByQ = new Map();
      const wrongCount = new Map();
      for (const r of base) {
        const k = String(r.question_id);
        const prev = lastByQ.get(k);
        if (!prev || Number(r.created_at) >= Number(prev.created_at)) lastByQ.set(k, r);
        if (r.is_correct === 0) wrongCount.set(k, (wrongCount.get(k) || 0) + 1);
      }
      const wrongUnique = [...lastByQ.values()].filter((r) => r.is_correct === 0).length;
      const repeatWrong = [...wrongCount.values()].filter((c) => c >= 2).length;
      const everWrong = new Set([...wrongCount.keys()]);
      const fixed = [...everWrong].filter((k) => lastByQ.get(k)?.is_correct === 1).length;

      const last7Start = now - 7 * 86400000;

      return {
        overall: {
          做: rows.length, 对: rightN, 正确率: pct(rightN, graded.length),
          中位用时秒: Math.round(median(secList) / 1000), 平均单题秒: Math.round(avg(secList) / 1000),
          估计分: pct(rightN, graded.length), 活跃天数: daily.filter((n) => n > 0).length,
          连续天数: streak, 最长连续: longest, 窗口天数: Number(days),
        },
        modules,
        chapters: { 最弱: subs.slice(0, 6), 最强: subs.slice(-4).reverse() },
        difficulty,
        types,
        behavior: {
          每日题数: daily,
          秒选占比: rows.length ? Math.round((secList.filter((s) => s <= 6000).length / rows.length) * 100) : 0,
          超时占比: rows.length ? Math.round((secList.filter((s) => s >= 120000).length / rows.length) * 100) : 0,
        },
        errors: { 错题: wrongUnique, 近7天: base.filter((r) => r.is_correct === 0 && Number(r.created_at) >= last7Start).length, 重复错: repeatWrong, 二次答对率: everWrong.size ? Math.round((fixed / everWrong.size) * 100) : null },
      };
    },
    /** 统计（与 /api/records/stats 同构，聚合本地记录） */
    async stats() {      const records = await store.getAll('records');
      const agg = aggregateStats(records, tiku);
      const total = records.length;
      const done = new Set(records.filter((r) => r.is_correct).map((r) => `${r.subject}|${r.question_id}`)).size;
      // 错题 = 严格答错（is_correct=0）；主观题（申论/综应 is_correct=null）不计入错题
      const wrong = records.filter((r) => r.is_correct === 0).length;
      return { total, done, wrong };
    },
    /** 错题本（与 /api/records/wrong 同构：答错题去重 + 分页；只收 is_correct=0 的题；group/sub 按来源归档过滤）
     *  keepFixed=true 时不排除「已订正」的题（练习偏好里关掉自动移出时用） */
    async wrong({ limit = 50, offset = 0, group, sub, chapter, keepFixed } = {}) {
      const all = await store.getAll('records');
      // 每题只认最近一次作答：最近一次做对 = 已订正，默认移出错题本。
      // 老记录里可能还留着这次之前的历史错题行，所以这里不能只看 is_correct===0。
      const latest = new Map();
      for (const r of all) {
        const id = r.question_id;
        const prev = latest.get(id);
        if (!prev || (r.created_at || 0) >= (prev.created_at || 0)) latest.set(id, r);
      }
      let rows = keepFixed
        ? all.filter((r) => r.is_correct === 0)
        : [...latest.values()].filter((r) => r.is_correct === 0);
      // 主观题（申论/综应 is_correct=null）不计入错题本；按来源归档过滤（group='' 表示未分类，undefined=全部）
      if (group !== undefined) rows = rows.filter((r) => (r.group_key || '') === group);
      if (sub) rows = rows.filter((r) => (r.sub_key || '') === sub);
      if (chapter) rows = rows.filter((r) => (r.chapter || '') === chapter);
      rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const seen = new Set();
      const uniq = rows.filter((r) => (seen.has(r.question_id) ? false : (seen.add(r.question_id), true)));
      const total = uniq.length;
      const page = uniq.slice(offset, offset + limit);
      // 自定义题内容从 IndexedDB 取（custom- 前缀）
      const customRows = (await store.getAll('custom_questions')).filter((x) => x.prompt);
      const customOf = new Map(customRows.map((x) => [Number(x.id), x]));
      const list = [];
      for (const r of page) {
        let q = null;
        if (String(r.question_id).startsWith('custom-')) {
          // 自定义题：题面从 IndexedDB 取
          const cr = customOf.get(Number(String(r.question_id).replace(/^custom-/, '')));
          if (cr) q = { content: cr.prompt + ((cr.images || []).length ? ' [图]' : ''), type: 'custom' };
        } else {
          q = tiku.get('SELECT content, contentHtml, type, answer, answerIndex FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
        }
        list.push({
          id: r.question_id,
          questionId: r.question_id,   // 与 server /api/records/wrong 同构（app.js 点开用此字段）
          content: q?.content ? q.content.slice(0, 60) : (q?.contentHtml ? '（图片题）' : ''),
          available: !!q,              // 题库中已不存在的题（历史遗留）标记为不可重做
          answer: q?.answer != null ? String(q.answer) : '',            // 题库正确答案（不是用户选的）
          answerIndex: Number.isFinite(q?.answerIndex) ? q.answerIndex : -1,
          myAnswer: Array.isArray(r.selected) ? r.selected.slice().sort((a, b) => a - b).join(',') : '',
          subject: r.subject || '',
          chapter: r.chapter || '',
          time: fmtDT(r.created_at),
          type: q?.type ?? null,
        });
      }
      return { list, total, offset, limit, hasMore: offset + list.length < total };
    },
    /** 最近记录（与 /api/records/recent 同构） */
    async recent({ limit = 20 } = {}) {
      const rows = (await store.getAll('records')).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, limit);
      const list = [];
      for (const r of rows) {
        const q = tiku.get('SELECT content, contentHtml, type, answer, answerIndex FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
        list.push({
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          content: q?.content ? q.content.slice(0, 60) : (q?.contentHtml ? '（图片题）' : null),
          type: q?.type ?? null,
          correct: !!r.is_correct,
          time: fmtDT(r.created_at),
          costMs: r.cost_ms,
        });
      }
      return list;
    },
    /** 来源分组总览（与 /api/records/wrong/groups、/api/favorites/groups、/api/notes/groups 同构）：
     *  target='wrong'|'favorites'|'notes' → [{key,name,count,subs:[...]}] */
    async groups(target) {
      let rows;
      if (target === 'wrong') {
        const all = await store.getAll('records');
        const latest = new Map();
        for (const r of all) {
          const prev = latest.get(r.question_id);
          if (!prev || (r.created_at || 0) >= (prev.created_at || 0)) latest.set(r.question_id, r);
        }
        rows = [...latest.values()].filter((r) => r.is_correct === 0);
      } else {
        rows = await store.getAll(target);
      }
      return buildLocalGroups(rows);
    },
    /** 考点名映射（question_keypoints 表）：{ [questionId]: kpName }。报告要按考点下钻，题面本身不带考点 */
    keypoints({ ids }) {
      return keypointMapOf(tiku, ids);
    },
    /** 参照统计（本地口径，明确不是「全站」）：按请求的题目 id 给出
     *  - q:   { [id]: { n, wrong, top, topN } }  该题你做过几次、错几次、最常选的错误选项
     *  - kp:  { [kpName]: { n, ok } }            这些题所在考点上你的历史正确率
     */
    async refstats({ ids }) {
      const list = (ids || []).map(Number).filter((x) => Number.isFinite(x));
      const q = {};
      const kp = {};
      if (!list.length) return { q, kp };
      const kpMap = keypointMapOf(tiku, list);
      const wantKp = new Set(Object.values(kpMap));
      const recs = await store.getAll('records');
      const byQ = new Map();
      for (const r of recs) {
        const id = Number(r.question_id);
        if (!byQ.has(id)) byQ.set(id, []);
        byQ.get(id).push(r);
      }
      for (const id of list) {
        const rs = byQ.get(id) || [];
        if (!rs.length) continue;
        const wrongs = rs.filter((r) => r.is_correct === 0);
        const tally = new Map();
        for (const r of wrongs) {
          const sel = Array.isArray(r.selected) ? r.selected[0] : r.selected;
          if (sel == null) continue;
          tally.set(Number(sel), (tally.get(Number(sel)) || 0) + 1);
        }
        let top = null; let topN = 0;
        for (const [k, v] of tally) if (v > topN) { top = k; topN = v; }
        q[id] = { n: rs.length, wrong: wrongs.length, top, topN };
      }
      if (wantKp.size) {
        // 只统计这些考点下的题，避免把整个题库扫一遍
        for (const name of wantKp) {
          const rows = tiku.all(
            `SELECT questionId FROM question_keypoints WHERE kpName = ? LIMIT 20000`, name
          );
          const idSet = new Set(rows.map((r) => Number(r.questionId)));
          let n = 0; let ok = 0;
          for (const r of recs) {
            if (!idSet.has(Number(r.question_id))) continue;
            if (r.is_correct == null) continue;
            n++; if (r.is_correct) ok++;
          }
          if (n) kp[name] = { n, ok };
        }
      }
      return { q, kp };
    },
    /** 一键整理（与 /api/organize 同构，幂等可重复）：按题目真实来源重算归档列，历史未分类题自动归类 */
    async organize(target) {
      const kind = target === 'wrong' ? 'records' : target;
      if (!['records', 'favorites', 'notes'].includes(kind)) throw new Error('target 应为 wrong / favorites / notes');
      const rows = await store.getAll(kind);
      const groupCount = new Map();
      const updates = [];
      let total = 0;
      for (const r of rows) {
        if (target === 'wrong' && r.is_correct !== 0) continue; // 只整理错题记录
        total++;
        const cls = classifyLocal(store, tiku, r.question_id);
        const gk = cls.groupKey ?? '';
        const sk = cls.subKey ?? '';
        groupCount.set(gk, (groupCount.get(gk) || 0) + 1);
        if (gk !== (r.group_key || '') || sk !== (r.sub_key || '')) {
          updates.push({ ...r, group_key: gk, sub_key: sk });
        }
      }
      for (const u of updates) await store.put(kind, u);
      const groups = [...groupCount.entries()]
        .map(([key, count]) => ({ key, name: sourceGroupName(key), count }))
        .sort((a, b) => SOURCE_GROUPS.findIndex((g) => g.key === a.key) - SOURCE_GROUPS.findIndex((g) => g.key === b.key));
      return { ok: true, target, total, fixed: updates.length, groups };
    },
    /**
     * 申论/综应批改记录（离线存 IndexedDB 的 essays store）。
     * - saveEssay：每次批改落一条，含分数、作答原文、批改全文
     * - essays：倒序列表（回看用）
     * - essayStats：分数趋势 + 平均/首末/最高，全是「拿到满分百分比」口径
     */
    async saveEssay({ questionId, subject = '', chapter = '', answer = '', content = '', score = '', fullScore = null } = {}) {
      if (!String(content || '').trim()) throw new Error('缺少批改内容');
      const ai = parseScore(score, fullScore);
      await store.put('essays', {
        question_id: String(questionId || ''),
        subject, chapter,
        answer: String(answer || ''),
        content: String(content || ''),
        score: String(score || ''),
        full_score: fullScore == null ? null : Number(fullScore),
        got: ai.got, full: ai.full,
        created_at: Date.now(),
      });
      return { ok: true };
    },
    async essays({ limit = 50, offset = 0 } = {}) {
      const rows = await store.getAll('essays');
      rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      return {
        total, offset, limit, hasMore: offset + page.length < total,
        list: page.map((r) => ({
          id: r.id,
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          score: r.score || '',
          fullScore: r.full_score ?? null,
          answer: String(r.answer || '').slice(0, 400),
          content: String(r.content || ''),
          pct: r.full ? Math.round((Number(r.got) / Number(r.full)) * 100) : null,
          time: fmtDT(r.created_at),
          ts: r.created_at || 0,
        })),
      };
    },
    async essayStats() {
      const rows = (await store.getAll('essays')).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      const pts = rows
        .map((r) => ({ ts: r.created_at || 0, got: Number(r.got), full: Number(r.full), name: r.chapter || r.subject || '' }))
        .filter((x) => Number.isFinite(x.got) && Number.isFinite(x.full) && x.full > 0);
      const pcts = pts.map((x) => Math.round((x.got / x.full) * 100));
      return {
        count: rows.length,
        graded: pts.length,
        avgPct: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        firstPct: pcts.length ? pcts[0] : null,
        lastPct: pcts.length ? pcts[pcts.length - 1] : null,
        bestPct: pcts.length ? Math.max(...pcts) : null,
        trend: pts.map((x, i) => ({ ts: x.ts, pct: pcts[i], name: x.name })),
      };
    },
  };
}

/** 从「11/15」「11 分」「三档」这类评分文本里抠出分数（拿不到就返回 null） */
function parseScore(score, fullScore) {
  const s = String(score || '');
  const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return { got: Number(m[1]), full: Number(m[2]) };
  const n = /(\d+(?:\.\d+)?)/.exec(s);
  if (n && fullScore) return { got: Number(n[1]), full: Number(fullScore) };
  return { got: null, full: fullScore ? Number(fullScore) : null };
}

// ---------- 图片层 ----------
/** 公式图查询 + 真图形缓存（images 引擎适配器） */
export function createImagesApi(images) {
  return {
    /** 公式图：按 latex key 取 blob（未命中返回 null） */
    formula(key) {
      if (!key) return null;
      const r = images.get('SELECT mime, blob FROM images WHERE key = ?', key);
      return r ? { mime: r.mime, blob: r.blob } : null;
    },
    /** 题目内图片 URL 改写：contentHtml 中的 formulas URL → /formula/<key>（同源相对路径，SW 可拦截；Capacitor/浏览器通用） */
    rewriteHtml(html) {
      if (!html || !html.includes('<img')) return html;
      return html.replace(/src="https?:\/\/[^"]*formulas\?latex=([^&"]+)(?:&[^"]*)?"/g, (m, key) => `src="/formula/${encodeURIComponent(decodeURIComponent(key))}"`);
    },
  };
}

// ---------- 总入口 ----------
/**
 * @param {object} opts
 *   opts.tiku     — 题库引擎适配器 {get, all}
 *   opts.practice — q_material_map/q_materials 引擎适配器（可同 tiku）
 *   opts.images   — 图片库引擎适配器（可省略）
 *   opts.store    — 记录存储适配器（阶段 3 提供 IndexedDB 实现）
 * @returns {{ query, records, images, stats }}
 */
export async function initLocalApi(opts) {
  const { tiku, practice = tiku, images = null, store } = opts;
  if (!tiku || !store) throw new Error('initLocalApi 需要 tiku 与 store 适配器');
  const records = await store.getAll('records');
  const stats = aggregateStats(records, tiku);
  // 统计快照刷新：答题记录提交后调用（见 records.addRecord 的 onChanged 回调），
  // 原地替换 stats 的三个 Map 属性——local-queries 每次查询都动态读取，无需重启 App 即可刷新完成度。
  async function refreshStats() {
    const fresh = aggregateStats(await store.getAll('records'), tiku);
    stats.doneBySubject = fresh.doneBySubject;
    stats.chapterStats = fresh.chapterStats;
    stats.subStats = fresh.subStats;
    stats.catStats = fresh.catStats;
    return stats;
  }
  const query = createLocalApi(tiku, practice, stats);
  const recordsApi = createRecordsApi(store, tiku, refreshStats);
  const imagesApi = images ? createImagesApi(images) : null;
  return { query, records: recordsApi, images: imagesApi, stats, store };
}

/**
 * 浏览器端入口（阶段 3）：自动使用 IndexedDB 记录存储。
 * 题库引擎需调用方注入（阶段 4 双模式切换时由 app.js 传入 sql.js/CapacitorSQLite 引擎）。
 * @param {object} [opts] 同 initLocalApi，store 可省略（默认 createIdbStore()）
 */
export async function initLocalApiBrowser(opts = {}) {
  const store = opts.store || createIdbStore(opts.storeOpts || {});
  return initLocalApi({ ...opts, store });
}
