import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolMeta } from './execution-utils.ts';

export interface ActivityStep {
  tool: string;
  phase: 'start' | 'end' | 'output';
  success?: boolean;
  ts: number;
}

interface Props {
  activities: ActivityStep[];
  isActive: boolean;
  /** When true, never fade out — used for frozen historical activity timelines */
  persistent?: boolean;
}

interface ToolItem {
  key: string;
  tool: string;
  status: 'running' | 'done' | 'error';
}

function buildTimeline(activities: ActivityStep[]): ToolItem[] {
  const items: ToolItem[] = [];

  for (const step of activities) {
    if (step.phase === 'output') continue;
    if (step.phase === 'start') {
      const key = `${step.tool}_${step.ts}`;
      items.push({ key, tool: step.tool, status: 'running' });
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]!.tool === step.tool && items[i]!.status === 'running') {
          items[i] = { ...items[i]!, status: step.success === false ? 'error' : 'done' };
          break;
        }
      }
    }
  }
  return items;
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin text-brand-500 shrink-0" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function PulsingDots() {
  return (
    <span className="flex items-center gap-0.5">
      {[0, 150, 300].map(d => (
        <span key={d} className="w-1 h-1 rounded-full bg-brand-400 animate-bounce"
          style={{ animationDelay: `${d}ms`, animationDuration: '1s' }} />
      ))}
    </span>
  );
}

function TimelineItem({ item, idx, total }: { item: ToolItem; idx: number; total: number }) {
  const meta = getToolMeta(item.tool);
  return (
    <div className="flex items-center gap-2 py-0.5">
      {/* Vertical connector */}
      <div className="flex flex-col items-center self-stretch w-3 shrink-0">
        {idx > 0 && <div className="w-px h-2 bg-surface-overlay" />}
        <div className={`w-2.5 h-2.5 rounded-full border flex items-center justify-center text-[8px] shrink-0 ${
          item.status === 'running'
            ? 'border-brand-500 bg-brand-500/15'
            : item.status === 'error'
            ? 'border-red-500 bg-red-500/15 text-red-500'
            : 'border-gray-600 bg-surface-elevated text-fg-tertiary'
        }`}>
          {item.status === 'done' ? '✓' : item.status === 'error' ? '✗' : ''}
        </div>
        {idx < total - 1 && <div className="w-px flex-1 bg-surface-overlay mt-0.5" />}
      </div>

      {/* Label */}
      <div className={`flex items-center gap-1.5 text-xs ${
        item.status === 'running'
          ? 'text-brand-500'
          : item.status === 'error'
          ? 'text-red-500 opacity-60'
          : 'text-fg-tertiary'
      }`}>
        <span className="opacity-70">{meta.icon}</span>
        <span>{meta.label}{item.status === 'running' ? '…' : ''}</span>
        {item.status === 'running' && <Spinner />}
      </div>
    </div>
  );
}

export function ActivityIndicator({ activities, isActive, persistent }: Props) {
  const { t } = useTranslation('common');
  const timeline = buildTimeline(activities);
  const [expanded, setExpanded] = useState(false);

  const shouldShow = persistent || isActive || activities.length > 0;

  const hasAny = timeline.length > 0;
  const allDone = hasAny && timeline.every(t => t.status !== 'running');
  const showThinking = isActive && !hasAny;
  const showWriting = isActive && hasAny && allDone;

  if (persistent && allDone) {
    const errorCount = timeline.filter(t => t.status === 'error').length;
    const doneCount = timeline.filter(t => t.status === 'done').length;
    return (
      <div className="mb-3 border-b border-border-default/50 pb-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors select-none"
        >
          <span className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium">{t('activity.step', { count: doneCount })}</span>
          {errorCount > 0 && (
            <span className="text-red-500 ml-0.5">· {t('activity.failed', { count: errorCount })}</span>
          )}
          {!expanded && (
            <span className="ml-1 flex gap-0.5">
              {timeline.slice(0, 5).map(t => (
                <span key={t.key} className="text-[10px] opacity-60" title={getToolMeta(t.tool).label}>
                  {getToolMeta(t.tool).icon}
                </span>
              ))}
              {timeline.length > 5 && <span className="text-[10px] text-fg-tertiary">+{timeline.length - 5}</span>}
            </span>
          )}
        </button>
        {expanded && (
          <div className="mt-2 space-y-0.5">
            {timeline.map((item, idx) => (
              <TimelineItem key={item.key} item={item} idx={idx} total={timeline.length} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="mb-2 space-y-0.5 transition-all duration-300 overflow-hidden"
      style={{
        maxHeight: shouldShow ? '500px' : '0px',
        opacity: shouldShow ? 1 : 0,
        marginBottom: shouldShow ? undefined : '0px',
      }}
    >
      {timeline.map((item, idx) => (
        <TimelineItem key={item.key} item={item} idx={idx} total={timeline.length} />
      ))}

      <div
        className="transition-all duration-200 overflow-hidden"
        style={{ maxHeight: showThinking ? '40px' : '0px', opacity: showThinking ? 1 : 0 }}
      >
        <div className="flex items-center gap-1.5 text-xs text-fg-secondary py-0.5">
          <span className="mr-0.5">{t('activity.thinking')}</span>
          <PulsingDots />
        </div>
      </div>

      <div
        className="transition-all duration-200 overflow-hidden"
        style={{ maxHeight: showWriting ? '40px' : '0px', opacity: showWriting ? 1 : 0 }}
      >
        <div className="flex items-center gap-1.5 py-0.5">
          <div className="flex flex-col items-center self-stretch w-3 shrink-0">
            <div className="w-px h-2 bg-surface-overlay" />
            <div className="w-2.5 h-2.5 rounded-full border border-brand-500 bg-brand-500/15 shrink-0" />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-brand-500">
            <Spinner />
            <span>{t('activity.writingResponse')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
