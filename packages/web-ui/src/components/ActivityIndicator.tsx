import { useEffect, useRef, useState } from 'react';

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

const TOOL_META: Record<string, { label: string; icon: string }> = {
  shell_execute:        { label: 'Running command',        icon: '⌨' },
  file_read:            { label: 'Reading file',           icon: '📄' },
  file_write:           { label: 'Writing file',           icon: '✏' },
  file_edit:            { label: 'Editing file',           icon: '✏' },
  file_list:            { label: 'Listing files',          icon: '📂' },
  web_fetch:            { label: 'Fetching webpage',       icon: '🌐' },
  web_search:           { label: 'Searching web',          icon: '🔍' },
  web_extract:          { label: 'Extracting content',     icon: '📑' },
  create_subtask:       { label: 'Adding subtask',         icon: '📌' },
  update_task:          { label: 'Updating task',          icon: '✅' },
  add_task_note:        { label: 'Adding note',            icon: '📝' },
  git_status:           { label: 'Git status',             icon: '🔀' },
  git_diff:             { label: 'Git diff',               icon: '🔀' },
  git_log:              { label: 'Git log',                icon: '📜' },
  git_branch:           { label: 'Git branch',             icon: '🌿' },
  git_add:              { label: 'Git add',                icon: '➕' },
  git_commit:           { label: 'Git commit',             icon: '💾' },
  code_search:          { label: 'Searching code',         icon: '🔍' },
  browser_navigate:     { label: 'Opening page',           icon: '🌐' },
  browser_click:        { label: 'Clicking element',       icon: '👆' },
  browser_type:         { label: 'Typing text',            icon: '⌨' },
  browser_screenshot:   { label: 'Screenshot',             icon: '📸' },
  browser_extract:      { label: 'Extracting content',     icon: '📋' },
  agent_send_message:   { label: 'Messaging colleague',    icon: '💬' },
  agent_list:           { label: 'Checking team',          icon: '👥' },
  create_task:          { label: 'Creating task',          icon: '📌' },
  feishu_send_message:  { label: 'Sending Feishu msg',     icon: '✉' },
  feishu_search_docs:   { label: 'Searching Feishu',       icon: '🔍' },
};

function getToolMeta(tool: string) {
  return TOOL_META[tool] ?? { label: tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), icon: '⚙' };
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
    <svg className="w-3 h-3 animate-spin text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function PulsingDots() {
  return (
    <span className="flex items-center gap-0.5">
      {[0, 150, 300].map(d => (
        <span key={d} className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce"
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
        {idx > 0 && <div className="w-px h-2 bg-gray-700" />}
        <div className={`w-2.5 h-2.5 rounded-full border flex items-center justify-center text-[8px] shrink-0 ${
          item.status === 'running'
            ? 'border-indigo-500 bg-indigo-950'
            : item.status === 'error'
            ? 'border-red-600 bg-red-950 text-red-400'
            : 'border-gray-600 bg-gray-800 text-gray-500'
        }`}>
          {item.status === 'done' ? '✓' : item.status === 'error' ? '✗' : ''}
        </div>
        {idx < total - 1 && <div className="w-px flex-1 bg-gray-700 mt-0.5" />}
      </div>

      {/* Label */}
      <div className={`flex items-center gap-1.5 text-xs ${
        item.status === 'running'
          ? 'text-indigo-300'
          : item.status === 'error'
          ? 'text-red-400 opacity-60'
          : 'text-gray-500'
      }`}>
        <span className="opacity-70">{meta.icon}</span>
        <span>{meta.label}{item.status === 'running' ? '…' : ''}</span>
        {item.status === 'running' && <Spinner />}
      </div>
    </div>
  );
}

export function ActivityIndicator({ activities, isActive, persistent }: Props) {
  const timeline = buildTimeline(activities);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (persistent || isActive || activities.length > 0) {
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
    } else {
      timerRef.current = setTimeout(() => setVisible(false), 800);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [persistent, isActive, activities.length]);

  if (!visible) return null;

  const hasAny = timeline.length > 0;
  const allDone = hasAny && timeline.every(t => t.status !== 'running');
  const showThinking = isActive && !hasAny;
  const showWriting = isActive && hasAny && allDone;

  // Persistent (historical) mode: show a compact collapsed summary with expand toggle
  if (persistent && allDone) {
    const errorCount = timeline.filter(t => t.status === 'error').length;
    const doneCount = timeline.filter(t => t.status === 'done').length;
    return (
      <div className="mb-3 border-b border-gray-700/50 pb-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-400 transition-colors select-none"
        >
          <span className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium">{doneCount} step{doneCount !== 1 ? 's' : ''}</span>
          {errorCount > 0 && (
            <span className="text-red-400 ml-0.5">· {errorCount} failed</span>
          )}
          {/* Mini pill icons */}
          {!expanded && (
            <span className="ml-1 flex gap-0.5">
              {timeline.slice(0, 5).map(t => (
                <span key={t.key} className="text-[10px] opacity-60" title={getToolMeta(t.tool).label}>
                  {getToolMeta(t.tool).icon}
                </span>
              ))}
              {timeline.length > 5 && <span className="text-[10px] text-gray-600">+{timeline.length - 5}</span>}
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

  // Active / live mode: show full timeline
  return (
    <div className="mb-2 space-y-0.5">
      {timeline.map((item, idx) => (
        <TimelineItem key={item.key} item={item} idx={idx} total={timeline.length} />
      ))}

      {/* Thinking / Writing status */}
      {showThinking && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5">
          <span className="mr-0.5">Thinking</span>
          <PulsingDots />
        </div>
      )}
      {showWriting && (
        <div className="flex items-center gap-1.5 py-0.5">
          <div className="flex flex-col items-center self-stretch w-3 shrink-0">
            <div className="w-px h-2 bg-gray-700" />
            <div className="w-2.5 h-2.5 rounded-full border border-indigo-500 bg-indigo-950 shrink-0" />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-indigo-300">
            <Spinner />
            <span>Writing response…</span>
          </div>
        </div>
      )}
    </div>
  );
}
