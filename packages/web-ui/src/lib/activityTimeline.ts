/**
 * 把「执行轮次」与「评审轮次」合并成一条按时间排序的活动流 —— 合并逻辑只此一处。
 *
 * 为什么合并：同一张卡的历史本来就是一条叙事。拆成两个 tab 强迫读者在脑子里做交集，
 * 而且两边内容一旦弄错（曾把执行日志原样渲在评审 tab），人根本分不清哪段是谁做的。
 *
 * 轮次号怎么办（Owner 2026-11-12 定）：**各算各的**——「第 N 轮执行」「第 N 轮评审」。
 * 不去造一个假的全局轮次，那样只会让两个体系的编号互相覆盖。
 *
 * 纯函数：同输入同输出，不读时钟、不读网络。
 */
import type { RoundSummary } from '../api.ts';
import type { ReviewSession } from './taskReview.ts';

export type ActivityFilter = 'all' | 'execution' | 'review';

export type ActivityItem =
  | {
      kind: 'execution';
      key: string;
      /** executionRound：执行侧的编号，单独计数 */
      round: number;
      startedAt: string;
      endedAt: string | null;
      toolCount: number;
      logCount: number;
      status: string;
    }
  | {
      kind: 'review';
      key: string;
      /** 评审侧自己的轮次编号，不与执行混排 */
      round: number;
      startedAt: string;
      endedAt: string | null;
      session: ReviewSession;
    };

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

/**
 * 合并 + 排序 + 过滤。
 * 排序以「开始时间」为准（评审在提交那一刻开始，执行在那一轮开始跑）；
 * 同一时刻的执行排在评审前（先做完才可能被提交审）。
 */
export function buildActivityTimeline(
  rounds: readonly RoundSummary[],
  sessions: readonly ReviewSession[],
  filter: ActivityFilter = 'all',
): ActivityItem[] {
  const items: ActivityItem[] = [];

  if (filter !== 'review') {
    for (const r of rounds) {
      const startedAt = r.firstAt ?? '';
      if (Number.isNaN(ms(startedAt))) continue;
      items.push({
        kind: 'execution',
        key: `exec:${r.round}`,
        round: r.round,
        startedAt,
        endedAt: r.lastAt ?? null,
        toolCount: r.toolCount ?? 0,
        logCount: r.logCount ?? 0,
        status: r.status ?? '',
      });
    }
  }

  if (filter !== 'execution') {
    for (const s of sessions) {
      if (Number.isNaN(ms(s.queuedAt))) continue;
      items.push({
        kind: 'review',
        key: s.id,
        round: s.round,
        startedAt: s.queuedAt,
        endedAt: s.completedAt,
        session: s,
      });
    }
  }

  return items.sort((a, b) => {
    const d = ms(a.startedAt) - ms(b.startedAt);
    if (d !== 0) return d;
    // 同刻：执行在前，评审在后
    if (a.kind !== b.kind) return a.kind === 'execution' ? -1 : 1;
    return a.round - b.round;
  });
}
