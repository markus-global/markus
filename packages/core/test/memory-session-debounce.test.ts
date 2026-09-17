/**
 * MemoryStore 会话落盘：并发 worker 的防抖定时器必须**按会话**隔离。
 *
 * 缺陷背景：`saveDebounce` 是实例级**单值**，`debouncedSaveSession` 每次都
 * `clearTimeout(this.saveDebounce)`。并发模式下多个 worker 各有自己的会话，
 * 共享同一个定时器时，后到的 worker 会取消先到者的待写 —— 前一个会话的变更
 * 被静默丢弃（进程重启即永久丢失）。
 *
 * 双 worker 在同一 Agent 实例内共享 `this.memory`（agent.ts），因此这不是
 * 假想场景：worker A 的用户会话与 worker B 的任务会话会互相取消落盘。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-memdebounce-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('MemoryStore — 会话落盘防抖按会话隔离', () => {
  it('两个会话在防抖窗口内先后写：两者都必须落盘（旧实现只落最后一个）', async () => {
    const store = new MemoryStore(dir);
    const a = store.createSession('agt_x');
    const b = store.createSession('agt_x');

    // 模拟两个并发 worker：A 先写，300ms 后 B 写 —— 旧实现会用 B 的定时器
    // 取消 A 的待写，A 的会话文件永远不会出现。
    store.appendMessage(a.id, { role: 'user', content: 'A 的第一条' });
    await wait(300);
    store.appendMessage(b.id, { role: 'user', content: 'B 的第一条' });

    // 跨过防抖窗口
    await wait(1200);

    const fileA = join(dir, 'sessions', `${a.id}.json`);
    const fileB = join(dir, 'sessions', `${b.id}.json`);
    expect(existsSync(fileA), 'A 会话必须落盘（被 B 取消即为丢数据）').toBe(true);
    expect(existsSync(fileB), 'B 会话必须落盘').toBe(true);
  });

  it('同一会话连续写只落盘一次（防抖仍生效，未退化为每次同步写）', async () => {
    const store = new MemoryStore(dir);
    const s = store.createSession('agt_y');
    for (let i = 0; i < 20; i++) {
      store.appendMessage(s.id, { role: 'user', content: `msg ${i}` });
    }
    const file = join(dir, 'sessions', `${s.id}.json`);
    // 防抖窗口内不应写入
    expect(existsSync(file)).toBe(false);
    await wait(1200);
    expect(existsSync(file)).toBe(true);
    // 落盘内容必须是**全部** 20 条（防抖只合并写次数，不得丢消息）
    const persisted = JSON.parse(
      await import('node:fs').then(m => m.readFileSync(file, 'utf-8')),
    ) as { messages: Array<{ content: string }> };
    expect(persisted.messages).toHaveLength(20);
    expect(persisted.messages[19]!.content).toBe('msg 19');
  });
});
