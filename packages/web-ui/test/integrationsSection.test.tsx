/**
 * Manifest-driven Integrations UI — regression guards (slice S4, issue #340).
 *
 * The headline claim of this slice is: **a new platform needs zero UI code.**
 * That is not a slogan here — the section is rendered with a platform
 * (`mattermost`) that exists nowhere in the front-end, and the assertions are
 * that its card and every one of its fields appear. If someone reintroduces a
 * per-platform branch (or a hard-coded field list), the fake platform's fields
 * stop rendering and this file goes red.
 *
 * The second cluster pins the two rules a settings form gets wrong quietly:
 *   • an untouched secret is omitted from the payload (never overwritten with
 *     the mask/placeholder);
 *   • a required field blocks the save and is named on screen.
 *
 * ── Where these guards live after the "one card" refactor ───────────────────
 *
 * `PlatformCard` used to be a complete card — its own header, an enable switch,
 * a "Save & test" button and a Disconnect button — and this file drove *that*
 * component directly. The lifecycle now lives in `InstanceCard` (one per bot
 * instance, rendered by `InstancesSection`), and `PlatformCard.tsx` exports only
 * presentational pieces (`StatusBadge`, `Msg`, `FieldInput`, `PlatformFields`).
 * So the tests below were re-pointed, not relaxed:
 *
 *   • lifecycle behaviour — auto-save, disconnect-with-confirmation, the
 *     untouched-secret rule, the extras slot, the agent picker — is pinned
 *     through `InstancesSection`, exactly as `test/instancesSection.test.tsx`
 *     does. The payload contract of every assertion is unchanged;
 *   • the setup guide is now a standalone component (`SetupGuide`) and is
 *     rendered directly — that is what it is for. Its wiring to a bot
 *     (`configured = instance.hasConfig`) is pinned in
 *     `test/instancesSection.test.tsx`.
 *
 * TWO GUARANTEES THAT ONCE BELONGED TO THE OLD LAYOUT ARE PINNED HERE. Both
 * were briefly lost when the card was unified and are now restored in `src`:
 *
 *   1. the platform's *display name* is translated — the group header renders
 *      `platformLabel(t, status)`, so a Chinese user sees "飞书 / Lark";
 *   2. a platform whose manifest declares no `agent` field never issues the
 *      agents request — `InstanceCard` gates the loader on the field type.
 *
 * Everything else is re-pointed, never relaxed: the same behaviour and the same
 * payload shape are asserted, against the component that now owns them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../src/i18n/index.ts';
import {
  blankValue,
  buildSavePayload,
  initialDraft,
  isFieldEmpty,
  missingRequired,
  testResultMessage,
  type PlatformExtras,
  type PlatformStatus,
} from '../src/lib/platformIntegrations.ts';
import {
  type ConnectionTestSnapshot,
  type InstanceStatus,
} from '../src/lib/instanceIntegrations.ts';
import { SetupGuide } from '../src/components/integrations/SetupGuide.tsx';
import { InstancesSection } from '../src/components/integrations/InstancesSection.tsx';
import type { InstanceClient } from '../src/components/integrations/InstanceCard.tsx';
import type { AgentOption } from '../src/components/integrations/AgentSelect.tsx';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Several assertions below rely on English strings; pin the language so a
// detector that picks zh-CN/es on some machine cannot make them flaky.
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

/** A platform the front-end has never heard of — the whole point. */
const MATTERMOST: PlatformStatus = {
  id: 'mattermost',
  label: 'Mattermost',
  docsUrl: 'https://developers.mattermost.com/',
  capabilities: { inbound: true, outbound: true, threads: true },
  fields: [
    { key: 'serverUrl', label: 'Server URL', type: 'text', required: true, placeholder: 'https://chat.example.com' },
    { key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true },
    { key: 'teamId', label: 'Team ID', type: 'text', required: false },
    { key: 'retries', label: 'Retries', type: 'number', required: false, default: 3 },
    { key: 'verifyTls', label: 'Verify TLS', type: 'boolean', required: false, default: true },
    {
      key: 'events',
      label: 'Events',
      type: 'select',
      required: false,
      multiple: true,
      default: ['posts'],
      options: [
        { value: 'posts', label: 'Posts' },
        { value: 'reactions', label: 'Reactions' },
      ],
    },
  ],
  defaultEnabled: false,
  enabled: false,
  connected: false,
  hasConfig: false,
  values: {},
  secrets: { botToken: { hasValue: false } },
};

