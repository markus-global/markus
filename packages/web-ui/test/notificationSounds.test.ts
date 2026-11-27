/**
 * notificationSounds 护栏 —— 提示音的「事件→音色→是否播放」三段判定必须可单测。
 *
 * 这里咬的是行为，不是文本：
 *  · 目录完整性（每个事件都有音色与三语文案）—— 新增事件漏接线会红；
 *  · 事件判定（权威流结束才响、cancelled 不响、首帧不响）—— 改成「只要有 false 就响」会红；
 *  · 闸门（总开关 / 单事件开关 / 冷却）—— 去掉冷却或开关会红；
 *  · 播放路径（注入播放器，断言真的响了哪支音色）—— 不接播放器会红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFICATION_SOUND_EVENTS,
  SOUND_CUES,
  DEFAULT_SOUND_PREFERENCES,
  SoundGate,
  cueForEvent,
  cuePeakGain,
  parseSoundPreferences,
  playNotificationSound,
  previewSoundCue,
  readSoundPreferences,
  setSoundPlayerForTests,
  soundEventForNotification,
  soundEventForStreamTransition,
  soundEventForTaskUpdate,
  writeSoundPreferences,
  EVENT_COOLDOWN_MS,
  GLOBAL_GAP_MS,
  type SoundCue,
} from '../src/lib/notificationSounds.ts';

const here = dirname(fileURLToPath(import.meta.url));
const localeDir = join(here, '..', 'src', 'locales');

/** Minimal in-memory Storage — happy-dom's localStorage is not trustworthy here. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function localeValue(locale: string, dottedKey: string): unknown {
  const ns = dottedKey.startsWith('sounds.') ? 'settings' : 'common';
  const json = JSON.parse(readFileSync(join(localeDir, locale, `${ns}.json`), 'utf8')) as Record<string, unknown>;
  return dottedKey.split('.').reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, json);
}

describe('事件目录（单一事实源）', () => {
  it('每个事件都有音色、且音色有可播放的音符', () => {
    for (const def of NOTIFICATION_SOUND_EVENTS) {
      const notes = SOUND_CUES[def.cue];
      expect(notes, `${def.id} 的音色 ${def.cue} 不存在`).toBeTruthy();
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(note.freq).toBeGreaterThan(0);
        expect(note.durationMs).toBeGreaterThan(0);
        expect(note.gain).toBeGreaterThan(0);
        expect(note.gain).toBeLessThanOrEqual(1);
      }
    }
  });

  it('每个事件的中英文案都真实存在（不是回落到键名）', () => {
    for (const def of NOTIFICATION_SOUND_EVENTS) {
      for (const locale of ['zh-CN', 'en', 'es']) {
        for (const key of [def.labelKey, def.descKey]) {
          const value = localeValue(locale, key);
          expect(typeof value, `${locale} 缺 ${key}`).toBe('string');
          expect((value as string).trim().length).toBeGreaterThan(0);
        }
      }
      const cueLabel = localeValue('zh-CN', `sounds.cues.${def.cue}`);
      expect(typeof cueLabel, `缺音色名 sounds.cues.${def.cue}`).toBe('string');
    }
  });

  it('每支音色的整体峰值与时长达到「听得见」的下限（Owner 2026-11-27 反馈：原来偏小偏短）', () => {
    // 口径是**整支音色叠加后**的峰值（cuePeakGain），不是单音 gain：厚音色靠多 voice 叠，
    // 单音 gain 必须降下来才不削波。默认取单音 gain 会在厚重音色上给出错误结论。
    const LONG_CUES: SoundCue[] = ['attention', 'alert'];
    for (const def of NOTIFICATION_SOUND_EVENTS) {
      const notes = SOUND_CUES[def.cue];
      const peak = cuePeakGain(notes);
      // 业界提示音峰值约 -10～-6 dBFS（线性 0.3～0.5）；低于 0.24 就是「嗒一下」。
      expect(peak, `${def.cue} 峰值太小`).toBeGreaterThanOrEqual(0.24);
      // 也不能猛撞限幅器：normal 档应在它之下，loud 档才由它接住。
      expect(peak, `${def.cue} 峰值太大，normal 档会被限幅器压扁`).toBeLessThanOrEqual(0.9);
      const spanMs = Math.max(...notes.map((n) => n.startMs + n.durationMs));
      const floor = LONG_CUES.includes(def.cue) ? 550 : 250;
      expect(spanMs, `${def.cue} 太短`).toBeGreaterThanOrEqual(floor);
    }
    const span = (cue: SoundCue) => Math.max(...SOUND_CUES[cue].map((n) => n.startMs + n.durationMs));
    expect(span('attention')).toBeGreaterThan(span('chime'));
    expect(span('alert')).toBeGreaterThan(span('pop'));
  });

  it('需要动手的两支不能「单薄」：必须有低频垫 + 非整数倍钟泛音（Owner 2026-11-27 反馈）', () => {
    // 「单薄」的客观特征：全在 800 Hz 以上、泛音只有整倍、包络一碰到底。
    // 这里钉两条一旦被改回就变红的性质：
    //  ① 低频垫路（≤ 300 Hz）给「重量」；
    //  ② 主音带非整数倍泛音（2.76×，钟的三度泛音）给「金属感」。
    for (const cue of ['attention', 'ding'] as SoundCue[]) {
      const notes = SOUND_CUES[cue];
      expect(notes.some((n) => n.freq <= 300), `${cue} 缺低频垫，会听起来像蜂鸣器`).toBe(true);
      const richest = notes.reduce((best, n) => ((n.overtones?.length ?? 0) > (best.overtones?.length ?? 0) ? n : best), notes[0]);
      const mults = (richest.overtones ?? []).map((o) => o.mult);
      expect(mults.length, `${cue} 主音泛音太少`).toBeGreaterThanOrEqual(2);
      expect(mults.some((m) => !Number.isInteger(m)), `${cue} 缺非整数倍泛音，金属感出不来`).toBe(true);
    }
  });

  it('事件 id 唯一', () => {
    const ids = NOTIFICATION_SOUND_EVENTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('流状态迁移判定', () => {
  const serverDone = { streaming: false, source: 'server' as const, status: 'done' };

  it('服务端确认的「在流 → 结束」响完成音', () => {
    expect(soundEventForStreamTransition({ streaming: true, source: 'server' }, serverDone)).toBe('agent-reply-complete');
    expect(cueForEvent('agent-reply-complete')).toBe('chime');
  });

  it('错误结束响告警音；取消（用户按停止）不响', () => {
    expect(soundEventForStreamTransition({ streaming: true, source: 'server' }, { ...serverDone, status: 'error' })).toBe('agent-reply-error');
    expect(soundEventForStreamTransition({ streaming: true, source: 'server' }, { ...serverDone, status: 'cancelled' })).toBeNull();
  });

  it('首帧（没有上一份快照）不响 —— 否则每次打开应用会响一串', () => {
    expect(soundEventForStreamTransition(undefined, serverDone)).toBeNull();
  });

  it('本地乐观的 false（例如按停止）不响：只有服务端口径算结束', () => {
    expect(soundEventForStreamTransition({ streaming: true, source: 'server' }, { streaming: false, source: 'local' })).toBeNull();
  });

  it('仍在流 / 上一帧本来就不在流 → 不响', () => {
    expect(soundEventForStreamTransition({ streaming: true, source: 'server' }, { streaming: true, source: 'server' })).toBeNull();
    expect(soundEventForStreamTransition({ streaming: false, source: 'server' }, serverDone)).toBeNull();
  });
});

describe('通知与任务事件判定', () => {
  it('审批请求 → 审批音；任务待验收 → 验收音；失败 → 失败音', () => {
    expect(soundEventForNotification({ notification: { type: 'approval_request' } })).toBe('approval-requested');
    expect(soundEventForNotification({ notification: { type: 'review_request' } })).toBe('review-requested');
    expect(soundEventForTaskUpdate({ status: 'review' })).toBe('review-requested');
    expect(soundEventForTaskUpdate({ status: 'failed' })).toBe('task-failed');
  });

  it('同一种通知类型按服务端标注的 askKind 分流：提问 ≠ 审批闸门', () => {
    // 这两条都是 `approval_request`，靠 type 分不开；产生方在 metadata.askKind 上标注。
    expect(soundEventForNotification({
      notification: { type: 'approval_request', metadata: { askKind: 'input' } },
    })).toBe('input-requested');
    expect(soundEventForNotification({
      notification: { type: 'approval_request', metadata: { askKind: 'approval' } },
    })).toBe('approval-requested');
    // 旧通知没有该字段 → 保守当闸门（宁可催办，不把闸门误当随口一问）。
    expect(soundEventForNotification({
      notification: { type: 'approval_request', metadata: {} },
    })).toBe('approval-requested');
    expect(cueForEvent('input-requested')).toBe('ask');
    expect(cueForEvent('approval-requested')).toBe('attention');
  });

  it('普通通知归到默认音；不认识的形状一律 null（不猜）', () => {
    expect(soundEventForNotification({ notification: { type: 'notify_user' } })).toBe('notification');
    expect(soundEventForNotification({})).toBeNull();
    expect(soundEventForNotification(undefined)).toBeNull();
    expect(soundEventForTaskUpdate({ status: 'completed' })).toBeNull();
    expect(soundEventForTaskUpdate({})).toBeNull();
  });
});

describe('偏好解析与读写', () => {
  it('坏数据退回默认值，未知事件 id 丢弃', () => {
    expect(parseSoundPreferences(null)).toEqual(DEFAULT_SOUND_PREFERENCES);
    expect(parseSoundPreferences({ enabled: 'yes', disabledEvents: 'x' })).toEqual(DEFAULT_SOUND_PREFERENCES);
    expect(parseSoundPreferences({ enabled: false, disabledEvents: ['notification', 'nope'] }))
      .toEqual({ ...DEFAULT_SOUND_PREFERENCES, enabled: false, disabledEvents: ['notification'] });
    expect(parseSoundPreferences({ volume: 'loud' }).volume).toBe('loud');
    expect(parseSoundPreferences({ volume: 'ear-splitting' }).volume).toBe('normal');
  });

  it('写后可读，且只改传入字段', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    writeSoundPreferences({ enabled: false }, storage);
    expect(readSoundPreferences(storage)).toEqual({ ...DEFAULT_SOUND_PREFERENCES, enabled: false });
    writeSoundPreferences({ disabledEvents: ['task-failed'], volume: 'quiet' }, storage);
    expect(readSoundPreferences(storage)).toEqual({
      ...DEFAULT_SOUND_PREFERENCES,
      enabled: false,
      disabledEvents: ['task-failed'],
      volume: 'quiet',
    });
  });

  it('没有存储时读默认值而不是抛错', () => {
    expect(readSoundPreferences(null)).toEqual(DEFAULT_SOUND_PREFERENCES);
  });
});

describe('闸门（开关 + 冷却）', () => {
  let now = 0;
  let gate: SoundGate;

  beforeEach(() => {
    now = 1_000_000;
    gate = new SoundGate(() => now);
  });

  it('总开关关闭 → 一律不响', () => {
    expect(gate.shouldPlay('agent-reply-complete', { enabled: false, disabledEvents: [] })).toBe(false);
  });

  it('单事件关闭 → 该事件不响，其它事件照响', () => {
    const prefs = { enabled: true, disabledEvents: ['agent-reply-complete' as const] };
    expect(gate.shouldPlay('agent-reply-complete', prefs)).toBe(false);
    expect(gate.shouldPlay('review-requested', prefs)).toBe(true);
  });

  it('同一事件在冷却窗口内只响一次（多会话同时结束不叠音）', () => {
    const prefs = { enabled: true, disabledEvents: [] };
    expect(gate.shouldPlay('agent-reply-complete', prefs)).toBe(true);
    now += EVENT_COOLDOWN_MS - 1;
    expect(gate.shouldPlay('agent-reply-complete', prefs)).toBe(false);
    now += 1;
    expect(gate.shouldPlay('agent-reply-complete', prefs)).toBe(true);
  });

  it('不同事件之间也有全局最小间隔', () => {
    const prefs = { enabled: true, disabledEvents: [] };
    expect(gate.shouldPlay('agent-reply-complete', prefs)).toBe(true);
    now += GLOBAL_GAP_MS - 1;
    expect(gate.shouldPlay('task-failed', prefs)).toBe(false);
    now += 1;
    expect(gate.shouldPlay('task-failed', prefs)).toBe(true);
  });
});

describe('播放路径', () => {
  const played: SoundCue[] = [];

  beforeEach(() => {
    played.length = 0;
    setSoundPlayerForTests((cue) => played.push(cue));
  });

  afterEach(() => {
    setSoundPlayerForTests(null);
  });

  it('开着 → 真的用该事件的音色响一次', () => {
    const gate = new SoundGate(() => 5_000_000);
    expect(playNotificationSound('approval-requested', { enabled: true, disabledEvents: [] }, gate)).toBe(true);
    expect(played).toEqual(['attention']);
  });

  it('关着 → 返回 false 且一个音都不响', () => {
    const gate = new SoundGate(() => 5_000_000);
    expect(playNotificationSound('approval-requested', { enabled: false, disabledEvents: [] }, gate)).toBe(false);
    expect(played).toEqual([]);
  });

  it('试听绕过开关与冷却（用户点它就是要听）', () => {
    previewSoundCue('alert');
    previewSoundCue('alert');
    expect(played).toEqual(['alert', 'alert']);
  });
});
