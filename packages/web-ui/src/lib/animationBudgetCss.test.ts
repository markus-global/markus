import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 样式侧的守卫测试。
 *
 * 为什么这里只能用「读源码 + 断言文本」而不是行为测试：常驻 CSS 动画的代价是
 * **浏览器渲染管线**的行为（每帧一次全文档 style recalc），jsdom 不实现布局与
 * 合成，测不出来。真实证据来自 CDP 挂真实桌面实例的实测：6 条 infinite 动画
 * 常驻时 idle style recalc 122 次/秒，归零到 5.3 次/秒（一次性探针，未入库）。
 *
 * 所以这个文件是**栅栏**，不是完整证明：它拦住"又有人新开一条 infinite 动画"
 * 这个最昂贵、也最容易复发的错误。失效边界要说清——它只认 `animation:` 简写
 * 里的 `infinite`；换成 `animation-iteration-count: infinite` 或 `@property`
 * 驱动的 JS 动画它抓不到。
 */

// 不能依赖 import.meta.url：在 happy-dom 项目里它不一定是 file: 协议。
// 从 cwd 出发找两个候选（仓库根 或 包根），哪个存在用哪个。
const CANDIDATES = [
  resolve(process.cwd(), 'packages/web-ui/src/index.css'),
  resolve(process.cwd(), 'src/index.css'),
];
const CSS_PATH = CANDIDATES.find(p => existsSync(p));
if (!CSS_PATH) throw new Error(`找不到 index.css，试过：${CANDIDATES.join(' / ')}`);
const CSS = readFileSync(CSS_PATH, 'utf8');

/** 去掉 /* ... *\/ 注释，避免注释里的历史说明被当成真规则。 */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('index.css · 动画预算（不允许常驻 CSS 动画）', () => {
  it('没有任何 infinite 的 CSS 动画', () => {
    const offenders: string[] = [];
    const re = /animation\s*:\s*([^;}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CSS_NO_COMMENTS)) !== null) {
      const decl = m[1];
      if (/\binfinite\b/.test(decl)) {
        const line = CSS_NO_COMMENTS.slice(0, m.index).split('\n').length;
        offenders.push(`第 ${line} 行: animation: ${decl.trim()}`);
      }
    }
    expect(
      offenders,
      `发现常驻 CSS 动画。任何 infinite 动画都会让合成器每帧产帧（ProMotion 上 120/s），` +
      `并且每一帧触发一次全文档样式重算——实测这会让空闲期主线程常驻占用 15–21%。\n` +
      `改用 animationBudget 的 4Hz tick：给元素写 \`animation: none\` + 用 var(--anim-p) 派生。\n` +
      offenders.join('\n'),
    ).toEqual([]);
  });

  it('8 个 tick 状态都定义了 --anim-p（新动效一律用它派生）', () => {
    for (let phase = 0; phase < 8; phase++) {
      const re = new RegExp(`html\\[data-anim-tick='${phase}'\\][^{]*\\{[^}]*--anim-p:`);
      expect(re.test(CSS_NO_COMMENTS), `phase ${phase} 缺少 --anim-p`).toBe(true);
    }
  });

  it('--anim-p 在各 tick 之间递增（0 → 0.875 的锯齿）', () => {
    const values: number[] = [];
    for (let phase = 0; phase < 8; phase++) {
      const m = new RegExp(`html\\[data-anim-tick='${phase}'\\][^{]*\\{[^}]*--anim-p:\\s*([0-9.]+)`).exec(CSS_NO_COMMENTS);
      expect(m, `phase ${phase} 缺少 --anim-p`).not.toBeNull();
      values.push(Number(m![1]));
    }
    expect(values[0]).toBe(0);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `phase ${i} 的 --anim-p 没有递增`).toBeGreaterThan(values[i - 1]);
    }
  });

  it('transition-all 已被收窄，不再过渡「所有属性」', () => {
    const m = /\.transition-all\s*\{([^}]*)\}/.exec(CSS_NO_COMMENTS);
    expect(m, '.transition-all 收窄规则不见了——Tailwind 默认值会过渡所有属性').not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/transition-property\s*:/);
    // `all` 会把 scrollbar-color 这类非合成的继承属性也带上，每帧重算样式
    expect(body, 'transition-property 里又出现了 all').not.toMatch(/transition-property\s*:\s*all\b/);
    expect(body, 'scrollbar-color 不该参与过渡').not.toMatch(/scrollbar-color/);
  });
});
