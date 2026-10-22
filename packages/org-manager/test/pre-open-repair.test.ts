/**
 * 开库前自愈的**排程**回归。
 *
 * 这里锁的是那条曾经只有真实桌面启动才会走到的死路：
 * 大库一律传 `probeOnly: true`，而 `prepareDatabaseFile` 遇到「需要重建」标记时
 * 对 probeOnly 是**直接返回**的 → 「标记 → 就地重建」对桌面端大库永远不可达，
 * 每次重启只是把标记重写一遍（无限推迟，日志却写着 scheduled，看起来在跑）。
 *
 * storage 层的单测抓不到它：那些测试直接调 prepareDatabaseFile，不经过 probeOnly。
 * 所以这里断言的是**调用时的参数**，而不是被调函数的返回值。
 */
import { describe, it, expect, vi } from 'vitest';
import { runPreOpenRepair, type PreOpenRepairResult } from '../src/storage-bridge.js';

type Opts = { probeOnly?: boolean; allowBlockingProbe?: boolean } | undefined;

function harness(results: PreOpenRepairResult[]) {
  const calls: Opts[] = [];
  const reports: PreOpenRepairResult[] = [];
  const prepare = vi.fn(async (opts?: Opts) => {
    calls.push(opts);
    return results[calls.length - 1] ?? { action: 'none', reason: 'healthy' };
  });
  return { calls, reports, prepare };
}

describe('开库前自愈排程', () => {
  it('大库 + 已有「需要重建」标记 → 就地重建，且绝不传 probeOnly', async () => {
    const h = harness([{ action: 'repaired', reason: 'marked-for-repair' }]);

    const out = await runPreOpenRepair({
      isLarge: true,
      prepare: h.prepare as never,
      report: r => h.reports.push(r),
    });

    expect(out.first.action).toBe('repaired');
    expect(out.backgroundProbeStarted).toBe(false);
    // 死路守卫：第一次调用必须允许「标记 → 重建」这条分支。
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({ allowBlockingProbe: false });
    expect(h.calls[0]?.probeOnly).toBeUndefined();
    expect(h.reports).toHaveLength(1);
  });

  it('大库 + 没有标记 → 不在启动路径上探测，退到后台 probeOnly', async () => {
    const h = harness([
      { action: 'none', reason: 'probe-deferred-background' },
      { action: 'scheduled', reason: 'marked-for-repair' },
    ]);

    const out = await runPreOpenRepair({
      isLarge: true,
      prepare: h.prepare as never,
      report: r => h.reports.push(r),
    });

    expect(out.backgroundProbeStarted).toBe(true);
    // 启动路径上那次：只允许挡探测
    expect(h.calls[0]).toEqual({ allowBlockingProbe: false });
    // 后台那次：只探测、不重建（库正被写）
    expect(h.calls[1]).toEqual({ probeOnly: true });

    await vi.waitFor(() => expect(h.reports).toHaveLength(2));
    expect(h.reports[1]?.action).toBe('scheduled');
  });

  it('大库后台探测抛错 → 交给调用方记录，不冒充成功', async () => {
    const onErr = vi.fn();
    const prepare = vi.fn()
      .mockResolvedValueOnce({ action: 'none', reason: 'probe-deferred-background' })
      .mockRejectedValueOnce(new Error('boom'));

    await runPreOpenRepair({ isLarge: true, prepare: prepare as never, report: () => {}, onBackgroundProbeError: onErr });

    await vi.waitFor(() => expect(onErr).toHaveBeenCalledTimes(1));
    expect(String(onErr.mock.calls[0]?.[0])).toContain('boom');
  });

  it('小库 → 同步探测/修复（不传任何选项、不起后台）', async () => {
    const h = harness([{ action: 'repaired', reason: 'corrupt' }]);

    await runPreOpenRepair({ isLarge: false, prepare: h.prepare as never, report: r => h.reports.push(r) });

    expect(h.calls).toEqual([undefined]);
    expect(h.reports).toHaveLength(1);
  });
});
