import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const body = fs.readFileSync('D:/Projects/上岸APP/kaogong-shuati/RELEASE_NOTES.md', 'utf8');
const payload = JSON.stringify({ body });
fs.writeFileSync('D:/rel3/body.json', payload, 'utf8');

const id = '438752198';
const token = process.env.GH_TOKEN;
const out = execFileSync('curl.exe', [
  '-sS', '--ssl-no-revoke', '-x', 'http://127.0.0.1:18926',
  '-X', 'PATCH',
  '-H', `Authorization: Bearer ${token}`,
  '-H', 'Accept: application/vnd.github+json',
  '-H', 'Content-Type: application/json',
  '--data-binary', '@D:/rel3/body.json',
  `https://api.github.com/repos/CHAOYUE116/shangan/releases/${id}`,
], { encoding: 'utf8' });
const r = JSON.parse(out);
console.log('tag   :', r.tag_name);
console.log('name  :', r.name);
console.log('body长度:', (r.body || '').length);
console.log('前 80 字:', (r.body || '').slice(0, 80).replace(/\n/g, ' '));