function feishuLike(over: Partial<PlatformStatus> = {}): PlatformStatus {
  return {
    id: 'feishu',
    label: 'Feishu / Lark',
    capabilities: { inbound: true, outbound: true, threads: true, cards: true },
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', required: true },
      { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
      { key: 'notifyOnApproval', label: 'Notify on approvals', type: 'boolean', required: false, default: true },
    ],
    defaultEnabled: false,
    enabled: true,
    connected: true,
    hasConfig: true,
    values: { appId: 'cli_abc', notifyOnApproval: true },
    secrets: { appSecret: { hasValue: true } },
    ...over,
  };
}

const FEISHU_PLATFORM = feishuLike();

/**
 * The `InstanceStatus` the server hands the card for a configured Feishu bot.
 *
 * The card reads *the instance row*, not a `PlatformStatus`: the bound agent in
 * particular arrives as `instance.agentId` and is fed through the manifest's
 * agent field by `instanceAsPlatform`. Fixtures that need a binding must set
 * `agentId` here — putting it in `values` is overwritten by that adapter.
 */
function feishuInstance(over: Partial<InstanceStatus> = {}): InstanceStatus {
  const platform = FEISHU_PLATFORM;
  return {
    id: 'bi_fs_ready',
    platform: 'feishu',
    label: 'Sales',
    enabled: true,
    connected: true,
    hasConfig: true,
    capabilities: platform.capabilities,
    fields: platform.fields,
    values: { appId: 'cli_abc', notifyOnApproval: true },
    secrets: { appSecret: { hasValue: true } },
    agentId: null,
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: false,
    lastVerifiedAt: null,
    ...over,
  };
}

const AGENTS: AgentOption[] = [
  { id: 'agt_a1b2', name: 'Alice Writer', role: 'writer' },
  { id: 'agt_c3d4', name: 'Bob Analyst', role: 'analyst' },
];

const loadAgents = (): Promise<AgentOption[]> => Promise.resolve(AGENTS);

const VERIFIED: ConnectionTestSnapshot = {
  instanceId: 'bi_fs_ready',
  platform: 'feishu',
  status: 'verified',
  code: 'ABC123',
  targetChannelId: 'oc_release',
  targetChannelName: 'Release',
  outbound: { state: 'ok' },
  inbound: { state: 'ok' },
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:10:00.000Z',
};

interface Recorded {
  op: string;
  id?: string;
  platform?: string;
  label?: string;
  payload?: Record<string, unknown>;
  channels?: unknown;
}

/** An instance client that records every call instead of hitting the network. */
function clientStub(over: Partial<InstanceClient> = {}) {
  const calls: Recorded[] = [];
  const client: InstanceClient = {
    create: vi.fn(async (platform, label) => {
      calls.push({ op: 'create', platform, label });
      return feishuInstance({ id: 'bi_new', platform, label, canListChannels: false });
    }),
    save: vi.fn(async (id, payload) => { calls.push({ op: 'save', id, payload }); }),
    test: vi.fn(async (id, payload) => {
      calls.push({ op: 'test', id, payload });
      return { ok: true, message: 'pong' };
    }),
    remove: vi.fn(async (id) => { calls.push({ op: 'remove', id }); }),
    listChannels: vi.fn(async () => ({ supported: true, channels: [] })),
    saveChannels: vi.fn(async (id, channels) => { calls.push({ op: 'saveChannels', id, channels }); }),
    startConnectionTest: vi.fn(async () => VERIFIED),
    getConnectionTest: vi.fn(async () => null),
    ...over,
  };
  return { client, calls };
}

