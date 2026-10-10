/**
 * Bot-instance UI — regression guards (slice G5, messaging gateway).
 *
 * Two things this file exists to protect:
 *
 *  1. **Zero UI code per platform** (inherited from the platform-manifest
 *     programme). `mattermost` exists nowhere in the front-end; the section is
 *     rendered with it and every manifest-typed field must still appear. If
 *     someone reintroduces a per-platform branch, this goes red.
 *  2. **One platform, many bots.** Two instances of the same platform render as
 *     two independent cards; creating a second bot and binding a chat must be
 *     reachable from the UI alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import type { PlatformStatus } from '../src/lib/platformIntegrations.ts';
import {
  bindingFor,
  buildRoutingPayload,
  filterChannels,
  groupByPlatform,
  instanceAsPlatform,
  orphanBindings,
  removeChannelBinding,
  setChannelBinding,
  visiblePlatformIds,
  type InstanceChannelBinding,
  type InstanceStatus,
} from '../src/lib/instanceIntegrations.ts';
import { InstancesSection } from '../src/components/integrations/InstancesSection.tsx';
import type { InstanceClient } from '../src/components/integrations/InstanceCard.tsx';
import type { AgentOption } from '../src/components/integrations/AgentSelect.tsx';
import type { ConnectionTestSnapshot } from '../src/lib/instanceIntegrations.ts';
import { PLATFORM_EXTRAS } from '../src/components/integrations/platformExtras.tsx';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A platform the front-end has never heard of — the whole point. */
const MATTERMOST: PlatformStatus = {
  id: 'mattermost',
  label: 'Mattermost',
  docsUrl: 'https://developers.mattermost.com/',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'serverUrl', label: 'Server URL', type: 'text', required: true, placeholder: 'https://chat.example.com' },
    { key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
    { key: 'retries', label: 'Retries', type: 'number', required: false, default: 3 },
    { key: 'verifyTls', label: 'Verify TLS', type: 'boolean', required: false, default: true },
  ],
  defaultEnabled: false,
  enabled: false,
  connected: false,
  hasConfig: false,
  values: {},
  secrets: { botToken: { hasValue: false } },
};

const FEISHU_PLATFORM: PlatformStatus = {
  id: 'feishu',
  label: 'Feishu / Lark',
  capabilities: { inbound: true, outbound: true, threads: true, cards: true },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true },
    { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
    { key: 'agentId', label: 'Agent', type: 'agent', required: false },
  ],
  defaultEnabled: false,
  enabled: true,
  connected: true,
  hasConfig: true,
  values: { appId: 'cli_abc' },
  secrets: { appSecret: { hasValue: true } },
};

function instance(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: 'bi_mm_default',
    platform: 'mattermost',
    label: 'Default',
    enabled: false,
    connected: false,
    hasConfig: false,
    capabilities: MATTERMOST.capabilities,
    fields: MATTERMOST.fields,
    values: {},
    secrets: { botToken: { hasValue: false } },
    agentId: null,
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: true,
    lastVerifiedAt: null,
    ...over,
  };
}

const AGENTS: AgentOption[] = [
  { id: 'agt_secretary', name: 'Secretary' },
  { id: 'agt_sales', name: 'Sales' },
];

/** A finished verification run, as the server reports one. */
const VERIFIED_SNAPSHOT: ConnectionTestSnapshot = {
  instanceId: 'bi_fs_sales',
  platform: 'feishu',
  status: 'verified',
  code: 'ABC123',
  targetChannelId: 'oc_release',
  targetChannelName: 'Release',
  outbound: { state: 'ok', at: '2026-01-01T00:00:00.000Z', detail: null },
  inbound: { state: 'ok', at: '2026-01-01T00:00:00.000Z', detail: null },
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:10:00.000Z',
};

/** An instance client that records every call instead of hitting the network. */
function clientStub(over: Partial<InstanceClient> = {}) {
  const calls: Array<{ op: string; id?: string; platform?: string; payload?: unknown; channels?: unknown }> = [];
  const client: InstanceClient = {
    create: vi.fn(async (platform, label) => {
      calls.push({ op: 'create', platform, payload: label });
      return instance({ id: 'bi_new', platform, label });
    }),
    save: vi.fn(async (id, payload) => { calls.push({ op: 'save', id, payload }); }),
    test: vi.fn(async () => ({ ok: true, message: 'pong' })),
    remove: vi.fn(async (id) => { calls.push({ op: 'remove', id }); }),
    listChannels: vi.fn(async () => ({ supported: true, channels: [] })),
    saveChannels: vi.fn(async (id, channels) => { calls.push({ op: 'saveChannels', id, channels }); }),
    startConnectionTest: vi.fn(async (id) => {
      calls.push({ op: 'connectionTest', id });
      return VERIFIED_SNAPSHOT;
    }),
    getConnectionTest: vi.fn(async () => null),
    ...over,
  };
  return { client, calls };
}

