/**
 * Platform manifest registry — slice S5 (issue #340).
 *
 * S5 turns the previously-dead Telegram / Slack / WhatsApp / Discord adapters
 * into usable platforms by *declaring* them in the manifest registry. This file
 * pins the declaration itself: the adapters exist, the manifests describe the
 * config the adapters actually read, secrets are flagged, and the optional
 * credential probes behave (ok / failure / unsupported) without throwing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PLATFORM_MANIFESTS, getManifest, activeInboundMode } from '../src/platforms/registry.js';

const NEW_IDS = ['telegram', 'slack', 'whatsapp', 'discord'] as const;

describe('registry — the four revived platforms', () => {
  it('registers telegram / slack / whatsapp / discord', () => {
    const ids = PLATFORM_MANIFESTS.map((m) => m.id);
    for (const id of NEW_IDS) expect(ids).toContain(id);
  });

  it('keeps manifest ids unique (a registry must be a bijection)', () => {
    const ids = PLATFORM_MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(NEW_IDS)('%s builds an adapter that reports its own platform id', (id) => {
    expect(getManifest(id)!.createAdapter().platform).toBe(id);
  });

  it.each([
    ['telegram', 'botToken'],
    ['slack', 'botToken'],
    ['whatsapp', 'phoneNumberId'],
    ['whatsapp', 'accessToken'],
    ['discord', 'botToken'],
  ])('%s marks %s as required (minimum to build the client)', (id, key) => {
    expect(getManifest(id)!.fields.find((f) => f.key === key)?.required).toBe(true);
  });

  it.each(NEW_IDS)('%s flags every password field as secret', (id) => {
    for (const f of getManifest(id)!.fields) {
      if (f.type === 'password') expect(f.secret, `${id}.${f.key}`).toBe(true);
    }
  });

  it.each(NEW_IDS)('%s declares inbound + outbound capability', (id) => {
    expect(getManifest(id)!.capabilities).toMatchObject({ inbound: true, outbound: true });
  });

  it.each(NEW_IDS)('%s exposes the shared agent-binding field', (id) => {
    expect(getManifest(id)!.fields.some((f) => f.key === 'agentId')).toBe(true);
  });

  it('has no duplicate field keys within any manifest', () => {
    for (const m of PLATFORM_MANIFESTS) {
      const keys = m.fields.map((f) => f.key);
      expect(new Set(keys).size, m.id).toBe(keys.length);
    }
  });

  it('whatsapp declares no connection probe — honest, not a fake success', () => {
    expect(getManifest('whatsapp')!.testConnection).toBeUndefined();
  });
});

/**
 * G7 — the capability table is the *only* place that says how inbound arrives.
 * If a caller had to branch on a platform id to learn "socket vs webhook", the
 * table would not be a table. These assertions pin the declarations and the
 * single pure reader (`activeInboundMode`).
 */
describe('registry — capability declarations (G7)', () => {
  it.each([
    ['feishu', 'socket'],
    ['telegram', 'polling'],
    ['slack', 'socket'],
    ['discord', 'gateway'],
    ['whatsapp', 'webhook'],
  ] as const)('%s declares a %s inbound mode', (id, mode) => {
    expect(getManifest(id)!.capabilities.inboundModes).toContain(mode);
  });

  it.each([
    ['feishu', false],
    ['telegram', false],
    ['slack', false],
    ['discord', false],
    ['whatsapp', true],
  ] as const)('%s declares requiresPublicUrl = %s (honest transport fact)', (id, value) => {
    expect(getManifest(id)!.capabilities.requiresPublicUrl).toBe(value);
  });

  it('declares a 3s ack deadline where the platform demands one', () => {
    expect(getManifest('slack')!.capabilities.ackDeadlineMs).toBe(3000);
    expect(getManifest('discord')!.capabilities.ackDeadlineMs).toBe(3000);
  });

  it('keeps platform-unique abilities in `extra`, never inlined in core', () => {
    expect(getManifest('slack')!.capabilities.extra?.blockKit).toBe(true);
    expect(getManifest('discord')!.capabilities.extra?.slashCommands).toBe(true);
  });

  it('keeps the v1 boolean flags for every existing consumer', () => {
    for (const m of PLATFORM_MANIFESTS) {
      expect(typeof m.capabilities.inbound, m.id).toBe('boolean');
      expect(typeof m.capabilities.outbound, m.id).toBe('boolean');
      expect(typeof m.capabilities.threads, m.id).toBe('boolean');
    }
  });
});

/**
 * `activeInboundMode` is the single execution point for "how does inbound
 * arrive" — the reason core never branches on a platform id.
 */
