/**
 * AgentDelivery —— A2A 投递与回复的**唯一**执行点。
 *
 * 规范：`docs/architecture/mailbox-system.md` §11.1.1–§11.1.4。
 *
 * 这套东西存在的理由（2026-10-25 事故）：
 *   一条 A2A 消息曾经有两个可分离的动作 —— 「写进 channel_messages」和「唤醒对方」，
 *   而唤醒上有三重静默丢弃闸（30s per-channel 冷却、全局唤醒配额、链路正则）。
 *   实测：12 条 DM → 12 行记录、**1 次唤醒**、11 次静默丢弃，而 `agent_send_message`
 *   仍返回 `dispatched`。发送方无从知道消息没到，于是重复发送。
 *
 * 本模块把两件事各收敛到一个出口：
 *   · deliver()   —— 消息进入对方 mailbox（唯一投递点；同 channelKey 由 mailbox 合并）
 *   · postReply() —— agent 在频道里说了一句话（唯一写入点）
 *
 * 不存在"投递了但没唤醒"这种半状态：deliver 只有成功（已入队）或抛错两种结果。
 */

import { createLogger } from '@markus/shared';

const log = createLogger('agent-delivery');

/** 一条待投递的 A2A 消息。 */
export interface DeliveryRequest {
  orgId: string;
  /** `dm:a2a:a:b` 或 `group:...` —— 同时是持久化频道与合并键。 */
  channelKey: string;
  fromAgentId: string;
  fromAgentName: string;
  content: string;
  /** 接收方（一个或多个）。空数组 = 无接收方，直接视为无需投递。 */
  targetAgentIds: string[];
  /** 群聊 @提及：只有这些名字被直接点名（影响对方是否当"轮到你"处理）。 */
  mentions?: string[];
  /** 引用回复的消息 id（写回时带上）。 */
  replyToMsgId?: string;
  /**
   * 因果链标识：由**最初发起者**生成，跨跳原样传递。
   * 主动开始一段新对话 = 新 chainId；在既有链路里回复 = 沿用原 chainId。
   */
  chainId: string;
  /** 该 chainId 下已发生的跳数（本模块只透传，不解释）。 */
  depth: number;
  /** 该频道正处热链中：仍然投递，只是不延伸自动回复链。 */
  throttled?: boolean;
  /**
   * 这条消息**冲着谁**来的（按 targetAgentId 精确列出：DM 的对端、群聊里被 @ 的人）。
   * 列表内的目标 content 会带一行 `[MENTIONED]`；不在列表内的目标是开放式消息
   * （群发/广播），不预设它是给谁的。
   *
   * 为什么是 id 列表而不是布尔值：群聊里一条消息可以"只点名其中两个人"。
   * 布尔值无法表达这个状态，调用方只能把整批都标成 addressed（围观者也以为自己被点名）
   * 或者都不标（被点名者不知道自己该回）。用列表，含糊状态在类型上无法表达。
   */
  addressedTargetIds?: string[];
  /**
   * 消息来源：哪些是「人」而不是同事。
   * 这不是装饰——群聊里一条人类消息如果被当成 A2A 消息处理，agent 会读到
   * “humans do NOT see this conversation”并误判语境；回复也不会被人类看到。
   */
  origin?: 'agent' | 'human';
  /**
   * 需要把对端的回合产出收回来（DM / @提及 的"IM 式回复"）。
   * 为 true 时 deliver 会在 metadata 里挂 responsePromise，并通过
   * `DeliveryOutcome.replies` 把每个目标的 promise 交回给调用方；
   * 调用方拿到后必须经 `postReply()` 写回（唯一写点），不得自己 persist。
   */
  collectReply?: boolean;
}

export interface DeliveryOutcome {
  deliveryId: string;
  /** queued = 已进入对方 mailbox；具体是否与既有 item 合并由 mailbox 决定（§14）。 */
  state: 'queued';
  /** 实际投递到的 agent（不存在的 agent 会被跳过并记录）。 */
  deliveredTo: string[];
  chainId: string;
  depth: number;
  /** 与 deliveredTo 一一对应（仅 collectReply 时存在）。 */
  replies?: Array<Promise<string>>;
}

/** 最小依赖面：便于单测与替换。 */
export interface DeliveryDeps {
  /** 取出 agent；返回 undefined 表示不在本进程/不存在。 */
  getAgent: (agentId: string) => {
    config?: { name?: string };
    enqueueToMailbox: (
      sourceType: string,
      payload: { summary: string; content: string; extra?: Record<string, unknown> },
      options?: { metadata?: Record<string, unknown> },
    ) => unknown;
  } | undefined;
  /** 把一条回复写进频道历史；返回持久化 id（失败可返回 undefined）。 */
  persistReply?: (args: {
    orgId: string;
    channelKey: string;
    senderId: string;
    senderName: string;
    text: string;
    replyToId?: string;
  }) => Promise<string | undefined>;
  /** 广播给频道参与者（DM 用参与者，群聊用全部订阅者，由调用方实现）。 */
  broadcastReply?: (args: {
    channelKey: string;
    senderId: string;
    senderName: string;
    text: string;
    messageId?: string;
  }) => void;
}

let deliverySeq = 0;