interface RenderOptions {
  /** The bot's row, merged over the configured-Feishu default. */
  instance?: Partial<InstanceStatus>;
  /** The platform catalog the section groups by. */
  platforms?: PlatformStatus[];
  extras?: Record<string, PlatformExtras>;
}

/**
 * Render one bot's card the way the page does — through `InstancesSection` —
 * rather than by mounting `InstanceCard` in isolation. The card saves through
 * `onChanged` (a re-read) and the section is where that loop closes; the
 * reference file for this pattern is `test/instancesSection.test.tsx`.
 *
 * `defaultExpanded` is passed because the card is folded by default now (many
 * bots must not all be open at once).
 */
function renderInstance(client: InstanceClient, opts: RenderOptions = {}) {
  return render(
    <InstancesSection
      loadPlatforms={() => Promise.resolve(opts.platforms ?? [FEISHU_PLATFORM])}
      loadInstances={() => Promise.resolve([feishuInstance(opts.instance)])}
      client={client}
      extras={opts.extras}
      loadAgents={loadAgents}
      defaultExpanded
    />,
  );
}

/**
 * Wait past the card's auto-save debounce (`AUTOSAVE_DEBOUNCE_MS` = 700 ms in
 * `InstanceCard.tsx`), so that "the save did not fire" is a real assertion and
 * not a race against a timer that has not elapsed yet.
 */
const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 1200));

/**
 * The card's own success line — the replacement for the old "Save & test"
 * button's `integration-msg-ok`. A failed *probe* still renders
 * `integration-msg-err`; only the happy path moved into this indicator.
 */
async function expectCardSaysSaved(uid: string) {
  const slot = screen.getByTestId(`instance-save-state-${uid}`);
  await waitFor(() => expect(slot.querySelector('[data-state="saved"]')).not.toBeNull());
}

// ─── Pure form logic ─────────────────────────────────────────────────────────

describe('lib/platformIntegrations — pure form logic', () => {
  it('initialDraft: stored value wins, then default, then blank; secrets start empty', () => {
    const draft = initialDraft(MATTERMOST);
    expect(draft['retries']).toBe(3); // manifest default
    expect(draft['verifyTls']).toBe(true);
    expect(draft['events']).toEqual(['posts']);
    expect(draft['serverUrl']).toBe('');
    expect(draft['botToken']).toBe(''); // secret never pre-filled
  });

  it('initialDraft: a stored non-secret value overrides the manifest default', () => {
    const draft = initialDraft({ ...MATTERMOST, values: { retries: 9, serverUrl: 'https://x' } });
    expect(draft['retries']).toBe(9);
    expect(draft['serverUrl']).toBe('https://x');
  });

  it('isFieldEmpty treats a blank set / blank string as empty, a boolean as never empty', () => {
    const events = MATTERMOST.fields.find((f) => f.key === 'events')!;
    const verify = MATTERMOST.fields.find((f) => f.key === 'verifyTls')!;
    const url = MATTERMOST.fields.find((f) => f.key === 'serverUrl')!;
    expect(isFieldEmpty(events, [])).toBe(true);
    expect(isFieldEmpty(events, ['posts'])).toBe(false);
    expect(isFieldEmpty(verify, false)).toBe(false);
    expect(isFieldEmpty(url, '   ')).toBe(true);
  });

  it('buildSavePayload omits an untouched secret and keeps the rest', () => {
    const draft = initialDraft(feishuLike());
    draft['appId'] = 'cli_new';
    const payload = buildSavePayload(feishuLike(), draft, true);
    expect(payload['appId']).toBe('cli_new');
    expect(payload['enabled']).toBe(true);
    expect('appSecret' in payload).toBe(false); // untouched → stored value survives
  });

  it('buildSavePayload includes a secret once the user types one', () => {
    const draft = initialDraft(feishuLike());
    draft['appSecret'] = 's3cret';
    const payload = buildSavePayload(feishuLike(), draft, false);
    expect(payload['appSecret']).toBe('s3cret');
  });

  it('missingRequired names missing fields but accepts a stored secret', () => {
    const fields = feishuLike().fields;
    expect(missingRequired(fields, { appId: '', appSecret: '' }, { appSecret: { hasValue: true } })).toEqual(['appId']);
    expect(missingRequired(fields, { appId: 'x', appSecret: '' }, { appSecret: { hasValue: false } })).toEqual(['appSecret']);
    expect(missingRequired(fields, { appId: 'x', appSecret: '' }, { appSecret: { hasValue: true } })).toEqual([]);
  });

  it('testResultMessage normalises ok/success/message/error', () => {
    expect(testResultMessage({ ok: true, message: 'fine' })).toEqual({ ok: true, text: 'fine' });
    expect(testResultMessage({ success: false, error: 'nope' })).toEqual({ ok: false, text: 'nope' });
    expect(testResultMessage({ success: true })).toEqual({ ok: true, text: 'OK' });
  });

  it('blankValue mirrors the field type', () => {
    expect(blankValue({ key: 'b', label: 'B', type: 'boolean', required: false, default: true })).toBe(true);
    expect(blankValue({ key: 'n', label: 'N', type: 'number', required: false })).toBe('');
    expect(blankValue({ key: 'm', label: 'M', type: 'select', required: false, multiple: true })).toEqual([]);
  });
});

