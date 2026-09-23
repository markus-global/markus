import { useEffect, useRef, useState, useCallback, useMemo, memo, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AgentInfo } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  MemoExecEntryRow,
  TaskApprovalCard, RequirementApprovalCard,
  filterCompletedStarts, streamEntryToExecEntry, formatDuration,
  parseTaskApprovalFromResult, parseRequirementApprovalFromResult,
  type ExecEntry,
  type ExecutionStreamEntryUI,
  type TaskApprovalInfo, type RequirementApprovalInfo,
} from '../components/ExecutionTimeline.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { isRememberActionVisible, stripNotifyContext, stripThinkingBlocks, type ChatMsg, type MsgSegment } from './ChatHelpers.ts';
export { isRememberActionVisible };

// ─── NotificationBadge ────────────────────────────────────────────────────────

export function NotificationBadge({ priority }: { priority?: string }) {
  const { t } = useTranslation(['common', 'team']);
  const isHigh = priority === 'high' || priority === 'critical';
  const priorityLabel = priority && priority !== 'normal'
    ? ` · ${t(`common:priority.${priority}`, { defaultValue: priority })}`
    : '';
  return (
    <div className={`inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
      isHigh
        ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
        : 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
    }`}>
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      <span>{t('team:notifications.badgeLabel')}{priorityLabel}</span>
    </div>
  );
}

// ─── ChatAgentLink ────────────────────────────────────────────────────────────

