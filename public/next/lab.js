/* 实验室（测试版专用）：自学习引擎原型 v2
 *
 * 这个文件只做一件事：拿你本机的作答记录，让几种「预测你会不会答对」的算法
 * 同台比一次，看谁更准。准不准用 AUC 衡量（0.5 = 跟抛硬币一样，1 = 全对）。
 *
 * 四条模型（从简单到复杂，一层层加东西）：
 *   A 只看强弱      p = sigmoid(θ_kp)                  —— 「这个考点你做得好不好」
 *   B 加题型难度    p = sigmoid(θ_kp − b_题型)          —— 多选难一点、判断简单一点
 *   C 加蒙对概率    p = c + (1−c)·sigmoid(θ_kp − b)     —— 四选一瞎蒙也有 25%
 *   D 加遗忘        C 的基础上，按「多久没碰这个考点」给能力加不确定度
 *   基线            p = 该考点截至当时的历史正确率（现在 App 用的就是这种朴素判断）
 *
 * 刻意不用的东西：题库里那个 difficulty 字段。查过了，粉笔接口根本不下发每题难度，
 * 我们库里那些 5 是整卷数据集的默认值（单选 53%、判断 86% 都是 5），没有信息量。
 * 所以难度只能靠「题型 + 模块」的先验，加上你自己的作答结果来学。
 */
