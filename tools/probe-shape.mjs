import fs from 'fs';
import path from 'path';
const base = 'D:/Projects/上岸APP/research/fenbi-raw';
for (const c of ['syzc','sydw','zhyynl']) {
  const dir = path.join(base, c, 'papers');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const one = files[0] ? JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) : null;
  console.log(c, 'files=' + files.length, one ? JSON.stringify({ paperId: one.paperId, name: one.name, cat: one.cat, keys: Object.keys(one).slice(0,12), q: (one.questions||[]).length, firstQ: Object.keys((one.questions||[{}])[0]||{}) }) : 'none');
}
