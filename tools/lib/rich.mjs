// 粉笔富文本 → HTML 的小工具（crawl-scatter / import-scatter 共用）
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const TEX_HOST = "https://fb.fenbike.cn/api/planet/accessories/formulas?latex=";
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function texKey(v) {
  return String(v || "").split("?")[0].split("/").pop();
}

export function richToHtml(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return "";
    if (s.startsWith("{") || s.startsWith("[")) { try { return richToHtml(JSON.parse(s)); } catch { /* 纯文本 */ } }
    return s;
  }
  if (Array.isArray(raw)) return raw.map(richToHtml).join("");
  const name = raw.name || "";
  if (name === "txt") return esc(raw.value || "");
  if (name === "tex") return `<img flag="tex" src="${TEX_HOST}${texKey(raw.value)}" />`;
  if (name === "img" || name === "image") {
    const u = raw.value || raw.src || "";
    return u ? `<img src="${u}" />` : "";
  }
  const kids = raw.children ? richToHtml(raw.children) : "";
  if (name === "p" || name === "div") return kids ? `<p>${kids}</p>` : "";
  if (name === "br") return "<br />";
  if (name === "li") return `<li>${kids}</li>`;
  if (name === "ul" || name === "ol") return `<${name}>${kids}</${name}>`;
  if (name === "b" || name === "strong") return `<b>${kids}</b>`;
  if (name === "i" || name === "em") return `<i>${kids}</i>`;
  if (name === "u") return `<u>${kids}</u>`;
  if (["table", "tr", "td", "th", "tbody"].includes(name)) return `<${name}>${kids}</${name}>`;
  return kids || esc(raw.value || "");
}

const TARZAN = /\/api\/tarzan\/images\/[^"'\s)]+/g;

export function normLinks(html) {
  return String(html)
    .replace(/src="\/\/fb\.fbstatic\.cn\/api\/planet\/accessories\/formulas\?latex=/g, `src="${TEX_HOST}`)
    .replace(/src="\/\/fb\.fbstatic\.cn\//g, 'src="https://fb.fbstatic.cn/')
    .replace(/src='([^']+)'/g, 'src="$1"');
}

export const textOf = (h) => String(h || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export const latexKeys = (h) => [...new Set([...String(h || "").matchAll(/formulas\?latex=([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];

export function fingerprint(html) {
  return textOf(html).replace(/[\s\p{P}]/gu, "").slice(0, 120);
}

/** 把 tarzan 真图下载内联成 data URI（离线可看）；并发 8 */
export async function inlineTarzan(html, { timeout = 20000, conc = 8 } = {}) {
  const urls = [...new Set(String(html || "").match(TARZAN) || [])];
  if (!urls.length) return html;
  const map = new Map();
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        const r = await fetch("https://fb.fbstatic.cn" + u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeout) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = (r.headers.get("content-type") || "image/png").split(";")[0];
        map.set(u, `data:${mime};base64,${buf.toString("base64")}`);
      } catch { /* 单张失败忽略 */ }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  let out = html;
  for (const [u, d] of map) out = out.split(u).join(d);
  return out;
}