export class AgentDelivery {
  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * 投递一条 A2A 消息。**这是全平台唯一允许把消息交给另一个 agent 的地方。**
   *
   * 不做任何时间窗/配额判断：命中限流只影响 `throttled` 这个提示位，消息照常入队。
   * 「不发」这件事在这里根本无法表达 —— 要么入队，要么目标 agent 不存在（记录并跳过）。
   */
  deliver(req: DeliveryRequest): DeliveryOutcome {
    const deliveryId = `dlv_${Date.now().toString(36)}_${(++deliverySeq).toString(36)}`;
    const deliveredTo: string[] = [];
    const replies: Array<Promise<string>> = [];

    for (const targetId of req.targetAgentIds) {
      if (targetId === req.fromAgentId) continue;
      const agent = this.deps.getAgent(targetId);
      if (!agent) {
        log.warn('A2A delivery skipped — target agent not available', {
          deliveryId, targetId, channelKey: req.channelKey, from: req.fromAgentId,
        });
        continue;
      }
      try {
        // 「我是否被点名」在这里唯一决定，调用方无需（也无法）自己拼标记。
        const isAddressed = req.addressedTargetIds?.includes(targetId) ?? false;
        let resolveReply: ((value: string) => void) | undefined;
        if (req.collectReply) {
          const p = new Promise<string>(resolve => { resolveReply = resolve; });
          replies.push(p);
        }
        agent.enqueueToMailbox('a2a_message', {
          summary: req.mentions?.length
            ? `@mention from ${req.fromAgentName}`
            : `A2A message from ${req.fromAgentName}`,
          content:
            (isAddressed
              ? `[MENTIONED] This message is addressed to you (${req.fromAgentName} sent it to you directly or @mentioned you).\n\n`
              : '')
            + (req.origin === 'human'
              ? `[FROM HUMAN] ${req.fromAgentName} is a human user, not an agent — humans can see this channel.\n\n`
              : '[FROM AGENT] The sender is a fellow agent; no human is waiting on this.\n\n')
            + req.content,
          extra: {
            senderId: req.fromAgentId,
            senderName: req.fromAgentName,
            channelKey: req.channelKey,
            // Session identity, stated explicitly: an A2A message belongs to its
            // channel conversation, not to whatever session the target happens to
            // be in. Without this the turn falls back to the recipient's current
            // session and channel/private context bleed into each other.
            sessionHint: { kind: 'system', role: 'channel', key: req.channelKey },
            waitForReply: false,
            // 因果链：由最初发起者生成，跨跳原样传递（§11.1.3）
            chainId: req.chainId,
            chainDepth: req.depth,
            ...(req.mentions?.length ? { directMention: true, mentions: req.mentions } : {}),
            ...(req.replyToMsgId ? { replyToMsgId: req.replyToMsgId } : {}),
            ...(req.throttled ? { throttled: true } : {}),
          },
        }, {
          metadata: {
            senderId: req.fromAgentId,
            senderName: req.fromAgentName,
            senderRole: 'agent',
            ...(resolveReply
              ? { responsePromise: { resolve: (value: string) => resolveReply?.(value), reject: () => {} } }
              : {}),
          },
        });
        deliveredTo.push(targetId);
      } catch (err) {
        // 投递失败必须可见：不吞。调用方据此决定是否重试。
        log.error('A2A delivery failed — enqueue threw', {
          deliveryId, targetId, channelKey: req.channelKey, from: req.fromAgentId, error: String(err),
        });
        throw err;
      }
    }

    log.info('A2A delivered to mailbox', {
      deliveryId, channelKey: req.channelKey, from: req.fromAgentId,
      deliveredTo, chainId: req.chainId, depth: req.depth,
      mentionCount: req.mentions?.length ?? 0, throttled: !!req.throttled,
    });

    return {
      deliveryId, state: 'queued', deliveredTo, chainId: req.chainId, depth: req.depth,
      ...(replies.length > 0 ? { replies } : {}),
    };
  }

  /**
   * 一条 agent 回复写入频道。**这是唯一写点**（DM 与群聊共用），
   * 写完之后**不触发任何人** —— 自动回复链是 43 回合风暴的来源。
   */
  async postReply(args: {
    orgId: string;
    channelKey: string;
    agentId: string;
    agentName?: string;
    text: string;
    replyToMsgId?: string;
  }): Promise<{ messageId?: string }> {
    const text = (args.text ?? '').trim();
    if (!text) return {};

    let senderName = args.agentName;
    if (!senderName) {
      try { senderName = this.deps.getAgent(args.agentId)?.config?.name; } catch { /* roster may not have it */ }
      senderName = senderName ?? args.agentId;
    }

    let messageId: string | undefined;
    if (this.deps.persistReply) {
      try {
        messageId = await this.deps.persistReply({
          orgId: args.orgId,
          channelKey: args.channelKey,
          senderId: args.agentId,
          senderName: senderName!,
          text,
          replyToId: args.replyToMsgId,
        });
      } catch (err) {
        log.warn('Failed to persist A2A reply', { channelKey: args.channelKey, error: String(err) });
      }
    }
    try {
      this.deps.broadcastReply?.({
        channelKey: args.channelKey,
        senderId: args.agentId,
        senderName: senderName!,
        text,
        messageId,
      });
    } catch (err) {
      log.warn('Failed to broadcast A2A reply', { channelKey: args.channelKey, error: String(err) });
    }
    return { messageId };
  }
}

/** 新链：由发起者生成一个 id（仅此一处生成，回复必须沿用传入的 chainId）。 */
export function newChainId(): string {
  return `chain_${Date.now().toString(36)}_${(++deliverySeq).toString(36)}`;
}
