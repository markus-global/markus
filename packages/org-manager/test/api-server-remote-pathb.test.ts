import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Route-behaviour tests: run with auth bypassed so the anonymous request is
// treated as the org owner.
process.env['AUTH_ENABLED'] = 'false';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestServer, request } from './api-server-test-helpers.js';
import type { RemoteSetupPlannerLike } from '../src/api-server.js';

/**
 * Path B (T10) — "hand the tunnel setup to an Agent".
 *
 * These tests pin the seam the wizard relies on: the plan is built server-side
 * (never in the browser), the contract comes back to the UI verbatim, and the
 * dispatch goes to a real Agent through the normal mailbox path.
 *
 * Every server is given a throw-away config path: these routes persist the
 * `config.remote` INTENT, and a test must never touch the operator's real
 * `~/.markus/markus.json`.
 */

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-pathb-'));
  cfgPath = join(dir, 'markus.json');
  writeFileSync(cfgPath, JSON.stringify({ server: { apiPort: 8056 } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function newServer() {
  const ctx = createTestServer();
  ctx.server.setConfigPath(cfgPath);
  return ctx;
}

/** A planner stub that records what the server asked for. */
function makePlanner() {
  const seen: Array<Record<string, unknown>> = [];
  const planner: RemoteSetupPlannerLike = {
    plan: (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return {
        contract: {
          goal: `开通 ${input.kind}（${input.platform}）`,
          commands: [{ shell: 'sh', run: 'true', purpose: 'noop', sensitive: false, idempotent: true }],
          successCriteria: [],
          rollback: [],
        },
        prompt: `EXECUTE:${input.kind}`,
      };
    },
  };
  return { planner, seen };
}

describe('GET /api/settings/remote/detect', () => {
  it('501s when detection is not wired', async () => {
    const { server } = newServer();
    const res = await request(server, 'GET', '/api/settings/remote/detect');
    expect(res.status).toBe(501);
  });

  it('returns the injected probe result', async () => {
    const { server } = newServer();
    server.setRemoteDetectHandler(async () => ({ cloudflared: true, tailscale: false }));
    const res = await request(server, 'GET', '/api/settings/remote/detect');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ cloudflared: true, tailscale: false });
  });

  it('degrades to "not found" instead of 500 when the probe throws', async () => {
    const { server } = newServer();
    server.setRemoteDetectHandler(async () => {
      throw new Error('which exploded');
    });
    const res = await request(server, 'GET', '/api/settings/remote/detect');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ cloudflared: false, tailscale: false });
  });
});

describe('GET /api/settings/remote/agent-setup/targets', () => {
  it('lists candidate Agents and recommends the org Secretary', async () => {
    const { server } = newServer();
    const res = await request(server, 'GET', '/api/settings/remote/agent-setup/targets');
    expect(res.status).toBe(200);
    const agents = res.json['agents'] as Array<{ id: string }>;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.map((a) => a.id)).toContain('secretary');
    expect(res.json['recommendedId']).toBe('secretary');
    // The picker must never leak anything beyond id/name/role.
    for (const a of agents) {
      expect(Object.keys(a).sort()).toEqual(['id', 'name', 'role']);
    }
  });
});

