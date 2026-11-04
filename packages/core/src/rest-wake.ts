/**
 * rest 的条件命中判定 —— 纯函数，无副作用。
 *
 * 为什么单独存在：rest 注册了 `trigger / stage / dependency` 三类条件，但如果没有
 * 任何代码在事件发生时去比对它们，这三类就是**死字段**——工具接受参数、库里存着、
 * 永远不会有任何东西命中它。这是最坏的失败形态：不报错、不告警，只是永远不醒。
 *
 * 所以匹配逻辑必须存在，而且必须可测：它的每一条分支都决定「叫醒谁」。
 */

/** 一次可能唤醒等待者的事件。 */
export interface WakeEvent {
  kind: 'trigger' | 'stage' | 'dependency';
  /** trigger / stage：发生在哪条流上。 */
  threadRef?: string;
  /** stage：到达了哪个阶段。 */
  stage?: string;
  /** dependency：哪个任务变了。 */
  taskId?: string;
  /**
   * 事件的动作人（谁写的这条消息 / 谁改的状态）。
   *
   * 用于**排除自激**：agent 自己在某条流里说话，不应该把自己叫醒——
   * 否则「发一条 → 被自己唤醒 → 再发一条」就是一个无界循环，
   * 而且它看起来完全正常（每一条都是合法消息），不会报错。
   */
  actorAgentId?: string;
  /**
   * 给「未来的自己」看的摘要 —— 这是 C2.2 的载荷。
   * 唤醒时不重读全部历史，只给这一句 + 结构化字段。
   */
  summary: string;
}

/** 可被匹配的最小子集（不依赖 PendingCallback 的全部字段）。 */
export interface MatchableRest {
  id: string;
  agentId: string;
  restWakeOn?: Array<
    | { kind: 'trigger'; threadRef?: string }
    | { kind: 'stage'; threadRef: string; stage: string }
    | { kind: 'timeout'; ms: number }
    | { kind: 'dependency'; taskId: string }
  >;
}

/**
 * 单条条件是否被该事件满足。
 *
 * 注意：这里只管「条件对不对得上」，不管「该不该叫醒这个人」。
 * 自激排除在 `matchRestConditions` 里做——因为那需要同时看到等待者的 agentId
 * 和事件的动作人，而单条条件里没有 agentId 这个信息。
 */
export function restConditionMatches(cond: NonNullable<MatchableRest['restWakeOn']>[number], event: WakeEvent): boolean {
  switch (cond.kind) {
    case 'trigger':
      if (event.kind !== 'trigger') return false;
      // 未指定 threadRef = 「任何一条流的新 trigger 都叫我」
      return cond.threadRef === undefined || cond.threadRef === event.threadRef;
    case 'stage':
      return event.kind === 'stage' && cond.threadRef === event.threadRef && cond.stage === event.stage;
    case 'dependency':
      return event.kind === 'dependency' && cond.taskId === event.taskId;
    case 'timeout':
      // 时间到期由 wakeAt/sweep 负责，不走事件匹配。
      // 放在这里是显式说明「它不参与」，而不是靠 default 分支悄悄吞掉。
      return false;
  }
}

/**
 * 从一批 rest 等待者里挑出被该事件唤醒的那些。
 *
 * **OR 语义**：任一条件命中即唤醒（与 rest 注册时的语义一致）。
 * 一个 agent 可能同时用多条 rest 等同一件事 —— 只返回一次，避免重复唤醒。
 */
export function matchRestConditions<T extends MatchableRest>(rests: T[], event: WakeEvent): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rests) {
    if (seen.has(r.id)) continue;
    if (!r.restWakeOn || r.restWakeOn.length === 0) continue;
    // 自激排除：自己做的事不叫醒自己。不是优化，是防无界循环——
    // 「发一条 → 被自己叫醒 → 再发一条」每一步看起来都是正常消息，不会报错。
    if (event.actorAgentId && event.actorAgentId === r.agentId) continue;
    if (r.restWakeOn.some(c => restConditionMatches(c, event))) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * 构造唤醒载荷。
 *
 * 刻意**不带**历史正文：C2.2 要求「拿到新事件摘要而非重读全部历史」。
 * 一旦这里塞进整段对话，rest 就退化成「醒了再读一遍全部历史」——
 * 那和心跳的区别只剩触发方式，省下的 token 又还回去了。
 */
export function buildWakePayload(event: WakeEvent, restNote?: string): string {
  const lines = [
    `[REST WOKEN] ${event.summary}`,
    `Event: kind=${event.kind}${event.threadRef ? ` thread=${event.threadRef}` : ''}${event.stage ? ` stage=${event.stage}` : ''}${event.taskId ? ` task=${event.taskId}` : ''}`,
  ];
  if (restNote) lines.push(`你注册这次等待时写的备注：${restNote}`);
  lines.push('以上是本次事件的摘要；不需要重读全部历史，先判断这件事是否真的需要你动手。');
  return lines.join('\n');
}
