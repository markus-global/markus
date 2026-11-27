/**
 * notificationSounds — 「哪些事件有提示音、各自响什么、开没开」的唯一事实源。
 *
 * 设计要点（为什么这么切）：
 *
 * 1. **事件是枚举，不是散落的 if**。`NotificationSoundEvent` 是闭集，配一张
 *    `NOTIFICATION_SOUND_EVENTS` 目录（每个事件 → 一个音色 + 两个 i18n 键）。
 *    设置页的清单、播放判定、文档全部从这一张表派生 —— 新增一个提示音只改这里一处，
 *    不会出现「代码里有、设置页没有」或「文档写了、代码没接」的第二写者。
 *
 * 2. **声音是合成的，不是音频文件**。每个音色是一小组振荡器音符（频率/起始/时长/波形/
 *    增益）。好处：零二进制资产（不用管打包路径、跨平台解码、Electron 缓存）、
 *    可单测（音符表是纯数据）、音量可控不会炸。
 *
 * 3. **判定与播放分离**。`soundEventFor*` 是纯函数（从权威事件判定「该响哪个」），
 *    `SoundGate` 是纯调度的闸门（开关 / 单事件冷却 / 全局最小间隔），
 *    `playNotificationSound` 才碰 WebAudio。所以测试不需要音频环境就能咬住行为。
 *
 * 4. **偏好存本机**（localStorage），与主题同一层：提示音是「这台设备要不要出声」，
 *    不是账号级人格设置 —— 换设备后由用户各自决定，不跨设备强制静音。
 */
/* ─────────────────────────── 音色（合成配方） ─────────────────────────── */

/** 一个音符。`startMs` 相对音色起点，`gain` 是峰值增益（0..1 线性，1 = 满刻度）。 */
export interface CueNote {
  freq: number;
  startMs: number;
  durationMs: number;
  wave: OscillatorType;
  gain: number;
  /**
   * 叠加在基频上的泛音（倍数 + 相对增益）。纯正弦在同电平下听感明显比三角波弱，
   * 「听起来够响」要靠泛音撑，而不是把基频推上去 —— 后者刺耳且容易削波。
   */
  overtones?: Array<{ mult: number; gain: number }>;
}

/** 音色 id（闭集）。定义在目录之前，避免 `keyof typeof SOUND_CUES` 的循环引用。 */
export type SoundCue = 'chime' | 'ding' | 'pop' | 'attention' | 'alert' | 'ask';

/**
 * 音色目录。频率取自然音阶附近的值，听感上能区分「完成 / 需要你动手 / 出错」。
 * 短视频：单音不超过 0.35s，整组不超过 0.6s —— 提示音是提示，不是打扰。
 */
