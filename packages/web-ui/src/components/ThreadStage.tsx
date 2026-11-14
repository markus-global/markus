/**
 * C9-C · 详情页的两块可见物：**阶段徽章**与**证据折叠区**。
 *
 * 产品口径（方案 §11.1）：人**不感知事实本身**，只感知由事实派生的三件事 ——
 * 需要我做什么（Inbox）、这件事到哪一步（阶段徽章）、凭什么说做完了（证据）。
 * 所以这里没有「事实列表页」，只有：
 *
 *  · `ThreadStageBadge`：只读服务端派生好的闭集值，**不重算**。重算就是第二个写者，
 *    也就是过去同一张卡在两个页面显示不同状态的成因。
 *  · `EvidenceFold`：默认折叠。展开后每条结论只显示 `summary` + 谁断言的 + 验证结果
 *    + 可点的原始指针。**不渲染事实的原始 JSON** —— 把人当机器用，是把内部实现漏给用户。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TONE } from '../lib/tone.ts';
import {
  THREAD_STAGE_TONE,
  asThreadStage,
  evidenceSummary,
  sourceRefKind,
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

export interface EvidenceFoldProps {
  evidence: ThreadEvidence[];
  /** 点开原始指针：交付物跳转、评论在本页展开。由页面决定落地方式。 */
  onOpenSource?: (ref: string) => void;
}

/**
 * 「凭什么说做完了」——默认折叠。
 *
 * 空集合也有稳定形态（「还没有证据事实」），因为「没有证据」本身就是需要人看见的信息：
 * 一个不渲染的空区域会让「缺证据」和「不需要证据」看起来一样。
 */
export function EvidenceFold({ evidence, onOpenSource }: EvidenceFoldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = evidence.length;

  return (
    <div className="mt-3 rounded-lg border border-border-default/60 bg-surface-primary/40">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-evidence-toggle
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-fg-secondary hover:text-fg-primary transition-colors"
      >
        <span className="font-medium">{t('common:threadStage.evidence.title', { count })}</span>
        <span className="text-fg-tertiary">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2" data-evidence-body>
          {count === 0 ? (
            <p className="text-xs text-fg-tertiary">{t('common:threadStage.evidence.empty')}</p>
          ) : (
            evidence.map(item => (
              <div key={item.factId} className="text-xs text-fg-secondary border-t border-border-default/40 pt-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-fg-primary">{evidenceSummary(item.value) ?? t('common:threadStage.evidence.noSummary')}</span>
                  <span className="text-[10px] text-fg-tertiary whitespace-nowrap">
                    {item.verification
                      ? t(`common:threadStage.evidence.verification.${item.verification.result}`)
                      : t('common:threadStage.evidence.unverified')}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-fg-tertiary">
                    {t('common:threadStage.evidence.assertedBy', { who: item.assertedBy })}
                  </span>
                  {item.sourceRefs.map(ref => {
                    const kind = sourceRefKind(ref);
                    const label = t(`common:threadStage.evidence.refKind.${kind}`);
                    return (
                      <button
                        key={ref}
                        type="button"
                        data-source-ref={ref}
                        onClick={() => onOpenSource?.(ref)}
                        title={ref}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-fg-secondary hover:text-fg-primary"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