// ─── Save / secret / validation behaviour ────────────────────────────────────
//
// The card has no Save button any more: every edit is debounced (700 ms) and
// written by the card itself, which then probes the *stored* config. These tests
// wait for that write instead of clicking, and assert exactly the payload
// contract the old "Save & test" button produced.

describe('InstanceCard — save semantics', () => {
  it('saves the draft, omitting the untouched stored secret', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    const appId = within(card).getByTestId('integration-field-appId');
    await user.clear(appId);
    await user.type(appId, 'cli_edited');

    // No button to find: the edit persists itself and the assertion waits for
    // the call.
    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    const save = calls.find((c) => c.op === 'save')!;
    // The write is addressed to the bot's instance id — that is what replaced
    // the platform id as the save key when a platform gained many bots.
    expect(save.id).toBe('bi_fs_ready');
    expect(save.payload?.['appId']).toBe('cli_edited');
    expect(save.payload?.['enabled']).toBe(true);
    expect('appSecret' in (save.payload ?? {})).toBe(false);
    // …and the outcome is reported where the edits happened.
    await expectCardSaysSaved('bi_fs_ready');
  });

  it('holds the save back and names the missing field when a required field is blank', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    await user.clear(within(card).getByTestId('integration-field-appId'));

    // Saving is automatic, so "blocked" has to mean "never fires"…
    const missing = await within(card).findByTestId('instance-missing-bi_fs_ready');
    // …and the reason is on screen, naming the field by its translated label.
    expect(missing.textContent).toContain('App ID');
    await pastDebounce();
    expect(calls.some((c) => c.op === 'save')).toBe(false);
  });

  it('writes first, then probes the stored config (one save path)', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    const appId = within(card).getByTestId('integration-field-appId');
    await user.clear(appId);
    await user.type(appId, 'cli_probe');

    await waitFor(() => expect(calls.some((c) => c.op === 'test')).toBe(true), { timeout: 5000 });
    // The edited value was persisted…
    expect(calls.find((c) => c.op === 'save')!.payload?.['appId']).toBe('cli_probe');
    // …and the probe then ran against what the server now holds, not the draft.
    expect(calls.find((c) => c.op === 'test')!.payload).toEqual({});
    // Order matters: testing a draft that was never stored is what the old
    // two-button layout did, and it could pass on credentials that were never saved.
    expect(calls.findIndex((c) => c.op === 'save')).toBeLessThan(calls.findIndex((c) => c.op === 'test'));
    await expectCardSaysSaved('bi_fs_ready');
  });

  it('reports a save that persisted but did not authenticate', async () => {
    const user = userEvent.setup();
    const { client } = clientStub();
    client.test = vi.fn(async () => ({ ok: false, error: 'Invalid app secret' }));
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    await user.type(within(card).getByTestId('integration-field-appId'), 'X');

    const err = await within(card).findByTestId('integration-msg-err');
    expect(err.textContent).toContain('Invalid app secret');
  });

  it('does not call the probe at all when the save was rejected', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    client.save = vi.fn(async () => { throw new Error('server said no'); });
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    await user.type(within(card).getByTestId('integration-field-appId'), 'X');

    const err = await within(card).findByTestId('integration-msg-err');
    expect(err.textContent).toContain('server said no');
    expect(calls.some((c) => c.op === 'test')).toBe(false);
  });

  it('asks before disconnecting, and only the confirmation removes the bot', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client);

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    await user.click(within(card).getByTestId('instance-disconnect-bi_fs_ready'));
    // Pressing Disconnect opens a confirmation — it must not act yet.
    expect(calls.some((c) => c.op === 'remove')).toBe(false);
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();

    // Cancelling leaves the bot connected.
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(calls.some((c) => c.op === 'remove')).toBe(false);
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();

    // Only the dialog's own confirm button removes it. Two buttons read
    // "Disconnect" while the dialog is open (the card's and the dialog's), and
    // the dialog is portalled last.
    await user.click(within(card).getByTestId('instance-disconnect-bi_fs_ready'));
    const confirms = screen.getAllByRole('button', { name: /^Disconnect$/ });
    await user.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(calls.some((c) => c.op === 'remove')).toBe(true));
  });

  it('toggling a multi-select chip updates the saved array', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client, {
      instance: {
        fields: [
          { key: 'appId', label: 'App ID', type: 'text', required: false },
          {
            key: 'notifyPriority', label: 'Notify priority', type: 'select', required: false, multiple: true,
            default: ['high'],
            options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }],
          },
        ],
        values: { appId: 'x' },
        secrets: {},
      },
    });

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    // Optional settings are folded away by default (progressive disclosure)…
    expect(within(card).queryByTestId('integration-field-notifyPriority')).toBeNull();
    const more = within(card).getByTestId('instance-more-toggle-bi_fs_ready');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');

    await user.click(within(within(card).getByTestId('integration-field-notifyPriority')).getByText('Low'));

    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')!.payload?.['notifyPriority']).toEqual(['high', 'low']);
  });

  it('shows the stored-secret placeholder instead of a value', async () => {
    renderInstance(clientStub().client);
    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    const secret = within(card).getByTestId('integration-field-appSecret') as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(secret.placeholder.length).toBeGreaterThan(0);
  });
});

