// 粉笔多账号会话：cookie.txt / cookie.txt.bak-* 自动加载，403 限流时轮换账号
import fs from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadAccounts(root) {
  const files = fs.readdirSync(root).filter((f) => /^cookie.*\.txt(\.bak-\d+)?$/.test(f));
  const out = [];
  for (const f of files) {
    const cookie = fs.readFileSync(path.join(root, f), "utf8").trim();
    if (!cookie) continue;
    const uid = (cookie.match(/userid=(\d+)/) || [])[1] || "";
    if (!uid) continue;
    out.push({ file: f, cookie, uid });
  }
  // 去重（同一 uid 只留第一个）
  const seen = new Set();
  return out.filter((a) => (seen.has(a.uid) ? false : (seen.add(a.uid), true)));
}

export class Session {
  constructor(accounts, opts = {}) {
    if (!accounts.length) throw new Error("没有可用 cookie");
    this.accounts = accounts;
    this.i = 0;
    this.log = opts.log || ((m) => console.log(m));
    this.spins = 0;
  }
  get acc() { return this.accounts[this.i]; }
  uid() { return this.acc.uid; }
  headers(extra = {}) {
    return { cookie: this.acc.cookie, "user-agent": UA, referer: "https://www.fenbi.com/", origin: "https://www.fenbi.com", ...extra };
  }
  spaHeaders(extra = {}) {
    return this.headers({ referer: "https://spa.fenbi.com/", origin: "https://spa.fenbi.com", ...extra });
  }
  rotate(reason = "") {
    this.i = (this.i + 1) % this.accounts.length;
    this.spins++;
    this.log(`  ↻ 切账号 → ${this.acc.file} uid=${this.acc.uid}${reason ? "（" + reason.slice(0, 40) + "）" : ""}`);
  }
  // 403 + 频率过高 → 轮换账号重试；其它状态原样返回
  async fetch(url, opts = {}) {
    const { spa, ...rest } = opts;
    let last = null;
    for (let attempt = 0; attempt < this.accounts.length * 3; attempt++) {
      const headers = spa ? this.spaHeaders(rest.headers) : this.headers(rest.headers);
      let r;
      try {
        r = await fetch(url, { ...rest, headers });
      } catch (e) {
        last = { status: 0, __err: e };
        await sleep(1500);
        continue;
      }
      if (r.status !== 403) return r;
      const txt = await r.clone().text().catch(() => "");
      if (!/频率|频繁/.test(txt)) return r; // 无权查看之类的真 403
      last = r;
      this.rotate(txt.slice(0, 80));
      await sleep(2500);
    }
    return last;
  }
}
