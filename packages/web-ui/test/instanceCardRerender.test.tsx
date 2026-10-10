/**
 * P0 regression — "pick an agent, the card re-renders, the choice is gone".
 *
 * The card derives its form state from `status`, a value it rebuilds from the
 * `instance` prop on every render (`instanceAsPlatform(instance)` inside
 * `InstanceCard`). The draft-reset effect keys on that object's *content
 * fingerprint*, not its identity, so an unrelated re-render — typing, a channel
 * list arriving, the parent re-reading for its own reasons — changes the object
 * reference while leaving the fingerprint intact. It used to depend on the
 * object's identity, so any such re-render reset the whole form to the stored
 * values and silently dropped an unsaved agent pick; the following save then
 * wrote the empty value back.
 *
 * These tests pin **both halves** of the fix:
 *   • a re-render keeps the draft (the bug), and
 *   • a real data change still reloads it (so nobody "fixes" it by deleting the
 *     effect, which would break read-after-save).
 *
 * A bot card saves itself, so both scenarios are written around the auto-save
 * debounce (`AUTOSAVE_DEBOUNCE_MS = 700`): the first asserts the pick is *still
 * unsaved* the instant it re-renders (nothing has been written yet), then lets
 * the debounce fire and checks what eventually reached the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import type { InstanceStatus } from '../src/lib/instanceIntegrations.ts';
import {
  InstanceCard,
  type InstanceClient,
} from '../src/components/integrations/InstanceCard.tsx';
import type { AgentOption } from '../src/components/integrations/AgentSelect.tsx';
import type { PlatformField } from '../src/lib/platformIntegrations.ts';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

const AGENTS: AgentOption[] = [
  { id: 'agt_secretary', name: 'Secretary' },
  { id: 'agt_cto', name: 'CTO' },
];

/**
 * The manifest a bound-agent pick flows through: `agentId` is a `type: 'agent'`
 * field, so it renders the agent picker (never a plain text box) and is a
 * required field, which is what keeps the auto-save legal.
 */
const FIELDS: PlatformField[] = [
  { key: 'appId', label: 'App ID', type: 'text', required: true },
  { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
  { key: 'agentId', label: 'Bound agent', type: 'agent', required: true },
];

/**
 * A stored bot bound to the secretary, the way the server projects one. The
 * secret is *present* (never sent down) and the required credentials are in
 * place, so a save is not (correctly) held back — otherwise the "what got
 * saved" assertions below would pass for the wrong reason.
 */
function makeInstance(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: 'bi_fs_default',
    platform: 'feishu',
    label: 'Default',
    enabled: true,
    connected: true,
    hasConfig: true,
    capabilities: { inbound: true, outbound: true, threads: true, cards: true },
    fields: FIELDS,
    values: { appId: 'cli_abc' },
    secrets: { appSecret: { hasValue: true } },
    agentId: 'agt_secretary',
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: false,
    lastVerifiedAt: null,
    ...over,
  };
}

/** An instance client that records every call instead of hitting the network. */
function clientStub(over: Partial<InstanceClient> = {}) {
  const calls: Array<{ op: string; id?: string; platform?: string; payload?: Record<string, unknown> }> = [];
  const client: InstanceClient = {
    create: vi.fn(async (platform, label) => {
      calls.push({ op: 'create', platform, payload: { label } });
      return makeInstance({ id: 'bi_new', platform, label });
    }),
    save: vi.fn(async (id, payload) => {
      calls.push({ op: 'save', id, payload });
    }),
    test: vi.fn(async () => ({ ok: true, message: 'pong' })),
    remove: vi.fn(async (id) => {
      calls.push({ op: 'remove', id });
    }),
    listChannels: vi.fn(async () => ({ supported: false, channels: [] })),
    saveChannels: vi.fn(async (id) => {
      calls.push({ op: 'saveChannels', id });
    }),
    startConnectionTest: vi.fn(async () => {
      throw new Error('not exercised by this test');
    }),
    getConnectionTest: vi.fn(async () => null),
    ...over,
  };
  return { client, calls };
}

/** A stable loader, so the picker does not re-fetch on every harness render. */
const loadAgents = () => Promise.resolve(AGENTS);

/**
 * Renders the card the way `InstanceCard` consumes it: `instance` is rebuilt on
 * **every** render (a brand-new object carrying the same stored data), so its
 * identity changes while its content does not. Inside the card that becomes a
 * new `status` object on each render — the exact shape that used to wipe the
 * draft.
 */
function Harness({
  client,
  stored,
  reloadTo,
}: {
  client: InstanceClient;
  stored?: Partial<InstanceStatus>;
  reloadTo?: Partial<InstanceStatus>;
}) {
  const [data, setData] = useState<Partial<InstanceStatus>>(stored ?? {});
  return (
    <div>
      <button type="button" data-testid="unrelated-rerender" onClick={() => setData({ ...data })}>
        unrelated
      </button>
      {reloadTo && (
        <button type="button" data-testid="reload-data" onClick={() => setData(reloadTo)}>
          reload
        </button>
      )}
      <InstanceCard
        instance={makeInstance(data)}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />
    </div>
  );
}

async function pickAgent(user: ReturnType<typeof userEvent.setup>, name: string) {
  const box = await screen.findByRole('combobox', { name: 'Bound agent' });
  await user.click(box);
  await user.click(within(await screen.findByRole('listbox')).getByText(name));
}

describe('InstanceCard — agent binding survives an unrelated re-render', () => {
  it('keeps an unsaved agent pick when the card re-renders for an unrelated reason', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    render(<Harness client={client} />);

    const box = await screen.findByRole('combobox', { name: 'Bound agent' });
    // The server default (the secretary) is what the form opens with.
    expect((box as HTMLInputElement).value).toBe('Secretary');

    await pickAgent(user, 'CTO');
    expect((screen.getByRole('combobox', { name: 'Bound agent' }) as HTMLInputElement).value).toBe('CTO');

    // Premise guard: the pick is genuinely unsaved right now. This runs well
    // inside the 700 ms auto-save debounce, so nothing has been written yet —
    // if it had been, "the draft survived the re-render" would be vacuous.
    expect(calls.some((c) => c.op === 'save')).toBe(false);

    // The parent re-renders and hands the card a brand-new `instance` object
    // that carries the same (unchanged) stored values. The pick must survive.
    await user.click(screen.getByTestId('unrelated-rerender'));
    expect((screen.getByRole('combobox', { name: 'Bound agent' }) as HTMLInputElement).value).toBe('CTO');

    // …and what gets saved (once the debounce fires) is the pick, not the stale
    // stored value.
    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')?.payload?.['agentId']).toBe('agt_cto');
  });

  it('still adopts genuinely new stored data (the effect is not simply removed)', async () => {
    const user = userEvent.setup();
    const { client } = clientStub();
    render(<Harness client={client} reloadTo={{ agentId: 'agt_cto' }} />);

    expect((await screen.findByRole('combobox', { name: 'Bound agent' }) as HTMLInputElement).value).toBe(
      'Secretary',
    );

    // A real re-read (after save, or a QR registration) changes the stored data;
    // the form must follow it.
    await user.click(screen.getByTestId('reload-data'));
    expect((screen.getByRole('combobox', { name: 'Bound agent' }) as HTMLInputElement).value).toBe('CTO');
  });
});
