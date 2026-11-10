/**
 * public/backup.js — 数据备份与迁移（App 本地模式）
 *
 * 覆盖三类场景：误删/重装恢复、换手机迁移、升级前留档。
 * 设计说明见项目根「备份方案」：
 *   - 只备份用户数据（records/favorites/notes/custom_banks/skills/agents/prefs）
 *   - 不备份题库、AI 解析缓存、图形题缓存（可重建）
 *   - AI api_key 默认脱敏，用户勾选后才明文导出
 *   - 自动备份写应用私有目录（Directory.Data），保留最近 4 份
 *
 * 本文件同时导出纯函数（merge/validate/checksum）供 node --test 单测。
 */
'use strict';

export const FORMAT = 'kaogong-backup';
export const FORMAT_VERSION = 1;
export const APP_VERSION = '0.2.5';

const DATA_STORES = ['records', 'favorites', 'notes', 'custom_batches', 'custom_questions'];
const PREF_KEYS = ['theme', 'custom_practice_cfg', 'sg_review_v1', 'sg_session_v1', 'sg_last_subject', 'sg_profile'];
const PREF_PREFIXES = ['custom_bank_mode:', 'custom_bank_count:'];
const AUTO_KEEP = 4;
const AUTO_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_ENABLED_KEY = 'backup_auto_enabled';
const AUTO_LAST_KEY = 'backup_auto_last';
const AUTO_SIG_KEY = 'backup_auto_sig';
const AUTO_DIR = 'backups';
const PRE_IMPORT_NAME = 'pre-import-latest.json';
const AGENTS_KEY = 'ai_agents_v1';

let memorySnapshot = null; // 浏览器（无 Filesystem）模式下的导入前快照，仅当前会话可撤销

// ---------- 基础工具 ----------

function capPlugin(name) {
  return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins)
    ? window.Capacitor.Plugins[name] : null;
}

