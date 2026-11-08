/**
 * Guards for the shared "send to conversation" picker.
 *
 * The Owner's asks (2026-10-27) that these lock in:
 *   • workflows use the SAME picker as tasks/requirements (one implementation),
 *   • the picker shows real avatars instead of 🤖/👤 placeholders,
 *   • on open it scrolls the already-selected recipient into view, then leaves
 *     scrolling to the user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentInfo, HumanUserInfo } from '../src/api.ts';

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

/** Session list + last-message snippet requests the picker makes (card 7 ②). */
const sessionsApi = vi.hoisted(() => ({
  listByAgent: vi.fn(),
  getMessages: vi.fn(),
}));

vi.mock('../src/api.ts', () => ({ api: { sessions: sessionsApi } }));

vi.mock('../src/navBus.ts', () => ({ navBus: { navigate: nav.navigate } }));
vi.mock('react-i18next', () => {
  const t = (key: string, opts?: unknown) => {
    if (typeof opts === 'string') return opts;
    const fallback = (opts as { defaultValue?: string } | undefined)?.defaultValue ?? key;
    return fallback.replace(/{{(\w+)}}/g, (_m, name: string) =>
      String((opts as Record<string, unknown> | undefined)?.[name] ?? ''),
    );
  };
  return { useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }) };
});

import { SendToChatModal, resolveDefaultChatTarget } from '../src/components/SendToChat.tsx';

const agents = [
  { id: 'a1', name: 'Alpha 经理', role: '', status: 'active', skills: [], avatarUrl: '/api/avatars/a1.png' },
  { id: 'a2', name: 'Beta 工程师', role: '', status: 'idle', skills: [] },
] as unknown as AgentInfo[];

const users = [
  { id: 'u1', name: '老板', avatarUrl: '/api/avatars/u1.png' },
] as unknown as HumanUserInfo[];

function renderModal(overrides: Partial<Parameters<typeof SendToChatModal>[0]> = {}) {
  return render(
    <SendToChatModal
      chipLabel="标准功能开发流程"
      chipContent="@[标准功能开发流程](workflow:feature-dev)"
      agents={agents}
      users={users}
      defaultTarget="agent:a1"
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  nav.navigate.mockClear();
  sessionsApi.listByAgent.mockReset();
  sessionsApi.getMessages.mockReset();
  // Default: exactly one existing conversation with one message.
  sessionsApi.listByAgent.mockResolvedValue({
    sessions: [{ id: 's1', agentId: 'a2', title: '唯一对话', lastMessageAt: '2026-11-05T10:00:00Z' }],
    total: 1, page: 1, pageSize: 20, hasMore: false,
  });
  sessionsApi.getMessages.mockResolvedValue({
    messages: [{ id: 'm1', content: '上一句', createdAt: '2026-11-05T10:00:00Z' }],
    hasMore: false,
  });
});

describe('send-to-chat picker — recipients', () => {
  it('shows agent and human recipients with real avatars', () => {
    const { container } = renderModal();
    const imgs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(imgs).toContain('/api/avatars/a1.png');
    expect(imgs).toContain('/api/avatars/u1.png');
    // no emoji placeholders left in the list
    expect(container.textContent).not.toContain('🤖');
    expect(container.textContent).not.toContain('👤');
  });

  it('falls back to an initials badge for an agent without an avatar', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('B'); // Beta 工程师's initial
  });

  it('preselects the default target and marks it in the DOM', () => {
    const { container } = renderModal();
    const selected = container.querySelector('[data-selected="true"]');
    expect(selected?.textContent).toContain('Alpha 经理');
    expect(selected?.getAttribute('aria-current')).toBe('true');
  });

  it('scrolls the selected row into view on open, once', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    renderModal();
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // searching re-renders the list; the initial scroll must not repeat
    const search = screen.getByPlaceholderText('搜索智能体或成员…');
    fireEvent.change(search, { target: { value: 'Beta' } });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the context chip to the chosen recipient — solo conversation needs no extra click', async () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    const betaRow = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Beta 工程师'),
    )!;
    fireEvent.click(betaRow);
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));

    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    expect(nav.navigate).toHaveBeenCalledWith('team', expect.objectContaining({
      agentId: 'a2',
      // Exactly one conversation → it is used directly (no second step).
      sessionId: 's1',
      chatChips: JSON.stringify([{
        kind: 'note',
        label: '标准功能开发流程',
        content: '@[标准功能开发流程](workflow:feature-dev)',
      }]),
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('asks WHICH conversation when the agent owns several, and sends into the chosen one', async () => {
    sessionsApi.listByAgent.mockResolvedValue({
      sessions: [
        { id: 's1', agentId: 'a2', title: '老对话', lastMessageAt: '2026-11-05T10:00:00Z' },
        { id: 's2', agentId: 'a2', title: '新对话', lastMessageAt: '2026-11-05T12:00:00Z' },
      ],
      total: 2, page: 1, pageSize: 20, hasMore: false,
    });
    const { container } = renderModal();
    fireEvent.click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Beta 工程师'))!);
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));

    // Second level lists both conversations with their latest message snippet.
    const rows = await screen.findAllByRole('button', { name: /新对话|老对话/ });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('上一句');

    fireEvent.click(rows.find(r => r.textContent?.includes('新对话'))!);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('team', expect.objectContaining({
      agentId: 'a2',
      sessionId: 's2',
    })));
  });

  it('sends to a NEW conversation (no sessionId) when the agent has none yet', async () => {
    sessionsApi.listByAgent.mockResolvedValue({ sessions: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    const { container } = renderModal();
    fireEvent.click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Beta 工程师'))!);
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));

    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    const params = (nav.navigate.mock.calls[0] as [string, Record<string, string>])[1];
    expect(params.agentId).toBe('a2');
    expect(params.sessionId).toBeUndefined();
  });

  it('shows a readable failure and still lets the user send to the default conversation', async () => {
    sessionsApi.listByAgent.mockRejectedValue(new Error('boom'));
    const { container } = renderModal();
    fireEvent.click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Beta 工程师'))!);
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));

    const banner = await screen.findByText(/读取对话失败|Could not load/);
    expect(banner).toBeTruthy();
    // Never a dead end: the escape hatch sends into the default conversation.
    fireEvent.click(container.querySelector('[data-send-to-default-session]') as HTMLElement);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    const params = (nav.navigate.mock.calls[0] as [string, Record<string, string>])[1];
    expect(params.agentId).toBe('a2');
    expect(params.sessionId).toBeUndefined();
  });

  it('never asks about conversations when the recipient is a human', async () => {
    const { container } = renderModal({ defaultTarget: 'human:u1' });
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));
    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    expect(sessionsApi.listByAgent).not.toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith('team', expect.objectContaining({ dm: 'u1' }));
  });
});

describe('resolveDefaultChatTarget', () => {
  it('accepts a workflow owner (team manager) and falls back sensibly', () => {
    expect(resolveDefaultChatTarget('a1', agents, users)).toBe('agent:a1');
    expect(resolveDefaultChatTarget('u1', agents, users)).toBe('human:u1');
    expect(resolveDefaultChatTarget(undefined, agents, users)).toBe('agent:a1');
    expect(resolveDefaultChatTarget(undefined, [], users)).toBe('human:u1');
    expect(resolveDefaultChatTarget(undefined, [], [])).toBe('');
  });
});