// ─── Extras slot ─────────────────────────────────────────────────────────────

describe('extras slot', () => {
  it('renders the platform extras panel and lets it own fields via ctx.setValue', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderInstance(client, {
      extras: {
        feishu: {
          ownedFields: ['notifyOnApproval'],
          render: (ctx) => (
            <button
              data-testid="extras-set"
              onClick={() => ctx.setValue('notifyOnApproval', false)}
            >
              extra
            </button>
          ),
        },
      },
    });

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    // Owned field is NOT rendered by the generic form. Checked with "More
    // settings" open — that is where an optional field lives now — so the
    // assertion cannot pass merely because the fold is shut.
    await user.click(within(card).getByTestId('instance-more-toggle-bi_fs_ready'));
    expect(within(card).queryByTestId('integration-field-notifyOnApproval')).toBeNull();
    expect(within(card).getByTestId('extras-set')).toBeTruthy();

    // …and the extras panel edits the same draft the card's one writer persists.
    await user.click(within(card).getByTestId('extras-set'));
    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')!.payload?.['notifyOnApproval']).toBe(false);
  });
});

// ─── Setup guide ─────────────────────────────────────────────────────────────
//
// The guide is a standalone presentational component now, so it is rendered
// directly: that is the unit that owns "open when nothing is stored, folded once
// credentials exist". Which bots show it open (`configured = instance.hasConfig`)
// is pinned in `test/instancesSection.test.tsx`, and the localisation test below
// still reaches it through a rendered card.

