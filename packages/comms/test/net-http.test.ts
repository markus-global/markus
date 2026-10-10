/**
 * The outbound-HTTP seam (src/net/http.ts) and the invariant it exists to hold.
 *
 * Why this file exists: IM platform clients used to call the global `fetch`
 * directly, which silently bypassed the proxy the rest of the platform already
 * honours (LLM traffic goes through `proxyFetch`). The observable symptom was
 * "connection failed" on Telegram/Discord while the LLM path worked fine on the
 * very same machine — indistinguishable from a bad token.
 *
 * So this file pins three things:
 *   1. the classification of transport failures into a coded verdict,
 *   2. that an installed fetch really is what platform clients call, and
 *   3. that no call site can bypass the seam unnoticed (a source-level guard —
 *      the whole point is that a *new* adapter cannot reintroduce the bug).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  setHttpFetch,
  getHttpFetch,
  httpFetch,
  classifyFetchFailure,
  type FetchLike,
} from '../src/net/http.js';
import { TelegramClient } from '../src/telegram/client.js';
import { getManifest } from '../src/platforms/registry.js';

/** A `fetch` failure shaped the way undici actually throws one. */
function transportError(code: string): TypeError {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = { code, message: `connect ${code}` };
  return err;
}

afterEach(() => {
  setHttpFetch(null);
  vi.restoreAllMocks();
});

describe('classifyFetchFailure', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
    'treats a transport errno (%s) as network_unreachable',
    (code) => {
      expect(classifyFetchFailure(transportError(code))).toEqual({
        code: 'network_unreachable',
        detail: code,
      });
    },
  );

  it('treats a bare `TypeError: fetch failed` (no cause) as unreachable', () => {
    // Some runtimes drop the cause; the classification must survive that,
    // otherwise exactly the reported symptom falls back to "fetch failed".
    const verdict = classifyFetchFailure(new TypeError('fetch failed'));
    expect(verdict?.code).toBe('network_unreachable');
  });

  it('treats a timeout abort as unreachable', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyFetchFailure(err)?.code).toBe('network_unreachable');
  });

  it('does NOT claim a platform rejection is a network problem', () => {
    // The remedy differs (fix the token, not the proxy), so this must be null.
    expect(classifyFetchFailure(new Error('invalid app_secret'))).toBeNull();
  });
});

describe('the seam', () => {
  it('defaults to the global fetch and delegates to it', async () => {
    const fake = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fake);
    await httpFetch('https://example.test/');
    expect(fake).toHaveBeenCalledOnce();
  });

  it('routes an installed implementation through platform clients', async () => {
    // The end-to-end claim: install once, and a platform client uses it.
    const installed = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 7, is_bot: true, first_name: 'b' } }),
    });
    setHttpFetch(installed as unknown as FetchLike);

    await new TelegramClient({ botToken: 'tok' }).getMe();

    expect(installed).toHaveBeenCalledOnce();
    expect(String(installed.mock.calls[0]![0])).toContain('/bottok/getMe');
    expect(getHttpFetch()).toBe(installed);
  });

  it('surfaces the coded verdict from a manifest credential probe', async () => {
    // What the Settings API serialises to the UI: a code, not just "fetch failed".
    setHttpFetch((() => Promise.reject(transportError('ENOTFOUND'))) as unknown as FetchLike);

    const result = await getManifest('telegram')!.testConnection!({ botToken: 'tok' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('network_unreachable');
  });
});

describe('structural guard — no call site may bypass the seam', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('has no direct global-fetch call left in any platform client', () => {
    // `net/http.ts` is the one legitimate caller (it *is* the seam).
    const offenders = tsFiles(srcDir)
      .filter((file) => !file.endsWith(`${join('net', 'http.ts')}`))
      .filter((file) => /(?<!this\.rest\.)\bfetch\(/.test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(srcDir.length + 1));

    // A new adapter that calls `fetch(` would land here — that is the point.
    expect(offenders).toEqual([]);
  });
});