describe('activeInboundMode — the one reader of the table', () => {
  const caps = (id: string) => getManifest(id)!.capabilities;

  it('defaults to webhook for an unknown platform', () => {
    expect(activeInboundMode(undefined)).toBe('webhook');
  });

  it('honours an explicit socket opt-in (slack / feishu wsMode)', () => {
    expect(activeInboundMode(caps('slack'), { socketMode: true })).toBe('socket');
    expect(activeInboundMode(caps('feishu'), { wsMode: true })).toBe('socket');
    expect(activeInboundMode(caps('slack'), {})).toBe('webhook');
  });

  it('falls back to the platform default when nothing is chosen (feishu: long connection)', () => {
    // Feishu ships a long connection by default (design §6.5) — a desktop
    // install has no public URL. The table must say so, or it contradicts the
    // adapter it feeds.
    expect(caps('feishu')!.defaultInboundMode).toBe('socket');
    expect(activeInboundMode(caps('feishu'), {})).toBe('socket');
  });

  it('lets an explicit webhook opt-out beat the default (feishu wsMode:false)', () => {
    expect(activeInboundMode(caps('feishu'), { wsMode: false })).toBe('webhook');
  });

  it('falls back to the platform default when nothing is chosen (telegram: long polling)', () => {
    // Telegram ships long polling by default for the same reason Feishu ships a
    // long connection: a desktop install has no public HTTPS URL for Telegram to
    // call. This used to fall through to `webhook`, which the adapter then set to
    // `http://localhost:<port>` — a URL Telegram never calls, so every DM to the
    // bot was silently dropped. The table must say `polling` or it contradicts
    // the adapter it feeds.
    expect(caps('telegram')!.defaultInboundMode).toBe('polling');
    expect(activeInboundMode(caps('telegram'), {})).toBe('polling');
  });

  it('honours long polling in both directions (telegram)', () => {
    // Symmetric with `socketMode`: an explicit value beats the declared default,
    // so turning polling *off* must actually select the webhook server —
    // otherwise the toggle is decorative.
    expect(activeInboundMode(caps('telegram'), { pollingEnabled: true })).toBe('polling');
    expect(activeInboundMode(caps('telegram'), { pollingEnabled: false })).toBe('webhook');
  });

  it('picks gateway for a gateway-only platform and webhook for a webhook-only one', () => {
    expect(activeInboundMode(caps('discord'), {})).toBe('gateway');
    expect(activeInboundMode(caps('whatsapp'), {})).toBe('webhook');
  });
});

describe('testConnection probes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('telegram: ok when getMe returns ok:true, and hits the bot endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getManifest('telegram')!.testConnection!({ botToken: 'abc' })).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/botabc/getMe');
  });

  it('telegram: surfaces the Telegram error description', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) })),
    );
    expect(await getManifest('telegram')!.testConnection!({ botToken: 'abc' })).toEqual({
      ok: false,
      error: 'Unauthorized',
    });
  });

  it('telegram: missing token short-circuits without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await getManifest('telegram')!.testConnection!({})).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('slack: ok on auth.test, sending the bot token as a Bearer header', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getManifest('slack')!.testConnection!({ botToken: 'xoxb-1' })).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer xoxb-1');
  });

  it('slack: surfaces the Slack error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) })),
    );
    expect(await getManifest('slack')!.testConnection!({ botToken: 'x' })).toEqual({
      ok: false,
      error: 'invalid_auth',
    });
  });

  it('discord: ok on GET /users/@me with Bot auth', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getManifest('discord')!.testConnection!({ botToken: 'tok' })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/users/@me');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bot tok');
  });

  it('discord: reports the HTTP status on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await getManifest('discord')!.testConnection!({ botToken: 'x' })).toEqual({ ok: false, error: 'HTTP 401' });
  });

  it('network errors are returned as { ok:false }, never thrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await getManifest('telegram')!.testConnection!({ botToken: 'x' })).toEqual({
      ok: false,
      error: 'ECONNREFUSED',
    });
  });
});

/**
 * The optional channel-listing capability behind the bot-instance picker.
 *
 * Only Feishu implements it (its chat list is directly routable); the mapping
 * from the raw API item to our DTO is the part a Settings client depends on, so
 * it is pinned here rather than left to the route.
 */
describe('listChannels (channel picker)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is declared by feishu only — a platform that cannot enumerate says so', () => {
    expect(getManifest('feishu')!.listChannels).toBeTypeOf('function');
    for (const id of ['telegram', 'slack', 'whatsapp', 'discord']) {
      expect(getManifest(id)!.listChannels, id).toBeUndefined();
    }
  });

  it('maps Feishu chats to { id, name, kind:group }, dropping anything without a chat_id', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('tenant_access_token')) {
        return { json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_1', name: 'Team One', chat_mode: 'group' },
              { chat_id: 'oc_2', name: 'Team Two' },
              { name: 'no id — must not surface' },
            ],
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await getManifest('feishu')!.listChannels!({ appId: 'cli_a', appSecret: 's' })).toEqual([
      { id: 'oc_1', name: 'Team One', kind: 'group' },
      { id: 'oc_2', name: 'Team Two', kind: 'group' },
    ]);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/open-apis/im/v1/chats');
  });

  it('throws without credentials — "cannot list" must not look like "no channels"', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(getManifest('feishu')!.listChannels!({})).rejects.toThrow(/appId and appSecret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