describe('SetupGuide', () => {
  it('opens for an unconfigured platform and shows the numbered steps + console link', () => {
    render(
      <SetupGuide
        status={feishuLike({ hasConfig: false, secrets: { appSecret: { hasValue: false } } })}
        configured={false}
      />,
    );

    const guide = screen.getByTestId('integration-guide');
    expect(guide).toBeTruthy();
    // Steps come from the locale files, not the manifest.
    expect(within(guide).getByTestId('integration-guide-steps')).toBeTruthy();
    expect(within(guide).getByText('Create a self-built app')).toBeTruthy();
    // Feishu has a deep link to its developer console.
    expect(within(guide).getByTestId('integration-guide-console').getAttribute('href')).toContain('open.feishu.cn');
  });

  it('starts collapsed once credentials are stored, and can be reopened', async () => {
    const user = userEvent.setup();
    render(<SetupGuide status={feishuLike()} configured />);

    // Configured → the tutorial is out of the way…
    expect(screen.getByTestId('integration-guide').getAttribute('data-open')).toBe('false');
    expect(screen.queryByTestId('integration-guide-steps')).toBeNull();
    // …but still one click away.
    await user.click(screen.getByTestId('integration-guide-toggle'));
    expect(screen.getByTestId('integration-guide-steps')).toBeTruthy();
  });

  it('falls back to a one-line hint for a platform with no guide keys', () => {
    // MATTERMOST is unconfigured → guide open, but no steps defined for it.
    render(<SetupGuide status={MATTERMOST} configured={false} />);
    expect(screen.queryByTestId('integration-guide-steps')).toBeNull();
    expect(screen.getByTestId('integration-guide')).toBeTruthy();
  });
});

// ─── Localisation ────────────────────────────────────────────────────────────

describe('localisation by convention', () => {
  // Unmount *before* switching the language back. `changeLanguage` notifies every
  // mounted `useTranslation` subscriber, so changing it while a card is still on
  // screen re-renders that whole tree outside `act` (and RTL's own auto-cleanup
  // hook runs after this one, not before).
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('translates field labels and the setup guide from locale files', async () => {
    await i18n.changeLanguage('zh-CN');
    // Nothing stored yet, so the guide is open and its localised steps are on
    // screen for the assertion below.
    renderInstance(clientStub().client, {
      instance: { hasConfig: false, secrets: { appSecret: { hasValue: false } } },
    });

    const card = await screen.findByTestId('instance-card-bi_fs_ready');
    // Field labels come from the locale files, not the manifest strings.
    expect(within(card).getAllByText('App ID').length).toBeGreaterThan(0);
    expect(within(card).getByText('App Secret')).toBeTruthy();
    // Guide content is localised too.
    expect(within(card).getByText('创建企业自建应用')).toBeTruthy();
  });

  /**
   * LOST GUARANTEE — the platform's display name is no longer translated.
   *
   * `PlatformCard`'s header rendered `platformLabel(t, status)`, i.e. the locale
   * key `settings:integrations.platforms.<id>.label`, so a Chinese user saw
   * "飞书 / Lark". That header is gone: `InstanceCard` shows the instance's own
   * label plus the raw platform id, and `InstancesSection`'s group header renders
   * the manifest label verbatim (`platforms.find(...)?.label`). `platformLabel`
   * is still exported but called from nowhere, so the translated name never
   * reaches the screen. Kept (skipped) rather than deleted so the loss stays
   * visible; see the task report. Re-enable once the group header renders
   * `platformLabel`.
   */
  it('translates the platform display name', async () => {
    await i18n.changeLanguage('zh-CN');
    renderInstance(clientStub().client);
    await screen.findByTestId('instance-card-bi_fs_ready');
    expect(screen.getByText('飞书 / Lark')).toBeTruthy();
  });

  it('falls back to the manifest strings when a platform has no translations', async () => {
    await i18n.changeLanguage('zh-CN');
    renderInstance(clientStub().client, {
      platforms: [MATTERMOST],
      instance: {
        platform: 'mattermost',
        fields: MATTERMOST.fields,
        values: {},
        secrets: { botToken: { hasValue: false } },
        hasConfig: false,
      },
    });

    // The group header shows the manifest label as sent…
    expect(await screen.findByText('Mattermost')).toBeTruthy();
    expect(screen.getByText('Server URL')).toBeTruthy();
    // …and the unconfigured platform keeps its (empty) guide rather than
    // breaking on a missing locale key.
    expect(screen.queryByTestId('integration-guide-steps')).toBeNull();
    expect(screen.getByTestId('integration-guide')).toBeTruthy();
  });
});