describe('POST /api/settings/remote/agent-setup', () => {
  it('501s when no planner is wired', async () => {
    const { server } = newServer();
    const res = await request(server, 'POST', '/api/settings/remote/agent-setup', { kind: 'cloudflare_quick' });
    expect(res.status).toBe(501);
  });

  it('400s on an unsupported tunnel kind', async () => {
    const { server } = newServer();
    server.setRemoteSetupPlanner(makePlanner().planner);
    const res = await request(server, 'POST', '/api/settings/remote/agent-setup', {
      kind: 'not_a_tunnel',
    });
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toContain('Unsupported tunnel kind');
  });

  it('400s on an unknown Agent instead of silently substituting one', async () => {
    const { server } = newServer();
    server.setRemoteSetupPlanner(makePlanner().planner);
    const res = await request(server, 'POST', '/api/settings/remote/agent-setup', {
      kind: 'cloudflare_quick',
      agentId: 'agt_does_not_exist',
    });
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toContain('Unknown Agent');
  });

  it('builds the contract server-side and returns it with the prompt — WITHOUT dispatching', async () => {
    const { server, agentManager } = newServer();
    const { planner, seen } = makePlanner();
    server.setRemoteSetupPlanner(planner, 8123);

    const res = await request(server, 'POST', '/api/settings/remote/agent-setup', {
      kind: 'cloudflare_quick',
      platform: 'macos',
      username: 'alice',
      instanceName: 'My Markus',
    });

    expect(res.status).toBe(200);
    expect(res.json['agentId']).toBe('secretary');
    expect(res.json['contract']).toBeTruthy();
    // The prompt comes back so the wizard can prefill the Agent's composer.
    expect(res.json['prompt']).toBe('EXECUTE:cloudflare_quick');

    // The server — not the browser — decided the local port and platform.
    expect(seen).toHaveLength(1);
    expect(seen[0]!['kind']).toBe('cloudflare_quick');
    expect(seen[0]!['platform']).toBe('macos');
    expect(seen[0]!['localPort']).toBe(8123);
    expect(seen[0]!['username']).toBe('alice');
    expect(seen[0]!['instanceName']).toBe('My Markus');

    // Nothing was sent: the user reviews the prefilled draft and presses send.
    // (A background `sendMessage` here would make the whole run a black box.)
    const secretary = agentManager.getAgent('secretary') as unknown as { sendMessage: ReturnType<typeof vi.fn> };
    expect(secretary.sendMessage).not.toHaveBeenCalled();
  });

  it('honours an explicitly chosen Agent (returned, never messaged)', async () => {
    const { server, agentManager } = newServer();
    server.setRemoteSetupPlanner(makePlanner().planner);
    const res = await request(server, 'POST', '/api/settings/remote/agent-setup', {
      kind: 'tailscale_funnel',
      agentId: 'secretary',
    });
    expect(res.status).toBe(200);
    expect(res.json['agentId']).toBe('secretary');
    const secretary = agentManager.getAgent('secretary') as unknown as { sendMessage: ReturnType<typeof vi.fn> };
    expect(secretary.sendMessage).not.toHaveBeenCalled();
  });

  it('defaults the platform from the host OS when the client omits it', async () => {
    const { server } = newServer();
    const { planner, seen } = makePlanner();
    server.setRemoteSetupPlanner(planner);
    await request(server, 'POST', '/api/settings/remote/agent-setup', { kind: 'cloudflare_quick' });
    const expected =
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    expect(seen[0]!['platform']).toBe(expected);
  });
});

describe('POST /api/settings/remote/tunnel/register', () => {
  it('400s without a publicUrl', async () => {
    const { server } = newServer();
    server.setRemoteAgent({
      getRemoteStatus: () => ({}),
      start: async () => undefined,
      stop: async () => undefined,
      adopt: async () => undefined,
      onStatus: () => () => undefined,
    });
    const res = await request(server, 'POST', '/api/settings/remote/tunnel/register', {});
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toContain('publicUrl');
  });

  it('400s when the running controller cannot adopt an external address', async () => {
    const { server } = newServer();
    const res = await request(server, 'POST', '/api/settings/remote/tunnel/register', {
      publicUrl: 'https://abc.trycloudflare.com',
    });
    expect(res.status).toBe(400);
  });

  it('adopts the address through the controller', async () => {
    const { server } = newServer();
    const adopted: string[] = [];
    server.setRemoteAgent({
      getRemoteStatus: () => ({ enabled: true, publicUrl: adopted[0] ?? null }),
      start: async () => undefined,
      stop: async () => undefined,
      adopt: async (url: string) => {
        adopted.push(url);
      },
      onStatus: () => () => undefined,
    });
    const res = await request(server, 'POST', '/api/settings/remote/tunnel/register', {
      kind: 'cloudflare_quick',
      publicUrl: '  https://abc.trycloudflare.com  ',
    });
    expect(res.status).toBe(200);
    expect(adopted).toEqual(['https://abc.trycloudflare.com']);
  });
});
