/**
 * 复现台脚本：**不实现任何词表**，只把生产函数渲染出来。
 *
 * 一旦这里自己写死一个「待命」/「评审中」，这个复现台就失去意义——
 * 它会证明「我写的两个字符串不一样」，而不是「生产代码输出的两个词不一样」。
 * 所以 t 也直接用真实 locale JSON 做替身，与 stateVocabulary.test.ts 同一口径。
 */
import {
  attentionStateLabel,
  processStatusLabel,
  taskStatusLabel,
} from '../src/lib/stateVocabulary.ts';
import { STAGE_LABEL, stageLabel } from '../src/lib/threadPresentation.ts';
import zhAgent from '../src/locales/zh-CN/agent.json';
import zhCommon from '../src/locales/zh-CN/common.json';

type Json = Record<string, any>;
const dig = (obj: Json, path: string): any =>
  path.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), obj);

const t = ((key: string) => {
  const [ns, ...rest] = key.split(':');
  const path = rest.join(':');
  const bucket = ns === 'agent' ? dig(zhAgent as Json, path) : dig(zhCommon as Json, path);
  if (typeof bucket !== 'string') throw new Error(`词表缺键：${key}`);
  return bucket;
}) as any;

const set = (id: string, text: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺节点 ${id}`);
  el.textContent = text;
};

set('attention-state', attentionStateLabel('idle', t));
set('task-status', taskStatusLabel('review', t));
set('thread-stage', stageLabel('none:idle').label);

const vocab = document.getElementById('vocab')!;
const rows: Array<[string, string, string]> = [
  ['注意力', 'idle', attentionStateLabel('idle', t)],
  ['注意力', 'focused', attentionStateLabel('focused', t)],
  ['注意力', 'deciding', attentionStateLabel('deciding', t)],
  ['治理态', 'review', taskStatusLabel('review', t)],
  ['治理态', 'in_progress', taskStatusLabel('in_progress', t)],
  ['在等谁', 'none:idle', STAGE_LABEL['none:idle']!.label],
  ['在等谁', 'agent:working', STAGE_LABEL['agent:working']!.label],
  ['进程态', 'idle', processStatusLabel('idle', t)],
];
for (const [concept, value, label] of rows) {
  const tr = document.createElement('tr');
  for (const cell of [concept, value, label]) {
    const td = document.createElement('td');
    td.textContent = cell;
    tr.appendChild(td);
  }
  vocab.appendChild(tr);
}

// 给断言用的「证明块」：把两处文案与它们是否相同直接写进 DOM，截图即证据。
const proof = document.createElement('pre');
proof.id = 'proof';
const attentionWord = attentionStateLabel('idle', t);
const taskWord = taskStatusLabel('review', t);
proof.textContent = JSON.stringify(
  { attentionWord, taskWord, distinct: attentionWord !== taskWord },
  null,
  2,
);
document.body.appendChild(proof);
