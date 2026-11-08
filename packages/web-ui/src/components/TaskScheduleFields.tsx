import { useTranslation } from 'react-i18next';
import {
  type ScheduleDraft,
  type CalendarRepeat,
  INTERVAL_OPTIONS,
  intervalLabelKey,
  normalizeTime,
} from '../lib/taskSchedule.ts';

const WEEKDAY_CHIP_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A tiny segmented control. Used for the two top-level choices (trigger mode,
 * standard vs scheduled) so the selection reads as a mode rather than a form
 * field — a plain <select> hides the alternative and adds a click.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  return (
    <div className="inline-flex rounded-lg border border-border-default overflow-hidden">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`${pad} transition-colors ${
            value === opt.value
              ? 'bg-brand-600 text-on-brand'
              : 'bg-surface-elevated text-fg-secondary hover:text-fg-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Shared, human-friendly scheduler editor.
 *
 * Used by BOTH the create-task dialog and the task-detail schedule editor so
 * there is exactly one implementation. Plain-language fields (每天 / 工作日 /
 * 每周 + a time picker) build a cron expression under the hood; a raw-cron
 * escape hatch stays available for power users. A live preview line tells the
 * user, in words, what they just configured.
 */
export function TaskScheduleFields({
  value,
  onChange,
  compact = false,
}: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });

  const selectCls = `px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg outline-none focus:border-brand-500 ${
    compact ? 'text-xs' : 'text-sm'
  }`;

  const toggleWeekday = (day: number) => {
    const has = value.weekdays.includes(day);
    const next = has ? value.weekdays.filter(d => d !== day) : [...value.weekdays, day];
    set({ weekdays: next });
  };

  // Human-readable preview of the current configuration.
  let preview: string;
  if (value.mode === 'interval') {
    preview = t(`work:task.${intervalLabelKey(value.every)}`);
  } else if (value.calendar === 'cron') {
    preview = t('work:task.scheduleCron', { expr: value.cron.trim() || '—' });
  } else {
    const time = normalizeTime(value.time);
    if (value.calendar === 'daily') {
      preview = t('work:task.scheduleDailyAt', { time });
    } else if (value.calendar === 'weekdays') {
      preview = t('work:task.scheduleWeekdaysAt', { time });
    } else {
      const days = [...value.weekdays]
        .sort((a, b) => a - b)
        .map(d => t(`work:task.weekdayShort.${d}`))
        .join(' ');
      preview = value.weekdays.length
        ? t('work:task.scheduleWeeklyAt', { days, time })
        : t('work:task.scheduleNoDays');
    }
  }

  const showTimePicker =
    value.calendar === 'daily' || value.calendar === 'weekdays' || value.calendar === 'weekly';

  // Label + control on one line to keep the panel compact (label column is fixed so
  // the controls line up across rows).
  const rowLabelCls = 'text-fg-tertiary shrink-0 text-xs w-20';

  return (
    <div className="rounded-lg border border-border-default/70 bg-surface-elevated/40 p-3 space-y-2.5">
      {/* Trigger mode */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={rowLabelCls}>{t('work:task.scheduleRepeatMode')}</span>
        <Segmented
          size={compact ? 'sm' : 'md'}
          value={value.mode}
          onChange={m => set({ mode: m })}
          options={[
            { value: 'interval', label: t('work:task.scheduleByInterval') },
            { value: 'calendar', label: t('work:task.scheduleByCalendar') },
          ]}
        />
      </div>

      {value.mode === 'interval' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className={rowLabelCls}>{t('work:task.scheduleEveryLabel')}</span>
          <select value={value.every} onChange={e => set({ every: e.target.value })} className={selectCls}>
            {INTERVAL_OPTIONS.map(v => (
              <option key={v} value={v}>
                {t(`work:task.${intervalLabelKey(v)}`)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={rowLabelCls}>{t('work:task.scheduleRepeatLabel')}</span>
            <select
              value={value.calendar}
              onChange={e => set({ calendar: e.target.value as CalendarRepeat })}
              className={selectCls}
            >
              <option value="daily">{t('work:task.scheduleCalendarDaily')}</option>
              <option value="weekdays">{t('work:task.scheduleCalendarWeekdays')}</option>
              <option value="weekly">{t('work:task.scheduleCalendarWeekly')}</option>
              <option value="cron">{t('work:task.scheduleCalendarCron')}</option>
            </select>
            {showTimePicker && (
              <input
                type="time"
                value={value.time}
                onChange={e => set({ time: e.target.value })}
                className={selectCls}
              />
            )}
          </div>

          {value.calendar === 'weekly' && (
            <div className="flex flex-wrap gap-1 pl-[5.5rem]">
              {WEEKDAY_CHIP_ORDER.map(day => {
                const active = value.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    className={`w-7 h-7 rounded-full text-xs transition-colors ${
                      active
                        ? 'bg-brand-600 text-on-brand'
                        : 'bg-surface-elevated text-fg-secondary border border-border-default hover:text-fg-primary'
                    }`}
                  >
                    {t(`work:task.weekdayShort.${day}`)}
                  </button>
                );
              })}
            </div>
          )}

          {value.calendar === 'cron' && (
            <input
              value={value.cron}
              onChange={e => set({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              className={`${selectCls} w-full font-mono`}
            />
          )}
        </div>
      )}

      {/* Optional max runs */}
      <div className="flex items-center gap-2">
        <span className={rowLabelCls}>{t('work:task.scheduleMaxRuns')}</span>
        <input
          value={value.maxRuns}
          onChange={e => set({ maxRuns: e.target.value.replace(/\D/g, '') })}
          placeholder={t('work:task.scheduleMaxRunsPlaceholder')}
          className={`${selectCls} w-20`}
        />
      </div>

      {/* Live preview */}
      <div className="text-[11px] text-fg-secondary pt-1 border-t border-border-default/50">
        {t('work:task.schedulePreview', { desc: preview })}
        <span className="text-fg-tertiary"> · {t('work:task.scheduleTimezoneNote', { tz: value.timezone })}</span>
      </div>
    </div>
  );
}