function getStore() {
  return (typeof window !== 'undefined' && window.__LOCAL_STORE__) || null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 文件名时间戳：20261107-1930 */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(typeof ms === 'string' && isNaN(Number(ms)) ? ms : Number(ms));
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export async function sha256Hex(text) {
  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    throw new Error('当前环境不支持 SHA-256 校验');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持 gzip 解压');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 数据采集 ----------

function loadAgentsRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(AGENTS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/** 智能体配置：默认把 api_key 置空并标记 has_key，勾选后才明文导出 */
function exportAgents(includeKeys) {
  const raw = loadAgentsRaw();
  return Object.keys(raw).map((id) => {
    const a = { ...raw[id], id: raw[id].id ?? id };
    const key = String(a.api_key || '');
    if (!includeKeys && key) {
      a.api_key = '';
      a._has_key = true;
    } else {
      a._has_key = !!key;
    }
    return a;
  });
}

function exportPrefs() {
  const out = {};
  for (const k of PREF_KEYS) {
    const v = localStorage.getItem(k);
    if (v != null) out[k] = v;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (PREF_PREFIXES.some((p) => k.startsWith(p))) {
      const v = localStorage.getItem(k);
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/**
 * 采集用户数据。
 * @param {object} store IndexedDB 适配器（window.__LOCAL_STORE__）
 * @param {{includeImages?:boolean, includeKeys?:boolean}} [opts]
 */
export async function collectData(store, opts = {}) {
  const includeImages = opts.includeImages !== false;
  const includeKeys = opts.includeKeys === true;
  const records = await store.getAll('records');
  const favorites = await store.getAll('favorites');
  const notes = await store.getAll('notes');
  const customBatches = await store.getAll('custom_batches');
  let customQuestions = await store.getAll('custom_questions');
  if (!includeImages) customQuestions = customQuestions.map((q) => ({ ...q, images: [] }));

  let skills = [];
  try {
    const mod = await import('./ai-local.js');
    skills = await mod.exportUserSkills();
  } catch { /* 技能库不可用时不影响其他数据 */ }

  return {
    records,
    favorites,
    notes,
    customBatches,
    customQuestions,
    skills,
    agents: exportAgents(includeKeys),
    prefs: exportPrefs(),
  };
}

export function countImages(customQuestions) {
  let n = 0;
  for (const q of customQuestions || []) {
    if (Array.isArray(q.images)) n += q.images.length;
  }
  return n;
}

export function makeCounts(data) {
  return {
    records: (data.records || []).length,
    favorites: (data.favorites || []).length,
    notes: (data.notes || []).length,
    customBatches: (data.customBatches || []).length,
    customQuestions: (data.customQuestions || []).length,
    skills: (data.skills || []).length,
    agents: (data.agents || []).length,
    images: countImages(data.customQuestions),
  };
}

/** 用已采集的数据组装完整备份对象（含校验值）；UI 部分导出与全量导出共用 */
export async function buildPayloadFromData(data, opts = {}) {
  const checksum = await sha256Hex(JSON.stringify(data));
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    device: typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '',
    options: {
      includeImages: opts.includeImages !== false,
      includeKeys: opts.includeKeys === true,
    },
    counts: makeCounts(data),
    checksum,
    data,
  };
}

/** 组装完整备份对象（含校验值） */
export async function buildPayload(store, opts = {}) {
  return buildPayloadFromData(await collectData(store, opts), opts);
}

// ---------- 校验 ----------

export async function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件内容为空或格式错误');
  if (payload.format !== FORMAT) throw new Error('这不是上岸的备份文件');
  const ver = Number(payload.formatVersion);
  if (!Number.isFinite(ver) || ver < 1) throw new Error('备份文件版本号无效');
  if (ver > FORMAT_VERSION) throw new Error(`备份版本 ${ver} 高于当前 App 支持的 ${FORMAT_VERSION}，请先升级 App`);
  if (!payload.data || typeof payload.data !== 'object') throw new Error('备份文件缺少 data 字段');
  for (const k of ['records', 'favorites', 'notes', 'customBatches', 'customQuestions', 'skills', 'agents']) {
    if (payload.data[k] != null && !Array.isArray(payload.data[k])) throw new Error(`data.${k} 不是数组`);
  }
  if (payload.data.prefs != null && typeof payload.data.prefs !== 'object') throw new Error('data.prefs 格式错误');
  if (!payload.checksum) throw new Error('备份文件缺少校验值，无法确认完整性');
  const actual = await sha256Hex(JSON.stringify(payload.data));
  if (actual !== payload.checksum) throw new Error('校验失败：备份文件可能已损坏或被修改');
  return true;
}

// ---------- 合并计划 ----------

/** 记录去重键：同题、同卷、同一秒视为同一次作答 */
export function recordKey(r) {
  return `${r.question_id}|${r.paper_id ?? ''}|${Math.floor((Number(r.created_at) || 0) / 1000)}`;
}

/** 自定义题内容指纹（不含 id/batch_id） */
export function questionHash(q) {
  return `${String(q.prompt || '')}\u0000${String(q.answer || '')}\u0000${JSON.stringify(q.options || [])}`;
}

function noteTime(n) {
  const v = Number(n && (n.updated_at || n.created_at));
  return Number.isFinite(v) ? v : 0;
}

/**
 * 计算导入计划（纯函数，便于单测）。
 * @param {{records:Array, favorites:Array, notes:Array, customBatches:Array, customQuestions:Array}} current
 * @param {object} data 备份里的 data
 */
export function buildPlan(current, data) {
  const plans = {
    records: { rows: [], add: 0, skip: 0 },
    favorites: { rows: [], add: 0, skip: 0 },
    notes: { rows: [], add: 0, update: 0, skip: 0 },
    batches: { rows: [], add: 0, skip: 0 },
    questions: { rows: [], add: 0, skip: 0 },
    skills: { rows: [], add: 0, skip: 0 },
    agents: { rows: [], add: 0, skip: 0 },
    prefs: { rows: [], add: 0, skip: 0 },
  };

  // 做题记录
  const recSeen = new Set((current.records || []).map(recordKey));
  for (const r of data.records || []) {
    if (!r || r.question_id == null) { plans.records.skip++; continue; }
    const k = recordKey(r);
    if (recSeen.has(k)) { plans.records.skip++; continue; }
    recSeen.add(k);
    plans.records.rows.push(r);
    plans.records.add++;
  }

  // 收藏（一题一条）
  const favSeen = new Set((current.favorites || []).map((f) => String(f.question_id)));
  for (const f of data.favorites || []) {
    if (!f || f.question_id == null) { plans.favorites.skip++; continue; }
    const k = String(f.question_id);
    if (favSeen.has(k)) { plans.favorites.skip++; continue; }
    favSeen.add(k);
    plans.favorites.rows.push(f);
    plans.favorites.add++;
  }

  // 笔记（一题一条，较新的 updated_at 覆盖）
  const noteMap = new Map((current.notes || []).map((n) => [String(n.question_id), n]));
  for (const n of data.notes || []) {
    if (!n || n.question_id == null) { plans.notes.skip++; continue; }
    const k = String(n.question_id);
    const old = noteMap.get(k);
    if (!old) {
      noteMap.set(k, n);
      plans.notes.rows.push(n);
      plans.notes.add++;
    } else if (noteTime(n) > noteTime(old)) {
      noteMap.set(k, n);
      plans.notes.rows.push(n);
      plans.notes.update++;
    } else {
      plans.notes.skip++;
    }
  }

  // 自定义题库：批次按 name+subject 匹配；题目按内容指纹去重
  let nextBatchId = Math.max(0, ...(current.customBatches || []).map((b) => Number(b.id) || 0)) + 1;
  const batchIdMap = new Map();
  for (const b of data.customBatches || []) {
    if (!b || b.id == null) { plans.batches.skip++; continue; }
    const oldB = (current.customBatches || []).find(
      (x) => String(x.name || '').trim() === String(b.name || '').trim()
        && String(x.subject || '') === String(b.subject || '')
    );
    if (oldB) {
      batchIdMap.set(Number(b.id), Number(oldB.id));
      plans.batches.skip++;
    } else {
      const nid = nextBatchId++;
      batchIdMap.set(Number(b.id), nid);
      plans.batches.rows.push({ ...b, id: nid });
      plans.batches.add++;
    }
  }

  let nextQId = Math.max(0, ...(current.customQuestions || []).map((q) => Number(q.id) || 0)) + 1;
  const qSeen = new Set((current.customQuestions || []).map((q) => `${Number(q.batch_id)}|${questionHash(q)}`));
  for (const q of data.customQuestions || []) {
    if (!q) { plans.questions.skip++; continue; }
    const bid = batchIdMap.get(Number(q.batch_id));
    if (bid == null) { plans.questions.skip++; continue; }
    const k = `${bid}|${questionHash(q)}`;
    if (qSeen.has(k)) { plans.questions.skip++; continue; }
    qSeen.add(k);
    plans.questions.rows.push({ ...q, id: nextQId++, batch_id: bid });
    plans.questions.add++;
  }

  // 技能（按名字）
  const skillSeen = new Set((current.skills || []).map((s) => String(s.name)));
  for (const s of data.skills || []) {
    if (!s || !s.name) { plans.skills.skip++; continue; }
    const k = String(s.name);
    if (skillSeen.has(k)) { plans.skills.skip++; continue; }
    skillSeen.add(k);
    plans.skills.rows.push(s);
    plans.skills.add++;
  }

  // 智能体（按 id，保留本机配置与 key）
  const agentSeen = new Set((current.agents || []).map((a) => String(a.id)));
  for (const a of data.agents || []) {
    if (!a || a.id == null) { plans.agents.skip++; continue; }
    const k = String(a.id);
    if (agentSeen.has(k)) { plans.agents.skip++; continue; }
    agentSeen.add(k);
    plans.agents.rows.push(a);
    plans.agents.add++;
  }

  // 偏好设置
  const prefMap = current.prefs || {};
  for (const [k, v] of Object.entries(data.prefs || {})) {
    if (Object.prototype.hasOwnProperty.call(prefMap, k)) { plans.prefs.skip++; continue; }
    plans.prefs.rows.push([k, v]);
    plans.prefs.add++;
  }

  return plans;
}

/** 读取当前数据并生成导入计划（供 UI 预览） */
export async function planImport(store, data, mode = 'merge') {
  if (mode === 'replace') {
    return buildPlan({ records: [], favorites: [], notes: [], customBatches: [], customQuestions: [], skills: [], agents: [], prefs: {} }, data);
  }
  return buildPlan(await collectData(store, { includeImages: true, includeKeys: false }), data);
}

// ---------- 导入执行 ----------

async function writePreImportSnapshot(store) {
  const payload = await buildPayload(store, { includeImages: true, includeKeys: true });
  memorySnapshot = payload;
  const FS = capPlugin('Filesystem');
  if (!FS) return;
  try {
    const text = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(text);
    let data = text;
    let name = PRE_IMPORT_NAME;
    if (bytes.length > 4 * 1024 * 1024) {
      const gz = await gzipBytes(bytes);
      if (gz) { data = bytesToBase64(gz); name = PRE_IMPORT_NAME + '.gz'; }
    }
    await FS.mkdir({ path: AUTO_DIR, directory: 'DATA', recursive: true }).catch(() => {});
    await FS.writeFile({
      path: `${AUTO_DIR}/${name}`,
      data,
      directory: 'DATA',
      ...(name.endsWith('.gz') ? {} : { encoding: 'utf8' }),
    });
    if (name !== PRE_IMPORT_NAME) {
      await FS.deleteFile({ path: `${AUTO_DIR}/${PRE_IMPORT_NAME}`, directory: 'DATA' }).catch(() => {});
    }
  } catch (e) {
    console.warn('[backup] 导入前快照写入失败（仍保留内存快照）', e);
  }
}

async function readPreImportSnapshot() {
  const FS = capPlugin('Filesystem');
  if (FS) {
    for (const name of [PRE_IMPORT_NAME, PRE_IMPORT_NAME + '.gz']) {
      try {
        const isGz = name.endsWith('.gz');
        const r = await FS.readFile({
          path: `${AUTO_DIR}/${name}`,
          directory: 'DATA',
          ...(isGz ? {} : { encoding: 'utf8' }),
        });
        if (!r || !r.data) continue;
        const text = isGz
          ? new TextDecoder().decode(await gunzipBytes(base64ToBytes(String(r.data))))
          : String(r.data);
        return JSON.parse(text);
      } catch { /* 试下一个 */ }
    }
  }
  return memorySnapshot;
}

export async function hasUndoSnapshot() {
  return !!(await readPreImportSnapshot());
}

/**
 * 执行导入。
 * @param {object} store
 * @param {object} payload 已通过 validatePayload 的备份对象
 * @param {'merge'|'replace'} mode
 * @param {{skipSnapshot?:boolean}} [opts]
 */
export async function applyImport(store, payload, mode = 'merge', opts = {}) {
  await validatePayload(payload);
  const data = payload.data || {};
  const replace = mode === 'replace';

  if (!opts.skipSnapshot) await writePreImportSnapshot(store);

  if (replace) {
    for (const k of DATA_STORES) await store.clear(k);
  }

  const plan = await planImport(store, data, replace ? 'merge' : mode);

  if (plan.records.rows.length) await store.putMany('records', plan.records.rows);
  if (plan.favorites.rows.length) await store.putMany('favorites', plan.favorites.rows);
  if (plan.notes.rows.length) await store.putMany('notes', plan.notes.rows);
  if (plan.batches.rows.length) await store.putMany('custom_batches', plan.batches.rows);
  if (plan.questions.rows.length) await store.putMany('custom_questions', plan.questions.rows);

  // 技能库（replace 时先清空）
  try {
    const mod = await import('./ai-local.js');
    await mod.importUserSkills(data.skills || [], { replace });
  } catch (e) {
    console.warn('[backup] 技能库导入失败', e);
  }

  // 智能体配置
  const raw = loadAgentsRaw();
  if (replace) {
    const next = {};
    for (const a of data.agents || []) if (a && a.id != null) next[a.id] = a;
    localStorage.setItem(AGENTS_KEY, JSON.stringify(next));
  } else {
    for (const a of plan.agents.rows) {
      if (a && a.id != null && !raw[a.id]) raw[a.id] = a;
    }
    localStorage.setItem(AGENTS_KEY, JSON.stringify(raw));
  }

  // 偏好设置
  if (replace) {
    for (const [k, v] of Object.entries(data.prefs || {})) localStorage.setItem(k, String(v));
  } else {
    for (const [k, v] of plan.prefs.rows) localStorage.setItem(k, String(v));
  }

  return {
    records: plan.records.add,
    favorites: plan.favorites.add,
    notes: plan.notes.add + plan.notes.update,
    customBatches: plan.batches.add,
    customQuestions: plan.questions.add,
    skills: plan.skills.add,
    skipped: plan.records.skip + plan.favorites.skip + plan.notes.skip + plan.questions.skip,
  };
}

/** 撤销上次导入：用导入前快照整体覆盖 */
export async function undoLastImport(store) {
  const snap = await readPreImportSnapshot();
  if (!snap) throw new Error('没有可撤销的导入记录');
  await applyImport(store, snap, 'replace', { skipSnapshot: true });
  return true;
}

// ---------- 文件读写 ----------

/** 导出并分享/下载；返回 {filename, bytes, counts} */
export async function exportBackup(store, opts = {}) {
  const payload = await buildPayload(store, opts);
  const text = JSON.stringify(payload);
  let bytes = new TextEncoder().encode(text);
  let filename = `kaogong-backup-${stamp()}.json`;
  if (bytes.length > 8 * 1024 * 1024) {
    const gz = await gzipBytes(bytes);
    if (gz) { bytes = gz; filename += '.gz'; }
  }

  const FS = capPlugin('Filesystem');
  const Share = capPlugin('Share');
  const result = { filename, bytes: bytes.length, counts: payload.counts, shared: false, downloaded: false };

  if (FS) {
    const path = `exports/${filename}`;
    await FS.mkdir({ path: 'exports', directory: 'CACHE', recursive: true }).catch(() => {});
    await FS.writeFile({ path, data: bytesToBase64(bytes), directory: 'CACHE' });
    const uriRes = await FS.getUri({ path, directory: 'CACHE' });
    result.uri = uriRes && uriRes.uri;
    if (Share && result.uri) {
      // files 走 FileProvider（Android 上 url=file:// 往往只当文本分享，附件必须用 files）
      await Share.share({ title: '考公刷题备份', files: [result.uri], dialogTitle: '保存或分享备份文件' });
      result.shared = true;
    }
  } else {
    downloadBytes(bytes, filename);
    result.downloaded = true;
  }
  return result;
}

/** 读取用户选择的备份文件（支持 .json 与 .json.gz） */
export async function readBackupFile(file) {
  if (!file) throw new Error('未选择文件');
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzipBytes(bytes);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    throw new Error('文件不是有效的 JSON（可能已损坏）');
  }
  await validatePayload(payload);
  return payload;
}

export function pickBackupFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // 不按扩展名/MIME 过滤：部分安卓文件选择器会把 .json 当成未知类型直接隐藏；
    // 安全性由 readBackupFile() 的 format/version/checksum 校验保证。
    input.accept = '*/*';
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files && input.files[0];
      input.remove();
      resolve(f || null);
    };
    document.body.appendChild(input);
    input.click();
  });
}

