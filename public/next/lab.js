/* 实验室（测试版专用）：自学习引擎原型
 * 目标：不碰正式版，先把「能力估计 + 选题」这套东西跑起来，用真实作答记录做回测，
 * 看它到底比「考点历史正确率」强多少（AUC），再决定要不要并进正式版。
 *
 * 模型：按考点的 1PL（Logistic）能力估计，Glicko 式的 θ + RD 增量更新
 *   p(答对) = sigmoid(θ_kp - b_题)
 *   b_题 = (difficulty - 5) * 0.28   （题库难度 0-9 → logit 区间约 ±1.6）
 *   θ += K * (y - p)，K = 0.35 * RD / (RD + 0.5)，RD 随作答次数收缩（越做越确定）
 * 回测：按时间 70/30 切分，前 70% 训练，后 30% 预测；
 *   对比基线 = 该考点截至当时的历史正确率（带 0.5 先验的平滑值）。
 */
(function () {
  'use strict';
  window.__LAB__ = true;

  // 注意：__LOCAL_API_PROMISE__ 是个 Promise（resolve 出 (path, opts) => Promise 的函数），
  // 不是函数本身 —— 直接调用会报 "is not a function"。
  const getApi = async () => {
    const p = window.__LOCAL_API_PROMISE__;
    if (!p) return (path, opts) => fetch(path, opts).then((r) => r.json());
    return typeof p === 'function' ? p : await p;
  };
  const api = async (path, opts) => (await getApi())(path, opts);

  const diffToB = (d) => {
    const v = Number(d);
    if (!Number.isFinite(v)) return 0;
    return Math.max(-1.6, Math.min(1.6, (v - 5) * 0.28));
  };
  const sig = (x) => 1 / (1 + Math.exp(-x));

  /** 批量取题目难度与考点（原生库能一次查完，Web 端退回逐条） */
  async function loadMeta(ids) {
    const out = new Map();
    const db = window.NativeDB;
    if (db && db.all) {
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const q = chunk.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
        let rows = [];
        try {
          rows = await db.all(`SELECT questionId, difficulty, chapter, type FROM questions WHERE questionId IN (${q})`, '[]');
          if (typeof rows === 'string') rows = JSON.parse(rows);
          if (rows && rows.rows) rows = rows.rows;
        } catch { rows = []; }
        for (const r of rows || []) out.set(String(r.questionId), { diff: r.difficulty, chapter: r.chapter, type: r.type });
      }
    }
    return out;
  }

  async function loadKp(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      try {
        const d = await api('/api/kp?ids=' + encodeURIComponent(chunk.join(',')));
        for (const [k, v] of Object.entries(d || {})) if (v) map.set(String(k), v);
      } catch { /* 取不到就用 chapter 兜底 */ }
    }
    return map;
  }

  function auc(pairs) {
    const pos = pairs.filter((p) => p.y === 1).map((p) => p.p);
    const neg = pairs.filter((p) => p.y === 0).map((p) => p.p);
    if (!pos.length || !neg.length) return null;
    let win = 0;
    for (const a of pos) for (const b of neg) win += a > b ? 1 : a === b ? 0.5 : 0;
    return win / (pos.length * neg.length);
  }

  async function run() {
    const recs = await api('/api/records/recent?limit=4000');
    const list = (Array.isArray(recs) ? recs : recs.list || []).slice().reverse(); // 时间正序
    if (!list.length) return { events: 0 };
    const ids = [...new Set(list.map((r) => String(r.questionId)))];
    const [meta, kpMap] = await Promise.all([loadMeta(ids), loadKp(ids)]);
    const events = list.map((r) => {
      const m = meta.get(String(r.questionId)) || {};
      const kp = kpMap.get(String(r.questionId)) || m.chapter || r.chapter || '未分类';
      return { kp, b: diffToB(m.diff), y: r.correct ? 1 : 0, t: r.time || '' };
    });

    const cut = Math.floor(events.length * 0.7);
    const theta = new Map(); // kp -> {t, rd, n, ok}
    const testPairs = [], basePairs = [];
    let trainN = 0;

    events.forEach((e, i) => {
      let s = theta.get(e.kp);
      if (!s) { s = { t: 0, rd: 1.2, n: 0, ok: 0 }; theta.set(e.kp, s); }
      const p = sig(s.t - e.b);
      if (i >= cut) {
        testPairs.push({ p, y: e.y });
        basePairs.push({ p: (s.ok + 0.5) / (s.n + 1), y: e.y });
      } else {
        trainN += 1;
      }
      const K = 0.35 * (s.rd / (s.rd + 0.5));
      s.t += K * (e.y - p);
      s.rd = Math.max(0.18, s.rd * 0.985);
      s.n += 1;
      if (e.y) s.ok += 1;
    });

    const rows = [...theta.entries()]
      .map(([kp, s]) => ({ kp, theta: s.t, n: s.n, acc: s.n ? s.ok / s.n : 0, rd: s.rd }))
      .sort((a, b) => a.theta - b.theta);

    return {
      events: events.length,
      trainN,
      testN: testPairs.length,
      kps: rows.length,
      aucModel: auc(testPairs),
      aucBase: auc(basePairs),
      rows,
    };
  }

  function panel() {
    const host = document.createElement('div');
    host.id = 'lab-panel';
    host.innerHTML = `
      <style>
        #lab-panel{position:fixed;inset:0;z-index:9000;background:var(--bg,#F5F6F8);display:flex;flex-direction:column}
        .lab-bar{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line,#E8EBF0);background:var(--card,#fff);font-size:15px;color:var(--text,#1B1F27)}
        .lab-back{border:0;background:transparent;font-size:24px;line-height:1;padding:0 4px;color:inherit}
        .lab-tag{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(224,163,46,.14);color:#B87B14}
        .lab-body{padding:16px;overflow:auto;flex:1}
        .lab-lead{font-size:12.5px;line-height:1.6;color:var(--muted,#8A90A0);margin:0 0 14px}
        .lab-actions{display:flex;gap:10px;margin-bottom:16px}
        .lab-btn{flex:1;border:0;border-radius:12px;padding:12px;font-size:14.5px;font-weight:600;color:#fff;background:var(--brand,#2F5BEA)}
        .lab-btn[disabled]{opacity:.6}
        .lab-card{background:var(--card,#fff);border:1px solid var(--line,#E8EBF0);border-radius:14px;padding:14px;margin-bottom:12px}
        .lab-num{font-size:30px;font-weight:750;letter-spacing:-.5px;color:var(--text,#1B1F27)}
        .lab-lab{font-size:12px;color:var(--muted,#8A90A0);margin-top:2px}
        .lab-kv{display:flex;justify-content:space-between;align-items:baseline;font-size:13.5px;padding:6px 0;color:var(--text,#1B1F27)}
        .lab-kv b{font-size:17px;font-variant-numeric:tabular-nums}
        .lab-kv b.up{color:#1B8A4B}
        .lab-kv b.down{color:#C0392B}
        .lab-h{font-size:13px;font-weight:700;margin:16px 0 8px;color:var(--text,#1B1F27)}
        .lab-list{display:flex;flex-direction:column;gap:1px;background:var(--line,#E8EBF0);border-radius:12px;overflow:hidden;margin-bottom:14px}
        .lab-row{display:flex;align-items:center;gap:8px;background:var(--card,#fff);padding:10px 12px;font-size:13px}
        .lab-kp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1B1F27)}
        .lab-m{color:var(--muted,#8A90A0);font-size:12px;font-variant-numeric:tabular-nums}
      </style>
      <div class="lab-bar">
        <button class="lab-back" id="lab-close">‹</button>
        <b>实验室 · 自学习引擎</b>
        <span class="lab-tag">测试版</span>
      </div>
      <div class="lab-body" id="lab-body">
        <div class="lab-lead">用你自己的作答记录回测：前 70% 训练能力模型，后 30% 预测对错，看它比「考点历史正确率」准多少（AUC 越接近 1 越好）。</div>
        <div class="lab-actions">
          <button class="lab-btn" id="lab-run">开始回测</button>
        </div>
        <div id="lab-out"></div>
      </div>`;
    document.body.appendChild(host);
    host.querySelector('#lab-close').onclick = () => host.remove();
    host.querySelector('#lab-run').onclick = async () => {
      const out = host.querySelector('#lab-out');
      const btn = host.querySelector('#lab-run');
      btn.disabled = true;
      btn.textContent = '跑数中…';
      out.innerHTML = '<div class="lab-lead">正在读作答记录与考点…</div>';
      try {
        const r = await run();
        if (!r.events) { out.innerHTML = '<div class="lab-lead">还没有作答记录，先去做几道题再看。</div>'; btn.disabled = false; btn.textContent = '开始回测'; return; }
        const fmt = (v) => (v == null ? '—' : v.toFixed(3));
        const gain = r.aucModel != null && r.aucBase != null ? r.aucModel - r.aucBase : null;
        out.innerHTML = `
          <div class="lab-card">
            <div class="lab-num">${r.events}</div>
            <div class="lab-lab">条作答 · ${r.kps} 个考点 · 训练 ${r.trainN} / 测试 ${r.testN}</div>
          </div>
          <div class="lab-card">
            <div class="lab-kv"><span>本模型 AUC</span><b>${fmt(r.aucModel)}</b></div>
            <div class="lab-kv"><span>基线（考点历史正确率）</span><b>${fmt(r.aucBase)}</b></div>
            <div class="lab-kv"><span>差值</span><b class="${gain > 0 ? 'up' : 'down'}">${gain == null ? '—' : (gain > 0 ? '+' : '') + gain.toFixed(3)}</b></div>
          </div>
          <div class="lab-h">最该补的考点（按能力估计升序）</div>
          <div class="lab-list">
            ${r.rows.slice(0, 12).map((x) => `<div class="lab-row"><span class="lab-kp">${x.kp}</span><span class="lab-m">θ ${x.theta.toFixed(2)}</span><span class="lab-m">${Math.round(x.acc * 100)}% · ${x.n} 题</span></div>`).join('')}
          </div>
          <div class="lab-lead">样本还小的时候 AUC 波动大，做题越多越稳定。这份结果只写在本机。</div>`;
        btn.disabled = false;
        btn.textContent = '重新回测';
      } catch (e) {
        out.innerHTML = `<div class="lab-lead">跑失败了：${e && e.message ? e.message : e}</div>`;
        btn.disabled = false;
        btn.textContent = '重试';
      }
    };
    return host;
  }

  window.__LAB_OPEN__ = () => {
    const old = document.getElementById('lab-panel');
    if (old) { old.remove(); return; }
    panel();
  };
})();
