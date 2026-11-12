// 快速探针：两号各试一次「建练习」，看额度是否恢复
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAccounts, Session } from "./lib/fenbi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Q0 = "app=web&kav=131&av=134&hav=128&gav=2&apcid=0&deviceId=";
const accounts = loadAccounts(ROOT);
console.log("账号：", accounts.map((a) => a.uid).join(" · "));
const COURSE = process.argv[2] || "syzc";
// 随便挑一个考点 id
const leaves = JSON.parse(fs.readFileSync(path.join(ROOT, "report/kp-leaves.json"), "utf8")).leaves;
const kp = leaves[Number(process.argv[3] || 0)];
console.log("考点：", kp.name, kp.parent);

for (const acc of accounts) {
  const sess = new Session([acc]);
  const url = `https://tiku.fenbi.com/api/${COURSE}/exercises?${Q0}&userId=${acc.uid}`;
  const body = new URLSearchParams({ type: "2", keypointIds: kp.id, count: "100", exerciseTimeMode: "2" });
  try {
    const r = await sess.fetch(url, { method: "POST", body, spa: true });
    const t = await r.text();
    console.log(`  ${acc.uid} → ${r.status} ${t.slice(0, 120)}`);
  } catch (e) {
    console.log(`  ${acc.uid} → ERR ${e.message}`);
  }
}