// ---------- 自动备份 ----------

async function dataSignature(store) {
  const records = await store.getAll('records');
  const notes = await store.getAll('notes');
  const batches = await store.getAll('custom_batches');
  const lastRec = records.reduce((m, r) => Math.max(m, Number(r.created_at) || 0), 0);
  const lastNote = notes.reduce((m, n) => Math.max(m, noteTime(n)), 0);
  return [records.length, lastRec, notes.length, lastNote, batches.length].join('|');
}

export function autoBackupEnabled() {
  return localStorage.getItem(AUTO_ENABLED_KEY) !== '0';
}

export function setAutoBackupEnabled(on) {
  localStorage.setItem(AUTO_ENABLED_KEY, on ? '1' : '0');
}

export function lastAutoBackupTime() {
  return Number(localStorage.getItem(AUTO_LAST_KEY) || 0);
}

async function pruneAutoBackups(FS) {
  try {
    const r = await FS.readdir({ path: AUTO_DIR, directory: 'DATA' });
    const files = (r.files || [])
      .map((f) => (typeof f === 'string' ? f : f.name))
      .filter((n) => /^auto-.*\.json(\.gz)?$/.test(n))
      .sort()
      .reverse();
    for (const name of files.slice(AUTO_KEEP)) {
      await FS.deleteFile({ path: `${AUTO_DIR}/${name}`, directory: 'DATA' }).catch(() => {});
    }
  } catch { /* 目录不存在时忽略 */ }
}

