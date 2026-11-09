import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const rows = db.prepare("SELECT content FROM questions WHERE content LIKE '%使用不当的一项是%' LIMIT 3").all();
for (const r of rows) console.log(JSON.stringify(String(r.content).slice(0, 90)));
const g = db.prepare("SELECT COUNT(1) c FROM questions WHERE content LIKE '%（%）' ").get();
const g2 = db.prepare("SELECT COUNT(1) c FROM questions WHERE content LIKE '%（  ）%' ").get();
const sp = db.prepare("SELECT COUNT(1) c FROM questions WHERE content LIKE '%\u3000%'").get();
console.log('含全角括号', g.c, '含空括号', g2.c, '含全角空格', sp.c);
