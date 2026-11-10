import fs from 'fs';

/* ---------- 1) Application：把开库提到进程创建时 ---------- */
const APP = 'D:/Projects/上岸APP/app-shangan/android/app/src/main/java/com/kaogong/app/App.java';
fs.writeFileSync(APP, `package com.kaogong.app;

import android.app.Application;

/**
 * 进程级预热。
 *
 * 冷启动慢的主要原因不是 JS（整页 DOMContentLoaded 只要 1 秒），而是原生侧：
 * WebView 创建、Capacitor 插件注入，以及打开 348 MB 的题库。
 * 这三件事原本全串在 MainActivity.onCreate 里，一件等一件。
 *
 * 放在 Application 里先起一条后台线程把库打开，让「开库」和「WebView 初始化」并行。
 * 拿不到也不影响启动：MainActivity 会退回到自己 new 一个。
 */
public class App extends Application {

    /** 预热好的桥，MainActivity 直接复用，避免第二次打开同一个库。 */
    public static volatile NativeDbBridge warm;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            final NativeDbBridge db = new NativeDbBridge(this);
            warm = db;
            Thread t = new Thread(() -> {
                long s = System.currentTimeMillis();
                try {
                    db.open();
                    android.util.Log.i("NativeDB", "warm open in " + (System.currentTimeMillis() - s) + "ms");
                } catch (Throwable e) {
                    android.util.Log.w("NativeDB", "warm open failed: " + e.getMessage());
                }
            }, "db-warm");
            t.setDaemon(true);
            t.start();
        } catch (Throwable e) {
            android.util.Log.w("NativeDB", "warm 线程没起来：" + e.getMessage());
        }
    }
}
`, 'utf8');
console.log('App.java 写入');

/* ---------- 2) MainActivity 复用预热桥 ---------- */
const MA = 'D:/Projects/上岸APP/app-shangan/android/app/src/main/java/com/kaogong/app/MainActivity.java';
let ma = fs.readFileSync(MA, 'utf8');
const before = `            NativeDbBridge nativeDb = new NativeDbBridge(this);`;
const after = `            // 优先用 Application 里已经预热好的那一个，省掉一次开库（348 MB）
            NativeDbBridge nativeDb = App.warm != null ? App.warm : new NativeDbBridge(this);`;
if (!ma.includes(after)) {
  if (!ma.includes(before)) throw new Error('MainActivity 锚点没找到');
  ma = ma.replace(before, after);
  fs.writeFileSync(MA, ma, 'utf8');
  console.log('MainActivity 改为复用预热桥');
} else console.log('MainActivity 已是复用版');

/* ---------- 3) NativeDbBridge：跨线程安全 ---------- */
const NB = 'D:/Projects/上岸APP/app-shangan/android/app/src/main/java/com/kaogong/app/NativeDbBridge.java';
let nb = fs.readFileSync(NB, 'utf8');
if (!nb.includes('private volatile SQLiteDatabase tikuDb;')) {
  nb = nb.replace('    private SQLiteDatabase tikuDb;', '    private volatile SQLiteDatabase tikuDb;');
  nb = nb.replace('    private SQLiteDatabase imagesDb;', '    private volatile SQLiteDatabase imagesDb;');
  console.log('字段改为 volatile');
}
if (!nb.includes('private synchronized void openIfNeeded()')) {
  nb = nb.replace('    private void openIfNeeded() throws Exception {',
    `    // 预热线程（Application）和 JS 桥线程可能同时进来，必须串行，
    // 否则两条线程会同时往 files/db/ 里解压同一个 332 MB 文件
    private synchronized void openIfNeeded() throws Exception {`);
  console.log('openIfNeeded 改为 synchronized');
}
fs.writeFileSync(NB, nb, 'utf8');

/* ---------- 4) manifest 指定 Application ---------- */
const MF = 'D:/Projects/上岸APP/app-shangan/android/app/src/main/AndroidManifest.xml';
let mf = fs.readFileSync(MF, 'utf8');
if (!mf.includes('android:name=".App"')) {
  mf = mf.replace('    <application\n', '    <application\n        android:name=".App"\n');
  fs.writeFileSync(MF, mf, 'utf8');
  console.log('manifest 已挂 .App');
} else console.log('manifest 已挂过 .App');

/* ---------- 5) 前端：上次的首屏数字先直出 ---------- */
const F = 'D:/Projects/上岸APP/kaogong-shuati/public/next/app.js';
let s = fs.readFileSync(F, 'utf8');
const a1 = `  mark('bridge-ready');
`;
const b1 = `  mark('bridge-ready');

  // 上一次的首屏数字先直出。
  // 本地查询其实很快（subjects 71ms / stats 16ms），冷启动真正贵的是 WebView 首帧；
  // 先把上回的数字画上去，用户看到的是自己的数据，而不是四五个格的骨架屏，
  // 等 loadHome 回来再换成最新值——中间不会有跳变，因为数字本来就一样。
  let painted = false;
  try {
    const snap = JSON.parse(localStorage.getItem('sg_home_snap') || 'null');
    if (snap && snap.stats && localStorage.getItem('sg_profile')) {
      S.stats = snap.stats;
      if (Array.isArray(snap.subjects) && snap.subjects.length) S.subjects = snap.subjects;
      go('home');
      painted = true;
      mark('snap-paint');
      // 首屏一出来就撤启动图，不让用户对着图标等
      try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
`;
if (!s.includes(b1)) {
  if (!s.includes(a1)) throw new Error('boot 锚点没找到');
  s = s.replace(a1, b1);
  console.log('boot 加缓存直出');
}

const a2 = `  try { await loadHome(); go('home'); } catch (e) { toast(e.message); }
  mark('home-rendered');`;
const b2 = `  try { await loadHome(); go('home'); painted = true; } catch (e) { if (!painted) toast(e.message); }
  mark('home-rendered');
  // 存一份首屏快照，下次冷启先拿它画第一帧
  try { localStorage.setItem('sg_home_snap', JSON.stringify({ stats: S.stats, subjects: S.subjects, t: Date.now() })); } catch { /* ignore */ }`;
if (!s.includes(b2)) {
  if (!s.includes(a2)) throw new Error('loadHome 锚点没找到');
  s = s.replace(a2, b2);
  console.log('boot 存快照');
}

if (s.includes(`setTimeout(() => { try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ } }, 2500);`)) {
  s = s.replace(`setTimeout(() => { try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ } }, 2500);`,
    `setTimeout(() => { try { if (window.AndroidSplash) window.AndroidSplash.hide(); } catch { /* ignore */ } }, 1500);`);
  console.log('兜底撤图 2500 → 1500');
}
fs.writeFileSync(F, s, 'utf8');

/* ---------- 6) index.html：脚本加 defer ---------- */
const IH = 'D:/Projects/上岸APP/kaogong-shuati/public/next/index.html';
let ih = fs.readFileSync(IH, 'utf8');
if (ih.includes('<script src="../local-bootstrap.js"></script>')) {
  ih = ih.replace('<script src="../local-bootstrap.js"></script>', '<script src="../local-bootstrap.js" defer></script>');
  ih = ih.replace('<script src="app.js"></script>', '<script src="app.js" defer></script>');
  fs.writeFileSync(IH, ih, 'utf8');
  console.log('index.html 脚本加 defer');
} else console.log('index.html 已加过 defer');