export const SOUND_CUES: Record<SoundCue, CueNote[]> = {
  /** 上行两音：Agent 回复完成（最常听到，需柔和且有尾音）。 */
  chime: [
    { freq: 698.46, startMs: 0, durationMs: 170, wave: 'sine', gain: 0.3, overtones: [{ mult: 2, gain: 0.35 }] },
    { freq: 880.0, startMs: 120, durationMs: 320, wave: 'sine', gain: 0.28, overtones: [{ mult: 2, gain: 0.3 }, { mult: 3, gain: 0.1 }] },
  ],
  /**
   * 单次钟击 + 低八度垫 + 长余韵：任务转待验收。
   *
   * 为什么改成钟而不是「叮」一下：单低频中高频加陡峭包络 = 电子蜂鸣器，
   * 听感单薄。厚实感来自三件事 —— 低八度垫底（重量）、非整数倍泛音
   * 2.76×（钟的「三度泛音」，金属感）、长衰减（余韵）。
   */
  ding: [
    { freq: 261.63, startMs: 0, durationMs: 760, wave: 'sine', gain: 0.09 },
    { freq: 523.25, startMs: 0, durationMs: 700, wave: 'sine', gain: 0.08 },
    { freq: 1046.5, startMs: 0, durationMs: 650, wave: 'sine', gain: 0.16, overtones: [{ mult: 2, gain: 0.32 }, { mult: 2.76, gain: 0.16 }, { mult: 4, gain: 0.08 }] },
    { freq: 1567.98, startMs: 0, durationMs: 320, wave: 'sine', gain: 0.05 },
  ],
  /** 轻「啵」（两音上行，带一点弹性）：普通通知。 */
  pop: [
    { freq: 523.25, startMs: 0, durationMs: 150, wave: 'sine', gain: 0.3, overtones: [{ mult: 2, gain: 0.3 }] },
    { freq: 659.25, startMs: 80, durationMs: 190, wave: 'sine', gain: 0.26, overtones: [{ mult: 2, gain: 0.25 }] },
  ],
  /** 上行两音（低沉柔和）：Agent 在问你问题（request_user_input），语气是「询问」不是「催办」。 */
  ask: [
    { freq: 587.33, startMs: 0, durationMs: 200, wave: 'sine', gain: 0.28, overtones: [{ mult: 2, gain: 0.3 }] },
    { freq: 783.99, startMs: 130, durationMs: 340, wave: 'sine', gain: 0.26, overtones: [{ mult: 2, gain: 0.28 }] },
  ],
  /**
   * 低音垫 + 三音上行钟扫：有审批等你处理（需动手，当前最厚重的一支）。
   *
   * 与 `ding` 的区别不能只是音高：审批是「多件事等你逐个拍板」，所以是**三次**
   * 敲击并逐级上行，且带 196 Hz 低频垫——手机外放上也能听出分量。
   */
  attention: [
    { freq: 196.0, startMs: 0, durationMs: 520, wave: 'sine', gain: 0.1 },
    { freq: 783.99, startMs: 0, durationMs: 430, wave: 'sine', gain: 0.14, overtones: [{ mult: 2, gain: 0.3 }, { mult: 2.76, gain: 0.15 }] },
    { freq: 987.77, startMs: 150, durationMs: 400, wave: 'sine', gain: 0.13, overtones: [{ mult: 2, gain: 0.28 }, { mult: 2.76, gain: 0.12 }] },
    { freq: 1174.66, startMs: 300, durationMs: 520, wave: 'sine', gain: 0.13, overtones: [{ mult: 2, gain: 0.3 }, { mult: 2.76, gain: 0.15 }] },
  ],
  /** 下行两音（低、闷，不尖叫）：出错 / 失败。 */
  alert: [
    { freq: 392.0, startMs: 0, durationMs: 240, wave: 'triangle', gain: 0.32, overtones: [{ mult: 2, gain: 0.18 }] },
    { freq: 311.13, startMs: 220, durationMs: 380, wave: 'triangle', gain: 0.32, overtones: [{ mult: 2, gain: 0.18 }] },
  ],
};

/* ─────────────────────────────── 事件枚举 ─────────────────────────────── */

/** 会响提示音的事件（闭集）。 */
export type NotificationSoundEvent =
  | 'agent-reply-complete'
  | 'agent-reply-error'
  | 'input-requested'
  | 'approval-requested'
  | 'review-requested'
  | 'task-failed'
  | 'notification';

export interface NotificationSoundEventDef {
  id: NotificationSoundEvent;
  cue: SoundCue;
  /** i18n 键（`settings` 命名空间），设置页清单直接读它。 */
  labelKey: string;
  descKey: string;
}

/**
 * 事件目录 —— 这是设置页清单、文档与播放判定的**同一张表**。
 * 顺序即设置页展示顺序：先日常（回复完成），再需要动手，最后异常。
 */
export const NOTIFICATION_SOUND_EVENTS: readonly NotificationSoundEventDef[] = [
  {
    id: 'agent-reply-complete',
    cue: 'chime',
    labelKey: 'sounds.events.agentReplyComplete.label',
    descKey: 'sounds.events.agentReplyComplete.desc',
  },
  {
    id: 'input-requested',
    cue: 'ask',
    labelKey: 'sounds.events.inputRequested.label',
    descKey: 'sounds.events.inputRequested.desc',
  },
  {
    id: 'approval-requested',
    cue: 'attention',
    labelKey: 'sounds.events.approvalRequested.label',
    descKey: 'sounds.events.approvalRequested.desc',
  },
  {
    id: 'review-requested',
    cue: 'ding',
    labelKey: 'sounds.events.reviewRequested.label',
    descKey: 'sounds.events.reviewRequested.desc',
  },
  {
    id: 'notification',
    cue: 'pop',
    labelKey: 'sounds.events.notification.label',
    descKey: 'sounds.events.notification.desc',
  },
  {
    id: 'agent-reply-error',
    cue: 'alert',
    labelKey: 'sounds.events.agentReplyError.label',
    descKey: 'sounds.events.agentReplyError.desc',
  },
  {
    id: 'task-failed',
    cue: 'alert',
    labelKey: 'sounds.events.taskFailed.label',
    descKey: 'sounds.events.taskFailed.desc',
  },
];