export function ChatAgentLink({ name, agentId, agents, onViewProfile }: {
  name: string;
  agentId?: string;
  agents: AgentInfo[];
  onViewProfile?: (agentId: string) => void;
}) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const agent = agentId ? agents.find(a => a.id === agentId) : agents.find(a => a.name === name);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!agent) return <span>{name}</span>;

  return (
    <span ref={ref} className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-fg-tertiary hover:text-brand-500 cursor-pointer transition-colors">
        {name}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Avatar name={agent.name} avatarUrl={agent.avatarUrl} size={28} bgClass="bg-brand-500/15 text-brand-600" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg-primary font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-fg-tertiary">{agent.role} · {agent.agentRole ?? t('page.workerRole')}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              agent.status === 'working' ? 'bg-blue-400 animate-pulse'
              : agent.status === 'error' ? 'bg-red-400'
              : 'bg-green-400'
            }`} />
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            {t('page.viewProfileArrow')}
          </button>
        </div>
      )}
    </span>
  );
}

// ─── AvatarPopover ────────────────────────────────────────────────────────────

export function AvatarPopover({ agent, anchorRect, onClose, onViewProfile }: {
  agent: AgentInfo;
  anchorRect: { top: number; left: number };
  onClose: () => void;
  onViewProfile: (agentId: string) => void;
}) {
  const { t } = useTranslation(['common', 'team']);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const statusColor = agent.status === 'idle' ? 'bg-green-400'
    : agent.status === 'working' ? 'bg-blue-400 animate-pulse'
    : agent.status === 'error' ? 'bg-red-400'
    : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? t('common:status.online') : agent.status === 'working' ? t('common:status.working') : agent.status === 'error' ? t('common:status.error') : t('common:status.offline');

  const adjustRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    if (rect.right > vw - pad) el.style.left = `${Math.max(pad, vw - rect.width - pad)}px`;
    if (rect.left < pad) el.style.left = `${pad}px`;
    if (rect.bottom > vh - pad) el.style.top = `${Math.max(pad, vh - rect.height - pad)}px`;
  }, []);

  return (
    <div
      ref={adjustRef}
      className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] bg-surface-secondary border border-border-default rounded-xl shadow-2xl p-4 space-y-3"
      style={{ top: anchorRect.top + 40, left: anchorRect.left }}
    >
      <div className="flex items-center gap-3">
        <Avatar name={agent.name} avatarUrl={agent.avatarUrl} size={40} bgClass="bg-brand-500/15 text-brand-600" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg-primary font-medium truncate">{agent.name}</div>
          <div className="text-[11px] text-fg-tertiary">{agent.role}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-fg-secondary">{statusLabel}</span>
            {agent.agentRole && <span className="text-[10px] text-fg-tertiary">· {agent.agentRole}</span>}
          </div>
        </div>
      </div>
      <button
        onClick={() => { onClose(); onViewProfile(agent.id); }}
        className="w-full py-1.5 text-xs text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg transition-colors text-center"
      >
        {t('team:page.viewProfileArrow')}
      </button>
    </div>
  );
}

// ─── Credit error detection ───────────────────────────────────────────────────

/** Returns true if the error is a confirmed Markus Cloud AI credit/quota error. */
export function isMarkusCreditError(err: unknown): boolean {
  const raw = String(err);
  // Upstream 402 while Hub still has budget — not a user credit-exhausted state.
  if (raw.includes('MARKUS_UPSTREAM_ERROR')) return false;
  return raw.includes('CU_EXCEEDED')
    || raw.includes('CU_MONTHLY_EXCEEDED');
}

const CREDIT_MUTE_KEY = 'markus:credit-notif-muted';
let _lastCreditNotifTs = 0;

/**
 * Inject a credit-exhausted notification into the notification bell.
 * - Respects "don't remind again" (persisted in localStorage).
 * - 5-minute cooldown between notifications (desktop app stays open long).
 */
export function dispatchCreditNotification(): void {
  try { if (localStorage.getItem(CREDIT_MUTE_KEY)) return; } catch { /* */ }
  const now = Date.now();
  if (now - _lastCreditNotifTs < 5 * 60_000) return;
  _lastCreditNotifTs = now;
  window.dispatchEvent(new CustomEvent('markus:credit-exhausted'));
}

export function muteCreditNotifications(): void {
  try { localStorage.setItem(CREDIT_MUTE_KEY, '1'); } catch { /* */ }
}

export function unmuteCreditNotifications(): void {
  try { localStorage.removeItem(CREDIT_MUTE_KEY); } catch { /* */ }
}

// ─── friendlyAgentError ───────────────────────────────────────────────────────

export function friendlyAgentError(err: unknown, t: TFunction): string {
  const raw = String(err);

  if (raw.includes('AbortError') || raw.includes('abort'))
    return '';

  let detail = '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? '';
    } catch { /* ignore */ }
  }
  if (!detail) {
    const colonIdx = raw.lastIndexOf(': ');
    if (colonIdx >= 0) detail = raw.slice(colonIdx + 2).trim();
  }

  // All error keys live in the 'team' namespace — use explicit prefix so
  // this function works regardless of the caller's default namespace.
  const e = (key: string, opts?: Record<string, unknown>) => t(`team:errors.${key}`, opts);

  if (raw.includes('MARKUS_UPSTREAM_ERROR'))
    return e('aiUpstreamBillingMismatch', { detail: detail || e('defaultUpstreamBillingMismatch') });
  if (isMarkusCreditError(raw) || raw.includes('CU_EXCEEDED'))
    return e('markusCuExceeded');
  if (raw.includes('CU_WINDOW_EXCEEDED'))
    return e('markusWindowExceeded');
  if (raw.includes('MARKUS_RATE_LIMITED'))
    return e('markusRateLimited');

  if (/not available in your region/i.test(raw))
    return e('aiRegionBlocked', { model: (raw.match(/\[(?:markus|openrouter):([^\]]+)\]/i)?.[1] || '').trim() || '—' });
  if (raw.includes('401') || /unauthorized|invalid.?api.?key/i.test(raw))
    return e('ai401', { detail: detail || e('defaultInvalidApiKey') });
  if (raw.includes('429') || /rate.?limit/i.test(raw))
    return e('ai429', { detail: detail || e('defaultTooManyRequests') });
  if (/\b409\b/.test(raw) || /conflict/i.test(raw))
    return e('ai409', { detail: detail || e('defaultConflict') });
  if (raw.includes('502') || /bad.?gateway/i.test(raw))
    return e('ai502', { detail: detail || e('defaultUpstreamDown') });
  if (raw.includes('503') || /service.?unavailable/i.test(raw))
    return e('ai503', { detail: detail || e('defaultServiceDown') });

  // Strip vendor billing URLs if anything slipped through.
  const safe = (detail || raw).replace(/https?:\/\/[^\s]*openrouter\.ai[^\s]*/gi, '').trim();
  return e('aiGeneric', { detail: (safe || raw).slice(0, 120) });
}

// ─── MessageActions ───────────────────────────────────────────────────────────

export function MessageActions({
  msg, onCopy, onRetry, onResume, onReply, onRemember, isCopied, isLastAgentMsg, showRemember,
}: {
  msg: ChatMsg;
  onCopy: (msg: ChatMsg) => void;
  onRetry?: (msg: ChatMsg) => void;
  onResume?: (msg: ChatMsg) => void;
  onReply?: (msg: ChatMsg) => void;
  onRemember?: (msg: ChatMsg) => void;
  isCopied: boolean;
  isLastAgentMsg?: boolean;
  /** Set true only for user↔agent DM chat — never group/A2A. */
  showRemember?: boolean;
}) {
  const { t } = useTranslation(['team', 'common']);
  const isError = msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'));
  const isStopped = msg.isStopped;
  const isEmptyReply = !!msg.emptyReply || (
    msg.sender === 'agent' && !msg.text?.trim() && !(msg.segments?.some(s =>
      (s.type === 'text' && (s.content || s.thinking)) || s.type === 'tool'
    ))
  );
  const canRetry = isLastAgentMsg !== false;
  const canRemember = isRememberActionVisible(showRemember, msg.sender) && !!onRemember;
  return (
    <div className="flex items-center flex-wrap gap-0.5 mt-1">
      <button onClick={() => onCopy(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('common:copy')}>
        {isCopied
          ? <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
          : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        }
        {isCopied ? t('common:copied') : t('common:copy')}
      </button>
      {canRetry && onResume && (
        <button onClick={() => onResume(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-green-500 hover:text-green-400 hover:bg-green-500/10 transition-colors" title={t('page.messageActions.resumeTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          {t('page.messageActions.resumeTitle')}
        </button>
      )}
      {canRetry && isStopped && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-brand-500 hover:text-brand-500 hover:bg-brand-500/10 transition-colors" title={t('page.messageActions.reaskTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.reaskTitle')}
        </button>
      )}
      {canRetry && (isError || isEmptyReply) && !isStopped && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-amber-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors" title={t('page.messageActions.retryTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {canRetry && !isError && !isEmptyReply && !isStopped && msg.sender === 'agent' && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('page.messageActions.retryTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {onReply && (
        <button onClick={() => onReply(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('page.messageActions.replyTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 00-4-4H4" /></svg>
          {t('page.messageActions.replyTitle')}
        </button>
      )}
      {canRemember && (
        <button
          type="button"
          onClick={() => onRemember!(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors"
          title={t('page.messageActions.rememberTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a7 7 0 00-4 12.7V19a1 1 0 001 1h6a1 1 0 001-1v-4.3A7 7 0 0012 2z" />
            <path d="M9 22h6" />
          </svg>
          {t('page.messageActions.rememberTitle')}
        </button>
      )}
      {msg.sender === 'agent' && (
        <span className="ml-1 px-1 text-[10px] leading-none text-fg-tertiary/70 select-none whitespace-nowrap">
          {t('page.messageActions.aiGeneratedDisclaimer')}
        </span>
      )}
    </div>
  );
}

// ─── RememberModal ────────────────────────────────────────────────────────────

export function RememberModal({
  busy,
  onConfirm,
  onCancel,
}: {
  busy?: boolean;
  onConfirm: (userNote: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['team', 'common']);
  const [note, setNote] = useState('');
  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10050] p-4" onClick={onCancel}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[400px] max-w-[calc(100vw-2rem)] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base text-fg-primary">{t('page.messageActions.rememberModalTitle')}</h3>
        <p className="text-sm text-fg-secondary mt-1.5 leading-relaxed">{t('page.messageActions.rememberModalHint')}</p>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={t('page.messageActions.rememberModalPlaceholder')}
          rows={3}
          disabled={busy}
          className="mt-3 w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg outline-none focus:border-brand-500/50 resize-y min-h-[72px]"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-1.5 text-sm text-fg-secondary hover:text-fg-primary rounded-lg transition-colors"
          >
            {t('page.messageActions.rememberCancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            disabled={busy}
            className="px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-60 text-white rounded-lg transition-colors"
          >
            {busy ? t('common:loading', { defaultValue: '…' }) : t('page.messageActions.rememberConfirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── sentence healing ────────────────────────────────────────────────────────
//
// 一轮回复里，正文经常被拆成多段（每个工具调用开始时就 flush 一次 textBuf，见
// org-manager/src/sse-handler.ts），而模型分步输出时也确实会出现「这句话还没写完
// 就先去调工具，下一步再接着写」。渲染层如果照原样平铺，就会出现用户看到的
// 「正文半句 → 工具行 → 剩下半句」。
//
// 这里做的是**最小改动**的愈合，刻意不做「把所有正文合成一块」：
//   • 过程行（思考 / 工具）一律保留、顺序不变 —— 用户仍能看到完整的
//     思考 → 正文 → 执行 → 思考 过程；
//   • 只有当一段正文**明显是上一句的续写**（上一段没有句末标点、本段也不是新
//     段落/新块级元素的开头）时，才把这半句接回上一段，
//     并把夹在中间的过程行整体挪到「这句话说完之后」。
// 于是：`[正文A][工具][正文B:续写]` → `[正文A+B][工具]`；
//      而 `[正文A。][工具][正文B]` 保持原样，句子之间照样看得见工具行。

/** 句末标点 —— 以它结尾的正文视为「这句话已经说完」。 */
const SENTENCE_END_RE = /[.!?。！？…:：]\s*$|["'”’)\]}】》]\s*$|\n\s*$/;
/** 新段落 / 块级元素的起始标记 —— 这类片段不该被接回上一句。 */
const NEW_BLOCK_RE = /^(?:\n|#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|\||```|~~~|---)/;

