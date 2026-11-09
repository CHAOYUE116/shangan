import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/Projects/上岸APP/kaogong-shuati';
const OUT = 'D:/Projects/上岸APP/dist/release';
const NEW = `${ROOT}/tiku.db`;
const NEW_VER = '0.5.7-20261109-1520';
const WS = 'C:/Users/admin/Documents/deepseek-harness/default-workspace';

const missQids = fs.readFileSync(`${WS}/miss_ids.txt`, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const missPids = fs.readFileSync(`${WS}/miss_pids.txt`, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log('补题号', missQids.length, '补卷', missPids.length);

const STARTS = [
  ['0.5.2-20261109-0130', `${ROOT}/tiku.db.bak-harvest-202611082330`],
  ['0.5.3-20261109-1019', `${ROOT}/tiku.db.bak-fenbi-202611090400`],
  ['0.5.4-20261109-1220', NEW],
  ['0.5.5-20261109-1330', NEW],
  ['0.5.6-20261109-1430', NEW],
];

for (const [from, src] of STARTS) {
  const tmp = `${ROOT}/tiku.tmpfrom.db`;
  fs.copyFileSync(src, tmp);
  const d = new DatabaseSync(tmp);
  d.exec('BEGIN');
  const dq = d.prepare('DELETE FROM questions WHERE questionId = ?');
  for (const id of missQids) { try { dq.run(Number(id)); } catch { dq.run(id); } }
  // 卷也一起摘掉：设备上这 18 卷从来没到过，缺了它们这 754 道题在
  // 「JOIN papers 按年份过滤」的统计里仍然算不进去
  const dp = d.prepare('DELETE FROM papers WHERE id = ?');
  for (const id of missPids) { try { dp.run(Number(id)); } catch { dp.run(id); } }
  d.exec('COMMIT');
  d.close();

  console.log(`\n=== ${from} → ${NEW_VER} ===`);
  try {
    const out = execFileSync(process.execPath, [
      `${ROOT}/tools/build-tiku-delta.mjs`,
      '--old', tmp, '--new', NEW, '--from', from, '--to', NEW_VER, '--out', OUT,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      if (/题库增量|papers |questions |question_categories|原始|sha256 |输出/.test(line)) console.log(line.trimEnd());
    }
  } catch (e) {
    console.error('失败:', e.message);
  }
  fs.unlinkSync(tmp);
}
console.log('\n完成');
