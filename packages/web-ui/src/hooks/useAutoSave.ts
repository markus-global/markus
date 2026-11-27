/**
 * useAutoSave — 字段一改就自动提交（防抖），并给出可见的保存状态。
 *
 * 为什么不要「保存」按钮（Owner 2026-11-27）：这一页每个字段都是即时生效的策略值，
 * 而页面里有两组各带一个按钮 —— 改完上面那组、再改下面那组，只点一个必然发生。
 * 自动保存把「我到底存了没」这个问题从用户脑子里删掉。
 *
 * 三条契约（每条都对应一个真会踩到的失败）：
 *  · **防抖**：数字输入框按住方向键会连发 change，不必每次都打一个请求；
 *  · **序号防乱序**：慢响应回来时若已有更新的提交，丢弃它的回填 —— 否则 UI 会闪回旧值，
 *    用户看到自己刚改的数字跳回去，会以为没保存成功；
 *  · **卸载冲刷**：改完立刻切 tab，防抖窗口内的改动不能丢（fire-and-forget 发出去）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface AutoSaveOptions {
  /** 停止输入多久后提交（ms）。 */
  delayMs?: number;
  /** 「已保存」提示停留多久（ms）。 */
  savedMs?: number;
}

export interface AutoSave<T> {
  state: AutoSaveState;
  /** 记录最新值并重置防抖计时。 */
  schedule: (value: T) => void;
  /** 立刻提交待发值（切换分组/手动触发时用）。 */
  flush: () => void;
}

export function useAutoSave<T>(save: (value: T) => Promise<void>, options: AutoSaveOptions = {}): AutoSave<T> {
  const { delayMs = 600, savedMs = 2000 } = options;
  const [state, setState] = useState<AutoSaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const seq = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = useCallback(async () => {
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    const mine = ++seq.current;
    setState('saving');
    try {
      await saveRef.current(job.value);
      // 过期响应：期间已有新的提交，回填会让 UI 闪回旧值。
      if (mine !== seq.current) return;
      setState('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        setState((current) => (current === 'saved' ? 'idle' : current));
      }, savedMs);
    } catch {
      if (mine !== seq.current) return;
      setState('error');
    }
  }, [savedMs]);

  const schedule = useCallback((value: T) => {
    pending.current = { value };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void run();
    }, delayMs);
  }, [delayMs, run]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void run();
  }, [run]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    timer.current = null;
    // 卸载时把待发值发出去：用户改完立刻切走，改动不能丢。
    void run();
  }, [run]);

  return { state, schedule, flush };
}
