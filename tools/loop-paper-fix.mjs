/**
 * 反复跑 fix-from-paper.mjs，直到没有坏题卷为止。
 * 为什么要外层循环：粉笔「创建练习」是小时级配额，撞上就退出，等 10 分钟再来一轮。
 */
import { spawn } from 'node:child_process';

const WAIT = 10 * 60 * 1000;
const run = (args) => new Promise((res) => {
  const p = spawn(process.execPath, ['tools/fix-from-paper.mjs', ...args], { stdio: 'inherit' });
  p.on('exit', (code) => res(code ?? 0));
});

for (let round = 1; round <= 48; round += 1) {
  console.log(`\n===== 第 ${round} 轮 ${new Date().toLocaleTimeString('zh-CN')} =====`);
  const before = Date.now();
  const code = await run(['--apply', '--augment', '--gap', '6000', '--cooldown', '240']);
  console.log(`本轮结束 code=${code} 用时 ${Math.round((Date.now() - before) / 60000)} 分钟`);
  if (code === 0) {
    console.log('没有待修的卷了，收工');
    break;
  }
  console.log(`等 ${WAIT / 60000} 分钟再试……`);
  await new Promise((r) => setTimeout(r, WAIT));
}