/**
 * 启动后调用：满足「已开启 + 距上次 ≥7 天 + 数据有变化」时写一份自动备份。
 * 应用私有目录可扛误删/崩溃/覆盖安装，但卸载会被系统清除 —— 所以仍需定期手动导出。
 */
export async function maybeAutoBackup(store, opts = {}) {
  if (!store) return null;
  const force = !!opts.force;
  if (!force && !autoBackupEnabled()) return null;
  const last = lastAutoBackupTime();
  if (!force && last && Date.now() - last < AUTO_INTERVAL_MS) return null;

  const sig = await dataSignature(store);
  if (!force && sig === localStorage.getItem(AUTO_SIG_KEY)) return null;

  // 没有任何用户数据时不生成备份（避免新装/清空后产生一堆空备份）
  const [recCount, , noteCount, , batchCount] = sig.split('|').map(Number);
  if (!recCount && !noteCount && !batchCount) return null;

  const payload = await buildPayload(store, { includeImages: true, includeKeys: false });
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  let data = text;
  let name = `${AUTO_DIR}/auto-${stamp()}.json`;
  if (bytes.length > 6 * 1024 * 1024) {
    const gz = await gzipBytes(bytes);
    if (gz) { data = bytesToBase64(gz); name = `${AUTO_DIR}/auto-${stamp()}.json.gz`; }
  }

  const FS = capPlugin('Filesystem');
  if (!FS) return null; // 浏览器模式不写自动备份（无法静默落盘）
  await FS.mkdir({ path: AUTO_DIR, directory: 'DATA', recursive: true }).catch(() => {});
  await FS.writeFile({ path: name, data, directory: 'DATA', ...(name.endsWith('.gz') ? {} : { encoding: 'utf8' }) });
  await pruneAutoBackups(FS);
  localStorage.setItem(AUTO_LAST_KEY, String(Date.now()));
  localStorage.setItem(AUTO_SIG_KEY, sig);
  return { name, bytes: bytes.length };
}

