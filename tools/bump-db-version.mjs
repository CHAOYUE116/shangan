import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const NEW_VER = '0.5.5-20261109-1330';
const OUT = 'D:/Projects/上岸APP/dist/release';
const ASSETS = 'D:/Projects/上岸APP/kaogong-shuati/app-assets/tiku_app.db';

fs.writeFileSync('D:/Projects/上岸APP/kaogong-shuati/app-assets/db-version.txt', NEW_VER);
console.log('db-version.txt →', NEW_VER);

const st = fs.statSync(ASSETS);
console.log('assets db', (st.size / 1048576).toFixed(2), 'MB');
const d = new DatabaseSync(ASSETS, { readOnly: true });
console.log('qc rows', d.prepare('SELECT COUNT(*) n FROM question_categories').get().n);
console.log('questions rows', d.prepare('SELECT COUNT(*) n FROM questions').get().n);
d.close();
