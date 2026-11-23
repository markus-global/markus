/**
 * 工作记录（概览「运行与注意力」左栏）的**实体解析唯一写者**。
 *
 * 一条 mailbox 记录属于哪件事（task / requirement / channel），名字从实体表取。
 * 之前这是 api-server 路由里的一个内联闭包，测试咬不住它；提成纯函数后，归属
 * 判据可以被行为测试逐条钉死（见 test/worklog-entity.test.ts）。
 *
 * ## 两个身份，别混为一谈（2026-11-23 飞书消息误入「历史记录」根因）
 *
 *  - **执行身份** = `workUnitRef`：一条消息/一个回合一个，是幂等去重键。
 *    IM 入站是 `external:<platform>:<messageId>`（C10-B），**按消息**，里面没有
 *    「按会话」的稳定键可反解。
 *  - **会话实体** = entity：跨消息稳定。Web 聊天是 `cs_*` 会话（嵌在
 *    `session:<sid>:rN` ref 里，能反解）；IM 是入口**声明**的 `channelKey`
 *    （`payload.extra.channelKey` / `sessionHint`），解析器**读声明**，不去猜 ref。
 *
 * 旧实现只从 ref 形状反解实体，IM 的 external ref 解不出 → null → 前端「历史记录」。
 * 修复：结构身份（taskId/requirementId/session/a2a ref）优先；都没命中时，读入口
 * 声明的会话键。声明只有一个写者（入口），本模块是读者 —— 不是第二个写者。
 */
import { taskIdOfWorkUnitRef } from '@markus/shared';

export interface WorklogEntity {
  kind: string;
  id: string;
  name: string;
}

/** 实体名字来自实体表；解析器只通过这几个注入点取，不直接摸 storage。 */
export interface WorklogEntityDeps {
  agentId: string;
  taskTitle: (id: string) => string | undefined;
  requirementTitle: (id: string) => string | undefined;
  chatSessionTitle: (id: string) => string | undefined;
}

const short = (id: string): string => (id.length > 12 ? `${id.slice(0, 10)}…` : id);

/**
 * 入口声明的会话键（IM 入站写在 `payload.extra`）。优先 `channelKey`，退回
 * `sessionHint`（仅当它明确标了 `role:'channel'`）。拿不到返回空串。
 *
 * 这是**读声明**，不是反解 ref：channelKey 由入口写一次（单一事实源），与
 * `payload.taskId` 同性质 —— 结构事实，不是从派生键猜出来的。
 */
export function declaredConversationKey(extra: Record<string, unknown>): string {
  const ck = extra['channelKey'];
  if (typeof ck === 'string' && ck.trim()) return ck;
  const hint = extra['sessionHint'];
  if (hint && typeof hint === 'object') {
    const h = hint as Record<string, unknown>;
    if (h['role'] === 'channel' && typeof h['key'] === 'string' && h['key'].trim()) {
      return h['key'];
    }
  }
  return '';
}

const PLATFORM_NAMES: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
};

/**
 * 把 IM 会话键 `im:<bot>:<scope>:<chat>` 美化成可读名字（**仅显示**）。
 *
 * 这不是身份解析器：实体 id 仍是完整 channelKey，一个字符不改。这里只是给左栏
 * 一个人话标签，形状不认识就返回 undefined（由 put 退回短 id 标签），绝不猜身份。
 */
export function imConversationLabel(channelKey: string): string | undefined {
  const parts = channelKey.split(':');
  if (parts[0] !== 'im' || parts.length < 4) return undefined;
  const bot = parts[1] ?? '';
  const scope = parts[2] ?? '';
  const chat = parts.slice(3).join(':');
  const platformToken = bot.startsWith('bi_') ? (bot.split('_')[1] ?? '') : '';
  const platform = PLATFORM_NAMES[platformToken] ?? 'IM';
  const scopeName = scope === 'group' ? '群聊' : scope === 'dm' ? '私聊' : '会话';
  return `${platform}${scopeName} · ${short(chat)}`;
}

/**
 * 建一个**带 memo** 的实体解析器（一次扫描内同一实体只算一次名字）。
 * 归属判据按顺序、互斥；结构身份优先，IM 会话键兜底，解不出返回 null。
 */
