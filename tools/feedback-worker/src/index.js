/**
 * 上岸 · 纠错上报中转站（Cloudflare Worker）
 *
 * App 里点「纠错」→ POST 到这里 → 用仓库 token 建一条 GitHub Issue。
 * 好处：App 里不装 token；用户不需要 GitHub 账号；issue 就是你的待办列表。
 *
 * 环境变量（wrangler secret put）：
 *   ISSUE_TOKEN  有 issues:write 权限的 fine-grained token
 *   REPO         比如 chaoyue116/shangan-app
 * 可选：
 *   LABEL        默认 "用户纠错"
 *   ALLOW_ORIGIN 默认 "*"
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS, GET",
    },
  });

const esc = (s) => String(s ?? "").replace(/\r/g, "").slice(0, 20000);

const REASONS = {
  material: "材料缺失",
  image: "图片缺失/打不开",
  option: "选项缺失或错位",
  answer: "答案错误",
  analysis: "解析错误",
  category: "分类/模块不对",
  typo: "题干有错别字",
  dup: "重复题",
  stale: "题目过时",
  other: "其他",
};

function issueBody(p) {
  const rs = (p.reasons || []).map((r) => REASONS[r] || r);
  const q = p.question || {};
  const lines = [
    `**题号**：\`${esc(p.questionId)}\``,
    `**原因**：${rs.length ? rs.join("、") : "（未选）"}`,
    p.note ? `**补充**：${esc(p.note)}` : "",
    p.expect ? `**用户认为的正确答案/分类**：${esc(p.expect)}` : "",
    "",
    "<details><summary>题目快照</summary>",
    "",
    "```json",
    JSON.stringify(q, null, 2).slice(0, 12000),
    "```",
    "",
    "</details>",
    "",
    `> 设备：${esc(p.device || "-")} ｜ 版本：${esc(p.version || "-")} ｜ 库：${esc(p.dbVersion || "-")} ｜ 时间：${esc(p.at || new Date().toISOString())}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({ ok: true });
    if (url.pathname === "/health") return json({ ok: true, repo: env.REPO || null });

    if (url.pathname !== "/report") return json({ ok: false, error: "not_found" }, 404);
    if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
    if (!env.ISSUE_TOKEN || !env.REPO) return json({ ok: false, error: "server_not_configured" }, 500);

    let p;
    try {
      p = await req.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    const qid = String(p.questionId || "").trim();
    if (!qid) return json({ ok: false, error: "no_question_id" }, 400);

    const title = `[纠错] ${qid} · ${(p.reasons || []).map((r) => REASONS[r] || r).join("/") || "未选原因"}`.slice(0, 240);

    const res = await fetch(`https://api.github.com/repos/${env.REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ISSUE_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "shangan-feedback-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title,
        body: issueBody(p),
        labels: [env.LABEL || "用户纠错"],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: "github_failed", status: res.status, detail: data.message || null }, 502);
    return json({ ok: true, issue: data.number, url: data.html_url });
  },
};
