/**
 * 「反馈这个问题」——把一条错误消息气泡变成一份可直接提交的反馈草稿。
 *
 * ── 为什么要单独一个模块 ────────────────────────────────────────────────────
 * 预填内容是这个功能的**全部价值**：老板点「反馈这个问题」，是希望我们不用
 * 再回一句「麻烦把报错原文发一下」。所以字段清单是产品契约，而不是顺手拼的
 * 字符串：
 *
 *   原始错误    —— 未美化的那句。美化后的文案（"模型 API 认证失败"）丢掉了
 *                  provider 原文、status、request id，恰恰是诊断需要的东西。
 *   provider:model —— LLM router 给每条 provider 错误加的 `[provider:model]`
 *                  前缀，是"到底哪个模型坏了"的唯一线索。
 *   时间        —— 本地 ISO（带偏移），能直接和上游日志对齐。
 *   客户端版本  —— 只在 UI 真读得到时填（{@link detectAppVersion}）。
 *   会话上下文  —— agent 名 / session id，能拿到哪个填哪个。
 *
 * 缺失字段一律**省略**，绝不编造占位值 —— 一份写着 "provider: unknown" 的
 * 反馈比没有这一行更坏，它会让人去查一个不存在的东西。
 *
 * ── 为什么用中文标签 ────────────────────────────────────────────────────────
 * 这不是给最终用户读的文案，而是给处理反馈的人看的一次性诊断快照：界面文案
 * 跟着 i18n 走，这份快照不跟（否则英文用户提交上来的东西，处理人还得反向
 * 翻译字段名）。这里刻意不接 i18n，也不进 locales/*。
 */
import type { ChatMsg } from '../pages/ChatHelpers.ts';

/** 反馈正文的长度上限，与 FeedbackModal 的 textarea maxLength 一致。 */
const MAX_BODY = 4000;

/** 标题上限（FeedbackModal 的 input maxLength = 120），留一点安全余量。 */
const MAX_TITLE = 120;

export interface ErrorFeedbackSource {
  /**
   * 未美化的错误原文。live 气泡从 `ChatMsg.errorRaw` 拿；历史气泡没有保留
   * 原文时为 undefined（此时正文会如实说明，而不是拿美化后的话冒充原文）。
   */
  rawError?: string;
  /** 气泡里实际显示的（美化后）提示。 */
  friendlyError?: string;
  agentName?: string;
  agentId?: string;
  sessionId?: string;
  /** 客户端版本；读不到就不要传。 */
  appVersion?: string;
  /** 注入点：默认 `new Date()`。测试靠它把时间钉死。 */
  now?: Date;
}

export interface ErrorFeedbackDraft {
  title: string;
  body: string;
}

/**
 * 本地时区的 ISO 8601 字符串，形如 `2026-01-02T03:04:05+08:00`。
 *
 * 不用 `toISOString()`：它是 UTC，用户看到 08:00 而日志上是 00:00，对时间
 * 就变成了猜谜。偏移量写进字符串，任何人（任何时区）都能换算回同一瞬间。
 */
export function localIsoString(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

/**
 * 从错误原文里取 `provider:model`。
 *
 * LLMRouter.enrichError 给每条 provider 失败加上 `[provider:model]` 前缀
 * （`[markus:claude-sonnet-4.5] OpenAI API error 401: …`），friendlyAgentError
 * 里也已经在用同一个形状匹配 region 报错 —— 说明这个前缀确实到达了前端。
 *
 * 只认这个方括号形状。裸的 `foo:bar` 会误吞 `https://…`、`request_id:…`
 * 之类的正常内容，宁可漏也不要填错。
 */
export function extractProviderModel(raw: string): string | undefined {
  const m = raw.match(/\[([A-Za-z0-9][\w.-]*):([^\]\s]+)\]/);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/**
 * 客户端版本 —— 走现有的 `__APP_VERSION__` 注入（vite define，UserAccountMenu
 * 的 "v0.19.x" 就是它）。构建时未注入（某些测试/嵌入场景）则返回 undefined，
 * 由调用方省略这一行。
 */
export function detectAppVersion(): string | undefined {
  try {
    return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : undefined;
  } catch {
    return undefined;
  }
}

/** 取第一行非空内容并截断 —— 标题只能是一行。 */
function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function clip(text: string, max = MAX_BODY): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 拼出反馈的初值。用户可以在弹窗里随便改 —— 这里只保证「打开就有料」。
 */
export function buildErrorFeedbackDraft(src: ErrorFeedbackSource): ErrorFeedbackDraft {
  const raw = (src.rawError ?? '').trim();
  const friendly = (src.friendlyError ?? '').trim();
  const providerModel = extractProviderModel(`${raw}\n${friendly}`);
  const when = src.now ?? new Date();

  const lines: string[] = ['—— 以下为自动填入的错误诊断，可直接修改 ——'];
  // 「原文」这个词必须名副其实：拿不到原文时说出来，别让美化后的文案冒充。
  lines.push(`原始错误：${raw ? clip(raw) : '（该气泡没有保留错误原文，只有下面的界面提示）'}`);
  if (friendly && friendly !== raw) lines.push(`界面提示：${clip(friendly)}`);
  if (providerModel) lines.push(`provider:model：${providerModel}`);
  lines.push(`时间：${localIsoString(when)}`);
  if (src.appVersion) lines.push(`客户端版本：${src.appVersion}`);

  const agent = (src.agentName ?? '').trim();
  const agentId = (src.agentId ?? '').trim();
  const who = agent && agentId ? `${agent}（${agentId}）` : agent || agentId;
  if (who) lines.push(`agent：${who}`);
  if (src.sessionId) lines.push(`会话 ID：${src.sessionId}`);

  lines.push('');
  lines.push('我当时的操作 / 期望的结果：（在这里补充）');

  const reason = firstLine(friendly || raw, 60) || '未知错误';
  const title = clip(`聊天报错：${providerModel ? `${providerModel} · ` : ''}${reason}`, MAX_TITLE);

  return { title, body: clip(lines.join('\n')) };
}

/**
 * 气泡 → 诊断来源。放在 lib 里（而不是组件里）是为了让「哪些事实会进反馈」
 * 可以脱离 DOM 断言。
 */
export function errorFeedbackSourceFromMessage(
  msg: Pick<ChatMsg, 'text' | 'errorRaw' | 'agentId' | 'agentName' | 'sessionId'>,
  extra?: { agentName?: string; agentId?: string; sessionId?: string; appVersion?: string; now?: Date },
): ErrorFeedbackSource {
  return {
    rawError: msg.errorRaw,
    friendlyError: msg.text,
    // 真实 agent 名优先于气泡署名：错误气泡的署名常常是「系统」，
    // 而诊断要的是「哪个 agent 出的事」。
    agentName: extra?.agentName ?? msg.agentName,
    agentId: extra?.agentId ?? msg.agentId,
    sessionId: extra?.sessionId ?? msg.sessionId,
    appVersion: extra?.appVersion,
    now: extra?.now,
  };
}