export function createWorklogEntityResolver(
  deps: WorklogEntityDeps,
): (item: Record<string, unknown>) => WorklogEntity | null {
  const memo = new Map<string, WorklogEntity>();
  const put = (
    kind: string,
    id: string,
    name: string | undefined,
    fallbackPrefix: string,
  ): WorklogEntity => {
    const key = `${kind}:${id}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const v = { kind, id, name: (name && name.trim()) || `${fallbackPrefix} ${short(id)}` };
    memo.set(key, v);
    return v;
  };

  const resolve = (item: Record<string, unknown>): WorklogEntity | null => {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const ref = typeof item.workUnitRef === 'string' ? item.workUnitRef : '';
    const extra = (payload['extra'] ?? {}) as Record<string, unknown>;

    /**
     * ① **自身事务**：只有它自己的决策与维护（唤醒信号 / dream / 日报）归决策循环。
     *    启动唤醒（[RESTARTED]）没有 ref，但标了 extra.loopWake，不是「未归属」。
     *    不用 category==='system' 当判据：category 回答「怎么投递的」，不是「谁的活」
     *    （否则后台命令回执会被扫进决策循环，Owner 2026-11-18 实测 203 条）。
     */
    const stType = String(item.sourceType ?? '');
    const isWake = extra['loopWake'] === true || extra['triggerWake'] === true;
    const SELF_OWNED_TYPES = new Set(['system_event', 'memory_consolidation', 'daily_report']);
    if (isWake || SELF_OWNED_TYPES.has(stType)) {
      return put('channel', `loop_${deps.agentId}`, '决策循环（Loop）', '决策循环');
    }

    // ② 结构身份优先：载荷/元数据上的 taskId / requirementId，不依赖 ref。
    const taskId = (payload['taskId'] ?? meta['taskId']) as string | undefined;
    if (taskId) {
      return put('task', taskId, deps.taskTitle(taskId), '任务');
    }
    const reqId = payload['requirementId'] as string | undefined;
    if (reqId) {
      return put('requirement', reqId, deps.requirementTitle(reqId), '需求');
    }

    // ③ ref 里解（旧行可能没有 ref）。ref 语法只住在 @markus/shared 构造器旁，
    //    这里调官方反解函数，不再写一份正则（两份正则 = 两个语法写者）。
    const taskIdFromRef = taskIdOfWorkUnitRef(ref);
    if (taskIdFromRef) {
      return put('task', taskIdFromRef, deps.taskTitle(taskIdFromRef), '任务');
    }
    const sessFromRef = /^session:(.+?):r\d+$/.exec(ref);
    if (sessFromRef) {
      const sid = sessFromRef[1]!;
      return put('channel', sid, deps.chatSessionTitle(sid), sid.startsWith('loop_') ? '决策循环' : '会话');
    }

    // ④ 委派 → 递归到父单元（它服务的那件事才是实体）。
    if (ref.startsWith('delegation:')) {
      const body = ref.slice('delegation:'.length);
      const hash = body.indexOf('#');
      const parentRef = hash > 0 ? body.slice(0, hash) : body;
      return resolve({ ...item, workUnitRef: parentRef });
    }

    // ⑤ a2a：ref 里已带实体键。DM 形状（a2a:dm:…）本身就是一条会话地址，归会话。
    if (ref.startsWith('a2a:task:')) {
      const id = ref.slice('a2a:task:'.length);
      return put('task', id, deps.taskTitle(id), '任务');
    }
    if (ref.startsWith('a2a:channel:')) {
      const id = ref.slice('a2a:channel:'.length);
      return put('channel', id, undefined, '频道');
    }
    if (ref.startsWith('a2a:')) {
      const inner = ref.slice('a2a:'.length);
      return put('channel', inner, undefined, '会话');
    }

    // ⑥ IM / 外部人类会话：结构身份都没命中时，读入口**声明**的会话键。
    //    external ref 是按消息的幂等键，反解不出会话；channelKey 才是跨消息稳定的
    //    会话实体。读声明 → 一段飞书对话聚成一个 channel 桶，而不是「历史记录」。
    const channelKey = declaredConversationKey(extra);
    if (channelKey) {
      return put('channel', channelKey, imConversationLabel(channelKey), '会话');
    }

    // ⑦ 解不出 → null，前端显示「未归属」，不猜、不塞进别的实体。
    return null;
  };

  return resolve;
}
