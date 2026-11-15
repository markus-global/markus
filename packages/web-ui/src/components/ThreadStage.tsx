/**
 * C9-C · 详情页的两块可见物：**阶段徽章**与**证据区**。
 *
 * 产品口径（方案 §11.1）：人**不感知事实本身**，只感知由事实派生的三件事 ——
 * 需要我做什么（Inbox）、这件事到哪一步（阶段徽章）、凭什么说做完了（依据）。
 *
 * 2026-11-15 返工（Owner：「点了之后没有内容，体验很差」——真机复现后确认不是空，
 * 是**读不了**）。当时的实际渲染：
 *   「凭什么说做完了（2）」→ 展开后是一段 500 多字的无排版长文，
 *   后面跟着 5 个一模一样的「原始记录」按钮和裸 agent id `agt_d7f911…`。
 * 五个具体病灶与对应修法：
 *   ① 按钮写反问句 → 改陈述式「完成依据（N 条）」+ 一句它到底是什么的解释；
 *   ② 长文原样倾倒 → `whitespace-pre-wrap` 保段落 + 默认 4 行 + 展开全文；
 *   ③ 指针只显示类型 → 类型 + 值片段（「提交 48f3c75d」「实测记录」），源自
 *      `sourceRefPointer`；同类多个也能分辨；
 *   ④ 断言者显示裸 id → 由页面注入 `nameOf` 解析成名字，缺失时才退回 id；
 *   ⑤ 无摘要显示「（无摘要）」→ 改显示谓词人话（「交付证据」），信息量归零的占位符不出现。
 *
 * 空集合仍然渲染：**「没有证据」本身就是需要人看见的信息**（一个不渲染的空区域会让
 * 「缺证据」和「不需要证据」看起来一样），但空态要给出去向，不能只是沉默。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TONE } from '../lib/tone.ts';
import {
  THREAD_STAGE_TONE,
  asThreadStage,
  evidenceSummary,
  sourceRefPointer,
  threadStageLabel,
  type ThreadEvidence,
} from '../lib/threadStage.ts';

/** 阶段徽章。`stage` 来自服务端；非法值不渲染（宁可不显示，也不编造）。 */
export function ThreadStageBadge({ stage }: { stage?: string | null }) {
  const { t } = useTranslation();
  const resolved = asThreadStage(stage ?? undefined);
  if (!resolved) return null;
  const label = threadStageLabel(resolved, t);
  if (!label) return null;
  const tone = TONE[THREAD_STAGE_TONE[resolved]];
  return (
    <span
      data-thread-stage={resolved}
      className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap align-middle ${tone.chip}`}
    >
      {label}
    </span>
  );
}

/** 已知结论类型的人话标签；未收录的按原样显示（不隐藏、不猜）。 */
const KNOWN_PREDICATES = new Set([
  'task.completion_evidence',
  'task.rejection_reason',
  'requirement.acceptance_met',
  'work.defect_class',
  'agent.capability_claim',
  'memory.consolidation_suggestion',
]);

/** 超过这个字符数才折叠，避免短摘要也被「展开全文」打断阅读。 */
const CLAMP_THRESHOLD = 160;

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface EvidenceFoldProps {
  evidence: ThreadEvidence[];
  /** 把 agent id 解析成人名；缺失时退回 id（宁可显示 id 也不显示「某人」）。 */
  nameOf?: (agentId: string) => string | undefined;
  /** 点开原始指针：交付物跳转、评论在本页展开。由页面决定落地方式。 */
  onOpenSource?: (ref: string) => void;
}

function EvidenceItem({
  item,
  nameOf,
  onOpenSource,
}: {
  item: ThreadEvidence;
  nameOf?: (agentId: string) => string | undefined;
  onOpenSource?: (ref: string) => void;
}) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const summary = evidenceSummary(item.value);
  const long = (summary?.length ?? 0) > CLAMP_THRESHOLD;
  const predicateLabel = KNOWN_PREDICATES.has(item.predicate)
    ? t(`common:threadStage.evidence.predicate.${item.predicate.replace(/\./g, '_')}`, { defaultValue: item.predicate })
    : item.predicate;

  return (
    <div className="border-t border-border-default/40 pt-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium text-fg-secondary">{predicateLabel}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
            item.verification
              ? item.verification.result === 'pass'
                ? 'bg-status-ok/10 text-status-ok'
                : 'bg-status-danger/10 text-status-danger'
              : 'bg-surface-secondary text-fg-tertiary'
          }`}
        >
          {item.verification
            ? t(`common:threadStage.evidence.verification.${item.verification.result}`)
            : t('common:threadStage.evidence.unverified')}
        </span>
      </div>

      {summary ? (
        <>
          <p
            className={`mt-1 whitespace-pre-wrap text-xs leading-relaxed text-fg-primary ${
              long && !full ? 'line-clamp-4' : ''
            }`}
          >
            {summary}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setFull(v => !v)}
              className="mt-1 text-[10.5px] text-brand-500 transition-colors hover:underline"
            >
              {full ? t('common:threadStage.evidence.collapse') : t('common:threadStage.evidence.expand')}
            </button>
          )}
        </>
      ) : (
        // 没有 summary 时不放「（无摘要）」这种零信息占位符：谓词本身已是这条结论的内容。
        <p className="mt-1 text-xs text-fg-tertiary">{t('common:threadStage.evidence.predicateOnly')}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-fg-tertiary">
        <span>
          {t('common:threadStage.evidence.assertedBy', {
            who: nameOf?.(item.assertedBy) ?? item.assertedBy,
          })}
        </span>
        <span aria-hidden>·</span>
        <span title={item.createdAt}>{shortTime(item.createdAt)}</span>
        {item.verification?.verifiedBy && (
          <>
            <span aria-hidden>·</span>
            <span>
              {t('common:threadStage.evidence.verifiedBy', {
                who: nameOf?.(item.verification.verifiedBy) ?? item.verification.verifiedBy,
              })}
            </span>
          </>
        )}
        {item.sourceRefs.map(ref => {
          const ptr = sourceRefPointer(ref);
          const kindLabel = t(`common:threadStage.evidence.refKind.${ptr.kind}`);
          return (
            <button
              key={ref}
              type="button"
              data-source-ref={ref}
              onClick={() => onOpenSource?.(ref)}
              title={ref}
              className="rounded bg-surface-secondary px-1.5 py-0.5 text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {ptr.short ? `${kindLabel} ${ptr.short}` : kindLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 「完成依据」——默认折叠。 */
export function EvidenceFold({ evidence, nameOf, onOpenSource }: EvidenceFoldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = evidence.length;

  return (
    <div className="mt-3 rounded-lg border border-border-default/60 bg-surface-primary/40" data-evidence-fold>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-evidence-toggle
        className="w-full px-3 py-2 text-left transition-colors hover:bg-surface-secondary/40"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-fg-primary">
            {t('common:threadStage.evidence.title', { count })}
          </span>
          <span className="text-[10px] text-fg-tertiary">{open ? '▾' : '▸'}</span>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-fg-tertiary">
          {t('common:threadStage.evidence.subtitle')}
        </p>
      </button>

      {open && (
        <div className="space-y-2.5 px-3 pb-3" data-evidence-body>
          {count === 0 ? (
            <div className="rounded-md border border-dashed border-border-default px-3 py-2">
              <p className="text-xs text-fg-secondary">{t('common:threadStage.evidence.empty')}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-fg-tertiary">
                {t('common:threadStage.evidence.emptyHint')}
              </p>
            </div>
          ) : (
            evidence.map(item => (
              <EvidenceItem key={item.factId} item={item} nameOf={nameOf} onOpenSource={onOpenSource} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