(function () {
  'use strict';
  window.__LAB__ = true;

  // __LOCAL_API_PROMISE__ 是个 Promise（resolve 出 (path, opts) => Promise 的函数），不是函数本身
  const getApi = async () => {
    const p = window.__LOCAL_API_PROMISE__;
    if (!p) return (path, opts) => fetch(path, opts).then((r) => r.json());
    return typeof p === 'function' ? p : await p;
  };
  const api = async (path, opts) => (await getApi())(path, opts);

  const sig = (x) => 1 / (1 + Math.exp(-x));

  /* 题型先验：不是数据标出来的，是常识 + 题库结构定的
     判断只有对错两档、不用算，最简单；多选要凑齐，最难 */
  function typePrior(type) {
    const t = String(type);
    if (t === '5') return -0.5;   // 判断题
    if (t === '2') return 0.7;    // 多选题
    if (t === '3') return 0.9;    // 不定项
    return 0;                     // 单选
  }
  /* 模块先验：数量关系/资料分析对多数人更难，政治理论更熟 */
  function chapterPrior(chapter) {
    const c = String(chapter || '');
    if (/数量关系/.test(c)) return 0.6;
    if (/资料分析/.test(c)) return 0.4;
    if (/判断推理/.test(c)) return 0.2;
    if (/常识判断/.test(c)) return -0.2;
    if (/政治理论|公共基础/.test(c)) return -0.3;
    return 0;
  }
  /* 蒙对概率 c：按选项数算，单选 4 项 → 0.25，判断 → 0.5 */
  function guessOf(type, optionCount) {
    const t = String(type);
    if (t === '5') return 0.5;
    const n = Number(optionCount) || 4;
    if (n < 2) return 0;
    return 1 / n;
  }

  async function loadMeta(ids) {
    const out = new Map();
    const db = window.NativeDB;
    if (db && db.all) {
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const q = chunk.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
        let rows = [];
        try {
          rows = await db.all(`SELECT questionId, chapter, type, options FROM questions WHERE questionId IN (${q})`, '[]');
          if (typeof rows === 'string') rows = JSON.parse(rows);
          if (rows && rows.rows) rows = rows.rows;
        } catch { rows = []; }
        for (const r of rows || []) {
          let oc = 0;
          try { oc = JSON.parse(r.options || '[]').length; } catch { oc = 0; }
          out.set(String(r.questionId), { chapter: r.chapter, type: r.type, optionCount: oc });
        }
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
      } catch { /* 没有考点就用模块兜底 */ }
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

  const parseTime = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0;
  };

  /* 跑一次四模型对比：按时间正序，前 70% 训练、后 30% 在线评估 */
  async function run() {
    const recs = await api('/api/records/recent?limit=4000');
    const list = (Array.isArray(recs) ? recs : recs.list || []).slice().reverse();
    if (!list.length) return { events: 0 };

    const ids = [...new Set(list.map((r) => String(r.questionId)))];
    const [meta, kpMap] = await Promise.all([loadMeta(ids), loadKp(ids)]);

    const events = list.map((r) => {
      const m = meta.get(String(r.questionId)) || {};
      const kp = kpMap.get(String(r.questionId)) || m.chapter || r.chapter || '未分类';
      const type = m.type ?? r.type;
      return {
        kp,
        b: typePrior(type) + chapterPrior(m.chapter || r.chapter),
        c: guessOf(type, m.optionCount),
        y: r.correct ? 1 : 0,
        ts: parseTime(r.time),
      };
    });

    const cut = Math.floor(events.length * 0.7);
    // 每个考点一份状态：能力 θ、不确定度 rd、作答数 n、答对数 ok、最近一次时间
    const S = new Map();
    const st = (kp) => {
      let s = S.get(kp);
      if (!s) { s = { t: 0, rd: 1.2, n: 0, ok: 0, last: 0 }; S.set(kp, s); }
      return s;
    };
    const out = { A: [], B: [], C: [], D: [], base: [] };

    events.forEach((e, i) => {
      const s = st(e.kp);
      const ageing = e.ts && s.last ? Math.min(2.5, 0.05 * Math.sqrt(Math.max(0, (e.ts - s.last) / 86400000)) * 3) : 0;
      const pA = sig(s.t);
      const pB = sig(s.t - e.b);
      const pC = e.c + (1 - e.c) * sig(s.t - e.b);
      const pD = e.c + (1 - e.c) * sig(s.t - e.b + ageing);
      if (i >= cut) {
        out.A.push({ p: pA, y: e.y });
        out.B.push({ p: pB, y: e.y });
        out.C.push({ p: pC, y: e.y });
        out.D.push({ p: pD, y: e.y });
        out.base.push({ p: (s.ok + 0.5) / (s.n + 1), y: e.y });
      }
      // 训练：答完这道题就更新（部署时也是这个顺序）
      const K = 0.35 * (s.rd / (s.rd + 0.5));
      s.t += K * (e.y - sig(s.t - e.b));   // 用带难度的残差更新，θ 才是「能力」而不是「正确率」
      s.rd = Math.max(0.18, s.rd * 0.985);
      s.n += 1;
      if (e.y) s.ok += 1;
      s.last = e.ts || s.last;
    });

    const rows = [...S.entries()]
      .map(([kp, s]) => ({ kp, theta: s.t, n: s.n, acc: s.n ? s.ok / s.n : 0 }))
      .sort((a, b) => a.theta - b.theta);

    return {
      events: events.length,
      trainN: cut,
      testN: events.length - cut,
      kps: rows.length,
      auc: { A: auc(out.A), B: auc(out.B), C: auc(out.C), D: auc(out.D), base: auc(out.base) },
      rows,
    };
  }

  const fmt = (v) => (v == null ? '—' : v.toFixed(3));
  const pct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + 'pt');

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
        .lab-lead{font-size:12.5px;line-height:1.65;color:var(--muted,#8A90A0);margin:0 0 14px}
        .lab-actions{display:flex;gap:10px;margin-bottom:16px}
        .lab-btn{flex:1;border:0;border-radius:12px;padding:12px;font-size:14.5px;font-weight:600;color:#fff;background:var(--brand,#2F5BEA)}
        .lab-btn[disabled]{opacity:.6}
        .lab-card{background:var(--card,#fff);border:1px solid var(--line,#E8EBF0);border-radius:14px;padding:14px;margin-bottom:12px}
        .lab-num{font-size:30px;font-weight:750;letter-spacing:-.5px;color:var(--text,#1B1F27)}
        .lab-lab{font-size:12px;color:var(--muted,#8A90A0);margin-top:2px}
        .lab-h{font-size:13px;font-weight:700;margin:16px 0 8px;color:var(--text,#1B1F27)}
        .lab-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
        .lab-tbl th,.lab-tbl td{padding:8px 6px;text-align:left;border-bottom:1px solid var(--line,#EDEFF3)}
        .lab-tbl th{font-weight:600;color:var(--muted,#8A90A0);font-size:11.5px}
        .lab-tbl td b{font-variant-numeric:tabular-nums;font-size:14px}
        .lab-tbl tr.win td{background:rgba(27,138,75,.07)}
        .up{color:#1B8A4B}.down{color:#C0392B}
        .lab-row{display:flex;align-items:center;gap:8px;background:var(--card,#fff);padding:10px 12px;font-size:13px}
        .lab-list{display:flex;flex-direction:column;gap:1px;background:var(--line,#E8EBF0);border-radius:12px;overflow:hidden;margin-bottom:14px}
        .lab-kp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1B1F27)}
        .lab-m{color:var(--muted,#8A90A0);font-size:12px;font-variant-numeric:tabular-nums}
      </style>
      <div class="lab-bar">
        <button class="lab-back" id="lab-close">‹</button>
        <b>实验室 · 自学习引擎</b>
        <span class="lab-tag">测试版</span>
      </div>
      <div class="lab-body" id="lab-body">
        <div class="lab-lead">拿你自己的作答记录做考试：前 70% 当「已学过的历史」，后 30% 让每个模型去猜「你会不会答对」，猜得准不准用 AUC 打分（0.5 = 抛硬币，1 = 全对）。</div>
        <div class="lab-actions">
          <button class="lab-btn" id="lab-run">开始对比</button>
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
        if (!r.events) {
          out.innerHTML = '<div class="lab-lead">还没有作答记录，先去做几道题再看。</div>';
          btn.disabled = false;
          btn.textContent = '开始对比';
          return;
        }
        const a = r.auc;
        const best = Math.max(...['A', 'B', 'C', 'D'].map((k) => a[k] ?? -1));
        const line = (key, name, note) => `
          <tr class="${a[key] === best ? 'win' : ''}">
            <td>${name}<div class="lab-lab">${note}</div></td>
            <td><b>${fmt(a[key])}</b></td>
            <td class="${(a[key] ?? 0) - (a.base ?? 0) > 0 ? 'up' : (a[key] == null ? '' : 'down')}">${pct(a[key] == null || a.base == null ? null : a[key] - a.base)}</td>
          </tr>`;
        out.innerHTML = `
          <div class="lab-card">
            <div class="lab-num">${r.events}</div>
            <div class="lab-lab">条作答 · ${r.kps} 个考点 · 训练 ${r.trainN} / 测试 ${r.testN}</div>
          </div>
          <div class="lab-h">谁猜得更准</div>
          <table class="lab-tbl">
            <tr><th>模型</th><th>AUC</th><th>比基线</th></tr>
            ${line('base', '基线（考点历史正确率）', '现在 App 用的朴素办法')}
            ${line('A', 'A · 只看强弱', '只按考点估你的水平')}
            ${line('B', 'B · 加题型难度', '多选难、判断易')}
            ${line('C', 'C · 加蒙对概率', '四选一有 25% 靠蒙')}
            ${line('D', 'D · 加遗忘', '久没练的考点算更不确定')}
          </table>
          <div class="lab-h">最该补的考点（按能力估计升序）</div>
          <div class="lab-list">
            ${r.rows.slice(0, 12).map((x) => `<div class="lab-row"><span class="lab-kp">${x.kp}</span><span class="lab-m">θ ${x.theta.toFixed(2)}</span><span class="lab-m">${Math.round(x.acc * 100)}% · ${x.n} 题</span></div>`).join('')}
          </div>
          <div class="lab-lead">绿底那行是这批数据里最准的。样本小的时候 AUC 会抖，测试集里正例少于 5 个就不太可信；这份结果只写在本机。</div>`;
        btn.disabled = false;
        btn.textContent = '再跑一次';
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