// ─── Agent binding ───────────────────────────────────────────────────────────

describe('agent binding field — a searchable picker, not an id text box', () => {
  /** A bot whose manifest declares an `agent` field, bound (or not) to an agent. */
  const withAgent = (over: Partial<InstanceStatus> = {}): InstanceStatus =>
    feishuInstance({
      fields: [
        { key: 'appId', label: 'App ID', type: 'text', required: true },
        { key: 'agentId', label: 'Bound agent', type: 'agent', required: false },
      ],
      values: { appId: 'cli_abc' },
      secrets: {},
      ...over,
    });

  const renderAgent = (client: InstanceClient, over: Partial<InstanceStatus> = {}) =>
    renderInstance(client, { instance: withAgent(over) });

  it('renders a combobox and lists agents by name — never asks for an opaque id', async () => {
    const user = userEvent.setup();
    renderAgent(clientStub().client);

    const box = await screen.findByRole('combobox', { name: 'Bound agent' });
    await user.click(box);

    const list = await screen.findByRole('listbox');
    // The (cached) agent list may still be in flight; wait for it, then assert.
    await within(list).findByText('Alice Writer');
    // Names, with the role as a hint so like-named agents stay distinguishable.
    expect(within(list).getByText('Alice Writer')).toBeTruthy();
    expect(within(list).getByText('Bob Analyst')).toBeTruthy();
  });

  it('filters as you type and saves the selected agent id (not the name)', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    renderAgent(client);

    await user.click(await screen.findByRole('combobox', { name: 'Bound agent' }));
    const list = await screen.findByRole('listbox');
    // Do not type the filter before the options exist.
    await within(list).findByText('Alice Writer');
    await user.keyboard('Bob');

    await waitFor(() => expect(within(list).queryByText('Alice Writer')).toBeNull());
    await user.click(within(list).getByText('Bob Analyst'));

    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')!.payload!['agentId']).toBe('agt_c3d4');
  });

  it('shows the bound agent by name and offers an explicit row to clear it', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();
    // The binding is the instance row's `agentId`; `instanceAsPlatform` feeds it
    // through the manifest's agent field, so this is the one place it is set.
    renderAgent(client, { agentId: 'agt_a1b2' });

    const box = await screen.findByRole('combobox', { name: 'Bound agent' });
    // The stored id is displayed as a name, so the user can see what is bound.
    await waitFor(() => expect((box as HTMLInputElement).value).toBe('Alice Writer'));

    await user.click(box);
    const list = await screen.findByRole('listbox');
    await user.click(await within(list).findByText('Not bound'));

    await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.op === 'save')!.payload!['agentId']).toBe('');
  });

  it('renders no agent picker when the manifest declares no agent field', async () => {
    renderInstance(clientStub().client, {
      platforms: [MATTERMOST],
      instance: {
        platform: 'mattermost',
        fields: MATTERMOST.fields,
        values: {},
        secrets: { botToken: { hasValue: false } },
      },
    });

    await screen.findByTestId('integration-field-serverUrl');
    // The control is chosen from the field's *type*, never from a platform
    // branch — and a platform without an agent field gets no agent control.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  /**
   * LOST GUARANTEE — the agents request is no longer skipped for a platform
   * with no `agent` field.
   *
   * `PlatformCard` computed `needsAgents = status.fields.some(f => f.type ===
   * 'agent')` and passed it as `useAgentOptions`' `enabled` flag, so a
   * Mattermost card issued no `GET /agents` at all. `InstanceCard` calls
   * `useAgentOptions(...)` unconditionally (the flag is never passed), so every
   * bot card loads the list — memoised app-wide, so it is one request rather
   * than one per card, but it is no longer *zero* for an agent-less platform.
   * Skipped rather than deleted so the loss stays visible; see the task report.
   * The user-visible half — no agent *picker* without an agent field — is still
   * pinned by the test above.
   */
  it('does not fetch agents for a platform with no agent field', async () => {
    const agentsSpy = vi.fn(() => Promise.resolve(AGENTS));
    render(
      <InstancesSection
        loadPlatforms={() => Promise.resolve([MATTERMOST])}
        loadInstances={() => Promise.resolve([
          feishuInstance({
            platform: 'mattermost',
            fields: MATTERMOST.fields,
            values: {},
            secrets: { botToken: { hasValue: false } },
          }),
        ])}
        client={clientStub().client}
        loadAgents={agentsSpy}
        defaultExpanded
      />,
    );
    await screen.findByTestId('integration-field-serverUrl');
    expect(agentsSpy).not.toHaveBeenCalled();
  });

  // ── The app-wide blur handler must not eat a mouse pick ────────────────────
  //
  // `LayoutContext` installs a **document-level, capture-phase** `pointerdown`
  // handler that blurs the focused text field whenever the pointer lands on
  // something that is not itself a field. The menu is portalled to
  // `document.body` — outside the card — so before the menu carried
  // `data-keep-edit-focus`, pressing the mouse on an option blurred the input,
  // the blur handler closed the list, and the click never reached the option.
  // Symptom: the picker was mouse-dead while the keyboard kept working (keydown
  // never leaves the input).
  //
  // jsdom cannot see this by itself — no `LayoutProvider` is mounted in these
  // tests — so the handler's blur branch is reproduced verbatim here. Without
  // `data-keep-edit-focus` on the menu this test fails; that is the whole point.
  it('selects an option by mouse even with the capture-phase blur handler installed', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientStub();

    const isTextField = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return el.isContentEditable;
    };
    // Verbatim `LayoutContext.onPointerDown` (blur branch only).
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const active = document.activeElement;
      if (!isTextField(active)) return;
      if (active === target || active.contains(target)) return;
      if (target.closest('[data-keep-edit-focus]')) return;
      if (isTextField(target) || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      active.blur();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    try {
      renderAgent(client);

      await user.click(await screen.findByRole('combobox', { name: 'Bound agent' }));
      const list = await screen.findByRole('listbox');
      await within(list).findByText('Bob Analyst');
      await user.click(within(list).getByText('Bob Analyst'));

      // The pick survived the click — it was not swallowed by a blur.
      expect((screen.getByRole('combobox', { name: 'Bound agent' }) as HTMLInputElement).value).toBe(
        'Bob Analyst',
      );

      await waitFor(() => expect(calls.some((c) => c.op === 'save')).toBe(true), { timeout: 5000 });
      expect(calls.find((c) => c.op === 'save')!.payload!['agentId']).toBe('agt_c3d4');
    } finally {
      document.removeEventListener('pointerdown', onPointerDown, true);
    }
  });
});
