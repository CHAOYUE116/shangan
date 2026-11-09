import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/Projects/上岸APP/kaogong-shuati';
const OUT = 'D:/Projects/上岸APP/dist/release';
const NEW = `${ROOT}/tiku.db`;
const NEW_VER = '0.5.6-20261109-1430';

// 设备上整条 questionId 都缺的那 754 道题（0.5.4 增量包加上去后又丢了）
const missIds = fs.readFileSync('C:/Users/admin/Documents/deepseek-harness/default-workspace/miss_ids.txt', 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log('修复题号', missIds.length);

const STARTS = [
  ['0.5.2-20261109-0130', `${ROOT}/tiku.db.bak-harvest-202611082330`],
  ['0.5.3-20261109-1019', `${ROOT}/tiku.db.bak-fenbi-202611090400`],
  ['0.5.4-20261109-1220', NEW],
  ['0.5.5-20261109-1330', NEW],
];

for (const [from, src] of STARTS) {
  const tmp = `${ROOT}/tiku.tmpfrom.db`;
  fs.copyFileSync(src, tmp);
  const d = new DatabaseSync(tmp);
  // 把这批题从「旧库」里摘掉，diff 时它们就会被判成新增，随包下发
  const del = d.prepare('DELETE FROM questions WHERE questionId = ?');
  d.exec('BEGIN');
  for (const id of missIds) {
    try { del.run(Number(id)); } catch { del.run(id); }
  }
  d.exec('COMMIT');
  d.close();

  console.log(`\n=== ${from} → ${NEW_VER} ===`);
  try {
    const out = execFileSync(process.execPath, [
      `${ROOT}/tools/build-tiku-delta.mjs`,
      '--old', tmp, '--new', NEW,
      '--from', from, '--to', NEW_VER,
      '--out', OUT,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      if (/题库增量|papers |questions |question_categories|原始|sha256 |输出/.test(line)) console.log(line.trimEnd());
    }
  } catch (e) {
    console.error('失败:', e.message);
    if (e.stdout) console.error(String(e.stdout).slice(-600));
  }
  fs.unlinkSync(tmp);
}
console.log('\n完成');