/** B 是否只是 A 的续写（同一句话被过程行切开）。 */
export function isSentenceContinuation(a: string, b: string): boolean {
  const prev = a.replace(/\s+$/, '');
  if (!prev) return false;
  if (SENTENCE_END_RE.test(a)) return false; // A 已经说完
  if (!b.trim()) return false;
  if (NEW_BLOCK_RE.test(b)) return false; // B 是新段落
  return true;
}

/**
 * 拼接两块正文 —— **只补原文确实存在的那个空格**。
 *
 * 上一版按「拉丁字母交界就补空格」去猜，把被切开的一个词接成了 `w ith`：
 * 分段点是 token 边界，而 token 会在词中间断开（`w` + `ith`），此时两边都没有
 * 空白，正确做法是**原样相接**。真正需要补空格只有一种情况：原文本来有空白，
 * 但被 `emitText` 的 `trim()` 抹掉了 —— 那由 metadata 里的
 * `trailingSpace` / `leadingSpace` 记账，不再靠字符类型猜。
 */
export function joinProse(a: string, b: string, opts?: { spaceNeeded?: boolean }): string {
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  return opts?.spaceNeeded ? `${a} ${b}` : a + b;
}

export function healSentenceSplits(entries: ExecutionStreamEntryUI[]): ExecutionStreamEntryUI[] {
  const isProcess = (e: ExecutionStreamEntryUI) => e.type !== 'text' || e.metadata?.isThinking === true;
  const out: ExecutionStreamEntryUI[] = [];
  let pending: ExecutionStreamEntryUI[] = [];
  let lastText = -1;

  for (const entry of entries) {
    if (isProcess(entry)) {
      pending.push(entry);
      continue;
    }
    const prev = lastText >= 0 ? out[lastText] : undefined;
    if (
      prev
      && pending.length > 0
      && entry.metadata?.paragraphBreak !== true
      && prev.metadata?.paragraphAfter !== true
      && isSentenceContinuation(prev.content, entry.content)
    ) {
      // 只有原文这里本来有空白时才补空格（trim() 抹掉的那个）。
      prev.content = joinProse(prev.content, entry.content, {
        spaceNeeded: prev.metadata?.trailingSpace === true || entry.metadata?.leadingSpace === true,
      });
      out.push(...pending); // 过程行挪到这句话说完之后
      pending = [];
      continue;
    }
    if (pending.length > 0) {
      out.push(...pending);
      pending = [];
    }
    out.push(entry);
    lastText = out.length - 1;
  }
  if (pending.length > 0) out.push(...pending);
  return out;
}

// ─── 过程成组：思考 + 工具默认折成一行 ─────────────────────────────────────────
//
// 为什么不是「把过程行全收进气泡底部」：用户要的是**顺序不变**的完整性 ——
// 思考 → 正文 → 执行 → 思考，只是每一段过程默认折起来。所以这里只做分组，
// 不搬运、不重排：连续的思考/工具行合成一个 process 块，正文行各自成块。

