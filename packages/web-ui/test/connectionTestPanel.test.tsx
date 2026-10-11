/**
 * Two-leg connection verification in the Settings card.
 *
 * What this file protects:
 *
 *  1. **The two legs are shown separately.** A single "Connected ✓" cannot
 *     express "receives but cannot send" — the exact misconfiguration that
 *     silently breaks notifications. If someone collapses the panel back to one
 *     boolean, this goes red.
 *  2. **The handshake is deliberate.** Saving is automatic, but the handshake
 *     sends a *real* message into the user's IM, so it must never fire as a side
 *     effect of typing or of an automatic save — only when asked for.
 *  3. **A live run is polled**, because the reply arrives out-of-band from the
 *     IM client — there is nothing to await in the request that started it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../src/i18n/index.ts';
import { InstanceCard, type InstanceClient } from '../src/components/integrations/InstanceCard.tsx';
import type { AgentOption } from '../src/components/integrations/AgentSelect.tsx';
import type {
  ConnectionTestSnapshot,
  InstanceStatus,
} from '../src/lib/instanceIntegrations.ts';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.useRealTimers();
});

const AGENTS: AgentOption[] = [{ id: 'agt_secretary', name: 'Secretary' }];

function instance(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: 'bi_tg_1',
    platform: 'telegram',
    label: 'Sales bot',
    enabled: true,
    connected: true,
    hasConfig: true,
    capabilities: { inbound: true, outbound: true, threads: true },
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true },
      { key: 'agentId', label: 'Agent', type: 'agent', required: false },
    ],
    values: { agentId: 'agt_secretary' },
    secrets: { botToken: { hasValue: true } },
    agentId: 'agt_secretary',
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: false,
    ...over,
  };
}

function snapshot(over: Partial<ConnectionTestSnapshot> = {}): ConnectionTestSnapshot {
  return {
    instanceId: 'bi_tg_1',
    platform: 'telegram',
    status: 'awaiting_reply',
    code: 'ABC123',
    targetChannelId: 'chat-1',
    targetChannelName: 'Ops',
    outbound: { state: 'ok', detail: 'test message accepted by the platform' },
    inbound: { state: 'pending' },
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    ...over,
  };
}

function clientStub(over: Partial<InstanceClient> = {}) {
  const client: InstanceClient = {
    create: vi.fn(async () => instance()),
    save: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, success: true })),
    remove: vi.fn(async () => undefined),
    listChannels: vi.fn(async () => ({ supported: false, channels: [] })),
    saveChannels: vi.fn(async () => undefined),
    startConnectionTest: vi.fn(async () => snapshot()),
    getConnectionTest: vi.fn(async () => null),
    ...over,
  };
  return client;
}

function renderCard(client: InstanceClient, over: Partial<InstanceStatus> = {}) {
  return render(
    <InstanceCard
      instance={instance(over)}
      client={client}
      extras={{}}
      loadAgents={async () => AGENTS}
      defaultExpanded
    />,
  );
}

describe('ConnectionTestPanel', () => {
  it('shows both legs once a run exists', async () => {
    const client = clientStub();
    renderCard(client);

    fireEvent.click(screen.getByTestId('connection-test-start'));

    await waitFor(() => expect(client.startConnectionTest).toHaveBeenCalledWith('bi_tg_1'));
    await waitFor(() => expect(screen.getAllByTestId('connection-test-leg')).toHaveLength(2));
    // The outbound leg is measured, not assumed.
    expect(screen.getByText('test message accepted by the platform')).toBeTruthy();
    expect(screen.getByText('Outbound (bot → IM)')).toBeTruthy();
    expect(screen.getByText('Inbound (IM → bot)')).toBeTruthy();
    // The prompt tells the user what to reply with, in the target conversation.
    expect(screen.getByText(/ABC123/)).toBeTruthy();
  });

  it('starts the handshake only when asked, never as a side effect of saving', async () => {
    const client = clientStub();
    renderCard(client);

    // An automatic save fires…
    fireEvent.click(screen.getByTestId('instance-enabled-bi_tg_1'));
    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 5000 });
    // …and must not have quietly sent a real IM message.
    expect(client.startConnectionTest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('connection-test-start'));
    await waitFor(() => expect(client.startConnectionTest).toHaveBeenCalledWith('bi_tg_1'));
  });

  it('polls a live run and renders the verified state when the reply lands', async () => {
    const client = clientStub({
      startConnectionTest: vi.fn(async () => snapshot()),
      getConnectionTest: vi.fn(async () =>
        snapshot({
          status: 'verified',
          outbound: { state: 'ok', detail: 'test message accepted by the platform' },
          inbound: { state: 'ok', detail: 'reply from user-1' },
        }),
      ),
    });
    renderCard(client);

    fireEvent.click(screen.getByTestId('connection-test-start'));

    // The reply arrives out-of-band from the IM client, so the only way this
    // state can reach the UI is the poll fetching it. The card polls every
    // 2.5s, so the wait must outlast one interval.
    await waitFor(() => expect(client.getConnectionTest).toHaveBeenCalled(), { timeout: 6000 });
    await waitFor(() => expect(screen.getByText('reply from user-1')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getByText(/Both directions work/)).toBeTruthy();
  }, 10000);

  it('flips the header badge to verified as soon as the run completes', async () => {
    // The durable fact is written by the gateway when the reply lands, and nothing
    // re-reads the instance list on its own — so the badge used to stay
    // "unverified" while the panel directly below it reported the handshake had
    // passed. The badge must answer from the same observation the panel shows.
    let polls = 0;
    const client = clientStub({
      startConnectionTest: vi.fn(async () => snapshot()),
      getConnectionTest: vi.fn(async () => {
        polls += 1;
        // The card adopts any pre-existing run on mount, so the first read is
        // "nothing yet"; the reply only lands on the poll after the click.
        return polls === 1
          ? null
          : snapshot({
              status: 'verified',
              outbound: { state: 'ok', detail: 'test message accepted by the platform' },
              inbound: { state: 'ok', detail: 'reply from user-1' },
            });
      }),
    });
    renderCard(client);
    const card = screen.getByTestId('instance-card-bi_tg_1');
    expect(card.getAttribute('data-connection')).toBe('unverified');

    fireEvent.click(screen.getByTestId('connection-test-start'));

    await waitFor(
      () => expect(card.getAttribute('data-connection')).toBe('verified'),
      { timeout: 6000 },
    );
  }, 10000);

  it('re-reads the list once a run completes, so the verified fact outlives the run', async () => {
    // The badge's durable answer is `lastVerifiedAt`, served by the list. A
    // completed run must therefore pull the list back in, or the badge reverts
    // the moment the transient run is forgotten.
    const client = clientStub({
      startConnectionTest: vi.fn(async () => snapshot()),
      getConnectionTest: vi.fn(async () =>
        snapshot({
          status: 'verified',
          outbound: { state: 'ok', detail: 'test message accepted by the platform' },
          inbound: { state: 'ok', detail: 'reply from user-1' },
        }),
      ),
    });
    const onChanged = vi.fn(async () => undefined);
    render(
      <InstanceCard
        instance={instance()}
        client={client}
        extras={{}}
        loadAgents={async () => AGENTS}
        onChanged={onChanged}
        defaultExpanded
      />,
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 6000 });
  }, 10000);

  it('renders an inbound-first run without a code when no target is known', async () => {
    const client = clientStub({
      startConnectionTest: vi.fn(async () =>
        snapshot({ status: 'awaiting_inbound', code: null, targetChannelId: null, outbound: { state: 'pending' } }),
      ),
    });
    renderCard(client);

    fireEvent.click(screen.getByTestId('connection-test-start'));

    await waitFor(() => expect(screen.getByText(/Send any message to this bot/)).toBeTruthy());
  });
});