export async function listAutoBackups() {
  const FS = capPlugin('Filesystem');
  if (!FS) return [];
  try {
    const r = await FS.readdir({ path: AUTO_DIR, directory: 'DATA' });
    return (r.files || [])
      .map((f) => (typeof f === 'string' ? f : f.name))
      .filter((n) => /^auto-.*\.json(\.gz)?$/.test(n))
      .sort()
      .reverse();
  } catch { return []; }
}

export async function readAutoBackup(name) {
  const FS = capPlugin('Filesystem');
  if (!FS) throw new Error('当前环境不支持读取自动备份');
  const isGz = name.endsWith('.gz');
  const r = await FS.readFile({
    path: `${AUTO_DIR}/${name}`,
    directory: 'DATA',
    ...(isGz ? {} : { encoding: 'utf8' }),
  });
  const text = isGz
    ? new TextDecoder().decode(await gunzipBytes(base64ToBytes(String(r.data))))
    : String(r.data || '');
  const payload = JSON.parse(text);
  await validatePayload(payload);
  return payload;
}

// ---------- 页面 ----------

function badge(n, cls = '') {
  return `<span class="tag ${cls}" style="margin-left:6px">${n}</span>`;
}

/**
 * 渲染「数据与备份」页。
 * @param {object} ctx {view, el, ico, esc, toast}
 */