export interface ProcessRunSummary {
  /** 思考行数（同一段 reasoning 已被 emitThinking 合并成一行）。 */
  thinkingCount: number;
  /** 工具调用数（tool_start 的条数，一个工具算一次）。 */
  toolCount: number;
  subagentCount: number;
  /** 仍在跑的工具名（收尾了就没有）。 */
  runningTool?: string;
  /** 最后一个、还没结束的工具仍在运行。 */
  running: boolean;
  /** 这段过程以「思考」收尾 → 折叠行显示「思考中…」。 */
  tailIsThinking: boolean;
  /** 首末 entry 的真实时间跨度；拿不到真实时间戳时为 0。 */
  elapsedMs: number;
  /**
   * 这段过程里失败了几次：`error` 行 + `tool_end` 标记 success:false 的工具。
   * 图标要用它区分「跑完了」和「跑完了但有失败」——后者不该给一个表示完成的勾。
   */
  errorCount: number;
}

export type ChatTimelineBlock =
  | { kind: 'text'; key: string; entry: ExecutionStreamEntryUI }
  | { kind: 'process'; key: string; entries: ExecutionStreamEntryUI[]; summary: ProcessRunSummary };

/** 过程行 = 工具/状态/错误/子智能体，以及 metadata 标记为思考的正文行。 */
export function isProcessEntry(entry: ExecutionStreamEntryUI): boolean {
  return entry.type !== 'text' || entry.metadata?.isThinking === true;
}

/** 首末 entry 的真实时间跨度；拿不到真实时间戳时为 0。过程块与顶部「已工作」行共用。 */
export function entriesElapsedMs(entries: ExecutionStreamEntryUI[]): number {
  const first = Date.parse(entries[0]?.createdAt ?? '');
  const last = Date.parse(entries[entries.length - 1]?.createdAt ?? '');
  return Number.isFinite(first) && Number.isFinite(last) && last > first ? last - first : 0;
}

export function summarizeProcessRun(entries: ExecutionStreamEntryUI[]): ProcessRunSummary {
  let thinkingCount = 0;
  let toolCount = 0;
  let subagentCount = 0;
  let pendingTool: string | null = null;
  let errorCount = 0;

  for (const e of entries) {
    if (e.type === 'text' && e.metadata?.isThinking === true) { thinkingCount++; continue; }
    if (e.type === 'tool_start') {
      toolCount++;
      pendingTool = e.content;
      continue;
    }
    if (e.type === 'tool_end') {
      // 工具失败 = 失败一次（与 streamEntryToExecEntry 的 status:'error' 同一判据）。
      if (e.metadata?.success === false) errorCount++;
      pendingTool = null;
      continue;
    }
    if (e.type === 'subagent_start') subagentCount++;
    if (e.type === 'error') errorCount++;
  }

  const elapsedMs = entriesElapsedMs(entries);

  return {
    thinkingCount,
    toolCount,
    subagentCount,
    running: pendingTool !== null,
    ...(pendingTool ? { runningTool: pendingTool } : {}),
    tailIsThinking: entries[entries.length - 1]?.type === 'text'
      && entries[entries.length - 1]?.metadata?.isThinking === true,
    elapsedMs,
    errorCount,
  };
}

/**
 * 把时间线切成「正文块」与「过程块」（后者代表一段连续的思考/工具）。
 * 空输入 → 空数组；过程块一定非空，调用方不必再判空。
 */
export function groupProcessRuns(entries: ExecutionStreamEntryUI[]): ChatTimelineBlock[] {
  const blocks: ChatTimelineBlock[] = [];
  let run: ExecutionStreamEntryUI[] = [];
  let runStart = 0;

  const flushRun = () => {
    if (run.length === 0) return;
    blocks.push({
      kind: 'process',
      key: `proc_${runStart}`,
      entries: run,
      summary: summarizeProcessRun(run),
    });
    run = [];
  };

  entries.forEach((entry, index) => {
    if (isProcessEntry(entry)) {
      if (run.length === 0) runStart = index;
      run.push(entry);
      return;
    }
    flushRun();
    blocks.push({ kind: 'text', key: `text_${index}`, entry });
  });
  flushRun();
  return blocks;
}

/**
 * 最后一个正文块的索引；没有正文块 → -1。**「最终结果」= 最后一个正文块。**
 *
 * 为什么是「最后一个」而不是「唯一一个」：一轮里正文会被工具切开好几段
 * （每个工具开始就 flush 一次 textBuf），中间那些是过程旁白，只有末尾那段
 * 才是真正交付给用户的结论。
 */
export function lastTextBlockIndex(blocks: ChatTimelineBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === 'text') return i;
  }
  return -1;
}

/**
 * 完成后要折进顶部一行的块数（= 最终结果之前的全部块）。0 = 没什么可折，
 * 此时不显示顶部行 —— 一条纯正文的简单回复不该平白多出一行。
 *
 * 只在**这轮已经结束**时才折：流式期间逐段展开正是「生成中与生成完气泡等高」的
 * 前提；中途把已经产出的内容收走，会让用户正在盯的东西突然消失。
 */
export function collapsibleBlockCount(blocks: ChatTimelineBlock[], isStreaming: boolean): number {
  if (isStreaming) return 0;
  const idx = lastTextBlockIndex(blocks);
  return idx > 0 ? idx : 0;
}

/**
 * 「已工作 N 秒 / N 分 N 秒」。秒级不写「0 分」；分钟级保留余秒 ——
 * 「2 分 13 秒」比「2 分钟」更能说明这轮到底有多重。
 *
 * 不复用 execution-utils 的 formatDuration：那个产出 `1.2s` 这种工程口径，
 * 混在正文里很突兀。
 */
export function formatWorkedFor(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.round(ms / 1000));
  // 显式写死 `common:` 前缀。这里的 `t` 由调用方传入，而调用方（AgentMessageBody）
  // 用的是 useTranslation(['team','common']) —— react-i18next 会把 t 绑到
  // namespaces[0]（即 'team'），于是 `execution.*` 这类只存在于 common 的 key
  // 会原样渲染成 "execution.workedForMinutes"。前缀让这个 helper 不依赖调用方绑了哪个 ns。
  if (total < 60) return t('common:execution.workedForSeconds', { seconds: total });
  return t('common:execution.workedForMinutes', {
    minutes: Math.floor(total / 60),
    seconds: total % 60,
  });
}

