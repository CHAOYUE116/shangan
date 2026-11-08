import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('tiku.db');
const apply = process.argv.includes('--apply');

const ids = db.prepare(`
  SELECT q.id FROM questions q WHERE q.content IS NULL OR TRIM(q.content)=''
`).all().map((r) => r.id);

console.log('待删除空题干题', ids.length, apply ? '（执行）' : '（预演，加 --apply 才写）');
if (!ids.length) { db.close(); process.exit(0); }

const paperIds = db.prepare(`
  SELECT DISTINCT paperId FROM questions WHERE content IS NULL OR TRIM(content)=''
`).all().map((r) => r.paperId);
console.log('涉及试卷', paperIds.length, '份');

if (apply) {
  db.exec('BEGIN');
  try {
    const delQ = db.prepare('DELETE FROM questions WHERE id = ?');
    const delKp = db.prepare('DELETE FROM question_keypoints WHERE questionId = ?');
    const delDeep = db.prepare('DELETE FROM question_deep WHERE questionId = ?');
    let n = 0;
    for (const id of ids) {
      delQ.run(id);
      try { delKp.run(id); } catch {}
      try { delDeep.run(id); } catch {}
      n++;
    }
    // 修正试卷题量
    const fixCount = db.prepare(`
      UPDATE papers SET questionCount = (
        SELECT COUNT(*) FROM questions q WHERE q.paperId = papers.id
      ) WHERE id = ?
    `);
    for (const pid of paperIds) fixCount.run(pid);
    db.exec('COMMIT');
    console.log('✓ 删除', n, '题，修正', paperIds.length, '份试卷题量');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('回滚:', e.message);
    throw e;
  }
}

const left = db.prepare(`SELECT COUNT(*) c FROM questions WHERE content IS NULL OR TRIM(content)=''`).get().c;
console.log('剩余空题干', left);
db.close();