const loadAgents = () => Promise.resolve(AGENTS);

// ─── Pure logic ──────────────────────────────────────────────────────────────

describe('lib/instanceIntegrations — pure logic', () => {
  it('instanceAsPlatform carries the manifest, the bound agent and secret presence through', () => {
    const view = instanceAsPlatform(instance({
      platform: 'feishu',
      fields: FEISHU_PLATFORM.fields,
      values: { appId: 'cli_abc' },
      secrets: { appSecret: { hasValue: true } },
      enabled: true,
      hasConfig: true,
      agentId: 'agt_sales',
    }));
    expect(view.id).toBe('feishu');
    expect(view.fields).toEqual(FEISHU_PLATFORM.fields);
    // One fact: the instance's bound agent arrives through the manifest's agent
    // field, so the picker can never disagree with the row that owns it.
    expect(view.values).toEqual({ appId: 'cli_abc', agentId: 'agt_sales' });
    expect(view.secrets).toEqual({ appSecret: { hasValue: true } });
    expect(view.enabled).toBe(true);
  });

  it('instanceAsPlatform renders an unbound bot as a blank agent, not a missing key', () => {
    const view = instanceAsPlatform(instance({ fields: FEISHU_PLATFORM.fields, agentId: null }));
    expect(view.values['agentId']).toBe('');
  });

  it('buildRoutingPayload writes only the notification target — never a replay of stored values', () => {
    const payload = buildRoutingPayload('agt_secretary');
    expect(payload).toEqual({ notifyAgentId: 'agt_secretary' });
    // Routing must not be a second writer of the bound agent: if this payload
    // carried `agentId` (or a credential), a save issued after the user picked a
    // new agent in the credential form would write the *stale stored* value back
    // over it.
    expect('agentId' in payload).toBe(false);
  });

  it('setChannelBinding replaces an existing binding and keeps the list sorted', () => {
    let list: InstanceChannelBinding[] = [];
    list = setChannelBinding(list, 'oc_b', 'agt_sales', 'group');
    list = setChannelBinding(list, 'oc_a', 'agt_sales', 'group');
    expect(list.map((b) => b.nativeId)).toEqual(['oc_a', 'oc_b']);
    // Re-binding the same chat must not duplicate it.
    list = setChannelBinding(list, 'oc_a', 'agt_secretary', 'group');
    expect(list).toHaveLength(2);
    expect(bindingFor(list, 'oc_a')?.agentId).toBe('agt_secretary');
  });

  it('removeChannelBinding drops exactly one chat', () => {
    const list = setChannelBinding([], 'oc_a', 'agt_sales', 'group');
    expect(removeChannelBinding(list, 'oc_a')).toEqual([]);
    expect(removeChannelBinding(list, 'oc_missing')).toHaveLength(1);
  });

  it('orphanBindings keeps chats the platform no longer advertises', () => {
    const list = setChannelBinding([], 'oc_gone', 'agt_sales', 'group');
    const orphans = orphanBindings(list, [{ id: 'oc_known', name: 'Known' }]);
    expect(orphans.map((b) => b.nativeId)).toEqual(['oc_gone']);
  });

  it('filterChannels matches on name and id, case-insensitively', () => {
    const known = [{ id: 'oc_1', name: 'Release' }, { id: 'oc_2', name: 'Sales' }];
    expect(filterChannels(known, 'rel').map((c) => c.id)).toEqual(['oc_1']);
    expect(filterChannels(known, 'OC_2').map((c) => c.id)).toEqual(['oc_2']);
    expect(filterChannels(known, '  ')).toHaveLength(2);
  });

  it('groupByPlatform keeps instances of one platform together, in order', () => {
    const grouped = groupByPlatform([
      instance({ id: 'bi_1', platform: 'feishu' }),
      instance({ id: 'bi_2', platform: 'mattermost' }),
      instance({ id: 'bi_3', platform: 'feishu' }),
    ]);
    expect(grouped.map((g) => g.platform)).toEqual(['feishu', 'mattermost']);
    expect(grouped[0].instances.map((i) => i.id)).toEqual(['bi_1', 'bi_3']);
  });

  it('visiblePlatformIds unions the catalog with platforms that already have bots', () => {
    const ids = visiblePlatformIds(
      [{ id: 'feishu' }, { id: 'slack' }],
      [instance({ platform: 'retired_platform' })],
    );
    // A platform dropped from the registry keeps its bots visible and deletable.
    expect(ids).toEqual(['feishu', 'slack', 'retired_platform']);
  });
});

