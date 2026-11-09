import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// These tests pin route behaviour, not the auth layer: run with auth bypassed so
// the anonymous request is treated as the org owner (as the pre-auth-gate suite did).
process.env['AUTH_ENABLED'] = 'false';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestServer, request } from './api-server-test-helpers.js';
import type { RemoteControllerLike } from '../src/api-server.js';

/**
 * T8 — remote-access wiring on the local API server.
 *
 * Covers: the single `remote:status` payload (V2 + legacy aliases), config
 * read/write being a single source of truth (INTENT only), the enable/disable/
 * restart/rotate routes, and the injected verify-route hook.
 */

function makeController(over: Partial<RemoteControllerLike> = {}) {
  const calls: string[] = [];
  let payload: Record<string, unknown> = {
    enabled: true,
    mode: 'cloudflare_quick',
    state: 'ready',
    entryUrl: 'https://me.remote.markus.global',
    publicUrl: 'https://abc.trycloudflare.com',
    health: 'up',
    connected: true,
    remoteUrl: 'https://abc.trycloudflare.com',
    signalUrl: null,
    instanceId: 'ep_1',
    peerCount: 0,
    peers: [],
  };
  const listeners = new Set<() => void>();
  const controller: RemoteControllerLike = {
    getRemoteStatus: () => payload,
    start: async () => void calls.push('start'),
    stop: async () => void calls.push('stop'),
    restart: async () => void calls.push('restart'),
    rotate: async () => void calls.push('rotate'),
    onStatus: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getVerifyToken: () => 'vtok',
    getVerifyPath: () => '/api/remote/verify',
    getActiveEndpointId: () => 'ep_1',
    ...over,
  };
  return {
    controller,
    calls,
    setPayload: (p: Record<string, unknown>) => {
      payload = { ...payload, ...p };
    },
    emit: () => listeners.forEach((l) => l()),
  };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

describe('API server — remote access (T8)', () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'markus-remote-'));
    cfgPath = join(dir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ server: { apiPort: 8056 } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('status payload', () => {
    it('GET returns the controller payload (V2 + legacy aliases)', async () => {
      const { server } = createTestServer();
      const c = makeController();
      server.setRemoteAgent(c.controller);

      const res = await request(server, 'GET', '/api/settings/remote');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        mode: 'cloudflare_quick',
        state: 'ready',
        publicUrl: 'https://abc.trycloudflare.com',
        instanceId: 'ep_1',
        // legacy aliases stay on the wire for old UI builds
        connected: true,
        remoteUrl: 'https://abc.trycloudflare.com',
        signalUrl: null,
        peerCount: 0,
        peers: [],
      });
    });

    it('with no controller reports the persisted INTENT (configured but offline)', async () => {
      const { server } = createTestServer();
      server.setConfigPath(cfgPath);
      writeFileSync(cfgPath, JSON.stringify({ remote: { enabled: true, mode: 'tailscale_serve' } }));

      const res = await request(server, 'GET', '/api/settings/remote');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        enabled: true,
        mode: 'tailscale_serve',
        state: 'idle',
        connected: false,
        remoteUrl: null,
        instanceId: null,
      });
    });

    it('controller status changes broadcast a remote:status V2 payload', async () => {
      const { server } = createTestServer();
      const broadcast = vi.spyOn(server.getWSBroadcaster(), 'broadcast');
      const c = makeController();
      server.setRemoteAgent(c.controller);

      c.setPayload({ state: 'degraded', health: 'down', connected: false });
      c.emit();

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'remote:status' }));
      const last = broadcast.mock.calls.at(-1)![0] as { payload: Record<string, unknown> };
      expect(last.payload).toMatchObject({
        mode: 'cloudflare_quick',
        state: 'degraded',
        health: 'down',
        connected: false,
      });
    });

    it('a legacy agent exposing only getStatus() still works (back-compat)', async () => {
      const { server } = createTestServer();
      const broadcast = vi.spyOn(server.getWSBroadcaster(), 'broadcast');
      let cb: (() => void) | undefined;
      server.setRemoteAgent({
        getStatus: () => ({ enabled: true, connected: false, state: 'connecting' }),
        start: async () => {},
        stop: async () => {},
        onStatus: (c: () => void) => {
          cb = c;
          return () => {};
        },
      } as unknown as RemoteControllerLike);

      cb?.();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'remote:status' }));
      const last = broadcast.mock.calls.at(-1)![0] as { payload: Record<string, unknown> };
      expect(last.payload).toMatchObject({ enabled: true, state: 'connecting' });
    });
  });

  describe('enable / disable config (single source of truth)', () => {
    it('POST /enable starts the tunnel and persists ONLY the intent', async () => {
      const { server } = createTestServer();
      server.setConfigPath(cfgPath);
      const c = makeController();
      server.setRemoteAgent(c.controller);

      const res = await request(server, 'POST', '/api/settings/remote/enable', { mode: 'tailscale_funnel' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true });
      expect(c.calls).toContain('start');

      const saved = readJson(cfgPath);
      expect(saved['remote']).toEqual({ enabled: true, mode: 'tailscale_funnel' });
      // No duplicate state: the persisted block never echoes live tunnel state.
      const remote = saved['remote'] as unknown as Record<string, unknown>;
      expect(remote['publicUrl']).toBeUndefined();
      expect(remote['state']).toBeUndefined();
      expect(remote['entryUrl']).toBeUndefined();
    });

    it('POST /enable rejects an unknown mode (whitelist) but still persists the intent', async () => {
      const { server } = createTestServer();
      server.setConfigPath(cfgPath);
      server.setRemoteAgent(makeController().controller);

      await request(server, 'POST', '/api/settings/remote/enable', { mode: 'evil-mode' });
      expect(readJson(cfgPath)['remote']).toEqual({ enabled: true });
    });

    it('POST /enable builds the controller via the factory when none is wired', async () => {
      const { server } = createTestServer();
      server.setConfigPath(cfgPath);
      const c = makeController();
      server.setRemoteAgentFactory(async () => c.controller);

      const res = await request(server, 'POST', '/api/settings/remote/enable');
      expect(res.status).toBe(200);
      expect(c.calls).toContain('start');
      expect(readJson(cfgPath)['remote']).toEqual({ enabled: true });
    });

    it('POST /disable stops the controller and persists enabled:false', async () => {
      const { server } = createTestServer();
      server.setConfigPath(cfgPath);
      writeFileSync(cfgPath, JSON.stringify({ remote: { enabled: true, mode: 'cloudflare_quick' } }));
      const c = makeController();
      server.setRemoteAgent(c.controller);

      const res = await request(server, 'POST', '/api/settings/remote/disable');
      expect(res.status).toBe(200);
      expect(c.calls).toContain('stop');
      // Only `enabled` flips — the chosen mode is preserved (intent, not state).
      expect(readJson(cfgPath)['remote']).toEqual({ enabled: false, mode: 'cloudflare_quick' });
    });
  });

  describe('tunnel control routes', () => {
    // The paths here are the ones the web-ui wizard declares in
    // `REMOTE_LOCAL_ROUTES` (T9); T10 aligned the server onto that table.
    it('POST /tunnel/restart and /tunnel/rotate drive the controller', async () => {
      const { server } = createTestServer();
      const c = makeController();
      server.setRemoteAgent(c.controller);

      expect((await request(server, 'POST', '/api/settings/remote/tunnel/restart')).status).toBe(200);
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/rotate')).status).toBe(200);
      expect(c.calls).toEqual(['restart', 'rotate']);
    });

    it('POST /tunnel/register lazily wires the controller (works before any /enable)', async () => {
      // Regression (2026-10-14): the wizard's "我已运行" → paste-address → register
      // flow must work in a session where no tunnel was ever supervised, because
      // boot only wires the controller when config.remote.enabled was already true.
      const { server } = createTestServer();
      const adopted: string[] = [];
      const c = makeController({ adopt: async (url: string) => void adopted.push(url) });
      server.setRemoteAgentFactory(async () => c.controller);

      const res = await request(server, 'POST', '/api/settings/remote/tunnel/register', {
        kind: 'cloudflare_quick',
        publicUrl: 'https://x.trycloudflare.com',
      });

      expect(res.status).toBe(200);
      expect(adopted).toEqual(['https://x.trycloudflare.com']);
    });

    it('POST /tunnel/register 400s (actionably) when nothing can be wired', async () => {
      const { server } = createTestServer();
      const res = await request(server, 'POST', '/api/settings/remote/tunnel/register', {
        publicUrl: 'https://x.trycloudflare.com',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain('Sign in to the Markus Hub');
    });

    it('POST /tunnel/stop stops the controller', async () => {
      const { server } = createTestServer();
      const c = makeController();
      server.setRemoteAgent(c.controller);
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/stop')).status).toBe(200);
      expect(c.calls).toEqual(['stop']);
    });

    it('400s when nothing is running', async () => {
      const { server } = createTestServer();
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/restart')).status).toBe(400);
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/rotate')).status).toBe(400);
    });

    it('400s when the controller does not support the operation', async () => {
      const { server } = createTestServer();
      const c = makeController({ restart: undefined, rotate: undefined });
      server.setRemoteAgent(c.controller);
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/restart')).status).toBe(400);
      expect((await request(server, 'POST', '/api/settings/remote/tunnel/rotate')).status).toBe(400);
    });
  });

  describe('verify route hook', () => {
    it('answers the injected verify path and falls through for everything else', async () => {
      const { server } = createTestServer();
      server.setRemoteVerifyHandler((req, res) => {
        if ((req.url ?? '').split('?')[0] !== '/api/remote/verify') return false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'vtok' }));
        return true;
      });

      const ok = await request(server, 'GET', '/api/remote/verify');
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ token: 'vtok' });

      // A non-matching path is routed normally, not swallowed by the hook.
      const other = await request(server, 'GET', '/api/settings/remote');
      expect(other.status).toBe(200);
      expect(other.json['token']).toBeUndefined();
    });

    it('a throwing hook never breaks normal routing', async () => {
      const { server } = createTestServer();
      server.setRemoteVerifyHandler(() => {
        throw new Error('boom');
      });
      const other = await request(server, 'GET', '/api/settings/remote');
      expect(other.status).toBe(200);
    });
  });
});