export async function renderBackupPage(ctx) {
  const { view, el, ico, esc, toast } = ctx;
  const store = getStore();
  if (!store) {
    view.innerHTML = `<div class="empty"><span class="empty-ico">${ico('alert', 40)}</span>数据备份仅支持 App 本地模式<br>请从手机 App 打开此页面</div>`;
    return;
  }

  view.innerHTML = '<div class="spinner"></div>';
  let data;
  try {
    data = await collectData(store, { includeImages: true, includeKeys: false });
  } catch (e) {
    view.innerHTML = `<div class="empty">读取本地数据失败：${esc(e.message)}</div>`;
    return;
  }
  const wrong = data.records.filter((r) => r.is_correct === 0).length;
  const imageCount = countImages(data.customQuestions);
  const autoLast = lastAutoBackupTime();
  const undoReady = await hasUndoSnapshot();

  view.innerHTML = '';

  // 数据概览
  const card = el('div', 'card', `
    <h3>${ico('chart', 16)} 当前数据</h3>
    <div class="li-sub">做题记录 ${badge(data.records.length)} · 错题 ${badge(wrong)}</div>
    <div class="li-sub">收藏 ${badge(data.favorites.length)} · 笔记 ${badge(data.notes.length)}</div>
    <div class="li-sub">自定义题库 ${badge(data.customBatches.length)} 批 / ${badge(data.customQuestions.length)} 题${imageCount ? ` · 图片 ${imageCount} 张` : ''}</div>
    <div class="li-sub">技能库 ${badge(data.skills.length)} 个 · AI 智能体 ${badge(data.agents.length)} 个</div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" id="bk-export" style="flex:1">${ico('save', 15)} 导出备份</button>
      <button class="btn btn-ghost" id="bk-import" style="flex:1">${ico('folder', 15)} 导入备份</button>
    </div>
    <div class="li-tip" style="margin-top:10px">${ico('lightbulb', 13)} 备份包含错题/收藏/笔记/自定义题库/技能/AI 配置；不包含题库本身和图片缓存</div>
  `);
  view.appendChild(card);

  // 自动备份
  const autoOn = autoBackupEnabled();
  const autoCard = el('div', 'card', `
    <h3>${ico('history', 16)} 自动备份</h3>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0 4px">
      <div>
        <div style="font-size:14px;font-weight:600">每周自动备份</div>
        <div class="li-sub" style="margin:2px 0 0">上次：${fmtTime(autoLast)}</div>
      </div>
      <label class="switch" style="display:inline-flex;align-items:center;gap:8px;flex:0 0 auto">
        <input type="checkbox" id="bk-auto-toggle" ${autoOn ? 'checked' : ''}>
      </label>
    </div>
    <div class="li-tip">${ico('alert', 13)} 自动备份存在应用私有目录：能恢复误删和覆盖安装，但<b>卸载 App 会被清除</b>。换机/卸载前请手动导出到网盘或微信。</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-ghost" id="bk-auto-now" style="flex:1">${ico('refresh', 15)} 立即备份</button>
      <button class="btn btn-ghost" id="bk-auto-restore" style="flex:1">${ico('history', 15)} 从备份恢复</button>
    </div>
    ${undoReady ? `<button class="btn btn-ghost btn-block" id="bk-undo" style="margin-top:8px;color:var(--red)">${ico('repeat', 15)} 撤销上次导入</button>` : ''}
  `);
  view.appendChild(autoCard);

  // ---- 导出 ----
  const exportSheet = () => {
    const overlay = el('div', 'sheet-overlay');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${ico('save', 16)} 导出备份</b><button class="sheet-close">✕</button></div>
        <div class="cfg-group">选择导出内容</div>
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0"><input type="checkbox" id="bk-opt-records" checked> 做题记录、错题、收藏、笔记</label>
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0"><input type="checkbox" id="bk-opt-custom" checked> 自定义题库（含题目图片）</label>
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0"><input type="checkbox" id="bk-opt-skills" checked> 技能库</label>
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0"><input type="checkbox" id="bk-opt-keys"> 包含 AI API Key（明文，分享前请谨慎）</label>
        <div class="li-tip" style="margin:6px 0 12px">${ico('alert', 13)} 备份文件可能包含你的作答与笔记，请只发给自己</div>
        <button class="btn btn-primary btn-block" id="bk-export-go">${ico('save', 15)} 生成并分享</button>
      </div>`;
    view.appendChild(overlay);
    overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#bk-export-go').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const includeRecords = overlay.querySelector('#bk-opt-records').checked;
      const includeCustom = overlay.querySelector('#bk-opt-custom').checked;
      const includeSkills = overlay.querySelector('#bk-opt-skills').checked;
      const includeKeys = overlay.querySelector('#bk-opt-keys').checked;
      if (!includeRecords && !includeCustom && !includeSkills) { toast('至少选择一项内容'); return; }
      btn.disabled = true;
      btn.textContent = '正在生成…';
      try {
        const full = await collectData(store, { includeImages: true, includeKeys: false });
        const picked = {
          records: includeRecords ? full.records : [],
          favorites: includeRecords ? full.favorites : [],
          notes: includeRecords ? full.notes : [],
          customBatches: includeCustom ? full.customBatches : [],
          customQuestions: includeCustom ? full.customQuestions : [],
          skills: includeSkills ? full.skills : [],
          agents: includeKeys ? exportAgents(true) : full.agents,
          prefs: includeRecords ? full.prefs : {},
        };
        const payload = await buildPayloadFromData(picked, { includeImages: includeCustom, includeKeys });
        const text = JSON.stringify(payload);
        let bytes = new TextEncoder().encode(text);
        let filename = `kaogong-backup-${stamp()}.json`;
        if (bytes.length > 8 * 1024 * 1024) {
          const gz = await gzipBytes(bytes);
          if (gz) { bytes = gz; filename += '.gz'; }
        }
        const FS = capPlugin('Filesystem');
        const Share = capPlugin('Share');
        if (FS) {
          const path = `exports/${filename}`;
          await FS.mkdir({ path: 'exports', directory: 'CACHE', recursive: true }).catch(() => {});
          await FS.writeFile({ path, data: bytesToBase64(bytes), directory: 'CACHE' });
          const uriRes = await FS.getUri({ path, directory: 'CACHE' });
          if (Share && uriRes && uriRes.uri) {
            await Share.share({ title: '考公刷题备份', files: [uriRes.uri], dialogTitle: '保存或分享备份文件' });
          }
          toast(`已生成 ${filename}（${(bytes.length / 1048576).toFixed(1)} MB）`);
        } else {
          downloadBytes(bytes, filename);
          toast('备份已开始下载');
        }
        overlay.remove();
      } catch (e) {
        toast('导出失败：' + e.message);
        btn.disabled = false;
        btn.textContent = '生成并分享';
      }
    };
  };

  // ---- 导入预览 ----
  const openPreview = async (payload, filename, mode = 'merge') => {
    const plan = await planImport(store, payload.data, mode);
    const overlay = el('div', 'sheet-overlay');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${ico('folder', 16)} 导入预览</b><button class="sheet-close">✕</button></div>
        <div class="li-sub" style="margin-bottom:4px">${esc(filename || '备份文件')}</div>
        <div class="li-sub">导出时间：${esc(fmtTime(payload.exportedAt))} · 版本 ${esc(payload.appVersion || '—')}</div>
        <div style="margin:12px 0 4px;font-weight:700">将导入</div>
        <div class="li-sub">记录 +${plan.records.add}${plan.records.skip ? ` · 已存在 ${plan.records.skip}` : ''}</div>
        <div class="li-sub">收藏 +${plan.favorites.add}${plan.favorites.skip ? ` · 已存在 ${plan.favorites.skip}` : ''}</div>
        <div class="li-sub">笔记 +${plan.notes.add}${plan.notes.update ? ` · 更新 ${plan.notes.update}` : ''}${plan.notes.skip ? ` · 跳过 ${plan.notes.skip}` : ''}</div>
        <div class="li-sub">自定义题库 +${plan.batches.add} 批 / +${plan.questions.add} 题${plan.questions.skip ? ` · 跳过 ${plan.questions.skip}` : ''}</div>
        <div class="li-sub">技能 +${plan.skills.add}${plan.skills.skip ? ` · 已存在 ${plan.skills.skip}` : ''}</div>
        <div class="li-tip" style="margin:10px 0 12px">${ico('alert', 13)} 导入前会自动保存一份当前数据快照，可在本页撤销</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="bk-do-merge" style="flex:1">合并导入</button>
          <button class="btn btn-ghost" id="bk-do-replace" style="flex:1;color:var(--red)">覆盖本地</button>
        </div>
      </div>`;
    view.appendChild(overlay);
    overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const run = async (btn, mode2) => {
      if (mode2 === 'replace' && !confirm('覆盖导入会清空本地现有记录/收藏/笔记/自定义题库，确定继续？')) return;
      btn.disabled = true;
      btn.textContent = '正在导入…';
      try {
        const r = await applyImport(store, payload, mode2);
        overlay.remove();
        toast(`导入完成：记录 ${r.records} / 收藏 ${r.favorites} / 笔记 ${r.notes} / 自定义题 ${r.customQuestions}`);
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        toast('导入失败：' + e.message);
        btn.disabled = false;
        btn.textContent = mode2 === 'replace' ? '覆盖本地' : '合并导入';
      }
    };
    overlay.querySelector('#bk-do-merge').onclick = (e) => run(e.currentTarget, 'merge');
    overlay.querySelector('#bk-do-replace').onclick = (e) => run(e.currentTarget, 'replace');
  };

  // ---- 选择文件 ----
  const startImport = async () => {
    let file;
    try { file = await pickBackupFile(); } catch { return; }
    if (!file) return;
    try {
      const payload = await readBackupFile(file);
      await openPreview(payload, file.name, 'merge');
    } catch (e) {
      toast(e.message);
    }
  };

  // ---- 从自动备份恢复 ----
  const openAutoList = async () => {
    const files = await listAutoBackups();
    const overlay = el('div', 'sheet-overlay');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-head"><b>${ico('history', 16)} 自动备份</b><button class="sheet-close">✕</button></div>
        <div id="bk-auto-list"></div>
      </div>`;
    view.appendChild(overlay);
    overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const listEl = overlay.querySelector('#bk-auto-list');
    if (!files.length) {
      listEl.innerHTML = '<div class="empty" style="padding:24px 0">还没有自动备份</div>';
      return;
    }
    for (const name of files) {
      const row = el('div', 'list-item', `
        <div class="li-main">
          <div class="li-title">${esc(name.replace('auto-', '').replace(/\.json(\.gz)?$/, ''))}</div>
          <div class="li-sub">${name.endsWith('.gz') ? '压缩备份' : '备份文件'}</div>
        </div>
      `);
      row.style.cursor = 'pointer';
      row.onclick = async () => {
        try {
          const payload = await readAutoBackup(name);
          overlay.remove();
          await openPreview(payload, name, 'merge');
        } catch (e) { toast('读取失败：' + e.message); }
      };
      listEl.appendChild(row);
    }
  };

  // ---- 事件绑定 ----
  view.querySelector('#bk-export').onclick = exportSheet;
  view.querySelector('#bk-import').onclick = startImport;
  view.querySelector('#bk-auto-toggle').onchange = (e) => {
    setAutoBackupEnabled(e.target.checked);
    toast(e.target.checked ? '已开启每周自动备份' : '已关闭自动备份');
  };
  view.querySelector('#bk-auto-now').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '正在备份…';
    try {
      const r = await maybeAutoBackup(store, { force: true });
      toast(r ? '自动备份完成' : '当前环境不支持自动备份');
    } catch (e2) {
      toast('备份失败：' + e2.message);
    }
    btn.disabled = false;
    btn.textContent = '立即备份';
  };
  view.querySelector('#bk-auto-restore').onclick = openAutoList;
  const undoBtn = view.querySelector('#bk-undo');
  if (undoBtn) {
    undoBtn.onclick = async () => {
      if (!confirm('撤销上次导入？当前数据会被替换为导入前的快照。')) return;
      undoBtn.disabled = true;
      try {
        await undoLastImport(store);
        toast('已撤销，正在刷新…');
        setTimeout(() => location.reload(), 1000);
      } catch (e) {
        toast(e.message);
        undoBtn.disabled = false;
      }
    };
  }
}