// ─── Zero UI code for an unknown platform (the inherited guard) ──────────────

describe('InstancesSection — zero UI code for a new platform', () => {
  it('renders a bot of a platform the UI has never seen, every field typed from its manifest', async () => {
    const user = userEvent.setup();
    const { client } = clientStub();
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([MATTERMOST])}
        loadInstances={() => Promise.resolve([instance()])}
        client={client}
        loadAgents={loadAgents}
      />,
    );

    const card = await screen.findByTestId('instance-card-bi_mm_default');
    expect(within(card).getByText('Default')).toBeTruthy();
    // A brand-less platform still gets an icon (the neutral fallback).
    expect(within(card).getByTestId('platform-icon-mattermost')).toBeTruthy();
    // The group header is the platform, derived from the catalog.
    expect(within(screen.getByTestId('platform-group-mattermost')).getByText('Mattermost')).toBeTruthy();

    // Collapsed by default — many bots must not all be open.
    expect(card.getAttribute('data-expanded')).toBe('false');
    expect(screen.queryByTestId('integration-field-serverUrl')).toBeNull();

    await user.click(within(card).getByTestId('instance-toggle-bi_mm_default'));
    expect(screen.getByTestId('instance-card-bi_mm_default').getAttribute('data-expanded')).toBe('true');

    // Required/credential fields render, typed from the manifest…
    expect(within(card).getByTestId('integration-field-serverUrl').getAttribute('type')).toBe('text');
    expect(within(card).getByTestId('integration-field-botToken').getAttribute('type')).toBe('password');
    // …optional ones are folded away until asked for (progressive disclosure).
    expect(within(card).queryByTestId('integration-field-retries')).toBeNull();
    expect(within(card).getByTestId('instance-more-toggle-bi_mm_default').getAttribute('aria-expanded')).toBe('false');
    await user.click(within(card).getByTestId('instance-more-toggle-bi_mm_default'));
    expect(within(card).getByTestId('integration-field-retries').getAttribute('type')).toBe('number');
    expect(within(card).getByTestId('integration-field-verifyTls').getAttribute('role')).toBe('switch');
    // Labels come from the manifest when no translation key exists.
    expect(within(card).getByText('Server URL')).toBeTruthy();
    // No platform-specific extras leaked in.
    expect(screen.queryByTestId('feishu-extras')).toBeNull();
  });

  it('shows a group with an "Add bot" affordance even when the platform has no bot yet', async () => {
    const { client } = clientStub();
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([MATTERMOST])}
        loadInstances={() => Promise.resolve([])}
        client={client}
        loadAgents={loadAgents}
      />,
    );
    await screen.findByTestId('instances-section');
    expect(screen.getByTestId('add-bot-mattermost')).toBeTruthy();
    expect(screen.getByTestId('platform-empty-mattermost')).toBeTruthy();
  });

  it('surfaces a load failure instead of an empty page', async () => {
    render(<InstancesSection loadPlatforms={() => Promise.reject(new Error('boom'))} />);
    const err = await screen.findByTestId('integrations-error');
    expect(err.textContent).toContain('boom');
  });
});

// ─── One platform, many bots ─────────────────────────────────────────────────

