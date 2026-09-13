import { createLogger } from '@markus/shared';

const log = createLogger('event-bus');

type Listener = (...args: unknown[]) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  /**
   * P1-5：累计的监听器异常次数。
   *
   * 事件总线的语义是「发完即忘」的广播，单个监听器抛错不应拖垮其他订阅者；
   * 但**静默吞掉**会让订阅方故障完全不可观测（审计 P1-5：无日志、无计数）。
   * 这里保留不中断其他监听器的语义，同时把每次异常留痕并计数，供日志/健康检查/测试断言。
   */
  private listenerErrors = 0;

  on(event: string, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  off(event: string, fn: Listener): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (err) {
        // 不中断其他监听器（保持广播语义），但不再静默：留痕 + 计数。
        this.listenerErrors++;
        log.warn('EventBus listener threw — continuing remaining listeners', {
          event,
          error: String(err),
        });
      }
    });
  }

  /** P1-5：监听器异常累计次数（可观测性入口）。 */
  getListenerErrorCount(): number {
    return this.listenerErrors;
  }

  once(event: string, fn: Listener): () => void {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}