const EVENTS_BY_ID = new Map(NOTIFICATION_SOUND_EVENTS.map((d) => [d.id, d]));

/** 事件定义（未知 id 返回 undefined —— 调用方必须处理，别假装存在）。 */
export function notificationSoundEvent(id: string): NotificationSoundEventDef | undefined {
  return EVENTS_BY_ID.get(id as NotificationSoundEvent);
}

/** 事件对应的音色；未知事件返回 undefined。 */
export function cueForEvent(id: NotificationSoundEvent): SoundCue {
  return EVENTS_BY_ID.get(id)!.cue;
}

/* ───────────────────────────── 事件判定（纯） ───────────────────────────── */

/** 存活性条目里判定所需的最小形状（与 `SessionStreamState` 的条目对齐）。 */
export interface StreamEntryLike {
  streaming: boolean;
  source: 'server' | 'local';
  status?: string;
}

/**
 * 流状态迁移 → 该响什么。
 *
 * 只在「**服务端权威**说这一回合结束了」时响：
 *   · 本地乐观的 false（用户按停止）不算结束提示 —— 那是用户自己的动作；
 *   · 没有上一份快照（首帧）不算 —— 否则每次打开应用都会响一串；
 *   · `cancelled` 不响；`error` 用告警音；其余按正常完成。
 */
export function soundEventForStreamTransition(
  prev: StreamEntryLike | undefined,
  next: StreamEntryLike & { sessionId?: string },
): NotificationSoundEvent | null {
  if (!prev || prev.streaming !== true) return null;
  if (next.streaming) return null;
  if (next.source !== 'server') return null;
  const status = (next.status ?? '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'stopped') return null;
  if (status === 'error' || status === 'failed') return 'agent-reply-error';
  return 'agent-reply-complete';
}

/**
 * `notification` WS 载荷 → 该响什么。
 *
 * 服务端在 `setHITLService` 里把通知原样塞进 `payload.notification`；
 * HITL 的审批通知 `type` 固定为 `approval_request`（见 hitl-service）。
 * 其余类型统一归到普通通知 —— 不按标题文本猜，猜错比不响更糟。
 */
export function soundEventForNotification(payload: unknown): NotificationSoundEvent | null {
  const n = (payload as {
    notification?: { type?: unknown; metadata?: { askKind?: unknown } };
  } | undefined)?.notification;
  const type = typeof n?.type === 'string' ? n.type.toLowerCase() : '';
  if (!type) return null;
  if (type === 'approval_request' || type === 'approval_required') {
    // 服务端把「提问 vs 闸门」标在 metadata.askKind 上（产生方才知道的事实，见
    // hitl-service 的 requestApproval）。旧通知没有该字段 ⇒ 保守当作闸门。
    return n?.metadata?.askKind === 'input' ? 'input-requested' : 'approval-requested';
  }
  if (type === 'task_review' || type === 'review_request' || type === 'review_requested') return 'review-requested';
  if (type === 'task_failed') return 'task-failed';
  return 'notification';
}

/**
 * `task:update` WS 载荷 → 该响什么。
 *
 * 只认两种状态跃迁的结果：待验收（`review`）与失败（`failed`）。
 * 其他状态（pending / in_progress / completed）不响 —— 完成是 Agent 的日常，
 * 每条都响就等于没响。
 */
export function soundEventForTaskUpdate(payload: unknown): NotificationSoundEvent | null {
  const status = (payload as { status?: unknown } | undefined)?.status;
  if (typeof status !== 'string') return null;
  if (status === 'review') return 'review-requested';
  if (status === 'failed') return 'task-failed';
  return null;
}

/* ─────────────────────────────── 偏好 ─────────────────────────────── */

export interface NotificationSoundPreferences {
  /** 总开关。关掉 = 任何提示音都不响（设置页「提示音」区块的总闸）。 */
  enabled: boolean;
  /** 单独关掉的事件（总开关仍开时生效）。 */
  disabledEvents: NotificationSoundEvent[];
  /** 响度档位。默认 `normal`；觉得吵的人调低，觉得小的人调高（Owner 2026-11-27）。 */
  volume: SoundVolume;
}

/**
 * 响度档位。系数直接乘在音色的峰值增益上，并在播放器里做逐音封顶，
 * 所以 `loud` 也不会削波成破音。
 */
export type SoundVolume = 'quiet' | 'normal' | 'loud';

export const SOUND_VOLUMES: readonly SoundVolume[] = ['quiet', 'normal', 'loud'];

export const VOLUME_SCALE: Record<SoundVolume, number> = {
  quiet: 0.6,
  normal: 1,
  loud: 1.7,
};

export const SOUND_PREFERENCES_KEY = 'markus-notification-sounds';
export const SOUND_PREFERENCES_CHANGED = 'markus:notification-sounds-changed';

export const DEFAULT_SOUND_PREFERENCES: NotificationSoundPreferences = {
  enabled: true,
  disabledEvents: [],
  volume: 'normal',
};

/** 宽松解析：坏数据一律退回默认值，不认识的事件 id 丢弃（不抛）。 */
export function parseSoundPreferences(raw: unknown): NotificationSoundPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOUND_PREFERENCES };
  const obj = raw as { enabled?: unknown; disabledEvents?: unknown; volume?: unknown };
  const disabled = Array.isArray(obj.disabledEvents)
    ? obj.disabledEvents.filter((id): id is NotificationSoundEvent => EVENTS_BY_ID.has(id as NotificationSoundEvent))
    : [];
  const volume = SOUND_VOLUMES.includes(obj.volume as SoundVolume) ? (obj.volume as SoundVolume) : 'normal';
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    disabledEvents: [...new Set(disabled)],
    volume,
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readSoundPreferences(storage: Storage | null = safeStorage()): NotificationSoundPreferences {
  if (!storage) return { ...DEFAULT_SOUND_PREFERENCES };
  try {
    const raw = storage.getItem(SOUND_PREFERENCES_KEY);
    return raw ? parseSoundPreferences(JSON.parse(raw)) : { ...DEFAULT_SOUND_PREFERENCES };
  } catch {
    return { ...DEFAULT_SOUND_PREFERENCES };
  }
}