describe('InstancesSection — a second bot on the same platform', () => {
  const twoBots = [
    instance({ id: 'bi_fs_default', platform: 'feishu', label: 'Default', fields: FEISHU_PLATFORM.fields, values: { appId: 'cli_abc' }, secrets: { appSecret: { hasValue: true } }, enabled: true, hasConfig: true }),
    instance({ id: 'bi_fs_sales', platform: 'feishu', label: 'Sales', fields: FEISHU_PLATFORM.fields, values: { appId: 'cli_sales' }, secrets: { appSecret: { hasValue: true } }, enabled: true, hasConfig: true, agentId: 'agt_sales' }),
  ];

  it('renders one independent card per instance, not one per platform', async () => {
    const { client } = clientStub();
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve(twoBots)}
        client={client}
        loadAgents={loadAgents}
      />,
    );

    const a = await screen.findByTestId('instance-card-bi_fs_default');
    const b = screen.getByTestId('instance-card-bi_fs_sales');
    expect(within(a).getByTestId('instance-label-bi_fs_default').textContent).toBe('Default');
    expect(within(b).getByTestId('instance-label-bi_fs_sales').textContent).toBe('Sales');
    // Exactly one platform group, containing both bots.
    expect(screen.getAllByTestId('platform-group-feishu')).toHaveLength(1);
    // The collapsed row shows the bound agent — that is how two bots differ.
    expect(within(b).getByTestId('instance-agent-bi_fs_sales').textContent).toContain('Sales');
    expect(within(a).queryByTestId('instance-agent-bi_fs_default')).toBeNull();
  });

  it('creates a second bot from the UI and then shows it', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    const loadInstances = vi.fn()
      .mockResolvedValueOnce([instance({ id: 'bi_fs_default', platform: 'feishu', label: 'Default', fields: FEISHU_PLATFORM.fields })])
      .mockResolvedValue([
        instance({ id: 'bi_fs_default', platform: 'feishu', label: 'Default', fields: FEISHU_PLATFORM.fields }),
        instance({ id: 'bi_fs_sales', platform: 'feishu', label: 'Sales', fields: FEISHU_PLATFORM.fields }),
      ]);
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={loadInstances}
        client={client}
        loadAgents={loadAgents}
      />,
    );

    await screen.findByTestId('instance-card-bi_fs_default');
    await user.click(screen.getByTestId('add-bot-feishu'));

    // "Add bot" opens the bot itself, in draft form — the setup steps and the
    // form are the first thing seen, not a name prompt. Nothing exists
    // server-side yet, so an abandoned draft leaves no half-configured bot.
    const draft = await screen.findByTestId('instance-card-new-feishu');
    expect(calls.some((c) => c.op === 'create')).toBe(false);

    await user.type(within(draft).getByTestId('new-bot-name-feishu'), 'Sales');
    // A name alone is not a bot: the platform's required fields must be there.
    expect(within(draft).getByTestId('instance-missing-new-feishu')).toBeTruthy();
    await user.type(within(draft).getByTestId('integration-field-appId'), 'cli_sales');
    await user.type(within(draft).getByTestId('integration-field-appSecret'), 'shh');

    // Completing it is what creates it — no separate "Create" step to click.
    await waitFor(() => expect(calls.some((c) => c.op === 'create')).toBe(true), { timeout: 5000 });
    const create = calls.find((c) => c.op === 'create')!;
    expect(create.platform).toBe('feishu');
    expect(create.payload).toBe('Sales');
    // The list is re-read, so the new bot is on screen without a page reload.
    expect(await screen.findByTestId('instance-card-bi_fs_sales')).toBeTruthy();
  });

  it('never creates an incomplete bot, however long it is left open', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([])}
        client={client}
        loadAgents={loadAgents}
      />,
    );
    await user.click(await screen.findByTestId('add-bot-feishu'));
    const draft = await screen.findByTestId('instance-card-new-feishu');

    // Nameless and credential-less: the hint names exactly what is missing…
    expect(within(draft).getByTestId('instance-missing-new-feishu')).toBeTruthy();
    // …and waiting past the auto-save debounce must not sneak a row in.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(calls.some((c) => c.op === 'create')).toBe(false);
    expect(calls.some((c) => c.op === 'save')).toBe(false);
  });
});

// ─── Routing: group bindings + notification target ──────────────────────────

