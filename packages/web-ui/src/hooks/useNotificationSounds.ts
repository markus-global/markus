/**
 * useNotificationSounds — 把「权威事件」接到「提示音」上的**唯一接线点**。
 *
 * 挂载在 App 根部（与 `useAttentionBadge` 同级），与当前停在哪个页面无关 ——
 * 用户可能正在看任务页，Agent 在后台会话里讲完了，也该有一声提示。
 *
 * 三路信号，各用一个已经存在的权威源，不新增判定：
 *
 *  1. **回合结束** ← `sessionStreamState`（服务端 `session:stream_state` 推送的客户端权威）。
 *     按前后两帧快照比较，只在「服务端说流结束了」时响；首帧只做基线，不响。
 *     这样切 tab、重连、轮询补状态都不会误响，而用户按停止（`cancelled`）不响。
 *  2. **审批 / 通知** ← WS `notification`（服务端 HITL 原样下发）。
 *  3. **任务待验收 / 失败** ← WS `task:update`（服务端状态机广播）。
 *
 * 去重与开关都在 `lib/notificationSounds.ts` 的 `SoundGate` 里，本文件不做第二套判断。
 */
import { useEffect } from 'react';
import { wsClient } from '../api.ts';
import { sessionStreamState } from '../lib/sessionStreamState.ts';
import {
  playNotificationSound,
  soundEventForNotification,
  soundEventForStreamTransition,
  soundEventForTaskUpdate,
  type StreamEntryLike,
} from '../lib/notificationSounds.ts';

interface StreamSnapshot extends StreamEntryLike {
  sessionId: string;
}

/**
 * @param active 已登录且应用就绪时为 true；false 时完全不订阅（未登录不该听到任何提示音）。
 */
export function useNotificationSounds(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    // 基线：挂载瞬间已经在流的会话，其「开始」属于历史，不该在结束时被当成新回合。
    // 只记录快照，不响。
    let snapshot = new Map<string, StreamSnapshot>(
      sessionStreamState.entriesSnapshot().map((e) => [e.sessionId, e]),
    );

    const unsubscribeStream = sessionStreamState.subscribe(() => {
      const next = sessionStreamState.entriesSnapshot();
      for (const entry of next) {
        const event = soundEventForStreamTransition(snapshot.get(entry.sessionId), entry);
        if (event) playNotificationSound(event);
      }
      snapshot = new Map(next.map((e) => [e.sessionId, e]));
    });

    const unsubscribeNotification = wsClient.on('notification', (event: unknown) => {
      const sound = soundEventForNotification((event as { payload?: unknown })?.payload);
      if (sound) playNotificationSound(sound);
    });

    const unsubscribeTask = wsClient.on('task:update', (event: unknown) => {
      const sound = soundEventForTaskUpdate((event as { payload?: unknown })?.payload);
      if (sound) playNotificationSound(sound);
    });

    return () => {
      unsubscribeStream();
      unsubscribeNotification();
      unsubscribeTask();
    };
  }, [active]);
}
