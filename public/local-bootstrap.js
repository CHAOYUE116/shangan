// local-bootstrap.js — App 本地模式（无服务器）启动脚本
// 由 index.html 以普通 <script> 加载并置于 app.js 之前（服务器模式自动 no-op）。
// 用动态 import() 保持同步设置标记：app.js 顶层调用 api() 时 __LOCAL_API_PROMISE__ 已就绪。
// 职责：
//   1. 检测本地模式（window.Capacitor 存在，或 URL 带 ?local=1）
//   2. 加载 sql.js 引擎（tiku_app.db）+ 公式图 images.db 导入 IndexedDB
//   3. 初始化 IndexedDB 记录存储 + 本地 API + AI（直调 OpenAI 兼容接口）
//   4. 注册图片离线 Service Worker（公式图 / 真图形缓存）
//   5. 暴露 window.__LOCAL_API_PROMISE__，app.js 的 api() 检测后自动走本地路由
// 说明：阶段 5 打包 App 时把 sql.js 引擎换成 capacitor-sqlite，接口不变（get/all/run）。

window.__LOCAL_API_PROMISE__ = null;

const isLocalMode = function () {
  return !!window.Capacitor || new URLSearchParams(location.search).has('local');
};

if (isLocalMode()) {
  window.__LOCAL_MODE__ = true;
  // 首启防白屏：显示"正在准备题库"遮罩（题库复制/解压期间 WebView 可能长时间无内容）
  const splash = document.getElementById('boot-splash');
  if (splash) splash.style.display = 'flex';
  const setBootProgress = function (pct) {
    const bar = document.getElementById('boot-splash-bar');
    if (bar) bar.style.width = pct + '%';
  };
  setBootProgress(8);
  window.__LOCAL_API_PROMISE__ = (async function () {
    // ---------- 1. 题库引擎：原生 SQLite 同步桥优先（Capacitor App 主路径，内存友好），sql.js 兜底（浏览器联调） ----------
    const engine = await import('./sqljs-engine.js');
    setBootProgress(20);
    let tiku = null;
    let nativeMode = false;
    if (window.NativeDB) {
      try {
        tiku = engine.loadNativeEngine();
        nativeMode = true;
      } catch (e) {
        console.warn('原生题库加载失败，回退 sql.js：', e.message);
        tiku = null;
      }
    }
    if (!tiku) {
      // 兼容两种部署：浏览器联调（../app-assets/）与 Capacitor 打包（./app-assets/）
      async function firstExisting(candidates) {
        for (const c of candidates) {
          try {
            const r = await fetch(c, { method: 'HEAD' });
            if (r.ok) return c;
          } catch {
            /* 继续尝试 */
          }
        }
        return candidates[0];
      }
      // 注意：Android aapt2 打包 assets 时会自动解压 .gz 文件并去掉扩展名（tiku_app.db.gz → tiku_app.db），
      // 因此 App 内直接请求未压缩的 tiku_app.db；浏览器联调（../app-assets/）同样用未压缩版
      const dbUrl = await firstExisting(['./app-assets/tiku_app.db', '../app-assets/tiku_app.db']);
      const imagesUrl = await firstExisting(['../app-assets/images.db', './app-assets/images.db']);
      tiku = await engine.loadSqljsEngine({ gzUrl: dbUrl, imagesUrl });
    }

    // ---------- 2. 本地 API + 记录存储 ----------
    setBootProgress(60);
    const { initLocalApiBrowser } = await import('./local-api.js');
    // 原生桥按 SQL 内容自动路由 tiku_app.db / images.db，可直接复用为图片引擎（公式图可用）
    const api = await initLocalApiBrowser({ tiku, images: nativeMode ? tiku : null });
    // 公式图交给渲染层直接查 images.db 换 data: URL —— WebView 里 Service Worker
    // 注册必然失败，sw-local.js 那套拦截在 App 内等于没装，所以不再依赖它。
    if (api && api.images) window.__LOCAL_IMAGES__ = api.images;
    // 公式图落 IndexedDB 只对 sql.js 兜底路径有意义（那边没有原生桥，只能从 IDB 取 blob）。
    // 原生模式下 createImagesApi 直接走 images.get() 查 images.db，这条链路纯属白搬
    // 5.2 万行 / 54MB blob（base64 过桥 + 逐行 atob），首启要白等十几秒，所以直接跳过。
    if (!nativeMode) {
      try {
        await engine.importImagesFromNative(tiku);
      } catch (e) {
        console.warn('公式图导入失败（不影响题库使用）：', e.message);
      }
    }

    // ---------- 3. AI（直调 OpenAI 兼容接口） ----------
    setBootProgress(82);
    const { createAiApi } = await import('./ai-local.js');
    // request 注入：浏览器 fetch；Capacitor 里用 CapacitorHttp 规避 CORS
    let request;
    // 超时参数（毫秒）：境外网关在弱网/被墙场景下 TCP 连接可能挂起，必须兜底，
    // 否则 CapacitorHttp/fetch 会无限等待，界面看起来「卡死」。
    const CONNECT_TIMEOUT_MS = 15000; // 连不上（DNS/握手/被墙）快速报错
    const READ_TIMEOUT_MS = 90000;   // 单次读取上限 90s（实测模型约 27s 返回）；总等待另有 3 分钟硬上限
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const CapacitorHttp = window.Capacitor.Plugins.CapacitorHttp;
      request = async function (url, opts) {
        const r = await CapacitorHttp.request({
          url: url,
          method: opts.method,
          headers: opts.headers,
          data: opts.body ? JSON.parse(opts.body) : undefined,
          connectTimeout: CONNECT_TIMEOUT_MS, // Android 原生层：连接阶段超时
          readTimeout: READ_TIMEOUT_MS,       // Android 原生层：读响应阶段超时
        });
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          // CapacitorHttp 有时把 body 原样返回成字符串（尤其网关 Content-Type 不规范时），
          // 这里统一兜一层，否则上层 data.choices 永远取不到，表现为「模型没有返回内容」。
          json: async function () {
            if (typeof r.data !== 'string') return r.data;
            try { return JSON.parse(r.data); } catch { return r.data; }
          },
          text: async function () { return typeof r.data === 'string' ? r.data : JSON.stringify(r.data == null ? '' : r.data); },
        };
      };
    } else {
      request = async function (url, opts) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
        try {
          const r = await fetch(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: ctrl.signal });
          return { ok: r.ok, status: r.status, json: function () { return r.json(); }, text: function () { return r.text(); } };
        } finally {
          clearTimeout(timer);
        }
      };
    }
    const ai = await createAiApi({ request: request, tiku: tiku, query: api.query });

    // ---------- 4. 本地 API 路由 ----------
    const { createLocalHandler } = await import('./local-handler.js');
    const handler = createLocalHandler({ query: api.query, records: api.records, store: api.store, ai: ai });
    // 调试/测试用：暴露记录存储（IndexedDB 适配器）
    window.__LOCAL_STORE__ = api.store;

    // ---------- 5. 图片离线 Service Worker ----------
    // App 里本地资源走自定义 scheme，register 一定失败；公式图已经改成渲染后
    // 用原生桥查 images.db 换成 data: URL（app.js 的 hydrateImages），
    // 所以 Service Worker 只在浏览器调试时注册，App 内干脆不注册，省一条 404。
    setBootProgress(96);
    const inShell = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (!inShell && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw-local.js', { scope: './' }).catch(function (e) {
        console.warn('SW 注册失败（浏览器模式）：', e.message);
      });
    }

    // 就绪后移除启动遮罩
    const splashEl = document.getElementById('boot-splash');
    if (splashEl) splashEl.remove();

    console.log('[local-mode] 离线题库就绪');
    return handler;
  })();
}