describe('InstanceCard — routing', () => {
  const withChannels = instance({
    id: 'bi_fs_sales',
    platform: 'feishu',
    label: 'Sales',
    fields: FEISHU_PLATFORM.fields,
    enabled: true,
    hasConfig: true,
    agentId: 'agt_sales',
    notifyAgentId: 'agt_secretary',
    canListChannels: true,
    // What the server returns once the bot is configured: the stored values and
    // a secret that is *present*. Without these the save is (correctly) held
    // back as incomplete, and the routing assertions below would pass for the
    // wrong reason.
    values: { appId: 'cli_abc' },
    secrets: { appSecret: { hasValue: true } },
  });

  function renderOne(client: InstanceClient, over: Partial<InstanceStatus> = {}) {
    return render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([{ ...withChannels, ...over }])}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );
  }

  it('binds a known chat to an agent and saves both channels and the notification target', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub({
      listChannels: vi.fn(async () => ({
        supported: true,
        channels: [{ id: 'oc_release', name: 'Release', kind: 'group' }],
      })),
    });
    renderOne(client);

    // Routing is not the common path, so it lives under "More settings" — but it
    // is one click in, not hidden behind a second screen.
    await user.click(await screen.findByTestId('instance-more-toggle-bi_fs_sales'));
    const toggle = (await screen.findByTestId(
      'instance-chat-toggle-bi_fs_sales-oc_release',
    )) as HTMLInputElement;
    // Unticked by default: a chat answers through the bot default until bound.
    expect(toggle.checked).toBe(false);

    await user.click(toggle);
    // Ticking defaults the chat to the bot's own agent — the common case.
    await screen.findByTestId('instance-chat-agent-bi_fs_sales-oc_release');

    // There is no save button: the change persists for you.
    await waitFor(() => expect(calls.some((c) => c.op === 'saveChannels')).toBe(true), { timeout: 5000 });
    const saveChannels = calls.find((c) => c.op === 'saveChannels')!;
    expect(saveChannels.channels).toEqual([
      { nativeId: 'oc_release', kind: 'group', agentId: 'agt_sales' },
    ]);

    const save = calls.find((c) => c.op === 'save');
    expect(save?.payload).toMatchObject({ notifyAgentId: 'agt_secretary' });
  });

  it('refuses to persist a route that leaves a chat with no agent — and says why', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub({
      listChannels: vi.fn(async () => ({
        supported: true,
        channels: [{ id: 'oc_release', name: 'Release', kind: 'group' }],
      })),
    });
    // A bot with no default agent: ticking a chat cannot silently pick one.
    renderOne(client, { agentId: null });
    await user.click(await screen.findByTestId('instance-more-toggle-bi_fs_sales'));
    await user.click(await screen.findByTestId('instance-chat-toggle-bi_fs_sales-oc_release'));

    // The gap is named on screen…
    expect(await screen.findByTestId('integration-msg-err')).toBeTruthy();
    // …and nothing half-assigned reaches the API, even though saving is automatic.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(calls.some((c) => c.op === 'saveChannels')).toBe(false);
    expect(calls.some((c) => c.op === 'save')).toBe(false);
  });

  it('reports a channel listing that failed without failing the whole card', async () => {
    const user = userEvent.setup();
    const { client } = clientStub({
      listChannels: vi.fn(async () => ({ supported: true, channels: [], error: 'token expired' })),
    });
    renderOne(client);
    await user.click(await screen.findByTestId('instance-more-toggle-bi_fs_sales'));
    const err = await screen.findByTestId('instance-chats-error-bi_fs_sales');
    expect(err.textContent).toContain('token expired');
  });

  it('does not probe a platform that cannot list chats', async () => {
    const user = userEvent.setup();
    const { client } = clientStub();
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([instance({ ...withChannels, canListChannels: false })])}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );
    await user.click(await screen.findByTestId('instance-more-toggle-bi_fs_sales'));
    expect(await screen.findByTestId('instance-chats-unsupported-bi_fs_sales')).toBeTruthy();
    expect(client.listChannels).not.toHaveBeenCalled();
  });
});

// ─── A just-created bot is not "configured" ──────────────────────────────────
//
// `hasConfig` separates "freshly created" from "actually filled in". It used to
// gate a destructive button, which made an unconfigured bot impossible to get
// rid of; it now drives the one thing it is good for — whether the "how do I get
// these credentials?" steps start open or folded away. These pin that on the
// client side; the server-side half (a fresh bot's DTO reports
// `hasConfig: false`) is pinned in
// packages/org-manager/test/instance-integrations.test.ts.

