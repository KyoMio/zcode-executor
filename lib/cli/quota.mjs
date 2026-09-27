// lib/cli/quota.mjs —— quota 子命令（外壳层，SPEC-offpeak G）：今天的闲时取号情况，零额度。
// 取数在 lib/offpeak-send.mjs 的 offPeakQuota，这里只排版一行与定退出码：changed → 1，其余 0
// （这是给派单方看的信息，额度用完不算错）。不起 app-server，不取号。
import { resolveHome } from '../config.mjs';
import { offPeakQuota } from '../offpeak-send.mjs';
import { parseFlags } from './common.mjs';

const STATE_TEXT = { unavailable: '暂时不可用', 'not-applicable': '不适用', changed: '接口变了' };

function serverText(q) {
  if (q.state !== 'ok') return `${STATE_TEXT[q.state]}（${q.reason}）`;
  if (q.canTakeNumber) return '现在可以取号';
  return q.nextTakeAt ? `今天额度已用完，${new Date(q.nextTakeAt).toLocaleString()} 以后可再取` : '现在不能取号';
}

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const q = await offPeakQuota({ home: resolveHome() });
  if (json) console.log(JSON.stringify(q));
  else console.log(`quota: 闲时取号今天本工具已用 ${q.usedToday} 次（每天约 ${q.estimatedDailyLimit} 次，App 里用的不计入）；服务器：${serverText(q)}`);
  if (q.state === 'changed') process.exitCode = 1;
}
