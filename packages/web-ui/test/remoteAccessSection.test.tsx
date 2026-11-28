/**
 * Remote-access onboarding wizard — component render guards (T9).
 *
 * The pure state machine is covered in `remoteAccessWizard.test.ts`. This file
 * proves the *wired* component behaves: it must render every connection method
 * (nothing silently dropped), open the six-step wizard on selection, hand the
 * operator a copy-paste command that targets the local port, and — before login —
 * ask for a Hub sign-in rather than pretending to work.
 *
 * These are the seams a future refactor is most likely to break silently, so
 * each assertion fails for a *behavioural* reason, not a snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';

// `hubApi.isAuthenticated` must be flippable per test; vi.hoisted keeps it safe
// under vi.mock's hoisting.
const state = vi.hoisted(() => ({ authed: true }));

vi.mock('../src/api.ts', () => ({
  api: {
    settings: {
      getRemoteV2: vi.fn(async () => null),
      enableRemote: vi.fn(async () => ({ ok: true })),
      disableRemote: vi.fn(async () => ({ ok: true })),
      remoteDetect: vi.fn(async () => ({ cloudflared: true, tailscale: false })),
      remoteTunnelRestart: vi.fn(async () => ({ ok: true })),
      remoteTunnelRotate: vi.fn(async () => ({ ok: true })),
      remoteTunnelStop: vi.fn(async () => ({ ok: true })),
      remoteTunnelRegister: vi.fn(async () => ({ ok: true })),
      remoteAgentSetup: vi.fn(async () => ({ ok: false })),
      remoteSetupTargets: vi.fn(async () => ({ agents: [], recommendedId: null })),
    },
  },
  hubApi: { isAuthenticated: () => state.authed },
  getHubUser: () => ({ username: 'alice' }),
  ensureHubAuth: vi.fn(async () => {}),
  wsClient: { on: vi.fn(() => () => {}) },
}));

import { RemoteAccessSection } from '../src/components/RemoteAccessSection.tsx';

beforeEach(async () => {
  state.authed = true;
  // Call history must not leak between tests (the Path-B assertions below
  // check *whether* a dispatch happened, not just its shape).
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('RemoteAccessSection — onboarding wizard', () => {
  it('offers every connection method, marking the named tunnel recommended', async () => {
    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText('Cloudflare Quick Tunnel')).toBeTruthy());

    for (const label of [
      'Cloudflare Quick Tunnel',
      'Cloudflare Named Tunnel',
      'Tailscale Funnel',
      'Tailscale Serve',
      'Custom relay / proxy',
    ]) {
      expect(screen.getByText(label), `method "${label}" must be offered`).toBeTruthy();
    }
    // 推荐的长期方案要打徽标。字形现在是自绘 SVG（不再是 ★），所以按**文案**定位，
    // 并额外断言星形图标确实画出来了 —— 只查文字的话，徽标丢了图标也能绿。
    const badge = Array.from(document.querySelectorAll('span'))
      .find(el => el.textContent?.trim() === 'Recommended');
    expect(badge, 'recommended badge must be rendered').toBeTruthy();
    expect(badge!.querySelector('svg'), 'badge must carry the drawn star icon').not.toBeNull();
  });

  it('asks for a Hub sign-in before offering setup when signed out', async () => {
    state.authed = false;
    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText(/Sign in to Markus Hub/)).toBeTruthy());
    // No method chooser is exposed until authenticated.
    expect(screen.queryByText('Cloudflare Quick Tunnel')).toBeNull();
  });

  it('walking method → "run it myself" reveals the six-step wizard and a runnable command', async () => {
    const user = userEvent.setup();
    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText('Cloudflare Quick Tunnel')).toBeTruthy());

    await user.click(screen.getByText('Cloudflare Quick Tunnel'));

    // Six steps, in order.
    for (const step of ['Install', 'Start', 'Resolve address', 'Register', 'Verify', 'Ready']) {
      expect(screen.getByText(step), `wizard step "${step}" must render`).toBeTruthy();
    }

    await user.click(screen.getByText("I'll run it myself"));

    // The run command must target the local api-server port — a wrong port is a
    // silent dead end, so assert on the actual command string.
    await waitFor(() => {
      const code = screen.getAllByText((_, el) => el?.tagName === 'CODE' && /cloudflared/.test(el.textContent ?? ''));
      expect(code.length).toBeGreaterThan(0);
      expect(code.some((n) => /(?:localhost|127\.0\.0\.1):\d+/.test(n.textContent ?? ''))).toBe(true);
    });
  });

  it('shows the honest-limits disclosure', async () => {
    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText('Good to know')).toBeTruthy());
  });

  // ── Path B (T10) ──────────────────────────────────────────────────────────

  it('path B: prefills the chosen Agent\'s chat with the plan instead of dispatching it', async () => {
    const { api } = await import('../src/api.ts');
    const { navBus } = await import('../src/navBus.ts');
    const nav = vi.spyOn(navBus, 'navigate');
    (api.settings.remoteSetupTargets as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: [{ id: 'secretary', name: 'Secretary', role: 'secretary' }],
      recommendedId: 'secretary',
    });
    (api.settings.remoteAgentSetup as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      agentId: 'secretary',
      prompt: 'PLEASE SET UP THE TUNNEL\nbrew install cloudflared',
      contract: {
        goal: 'Set up a Cloudflare quick tunnel for Markus',
        commands: [
          {
            id: 'install',
            shell: 'sh',
            run: 'brew install cloudflared',
            purpose: 'install the tunnel binary',
            sensitive: true,
            idempotent: true,
          },
        ],
        successCriteria: [],
        rollback: [],
      },
    });

    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText('Cloudflare Quick Tunnel')).toBeTruthy());
    await userEvent.click(screen.getByText('Cloudflare Quick Tunnel'));
    // Step 1 — reveal the picker. Nothing is built yet: choosing the recipient is
    // the user's call, never something the wizard does silently on their behalf.
    await userEvent.click(await screen.findByText('Let an Agent do it'));
    expect(api.settings.remoteAgentSetup).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());

    // Step 2 — press the hand-off button.
    await userEvent.click(screen.getByRole('button', { name: /Open in the Agent's chat/i }));

    // The request carries the server's recommended Agent and the chosen kind.
    await waitFor(() =>
      expect(api.settings.remoteAgentSetup).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cloudflare_quick', agentId: 'secretary' }),
      ),
    );
    // The commands the Agent will run are shown verbatim (consent, not surprise).
    await waitFor(() => expect(screen.getByText('brew install cloudflared')).toBeTruthy());
    // ...and the plan lands in the Agent's composer for the user to send — it is
    // never dispatched on their behalf (that would make the run a black box).
    await waitFor(() =>
      expect(nav).toHaveBeenCalledWith(
        'team',
        expect.objectContaining({
          agentId: 'secretary',
          prefillMessage: 'PLEASE SET UP THE TUNNEL\nbrew install cloudflared',
        }),
      ),
    );
    expect(screen.getByText(/Prefilled the task into the Agent's chat/i)).toBeTruthy();
  });

  it('path B: explains "no Agent available" instead of offering a dead button', async () => {
    const { api } = await import('../src/api.ts');
    (api.settings.remoteSetupTargets as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: [],
      recommendedId: null,
    });
    (api.settings.remoteAgentSetup as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'No Agent is available to run the setup.',
    });

    render(<RemoteAccessSection />);
    await waitFor(() => expect(screen.getByText('Cloudflare Quick Tunnel')).toBeTruthy());
    await userEvent.click(screen.getByText('Cloudflare Quick Tunnel'));
    await userEvent.click(await screen.findByText('Let an Agent do it'));

    // No silent dead end: the panel explains the missing prerequisite...
    await waitFor(() =>
      expect(screen.getByText(/No Agent is available\. Create or start one first\./)).toBeTruthy(),
    );
    // ...and the hand-off button is disabled rather than appearing to work.
    const handOff = screen.getByRole('button', { name: /Open in the Agent's chat/i });
    expect((handOff as HTMLButtonElement).disabled).toBe(true);
    expect(api.settings.remoteAgentSetup).not.toHaveBeenCalled();
  });
});
