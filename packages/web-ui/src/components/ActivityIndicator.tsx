import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolMeta } from './execution-utils.ts';
import { NamedIcon } from '../lib/namedIcons.tsx';

export interface ActivityStep {
  tool: string;
  phase: 'start' | 'end' | 'output';
  success?: boolean;
  ts: number;
  arguments?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
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

function TimelineItem({ item }: { item: ToolItem; idx: number; total: number }) {
  const { t } = useTranslation('common');
  const meta = getToolMeta(item.tool);
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      {/* The tool's own icon carries success/failure via color — no separate status badge. */}
      <NamedIcon
        name={meta.iconName}
        size={15}
        className={`shrink-0 ${
          item.status === 'running' ? 'text-brand-500'
          : item.status === 'error' ? 'text-red-500'
          : 'text-green-500'
        }`}
      />
      <span className={`text-xs ${
        item.status === 'running' ? 'text-brand-500'
        : item.status === 'error' ? 'text-red-500'
        : 'text-fg-secondary'
      }`}>{t(`execution.tools.${meta.key}`, { defaultValue: meta.label })}{item.status === 'running' ? '…' : ''}</span>
      {item.status === 'running' && <Spinner />}
    </div>
  );
}

export function ActivityIndicator({ activities, isActive, persistent }: Props) {
  const { t } = useTranslation('common');
  const timeline = buildTimeline(activities);
  const [expanded, setExpanded] = useState(false);

  const hasAny = timeline.length > 0;
  const allDone = hasAny && timeline.every(t => t.status !== 'running');

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
            <span className="ml-1 flex items-center gap-1">
              {timeline.slice(0, 5).map(it => {
                const m = getToolMeta(it.tool);
                return (
                  <NamedIcon
                    key={it.key}
                    name={m.iconName}
                    size={13}
                    className={`shrink-0 ${it.status === 'error' ? 'text-red-500' : 'text-green-500'}`}
                  />
                );
              })}
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

  // ── Live / active: collapsed-by-default compact summary (mirrors Team Chat) ──
  // Nothing has happened yet → a lightweight thinking indicator.
  if (!hasAny) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-fg-secondary py-0.5">
        <span className="mr-0.5">{t('activity.thinking')}</span>
        <PulsingDots />
      </div>
    );
  }

  const errorCount = timeline.filter(it => it.status === 'error').length;

  // Determine the single-line headline: the tool currently running, otherwise
  // (all tools done while still active) the model is writing its response.
  let running: ToolItem | null = null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i]!.status === 'running') { running = timeline[i]!; break; }
  }
  const lastItem = timeline[timeline.length - 1]!;
  let headLabel: string;
  if (running) {
    const m = getToolMeta(running.tool);
    headLabel = `${t(`execution.tools.${m.key}`, { defaultValue: m.label })}…`;
  } else if (isActive && allDone) {
    headLabel = t('activity.writingResponse');
  } else {
    const m = getToolMeta(lastItem.tool);
    headLabel = t(`execution.tools.${m.key}`, { defaultValue: m.label });
  }
  const spinning = !!running || (isActive && allDone);

  return (
    <div className="mb-1">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        className="flex items-center gap-1.5 text-xs w-full min-w-0 select-none text-fg-tertiary hover:text-fg-secondary transition-colors"
      >
        <span className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className={`truncate font-medium ${spinning ? 'text-brand-500' : 'text-fg-secondary'}`}>{headLabel}</span>
        <span className="shrink-0">· {t('activity.step', { count: timeline.length })}</span>
        {errorCount > 0 && <span className="text-red-500 shrink-0">· {t('activity.failed', { count: errorCount })}</span>}
        {spinning && <Spinner />}
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {timeline.map((item, idx) => (
            <TimelineItem key={item.key} item={item} idx={idx} total={timeline.length} />
          ))}
        </div>
      )}
    </div>
  );
}
