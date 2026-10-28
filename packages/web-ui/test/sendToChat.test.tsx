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
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentInfo, HumanUserInfo } from '../src/api.ts';

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

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

  it('sends the context chip to the chosen recipient', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    const betaRow = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Beta 工程师'),
    )!;
    fireEvent.click(betaRow);
    fireEvent.click(screen.getByRole('button', { name: '发送到对话' }));

    expect(nav.navigate).toHaveBeenCalledWith('team', expect.objectContaining({
      agentId: 'a2',
      chatChips: JSON.stringify([{
        label: '标准功能开发流程',
        content: '@[标准功能开发流程](workflow:feature-dev)',
      }]),
    }));
    expect(onClose).toHaveBeenCalled();
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