/** 读-改-写并广播（设置页与其它标签页同步）。 */
export function writeSoundPreferences(
  patch: Partial<NotificationSoundPreferences>,
  storage: Storage | null = safeStorage(),
): NotificationSoundPreferences {
  const next = parseSoundPreferences({ ...readSoundPreferences(storage), ...patch });
  try {
    storage?.setItem(SOUND_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 配额满：本次不持久化，但内存内的调用方仍读得到广播值 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SOUND_PREFERENCES_CHANGED, { detail: next }));
  }
  return next;
}

/** 订阅偏好变化（含其它标签页的 `storage` 事件）。返回退订函数。 */
export function subscribeSoundPreferences(cb: (prefs: NotificationSoundPreferences) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onLocal = () => cb(readSoundPreferences());
  const onStorage = (e: StorageEvent) => {
    if (e.key === SOUND_PREFERENCES_KEY) cb(readSoundPreferences());
  };
  window.addEventListener(SOUND_PREFERENCES_CHANGED, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SOUND_PREFERENCES_CHANGED, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

/* ─────────────────────────── 播放闸门（纯调度） ─────────────────────────── */

/** 同一事件的最小间隔：多会话同时结束不该叠成和弦。 */
export const EVENT_COOLDOWN_MS = 4000;
/** 任意两声之间的最小间隔。 */
export const GLOBAL_GAP_MS = 700;

/**
 * 闸门：决定「这一次该不该真出声」。
 *
 * 三条规则按顺序短路：总开关 → 单事件开关 → 冷却。
 * `now` 可注入，测试因此能精确咬住冷却边界（而不是靠 sleep）。
 */
export class SoundGate {
  private lastByEvent = new Map<NotificationSoundEvent, number>();
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = () => Date.now()) {}

  shouldPlay(event: NotificationSoundEvent, prefs: NotificationSoundPreferences): boolean {
    if (!prefs.enabled) return false;
    if (prefs.disabledEvents.includes(event)) return false;
    const t = this.now();
    if (t - (this.lastByEvent.get(event) ?? Number.NEGATIVE_INFINITY) < EVENT_COOLDOWN_MS) return false;
    if (t - this.lastAt < GLOBAL_GAP_MS) return false;
    this.lastByEvent.set(event, t);
    this.lastAt = t;
    return true;
  }

  reset(): void {
    this.lastByEvent.clear();
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

/** 模块级闸门：所有真实播放共用（跨订阅者也不会叠音）。 */
export const soundGate = new SoundGate();

/* ─────────────────────────────── 播放 ─────────────────────────────── */

type CuePlayer = (cue: SoundCue, volume: number) => void;

let audioContext: AudioContext | null = null;

/** 逐音封顶：`loud` 档也不许把波形推平（削波听起来是破音，不是更响）。 */
const PEAK_LIMIT = 0.85;

/**
 * 一支音色在任意时刻的峰值增益之和（按起止事件扫描，取最大值）。
 *
 * 用来回答两个问题：「这支音色在 `normal` 档会不会撞上限幅器」（测试断言）与
 * 「音量参数该留多少余量」。同一时刻**先加后减**是高估 —— 宁可保守。
 */
export function cuePeakGain(notes: readonly CueNote[]): number {
  const edges: Array<{ at: number; delta: number }> = [];
  for (const note of notes) {
    const voiceSum = note.gain * (1 + (note.overtones ?? []).reduce((sum, o) => sum + o.gain, 0));
    edges.push({ at: note.startMs, delta: voiceSum });
    edges.push({ at: note.startMs + note.durationMs, delta: -voiceSum });
  }
  edges.sort((a, b) => a.at - b.at || b.delta - a.delta);
  let current = 0;
  let peak = 0;
  for (const edge of edges) {
    current += edge.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

function webAudioPlayer(cue: SoundCue, volume: number): void {
  const Ctor =
    typeof window !== 'undefined'
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctor) return;
  const notes = SOUND_CUES[cue];
  if (!notes || notes.length === 0) return;

  try {
    audioContext ??= new Ctor();
    const ctx = audioContext;
    // 浏览器自动播放策略：首次可能需要用户手势后才能出声。拿不到就静默跳过，
    // 下一次事件会再试 —— 不弹错、不阻塞 UI。
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.01;

    // 支级音量 + 限幅器：音量档位乘在总线上，而不是逐音乘。
    //
    // 为什么需要限幅而不是「把每个音 clamp 到 0.85」：一支厚重的音色是多数个 voice
    // 叠出来的（低频垫 + 基频 + 几个非整数倍泛音），逐音 clamp 管不住**叠加后**的
    // 峰值 —— 那就是削波破音。限幅器（软压缩）在保住「更响」的同时把峰值压住，
    // 这是业界做法，也是 `loud` 档真能听出差别的前提。
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume, t0);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-6, t0);
    limiter.knee.setValueAtTime(6, t0);
    limiter.ratio.setValueAtTime(12, t0);
    limiter.attack.setValueAtTime(0.003, t0);
    limiter.release.setValueAtTime(0.15, t0);
    master.connect(limiter).connect(ctx.destination);

    /** 一个振荡器 + 包络；基频与每个泛音各一条，共享同一个时间窗。 */
    const voice = (freq: number, wave: OscillatorType, peak: number, start: number, end: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, start);
      // 短促的 attack/release 包络，避免爆音（直接起停会听到「咔」）。
      const level = Math.min(peak, PEAK_LIMIT);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(end + 0.02);
    };

    for (const note of notes) {
      const start = t0 + note.startMs / 1000;
      const end = start + note.durationMs / 1000;
      voice(note.freq, note.wave, note.gain, start, end);
      // 泛音让音色「有实体」，听感更响但不变刺耳。
      for (const overtone of note.overtones ?? []) {
        voice(note.freq * overtone.mult, note.wave, note.gain * overtone.gain, start, end);
      }
    }
  } catch {
    /* 音频设备不可用：提示音是体验增强，绝不因它抛错打断业务 */
  }
}

let cuePlayer: CuePlayer = webAudioPlayer;

/** 替换播放器（测试用；传 `null` 恢复 WebAudio 实现）。 */
export function setSoundPlayerForTests(player: CuePlayer | null): void {
  cuePlayer = player ?? webAudioPlayer;
}

/**
 * 播一个事件。返回是否真的响了 —— 调用方与测试都靠这个布尔判定，
 * 不要用「听没听到」当证据。
 */
export function playNotificationSound(
  event: NotificationSoundEvent,
  prefs: NotificationSoundPreferences = readSoundPreferences(),
  gate: SoundGate = soundGate,
): boolean {
  if (!gate.shouldPlay(event, prefs)) return false;
  cuePlayer(cueForEvent(event), VOLUME_SCALE[prefs.volume]);
  return true;
}

/**
 * 设置页「试听」：绕过开关与冷却（用户点它就是要听），但仍走同一个播放器，
 * 并按当前音量档位发声 —— 否则试听音量与真实事件不一致，调音量就靠猜。
 */
export function previewSoundCue(cue: SoundCue, volume: SoundVolume = readSoundPreferences().volume): void {
  cuePlayer(cue, VOLUME_SCALE[volume]);
}