describe('InstanceCard — setup steps follow `hasConfig`', () => {
  it('opens the setup steps for a bot nothing has been stored for', async () => {
    const { client } = clientStub();
    // What the server returns for a freshly created bot: the default agent is
    // *read through* (so `agentId` is set) while nothing is stored, so
    // `hasConfig` is false.
    const fresh = instance({
      id: 'bi_fs_new',
      platform: 'feishu',
      label: 'New',
      fields: FEISHU_PLATFORM.fields,
      hasConfig: false,
      agentId: 'agt_secretary',
      values: {},
      secrets: { appSecret: { hasValue: false } },
      canListChannels: true,
    });

    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([fresh])}
        client={client}
        extras={PLATFORM_EXTRAS}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );

    // The recommended first path (scan a QR to create + configure the app) is
    // reachable — this is exactly what the routing default must not hide.
    expect(await screen.findByTestId('feishu-register')).toBeTruthy();
    // Nothing stored yet ⇒ the guidance is open, because the user needs it.
    expect(screen.getByTestId('integration-guide').getAttribute('data-open')).toBe('true');
    // And a bot that exists can always be removed — hiding that on an
    // unconfigured bot left no way to get rid of it at all.
    expect(screen.getByTestId('instance-disconnect-bi_fs_new')).toBeTruthy();
  });

  it('collapses the setup steps once credentials are stored', async () => {
    const { client } = clientStub();
    const configured = instance({
      id: 'bi_fs_ready',
      platform: 'feishu',
      label: 'Ready',
      fields: FEISHU_PLATFORM.fields,
      hasConfig: true,
      agentId: 'agt_sales',
      values: { appId: 'cli_abc' },
      secrets: { appSecret: { hasValue: true } },
      canListChannels: true,
    });

    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([configured])}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );

    // A returning user does not have to scroll past a tutorial they finished.
    expect((await screen.findByTestId('integration-guide')).getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('instance-disconnect-bi_fs_ready')).toBeTruthy();
  });
});

// ─── Auto-save, the header switch, and the verified record ───────────────────

describe('InstanceCard — auto-save, header switch, verified state', () => {
  function configured(): InstanceStatus {
    return instance({
      id: 'bi_fs_ready',
      platform: 'feishu',
      label: 'Ready',
      fields: FEISHU_PLATFORM.fields,
      enabled: true,
      hasConfig: true,
      agentId: 'agt_sales',
      values: { appId: 'cli_abc' },
      secrets: { appSecret: { hasValue: true } },
    });
  }

  function renderOne(client: InstanceClient, over: Partial<InstanceStatus> = {}) {
    return render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={() => Promise.resolve([{ ...configured(), ...over }])}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );
  }

  it('saves a credential edit on its own — there is no save button to forget', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderOne(client);
    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    // The control the user used to have to find does not exist any more.
    expect(within(card).queryByRole('button', { name: /save/i })).toBeNull();

    await user.type(within(card).getByTestId('integration-field-appId'), 'X');
    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')?.payload).toMatchObject({ appId: 'cli_abcX' });
  });

  it('turns the bot on and off from the switch beside the status', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderOne(client);
    const sw = await screen.findByTestId('instance-enabled-bi_fs_ready');
    expect(sw.getAttribute('aria-checked')).toBe('true');

    await user.click(sw);
    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')?.payload).toMatchObject({ enabled: false });
  });

  it('shows the stored verification instead of forgetting it on reload', async () => {
    const { client } = clientStub();
    renderOne(client, { lastVerifiedAt: '2026-01-02T03:04:00.000Z' });
    // The fact survives a reload because the server kept it, not because a run
    // happens to still be in memory…
    expect(await screen.findByText(/Verified /)).toBeTruthy();
    // …and re-running is one click, not a reconfiguration.
    expect(screen.getByTestId('connection-test-start')).toBeTruthy();
  });

  it('removes the card once a disconnect is confirmed', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    const loadInstances = vi.fn()
      .mockResolvedValueOnce([configured()])
      .mockResolvedValue([]);
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([FEISHU_PLATFORM])}
        loadInstances={loadInstances}
        client={client}
        loadAgents={loadAgents}
        defaultExpanded
      />,
    );
    await user.click(await screen.findByTestId('instance-disconnect-bi_fs_ready'));

    // Destructive and irreversible ⇒ a confirmation stands between the click
    // and the deletion. The modal's confirm button is the last one by that name
    // in the document (the modal is portalled to the end of <body>).
    const confirm = screen.getAllByRole('button', { name: /disconnect/i }).at(-1)!;
    await user.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.op === 'remove')).toBe(true));
    // The card leaves the page, rather than lingering as "disconnected".
    await waitFor(() => expect(screen.queryByTestId('instance-card-bi_fs_ready')).toBeNull());
  });
});
