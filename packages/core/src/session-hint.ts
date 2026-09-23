/**
 * 会话身份契约（TurnSessionHint）
 * ---------------------------------------------------------------------------
 * 为什么需要它：全仓有 20+ 个入口能让 agent 处理一条消息，而「这一轮属于哪个会话」
 * 此前是由每个入口**各自拼接零散字段**（sessionId / dbSessionId / sessionRestore /
 * channelKey / 什么都不传）决定的；一旦某个入口漏传，agent 就会静默开一个新会话
 * ——「同一会话后续请求看不到历史」反复出现，根因就在这里。
 *
 * 契约：**每个入口都必须显式表态这一轮是什么会话**，五种可能：
 *   - new      显式新对话（用户点了「新对话」）
 *   - existing 继续一个已存在的 DB 会话（带 DB 身份，可带绑定内存会话与历史）
 *   - memory   继续一个**内存会话**（`sess_*`）——异步回调回到发起它的那一轮
 *   - system   系统/内部会话（heartbeat / task / report / announce / a2a / channel）
 *   - unknown  入口没表态 → **必须告警**，并按「不改变当前会话」处理，绝不静默新建
 *
 * 设计原则：这里是**纯函数 + 纯类型**，不依赖 agent 状态，便于测试与静态检查。
 */

export interface TurnSessionRestorePayload {
  dbSessionId: string;
  messages: Array<{ role: string; content: string }>;
  isRetry?: boolean;
  preferredMemorySessionId?: string | null;
}

export type TurnSessionHint =
  | { kind: 'new'; dbSessionId?: string }
  | {
      kind: 'existing';
      dbSessionId: string;
      preferredMemorySessionId?: string | null;
      messages?: Array<{ role: string; content: string }>;
      isRetry?: boolean;
    }
  /**
   * 继续一个**内存会话**（`sess_*`）。用于「本会话里发出的东西必须由本会话处理」
   * 的异步场景：`background_exec` / `a2a_reply` 等回调携带发起轮的 `originSessionId`，
   * 就是这一种。没有它，回调会落到 `unknown`（告警且不写 DB→内存绑定），消费端
   * 只能自己拼一个兜底会话 id —— 那正是「后台结果被孤立到独立会话」的根因。
   */
  | { kind: 'memory'; memorySessionId: string }
  | {
      kind: 'system';
      role: 'heartbeat' | 'task' | 'report' | 'announce' | 'a2a' | 'channel' | 'workflow' | 'federation';
      key?: string;
    }
  | { kind: 'unknown'; reason: string };

/** 归一化输入：可能是新式的显式 hint，也可能是零散的旧字段。 */
export interface TurnSessionHintInput {
  /** 新式：入口直接给出契约。优先级最高。 */
  sessionHint?: TurnSessionHint;
  /** 旧式：`null` = 显式新对话；对象 = 恢复既有会话。 */
  sessionRestore?: TurnSessionRestorePayload | null;
  /** 旧式：仅用于「写 DB→内存绑定」的 DB 身份。 */
  dbSessionId?: string;
  /** 旧式：流式路径把它当 DB 提示；非流式路径把它当内存 key（历史遗留，见 STATE-OWNERSHIP）。 */
  sessionId?: string;
  /** 旧式：频道/群聊作用域。 */
  channelKey?: string;
  /** 旧式：由 sourceType 推断系统会话角色。 */
  sourceType?: string;
}

const SYSTEM_SOURCE_ROLES: Record<string, Extract<TurnSessionHint, { kind: 'system' }>['role']> = {
  heartbeat: 'heartbeat',
  task_status_update: 'task',
  task_comment: 'task',
  review_request: 'task',
  requirement_update: 'task',
  requirement_comment: 'task',
  system_event: 'announce',
  workflow_update: 'workflow',
};

/** 看起来像 DB 会话 id（`cs_*`）。用于识别「把 DB id 当内存 key」这类误用。 */
export function looksLikeDbSessionId(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('cs_');
}

/**
 * 把「显式 hint」或「零散旧字段」归一成契约。
 *
 * 优先级：显式 hint > sessionRestore > channelKey > dbSessionId > sessionId > sourceType
 * 都没有 → `unknown`（调用方必须告警）。
 */
export function normalizeTurnSessionHint(input: TurnSessionHintInput): TurnSessionHint {
  if (input.sessionHint) return input.sessionHint;

  if (input.sessionRestore === null) {
    // 显式新对话。注意：**新对话的 DB 身份常常只出现在 `sessionId` 里**
    // （api-server 是先 persist 拿到 cs_* 再发消息），所以这里必须兼容这种形态，
    // 否则「首轮新对话」就落不下 DB→内存绑定（第二轮只能从瘦 DB 重建）。
    const dbId = input.dbSessionId
      ?? (looksLikeDbSessionId(input.sessionId) ? input.sessionId : undefined);
    return { kind: 'new', dbSessionId: dbId };
  }
  if (input.sessionRestore) {
    return {
      kind: 'existing',
      dbSessionId: input.sessionRestore.dbSessionId,
      preferredMemorySessionId: input.sessionRestore.preferredMemorySessionId ?? null,
      messages: input.sessionRestore.messages,
      isRetry: input.sessionRestore.isRetry,
    };
  }

  if (input.channelKey) {
    return { kind: 'system', role: 'channel', key: input.channelKey };
  }
  if (input.sourceType) {
    const role = SYSTEM_SOURCE_ROLES[input.sourceType]
      ?? (input.sourceType === 'a2a_message' ? 'a2a' : undefined);
    if (role) return { kind: 'system', role };
  }

  if (input.dbSessionId) {
    return { kind: 'existing', dbSessionId: input.dbSessionId };
  }
  if (looksLikeDbSessionId(input.sessionId)) {
    return { kind: 'existing', dbSessionId: input.sessionId as string };
  }

  return {
    kind: 'unknown',
    reason: input.sourceType ? `sourceType=${input.sourceType} 未提供任何会话身份` : '未提供任何会话身份',
  };
}

/** 人类可读的一句话描述（用于日志/告警，便于定位是哪个入口漏表态）。 */
export function describeTurnSessionHint(hint: TurnSessionHint): string {
  switch (hint.kind) {
    case 'new': return `new(db=${hint.dbSessionId ?? '-'})`;
    case 'existing': return `existing(db=${hint.dbSessionId}, preferred=${hint.preferredMemorySessionId ?? '-'})`;
    case 'memory': return `memory(${hint.memorySessionId})`;
    case 'system': return `system(${hint.role}${hint.key ? `,key=${hint.key}` : ''})`;
    case 'unknown': return `unknown(${hint.reason})`;
  }
}

/**
 * 只有这两种身份才需要写 DB→内存绑定；且断言收窄为「dbSessionId 必为 string」，
 * 以免调用方拿到 `string | undefined` 还得自己再判一次。
 */
export function hintCarriesDbIdentity(
  hint: TurnSessionHint,
): hint is (Extract<TurnSessionHint, { kind: 'new' }> | Extract<TurnSessionHint, { kind: 'existing' }>) & { dbSessionId: string } {
  return (
    (hint.kind === 'new' || hint.kind === 'existing')
    && typeof hint.dbSessionId === 'string'
    && hint.dbSessionId.length > 0
  );
}
