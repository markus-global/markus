/**
 * 「输出气泡里的链接只是一段死文本」——回归守卫。
 *
 * 症状（Owner 2026-11-27 报）：markus provider 积分不足时，气泡里显示
 * “余额不足，请充值或升级计划：https://markus.global/settings?tab=billing”，
 * 那个地址既不能点，点开也不该落在内嵌右侧栏——充值要带用户自己的登录态，
 * 必须在系统浏览器里完成。
 *
 * 这里断言的是**渲染结果 + 点击去向**，不是「调了某个函数」：
 *   · 地址必须是真正的 <a href>（死文本会直接变红）；
 *   · 点击必须走 Electron 桥（openExternal），而不是被 markdown 的右侧栏
 *     路由接走；
 *   · 同一句系统注释在气泡里只能出现**一次**（正文兜底与底部注释曾经各渲染
 *     一遍，一个能点、一个不能点）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const fx = vi.hoisted(() => {
  const BILLING_URL = 'https://markus.global/settings?tab=billing';
  return { BILLING_URL, FRIENDLY_CU: `⚠ 余额不足，请充值或升级计划：${BILLING_URL}` };
});

vi.mock('react-i18next', () => {
  // 词条扳手等于 locale 文件里的那一行（真实文案由 locale parity 测试看着）；
  // 这里只关心「美化后的那句话」能不能真的落在 DOM 里。
  const DICT: Record<string, string> = { 'team:errors.markusCuExceeded': fx.FRIENDLY_CU };
  const t = (key: string, opts?: unknown) => {
    const fallback = (opts as { defaultValue?: string } | undefined)?.defaultValue;
    return fallback ?? DICT[key] ?? key;
  };
  return {
    useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }),
    // i18n/index.ts 是模块单例，被这套组件的依赖链间接导入；它要 .use(initReactI18next)。
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

const stub = vi.hoisted(() => {
  const win = ((globalThis as unknown as { window?: Record<string, unknown> }).window ?? {}) as Record<string, unknown>;
  win['__MARKUS_HUB_BASE_URL__'] = '';
  win['location'] = { origin: 'http://localhost' };
  if (typeof win['innerWidth'] !== 'number') win['innerWidth'] = 1024;
  if (typeof win['matchMedia'] !== 'function') {
    win['matchMedia'] = (query: string) => ({
      matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
  }
  const openExternal = vi.fn();
  win['markusDesktop'] = { openExternal, isMAS: false };
  (globalThis as unknown as { window: unknown }).window = win;
  return { openExternal };
});

import { LinkifiedText } from '../src/components/LinkifiedText.tsx';
import { splitBareUrls } from '../src/components/markdown-utils.ts';
import { AgentMessageBody } from '../src/pages/ChatComponents.tsx';
import { dbMsgToChat, channelMsgToChat } from '../src/pages/ChatHelpers.ts';
import type { ChatMsg } from '../src/pages/ChatHelpers.ts';

const BILLING_URL = fx.BILLING_URL;
const CU_NOTICE = fx.FRIENDLY_CU;

function errorMsg(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: 'm1', sender: 'agent', text: CU_NOTICE,
    time: '11:25', agentName: 'Markus', isError: true,
    ...overrides,
  } as ChatMsg;
}

const anchors = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('a')) as HTMLAnchorElement[];

beforeEach(() => {
  stub.openExternal.mockClear();
});

describe('splitBareUrls — 与 markdown autolink 共用同一套 URL 边界', () => {
  it('把中文标点与句末标点留在链接之外', () => {
    const parts = splitBareUrls(`额度不足。请充值：${BILLING_URL}。谢谢`);
    expect(parts.filter(p => p.kind === 'link').map(p => p.value)).toEqual([BILLING_URL]);
    expect(parts[parts.length - 1]!.value).toBe('。谢谢');
  });

  it('没有 URL 时只有一段纯文本', () => {
    expect(splitBareUrls('没有链接的一句话')).toEqual([{ kind: 'text', value: '没有链接的一句话' }]);
  });
});

describe('LinkifiedText — 链接是真的 <a>，点击离开应用', () => {
  it('渲染 <a href>，且点击走 Electron openExternal（不是内嵌面板）', () => {
    const { container } = render(<LinkifiedText text={`余额不足，请充值：${BILLING_URL}`} />);
    const [a] = anchors(container);
    expect(a).toBeTruthy();
    expect(a!.getAttribute('href')).toBe(BILLING_URL);

    fireEvent.click(a!);

    expect(stub.openExternal).toHaveBeenCalledTimes(1);
    expect(stub.openExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it('纯文本里没有 URL 时不产生任何 <a>', () => {
    const { container } = render(<LinkifiedText text="额度不足，请联系管理员" />);
    expect(anchors(container)).toHaveLength(0);
  });
});

describe('错误气泡 — 同一句注释只渲染一次，且链接可点', () => {
  it('没有 segments（刚失败的气泡）：地址是可点的外链', () => {
    const { container } = render(
      <AgentMessageBody msg={errorMsg({ segments: [] })} isStreaming={false} liveActivities={[]} />,
    );
    const links = anchors(container);
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(BILLING_URL);

    fireEvent.click(links[0]!);
    expect(stub.openExternal).toHaveBeenCalledWith(BILLING_URL);

    // 句子本身仍然完整可见（不是把 URL 换成了「打开链接」四个字）。
    expect(container.textContent).toContain('余额不足，请充值或升级计划');
  });

  it('历史消息把报错存成了 text 段：正文渲染它，注释行不再重复，点击仍走外链', () => {
    const { container } = render(
      <AgentMessageBody
        msg={errorMsg({ segments: [{ type: 'text', content: CU_NOTICE }] })}
        isStreaming={false}
        liveActivities={[]}
      />,
    );
    const links = anchors(container);
    expect(links).toHaveLength(1);
    const occurrences = (container.textContent ?? '').split('请充值或升级计划').length - 1;
    expect(occurrences).toBe(1);

    // 这条路径以前走 MarkdownMessage：链接能点，但被路由进内嵌右侧栏。
    // 充值必须在系统浏览器里完成，所以这里钉死去向。
    fireEvent.click(links[0]!);
    expect(stub.openExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it('segments 只有过程段、报错只在 msg.text：由注释行渲染，仍然只有一处', () => {
    const { container } = render(
      <AgentMessageBody
        msg={errorMsg({ segments: [{ type: 'tool', tool: 'chat', status: 'done' }] as never })}
        isStreaming={false}
        liveActivities={[]}
      />,
    );
    expect(anchors(container)).toHaveLength(1);
    const occurrences = (screen.getByText(/余额不足，请充值或升级计划/).textContent ?? '')
      .split('余额不足，请充值或升级计划').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('翻页回来（历史行里只有 provider 原文）', () => {
  // 老板 2026-11-27：出错当场是“余额不足 + 可点链接”，切走再切回来变成
  // `CU_EXCEEDED: Credits exhausted…`，链接也没了。DB 里存的永远是原文，
  // 所以展示层必须从原文重新生成同一句话。
  const RAW = '⚠ Error: [markus:qwen/qwen4-max] CU_EXCEEDED: Credits exhausted. Please top up or upgrade your plan.';
  const row = {
    id: 'm_hist', sessionId: 's1', role: 'assistant', content: RAW,
    createdAt: '2026-11-27T03:30:00.000Z',
    metadata: { isError: true, segments: [{ type: 'text', content: RAW, createdAt: '2026-11-27T03:30:00.000Z' }] },
  } as never;

  it('重新变成同一句中文提醒，且链接可点、去系统浏览器', () => {
    const msg = dbMsgToChat(row);
    expect(msg.errorRaw).toBe(RAW);

    const { container } = render(<AgentMessageBody msg={msg} isStreaming={false} liveActivities={[]} />);

    expect(container.textContent).toContain('请充值或升级计划');
    expect(container.textContent).not.toContain('CU_EXCEEDED');
    const links = anchors(container);
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(BILLING_URL);

    fireEvent.click(links[0]!);
    expect(stub.openExternal).toHaveBeenCalledWith(BILLING_URL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 系统性回归：「刷新后变原话」不是 CU_EXCEEDED 一个类的问题，是**所有** provider
// 报错的问题。这里按错误类建矩阵，两条持久化映射（单聊 / 群聊）都走一遍：
//   · 不能漏出 provider 原话（错误码、request_id、JSON 体）；
//   · 必须命中**该类**的友好文案（落到 aiGeneric 兜底也算错分类）；
//   · 系统提示（本来就是人话）不得被包进 aiGeneric。
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_ERROR_CASES: Array<{ name: string; raw: string; expectText: string }> = [
  {
    name: 'markus CU_EXCEEDED',
    raw: '⚠ Error: [markus:qwen/qwen4-max] CU_EXCEEDED: Credits exhausted. Please top up or upgrade your plan.',
    expectText: '余额不足，请充值或升级计划',
  },
  {
    name: 'deepseek 402 insufficient balance',
    raw: '⚠ Error: [deepseek:deepseek-v4-flash] OpenAI API error 402: {"error":{"message":"Insufficient Balance (request_id: 63b6ee7e-23e1-492c-be4f-9f96eb3905d2)","type":"insufficient_balance_error","param":null,"code":"invalid_request_error"}}',
    expectText: 'team:errors.ai402',
  },
  {
    name: '401 bad key',
    raw: '⚠ Error: [openai:gpt-x] OpenAI API error 401: {"error":{"message":"Incorrect API key provided"}}',
    expectText: 'team:errors.ai401',
  },
  {
    name: '429 rate limited',
    raw: '⚠ Error: [x:y] HTTP 429: rate limit reached',
    expectText: 'team:errors.ai429',
  },
  {
    name: 'context overflow',
    raw: '⚠ Error: [x:y] CONTEXT OVERFLOW: requested 200000 tokens, maximum context length is 128000 tokens',
    expectText: 'team:errors.aiContextOverflow',
  },
];

describe('系统性：所有 provider 报错类的持久化行都重建为友好文案', () => {
  for (const c of PROVIDER_ERROR_CASES) {
    it(`单聊历史行：${c.name}`, () => {
      const row = {
        id: 'm_err', sessionId: 's1', role: 'assistant', content: c.raw,
        createdAt: '2026-11-27T10:00:00.000Z', metadata: { isError: true },
      } as never;
      const { container } = render(
        <AgentMessageBody msg={dbMsgToChat(row)} isStreaming={false} liveActivities={[]} />,
      );
      const shown = container.textContent ?? '';
      // 原话不得漏出
      expect(shown).not.toContain('request_id');
      expect(shown).not.toContain('"error"');
      expect(shown).not.toContain('insufficient_balance_error');
      // 必须落到**该类**的文案，而不是 aiGeneric 兜底
      expect(shown).toContain(c.expectText);
      expect(shown).not.toContain('aiGeneric');
    });

    it(`群聊历史行：${c.name}`, () => {
      const row = {
        id: 'cm_err', text: c.raw, senderType: 'agent', senderName: 'A',
        senderId: 'agt_x', createdAt: '2026-11-27T10:00:00.000Z', metadata: null,
      } as never;
      const msg = channelMsgToChat(row);
      expect(msg.errorRaw).toBe(c.raw);
      const { container } = render(<AgentMessageBody msg={msg} isStreaming={false} liveActivities={[]} />);
      const shown = container.textContent ?? '';
      expect(shown).not.toContain('request_id');
      expect(shown).toContain(c.expectText);
      expect(shown).not.toContain('aiGeneric');
    });
  }

  it('系统提示（本来就是人话）原样显示，不被包进 aiGeneric', () => {
    const note = '该 agent 已停止，这条消息没有投递。';
    const { container } = render(
      <AgentMessageBody
        msg={{ id: 'm_note', sender: 'agent', text: note, time: '', isError: true, errorRaw: note } as never}
        isStreaming={false}
        liveActivities={[]}
      />,
    );
    const shown = container.textContent ?? '';
    expect(shown).toContain(note);
    expect(shown).not.toContain('aiGeneric');
  });
});