// ─── ProcessRun — 一段过程（思考 + 工具）的折叠行 ─────────────────────────────

/** 折叠行开头那个图标的两种形态。轮廓不同，缩到 12px 也能一眼分开。 */
export type ProcessRunState = 'running' | 'done';

/**
 * 折叠行的状态图标 —— 两种形状，而不只是换颜色：
 *
 *   进行中：转圈的弧线（品牌色）—— 「在动」；旋转由 4Hz tick 驱动，不额外产帧
 *   已完成：对勾（弱色）        —— 「办完了」
 *
 * **工具失败不再单独出一种图标**（老板 2026-09-23 明确要求）：agent 调工具踩坑是
 * 常态，失败后往往自己重试并继续，给它一个惊叹号等于把「正常干活」画成「出事故」。
 * 失败次数照旧写在文字里（见 summary.errorCount），信息没丢，只是不再抢焦点。
 *
 * 为什么不能只靠颜色：这行只有 11px 高，颜色差异在暗色主题下最容易被忽略，
 * 而且对色觉障碍用户等于没有区分；形状差异才是真正可辨的。
 */
export function ProcessRunIcon({ state }: { state: ProcessRunState }) {
  if (state === 'running') {
    return (
      <span className="animate-spin inline-flex">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      </span>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6.5 9.5 17 4 11.5" />
    </svg>
  );
}

/**
 * 一段「过程」默认收成一行，点开才展开这段过程里的思考/工具明细；
 * 再点其中某一条，才是那一条的详情（复用 ExecEntryRow 既有行为）。
 *
 * 为什么全程默认收起：流式时过程行会把气泡撑得很长，结束时又整块收掉，
 * 前后不像同一条消息。全程折叠后，气泡在「生成中」和「生成完」基本等高，
 * 信息一条没少 —— 想看随时点开。
 */
function ProcessRun({
  entries,
  summary,
  isStreaming,
  isLastBlock,
  hideApprovalCards,
}: {
  entries: ExecutionStreamEntryUI[];
  summary: ProcessRunSummary;
  /** 这条消息整体还在流式输出。 */
  isStreaming: boolean;
  /** 这是时间线上的最后一块 —— 只有它可能以「思考中」收尾。 */
  isLastBlock: boolean;
  hideApprovalCards?: boolean;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);

  const rows = useMemo(
    () => filterCompletedStarts(
      entries.map(streamEntryToExecEntry).filter((e): e is ExecEntry => e !== null),
    ),
    [entries],
  );

  // 跑着的时候说「正在干什么」，跑完了说「干了多少」。
  // 「在跑」有两种：工具正在执行，或者这块以思考收尾 —— 后者说明 agent 此刻正在
  // 推理（流式思考中），同样该有活的反馈，否则气泡会看起来像卡住了。
  // 「在跑」有两种：工具真的还没结束（tool_start 没有配对的 tool_end），
  // 或者这块以思考收尾（流式思考中）—— 后者同样该有活的反馈。
  //
  // 判据故意不依赖「是不是最后一块」：待结束的工具无论落在哪一块，
  // 只要这轮还在流式，它就是在跑。只按位置判会让一个没收尾的工具显示成
  // 绿勾（已跑完），这是错的。位置只用来回答「思考是不是还在进行」——
  // 后面已经又出了正文，说明那段思考早就结束了。
  const running = isStreaming && (summary.running || (isLastBlock && summary.tailIsThinking));
  // 三个状态优先级：在跑 > 有失败 > 完成。跑着的时候先别急着报错（后面还会重试）。
  // 只有「在跑 / 跑完」两态：工具失败不再单独出一种图标（失败次数仍写在 label 里）。
  const state: ProcessRunState = running ? 'running' : 'done';
  const liveLabel = running && summary.runningTool
    ? t('execution.processRun.runningTool', {
        tool: t(`execution.tools.${summary.runningTool}`, { defaultValue: summary.runningTool }),
      })
    : null;

  const parts: string[] = [];
  if (summary.thinkingCount > 0) parts.push(t('execution.processRun.thinking'));
  if (summary.toolCount > 0) parts.push(t('execution.processRun.tools', { count: summary.toolCount }));
  if (summary.subagentCount > 0) parts.push(t('execution.processRun.subagents', { count: summary.subagentCount }));
  // 失败次数直接写进这一行 —— 收起状态下也该看得见「这段里有东西挂了」。
  // 但**不上色**：这一行的三种状态一律灰，靠形状（转圈 / 三角 / 对勾）和文字区分，
  // 颜色只留给「执行中」的品牌色。收起行是高频出现的安静元素，红色会把整条时间线
  // 染成警报墙，反而让人不再看它。
  if (summary.errorCount > 0) parts.push(t('execution.processRun.errors', { count: summary.errorCount }));
  // 只有拿到真实时间戳且确实超过 1 秒才显示耗时，避免出现「0.0s」这种噪音。
  if (summary.elapsedMs >= 1000) parts.push(formatDuration(summary.elapsedMs));

  const labelText = running
    ? (liveLabel ?? t('execution.thinkingEllipsis'))
    : (parts.join(' · ') || t('execution.processRun.label'));
  const stateLabel = t(`execution.processRun.state.${state}`);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-process-state={state}
        title={labelText}
        className="group relative w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-[11px] leading-tight text-fg-tertiary bg-surface-elevated/25 hover:bg-surface-elevated/45 border border-border-default/40 hover:border-border-default/70 overflow-hidden transition-colors cursor-pointer select-none"
      >
        {/* 运行中：一道扫光横穿整行 —— 「还活着」的最轻量表达 */}
        {running && <span className="process-run-sweep" aria-hidden="true" />}
        <span
          className={`relative shrink-0 flex items-center justify-center w-3 h-3 ${
            state === 'running' ? 'text-brand-400' : ''
          }`}
        >
          <ProcessRunIcon state={state} />
        </span>
        <span className="sr-only">{stateLabel}</span>
        <span className={`relative min-w-0 truncate ${running && !liveLabel ? 'activity-text-shimmer' : ''}`}>
          {running ? labelText : (parts.length === 0
            ? labelText
            : parts.map((p, i) => (
                <span key={p + i}>
                  {i > 0 ? ' · ' : ''}{p}
                </span>
              )))}
        </span>
        <svg
          className={`relative ml-auto w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="mt-1 ml-[7px] pl-3 border-l-2 border-border-default/50 space-y-2 min-w-0 overflow-hidden">
          {rows.length > 0 ? rows.map((row, i) => (
            <MemoExecEntryRow key={i} entry={row} showTime={false} hideApprovalCards={hideApprovalCards} />
          )) : (
            <div className="py-1 text-[11px] text-fg-tertiary">{t('execution.noToolDetail')}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── segmentsToStreamEntries ──────────────────────────────────────────────────

export function segmentsToStreamEntries(segments: ChatMsg['segments'], agentId?: string, msgTime?: string): ExecutionStreamEntryUI[] {
  if (!segments) return [];
  const entries: ExecutionStreamEntryUI[] = [];
  let seq = 0;
  const aid = agentId ?? '';

  const baseMs = msgTime ? new Date(msgTime).getTime() : Date.now();
  let cursorMs = baseMs;
  const hasRealTimestamps = segments.some(s => s.createdAt);

  const getTimestamp = (seg: MsgSegment): string => {
    if (seg.createdAt) return seg.createdAt;
    if (hasRealTimestamps) return new Date(cursorMs).toISOString();
    const ts = new Date(cursorMs).toISOString();
    if (seg.type === 'tool' && seg.durationMs) {
      cursorMs += seg.durationMs;
    } else {
      cursorMs += 1000;
    }
    return ts;
  };

  let insideThink = false;
  let thinkBuf = '';
  let textBuf = '';
  let currentSegTimestamp = '';

  const emitThinking = () => {
    const t = thinkBuf.trim();
    if (t) {
      const last = entries[entries.length - 1];
      // Merge adjacent thinking into one block so repeated reasoning segments do
      // not print multiple「思考中」headings — content stays chronological.
      if (last && last.type === 'text' && last.metadata?.isThinking) {
        last.content += (last.content ? '\n\n' : '') + t;
      } else {
        entries.push({
          id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
          seq: seq++, type: 'text', content: t, createdAt: currentSegTimestamp,
          metadata: { isThinking: true },
        });
      }
    }
    thinkBuf = '';
  };

  const emitText = () => {
    const raw = textBuf;
    const t = raw.trim();
    if (t) {
      // 原始分段首尾的空白/换行是「这句话是不是被过程行从中间切开」的唯一证据，
      // 而 `trim()` 会把它抹掉。所以先记账，交给 healSentenceSplits 判断：
      //   paragraphBreak —— 原文自己就是另起一段（以空行开头）
      //   paragraphAfter —— 原文以空行收尾（这句说完了）
      //   trailingSpace / leadingSpace —— 原文这里**本来有空白**，拼接时要补回来
      // 反过来说：两个 flag 都没有 ⇒ 原文此处紧挨着，拼接绝不能凭空插空格。
      const gaps: Record<string, boolean> = {};
      if (/^\s*\n/.test(raw)) gaps.paragraphBreak = true;
      if (/\n\s*\n\s*$/.test(raw)) gaps.paragraphAfter = true;
      if (/\s$/.test(raw)) gaps.trailingSpace = true;
      if (/^\s/.test(raw)) gaps.leadingSpace = true;
      entries.push({
        id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
        seq: seq++, type: 'text', content: t, createdAt: currentSegTimestamp,
        ...(Object.keys(gaps).length > 0 ? { metadata: gaps } : {}),
      });
    }
    textBuf = '';
  };

  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';

  const processText = (content: string) => {
    // Structured `seg.thinking` already carries reasoning — the inline tag scan
    // below is ONLY a compatibility fallback for legacy content that still
    // embeds markers. It strips the marker but never emits a second thinking
    // row (prevents duplicate「思考中」headings when the body mentions
    // "thinking"/"response" mid-sentence). Local state only — a stray unclosed
    // marker must not swallow the next segment's text.
    let pos = 0;
    let inLegacyThink = false;
    while (pos < content.length) {
      if (inLegacyThink) {
        const closeIdx = content.indexOf(CLOSE_TAG, pos);
        if (closeIdx === -1) {
          pos = content.length;
        } else {
          inLegacyThink = false;
          pos = closeIdx + CLOSE_TAG.length;
        }
      } else {
        const openIdx = content.indexOf(OPEN_TAG, pos);
        if (openIdx === -1) {
          textBuf += content.slice(pos);
          pos = content.length;
        } else {
          textBuf += content.slice(pos, openIdx);
          inLegacyThink = true;
          pos = openIdx + OPEN_TAG.length;
        }
      }
    }
  };

  for (const seg of segments) {
    currentSegTimestamp = getTimestamp(seg);

    if (seg.type === 'tool') {
      if (!insideThink) emitText();

      const toolStartTs = seg.createdAt && seg.durationMs
        ? new Date(new Date(seg.createdAt).getTime() - seg.durationMs).toISOString()
        : currentSegTimestamp;

      entries.push({
        id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
        seq: seq++, type: 'tool_start', content: seg.tool,
        metadata: {
          arguments: seg.args,
          // Live spawn_* rows need nested progress while still running — tool_end
          // is not emitted until the sub-agent finishes (can be minutes).
          ...(seg.status === 'running' && seg.subagentLogs?.length ? { subagentLogs: seg.subagentLogs } : {}),
        },
        createdAt: toolStartTs,
      });
      if (seg.status !== 'running') {
        entries.push({
          id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
          seq: seq++, type: 'tool_end', content: seg.tool,
          metadata: {
            arguments: seg.args, result: seg.result, error: seg.error, durationMs: seg.durationMs,
            success: seg.status !== 'error',
            ...(seg.subagentLogs?.length ? { subagentLogs: seg.subagentLogs } : {}),
          },
          createdAt: currentSegTimestamp,
        });
      }
    } else {
      if (seg.thinking) {
        if (!insideThink) emitText();
        thinkBuf += seg.thinking;
        emitThinking();
      }
      // notify_context is agent-internal; never surface it in the execution timeline.
      processText(stripNotifyContext(seg.content).cleaned);
    }
  }

  if (insideThink) {
    emitThinking();
  }
  // Always flush remaining plain text — even after a legacy unclosed marker,
  // the tail must not be dropped (the marker branch never feeds thinkBuf).
  emitText();
  // 最后一道：把被过程行切成两半的句子接回去（顺序、过程行都保留，见 healSentenceSplits）。
  return healSentenceSplits(entries);
}

// ─── AgentMessageBody ─────────────────────────────────────────────────────────

export const AgentMessageBody = memo(function AgentMessageBody({
  msg, isStreaming, liveActivities,
  onMentionClick,
  knownNames,
}: {
  msg: ChatMsg;
  isStreaming: boolean;
  liveActivities: ActivityStep[];
  onMentionClick?: (name: string, event: ReactMouseEvent) => void;
  knownNames?: string[];
}) {
  const { t } = useTranslation(['team', 'common']);
  const segments = msg.segments;
  const isStopped = msg.isStopped;
  // 过程（思考/工具）默认折成一行，流式中和结束后**同一套结构** ——
  // 展开状态由每个过程块自己持有（见 ProcessRun）。
  // 这轮结束后，最终结果之前的一切还会再整体折进顶部一行
  // （见 collapsibleBlockCount），这里持的就是那一行的展开开关。
  const [showFullHistory, setShowFullHistory] = useState(false);

  // Include thinking length — thinking_delta updates seg.thinking without changing
  // content length, and a content-only key would freeze the timeline mid-stream.
  const segLen = (s: MsgSegment) => s.type === 'text'
    ? s.content.length + (s.thinking?.length ?? 0)
    : (s.result?.length ?? 0) + (s.subagentLogs?.length ?? 0) * 1000 + (s.liveOutput?.length ?? 0);
  const segKey = segments ? segments.length + ':' + (segments.length > 0 ? segLen(segments[segments.length - 1]!) : 0) : '';
  // Also hash any in-flight spawn_* log growth (not always the last segment).
  const subagentLogKey = segments
    ? segments.reduce((n, s) => n + (s.type === 'tool' ? (s.subagentLogs?.length ?? 0) : 0), 0)
    : 0;
  const streamEntries = useMemo(
    () => segments && segments.length > 0 ? segmentsToStreamEntries(segments, msg.agentId, msg.rawCreatedAt) : [],
    [segKey, subagentLogKey, msg.agentId, msg.rawCreatedAt], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const committed = msg.committedSegments;
  const commitKey = committed ? committed.length + ':' + (committed.length > 0 ? segLen(committed[committed.length - 1]!) : 0) : '';
  const commitSubagentKey = committed
    ? committed.reduce((n, s) => n + (s.type === 'tool' ? (s.subagentLogs?.length ?? 0) : 0), 0)
    : 0;
  // While streaming, live `segments` (incl. thinking_delta) are the source of truth.
  // Preferring committedSegments here hid in-flight thinking after the first tool/commit.
  const fullLogEntries = useMemo(
    () => {
      if (isStreaming) return streamEntries;
      if (committed && committed.length > 0) {
        return segmentsToStreamEntries(committed, msg.agentId, msg.rawCreatedAt);
      }
      return streamEntries;
    },
    [isStreaming, commitKey, commitSubagentKey, msg.agentId, msg.rawCreatedAt, streamEntries], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (segments !== undefined && segments.length > 0) {
    const textSegments = segments.filter(s => s.type === 'text');
    // Live segments are the source of truth while streaming too. Gating this on
    // `!isStreaming` left every tool-less reply with an EMPTY bubble mid-stream
    // (the answer only appeared once the turn ended), while tool-using replies
    // looked fine because they render through FullExecutionLog instead.
    const allText = textSegments.map(s => s.content).join('');
    const stripMarkup = (t: string) => t
      .replace(/\n*<!--\s*notify_context:\s*[\s\S]*?-->/g, '')
      .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
      .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
      .replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '')
      .trim() || null;
    const segmentText = allText ? stripMarkup(allText) : null;
    // 正文只来自正文分段；正文只存在于 msg.text 的历史消息走第二兜底。
    // 不再拿「思考内容」当正文兜底：过程行现在默认折叠但**始终在**，气泡不会空，
    // 再把 reasoning 当正文渲染一遍只会让同一段内容在气泡里出现两次。
    const displayText = segmentText || (msg.text ? stripMarkup(msg.text) : null);
    // 时间线切成「正文块 / 过程块」：过程块（思考 + 工具）默认折成一行，
    // 顺序完全不动（思考 → 正文 → 执行 → 思考），只是每段过程收起。
    const blocks = groupProcessRuns(fullLogEntries);
    const hasTextBlock = blocks.some(b => b.kind === 'text');
    // 这轮结束后，最终结果（最后一个正文块）之前的全部块整体折进顶部一行，
    // 气泡只剩「已工作 X 秒」+ 最终结论 —— 这就是「降低气泡高度」的来源。
    const hideCount = collapsibleBlockCount(blocks, isStreaming);
    const offset = hideCount > 0 && !showFullHistory ? hideCount : 0;
    const workedLabel = formatWorkedFor(entriesElapsedMs(fullLogEntries), t);

    // Collect approval cards once for the bubble footer. The timeline hides its
    // mid-row copies via hideApprovalCards so the same card is not shown twice.
    const inlineCards: Array<{ key: string } & ({ kind: 'task'; info: TaskApprovalInfo } | { kind: 'req'; info: RequirementApprovalInfo })> = [];
    for (const seg of segments) {
      if (seg.type !== 'tool') continue;
      const ta = parseTaskApprovalFromResult(seg.tool, seg.result);
      if (ta) { inlineCards.push({ key: `task-${ta.taskId}`, kind: 'task', info: ta }); continue; }
      const ra = parseRequirementApprovalFromResult(seg.tool, seg.result);
      if (ra) { inlineCards.push({ key: `req-${ra.requirementId}`, kind: 'req', info: ra }); }
    }

    return (
      <div className="space-y-2 min-h-[1em] min-w-0 overflow-x-hidden">
        {/* 按时间顺序渲染：正文块 = 正文本身；过程块 = 折叠起来的思考/工具。
            顺序完全不重排，所以「思考 → 正文 → 执行 → 思考」照样看得见。 */}
        {/* 顶部一行：这轮干了多久，点开回到完整时间线。默认收起 ——
            气泡只在「已工作 N 秒」与最终结论之间。 */}
        {hideCount > 0 && (
          <button
            type="button"
            onClick={() => setShowFullHistory(v => !v)}
            aria-expanded={showFullHistory}
            data-worked-summary="true"
            title={workedLabel}
            className="group relative w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-[11px] leading-tight text-fg-tertiary bg-surface-elevated/25 hover:bg-surface-elevated/45 border border-border-default/40 hover:border-border-default/70 overflow-hidden transition-colors cursor-pointer select-none"
          >
            <span className="relative shrink-0 flex items-center justify-center w-3 h-3">
              <ProcessRunIcon state="done" />
            </span>
            <span className="relative min-w-0 truncate">{workedLabel}</span>
            <svg
              className={`relative ml-auto w-3 h-3 shrink-0 transition-transform ${showFullHistory ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        )}

        {blocks.slice(offset).map((block, i) => {
          // isLastBlock 必须按**整条时间线**判：切片之后 index 0 并不是首块。
          const globalIndex = i + offset;
          return block.kind === 'text' ? (
            <MarkdownMessage
              key={block.key}
              content={block.entry.content}
              onMentionClick={onMentionClick}
              knownNames={knownNames}
            />
          ) : (
            <ProcessRun
              key={block.key}
              entries={block.entries}
              summary={block.summary}
              isStreaming={isStreaming}
              isLastBlock={globalIndex === blocks.length - 1}
              hideApprovalCards
            />
          );
        })}

        {/* 刚开流、还没有任何 segment —— 别留一个空气泡。 */}
        {blocks.length === 0 && isStreaming && (
          <ActivityIndicator activities={liveActivities} isActive />
        )}

        {/* 没有任何正文块时退回 msg.text（正文只存在 text 字段里的历史消息）。
            有正文块时绝不重复输出 —— 正文由上面的块负责。 */}
        {!hasTextBlock && displayText && (
          <MarkdownMessage content={displayText} onMentionClick={onMentionClick} knownNames={knownNames} />
        )}

        {inlineCards.map(c => c.kind === 'task'
          ? <TaskApprovalCard key={c.key} info={c.info} />
          : <RequirementApprovalCard key={c.key} info={c.info} />
        )}

        {!isStreaming && !displayText && blocks.length === 0 && inlineCards.length === 0 && !isStopped && (msg.emptyReply || !msg.isError) && (
          <div className="flex items-start gap-1.5 text-[13px] text-fg-tertiary leading-relaxed">
            <span>{t('page.emptyReply')}</span>
          </div>
        )}

        {/* Ensure rate-limit / model errors always surface as calm grey copy, even if
            the timeline only captured tool rows before the stream failed. */}
        {!isStreaming && (msg.isError || msg.text.startsWith('⚠')) && msg.text && !(
          segments?.some(s => s.type === 'text' && s.content && (s.content === msg.text || s.content.startsWith('⚠')))
        ) && (
          <p className="mt-1.5 text-[13px] text-fg-tertiary leading-relaxed whitespace-pre-wrap">
            {msg.text.replace(/^⚠\s*/, '')}
          </p>
        )}

        {isStopped && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            <span>{t('page.stopped')}</span>
          </div>
        )}
      </div>
    );
  }

  const hasActivities = (msg.activities?.length ?? 0) > 0;
  const legacyText = msg.text
    ? msg.text
        .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
        .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
        .replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '')
        .trim()
    : '';
  return (
    <>
      {(isStreaming || hasActivities) && (
        <ActivityIndicator
          activities={isStreaming ? liveActivities : (msg.activities ?? [])}
          isActive={isStreaming}
          persistent={!isStreaming && hasActivities}
        />
      )}
      {legacyText
        ? (msg.isError || legacyText.startsWith('⚠')
          ? <p className="text-[13px] text-fg-tertiary leading-relaxed whitespace-pre-wrap">{legacyText.replace(/^⚠\s*/, '')}</p>
          : <MarkdownMessage content={legacyText} onMentionClick={onMentionClick} knownNames={knownNames} />)
        : null}
      {!isStreaming && !legacyText && !hasActivities && !isStopped && msg.sender === 'agent' && (msg.emptyReply || !msg.isError) && (
        <div className="flex items-start gap-1.5 text-[13px] text-fg-tertiary leading-relaxed">
          <span>{t('page.emptyReply')}</span>
        </div>
      )}
      {isStopped && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          <span>{t('page.stopped')}</span>
        </div>
      )}
    </>
  );
});
