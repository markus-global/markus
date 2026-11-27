/**
 * NotificationSoundSettings — 设置 → 通用 里的「提示音」配置块。
 *
 * 这个组件**不做判定**：事件清单来自 `lib/notificationSounds.ts` 的目录，
 * 开关状态来自同一模块的偏好读写，试听走同一个播放器。
 * 它只负责把那张表画出来 —— 加一个提示音不需要改这里。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from './Switch.tsx';
import { CARD, Section, SettingRow, TYPE, FG, BTN_SECONDARY } from '../lib/settings-primitives.tsx';
import {
  NOTIFICATION_SOUND_EVENTS,
  SOUND_VOLUMES,
  cueForEvent,
  previewSoundCue,
  readSoundPreferences,
  subscribeSoundPreferences,
  writeSoundPreferences,
  type NotificationSoundEvent,
  type NotificationSoundPreferences,
  type SoundVolume,
} from '../lib/notificationSounds.ts';

export function NotificationSoundSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [prefs, setPrefs] = useState<NotificationSoundPreferences>(readSoundPreferences);

  // 同设备其它标签页改了开关 → 这里跟着变（单一写者：写入只经 writeSoundPreferences）。
  useEffect(() => subscribeSoundPreferences(setPrefs), []);

  const setEnabled = (enabled: boolean) => setPrefs(writeSoundPreferences({ enabled }));

  // 切档位时立刻用新音量试听一次：音量是听觉判断，不给耳朵听就只能靠猜。
  const setVolume = (volume: SoundVolume) => {
    setPrefs(writeSoundPreferences({ volume }));
    previewSoundCue(cueForEvent('agent-reply-complete'), volume);
  };

  const setEventEnabled = (id: NotificationSoundEvent, on: boolean) => {
    const disabled = new Set(prefs.disabledEvents);
    if (on) disabled.delete(id);
    else disabled.add(id);
    setPrefs(writeSoundPreferences({ disabledEvents: [...disabled] }));
  };

  return (
    <Section title={t('sounds.title')} description={t('sounds.description')}>
      <div className={`${CARD} divide-y divide-border-default/40`}>
        <SettingRow label={t('sounds.enabled')} hint={t('sounds.enabledDesc')}>
          <Switch
            checked={prefs.enabled}
            onChange={setEnabled}
            label={t('sounds.enabled')}
            testId="sound-master-switch"
          />
        </SettingRow>
        <SettingRow label={t('sounds.volume')} hint={t('sounds.volumeDesc')}>
          <div className="flex flex-wrap gap-1 bg-surface-secondary/60 rounded-lg p-0.5">
            {SOUND_VOLUMES.map((volume) => (
              <button
                key={volume}
                type="button"
                disabled={!prefs.enabled}
                onClick={() => setVolume(volume)}
                data-testid={`sound-volume-${volume}`}
                className={`px-3 py-1.5 text-[11px] rounded-md transition-colors disabled:opacity-40 ${
                  prefs.volume === volume
                    ? 'bg-brand-600 text-on-brand shadow-sm'
                    : 'text-fg-secondary hover:text-fg-primary'
                }`}
              >
                {t(`sounds.volumes.${volume}`)}
              </button>
            ))}
          </div>
        </SettingRow>
        {NOTIFICATION_SOUND_EVENTS.map((def) => {
          const eventOn = prefs.enabled && !prefs.disabledEvents.includes(def.id);
          return (
            <SettingRow
              key={def.id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{t(def.labelKey)}</span>
                  <span className={`${TYPE.badge} ${FG.desc} rounded px-1.5 py-0.5 bg-surface-secondary`}>
                    {t(`sounds.cues.${cueForEvent(def.id)}`)}
                  </span>
                </span>
              }
              hint={t(def.descKey)}
            >
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={!prefs.enabled}
                onClick={() => previewSoundCue(cueForEvent(def.id))}
                data-testid={`sound-preview-${def.id}`}
              >
                {t('sounds.preview')}
              </button>
              <Switch
                checked={eventOn}
                onChange={(on) => setEventEnabled(def.id, on)}
                label={t(def.labelKey)}
                disabled={!prefs.enabled}
                testId={`sound-event-switch-${def.id}`}
              />
            </SettingRow>
          );
        })}
      </div>
      <p className={`px-1 ${TYPE.hint} ${FG.desc}`}>{t('sounds.deviceNote')}</p>
    </Section>
  );
}
