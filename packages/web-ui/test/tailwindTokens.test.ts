/**
 * 守卫：我们实际依赖的语义色 token **必须真的在主题里定义**。
 *
 * 起因（2026-10-28，Owner 报）：任务"取消（含依赖任务）"的弹窗背景透明。
 * 根因不是 z-index、也不是遮罩，而是卡片用了 `bg-surface-default` —— 这个 token
 * 主题里**从来没定义过**（只有 surface-primary/secondary/elevated/overlay）。
 * 类名解析不出来 → 卡片没有背景 → 看到的是底下的页面。
 *
 * 同一类病还有 `fg-quaternary`（被上百处使用却从未定义，导致那批"最淡一级文字"
 * 实际继承了父级颜色）。已用 `--color-fg-quaternary: var(--color-fg-muted)` 收敛。
 *
 * 这组断言只钉"我们承诺要用的 token 存在"，不做全仓扫描——全量扫描需要先清掉
 * 历史遗留名（surface-base/surface-2/3/inset/tertiary、border-hover、content-*），
 * 那是独立的一笔账，不能用一条会变红的守卫替它记账。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssFile = join(here, '..', 'src', 'index.css');

const css = readFileSync(cssFile, 'utf8');

function hasToken(name: string): boolean {
  return new RegExp(`--color-${name}\\s*:`).test(css);
}

describe('主题语义色 token', () => {
  it('对话框/卡片会用到的那几个 surface token 都存在（缺一个就会渲染成透明）', () => {
    for (const token of ['surface-primary', 'surface-secondary', 'surface-elevated', 'surface-overlay']) {
      expect(hasToken(token), `主题缺少 --color-${token}`).toBe(true);
    }
  });

  it('fg 四级文字都存在（quaternary 是 muted 的别名，跟随主题变化）', () => {
    for (const token of ['fg-primary', 'fg-secondary', 'fg-tertiary', 'fg-muted']) {
      expect(hasToken(token), `主题缺少 --color-${token}`).toBe(true);
    }
    expect(hasToken('fg-quaternary')).toBe(true);
  });

  it('不存在"用了但没定义"的 surface-default（本次透明弹窗的直接原因）', () => {
    expect(hasToken('surface-default')).toBe(false);
  });
});
