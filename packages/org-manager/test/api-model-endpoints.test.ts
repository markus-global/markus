import { describe, it, expect, vi } from 'vitest';
import type { LLMRouter } from '@markus/core/src/llm/router.js';
import type { SessionModelOverride } from '@markus/shared';

/**
 * Tests for the session model API endpoints that mirror the logic in
 * api-server.ts for GET/POST/DELETE /api/sessions/:sessionId/model.
 *
 * The API endpoints perform these steps before / after router operations:
 *   1. requireAuth — checks authentication
 *   2. llmRouter availability — returns 503 if missing
 *   3. Session ownership check — returns 403 if session belongs to another user
 *   4. Input validation — returns 400 for missing/invalid fields
 *   5. Router operation — setSessionModel / getSessionModel / clearSessionModel
 *   6. Audit logging
 *
 * These tests verify steps 3-6 by simulating the exact LLMRouter interaction
 * patterns that the API endpoints use, with mocked auth and storage.
 */

// ── Mock factories ────────────────────────────────────────────────────

function createMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    getSessionModel: vi.fn<(sessionId: string) => SessionModelOverride | undefined>(),
    setSessionModel: vi.fn<(sessionId: string, override: SessionModelOverride) => void>(),
    clearSessionModel: vi.fn<(sessionId: string) => void>(),
    clearAllSessionModels: vi.fn<() => void>(),
    listProviders: vi.fn(() => ['anthropic']),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    setDefaultProvider: vi.fn(),
    setProviderModel: vi.fn(),
    registerProviderFromConfig: vi.fn(),
    getProvider: vi.fn(),
    getActiveModelName: vi.fn(() => 'claude-sonnet-4-20250514'),
    isProviderEnabled: vi.fn(() => true),
    setProviderEnabled: vi.fn(),
    isAutoSelectEnabled: vi.fn(() => false),
    getEnhancedSettings: vi.fn(),
  } as unknown as LLMRouter;
}

interface MockSession {
  id: string;
  userId?: string;
}

function createMockStorage(sessions: MockSession[] = []) {
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  return {
    chatSessionRepo: {
      getSession: vi.fn((id: string) => sessionMap.get(id) ?? undefined),
    },
  };
}

interface AuditRecord {
  orgId: string;
  type: string;
  action: string;
  detail: string;
  userId: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}

function createMockAuditService() {
  const records: AuditRecord[] = [];
  return {
    record: vi.fn((rec: AuditRecord) => { records.push(rec); }),
    getRecords: () => records,
  };
}

// ── Simulated API endpoint logic ────────────────────────────────────

/**
 * Simulates POST /api/sessions/:sessionId/model
 * Returns { status, body } mimicking what the real API would JSON-respond.
 */
function simulatePostModel(
  sessionId: string,
  authUser: { userId: string; role: string } | null,
  body: { provider?: string; model?: string },
  router: LLMRouter | null,
  storage?: ReturnType<typeof createMockStorage>,
  auditService?: ReturnType<typeof createMockAuditService>,
): { status: number; body: Record<string, unknown> } {
  // Step 1: requireAuth
  if (!authUser) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  // Step 2: llmRouter availability
  if (!router) {
    return { status: 503, body: { error: 'LLM router not available' } };
  }

  // Step 3: Session ownership check
  if (storage) {
    const session = storage.chatSessionRepo.getSession(sessionId);
    if (session && session.userId && session.userId !== authUser.userId) {
      const isAdminOrOwner = authUser.role === 'owner' || authUser.role === 'admin';
      if (!isAdminOrOwner) {
        return { status: 403, body: { error: 'Access denied: this session belongs to another user' } };
      }
    }
  }

  // Step 4: Input validation
  const { provider, model } = body;
  if (!provider || typeof provider !== 'string') {
    return { status: 400, body: { error: 'provider (string) is required' } };
  }
  if (!model || typeof model !== 'string') {
    return { status: 400, body: { error: 'model (string) is required' } };
  }

  // Step 5: Router operation
  try {
    (router.setSessionModel as ReturnType<typeof vi.fn>)(sessionId, { provider, model });

    // Step 6: Audit logging
    auditService?.record({
      orgId: 'system',
      type: 'settings_changed',
      action: 'session_model_override',
      detail: `Session ${sessionId} model → ${provider}/${model}`,
      userId: authUser.userId,
      success: true,
      metadata: { sessionId, provider, model },
    });

    return { status: 200, body: { success: true, provider, model } };
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }
}

/**
 * Simulates DELETE /api/sessions/:sessionId/model
 */
function simulateDeleteModel(
  sessionId: string,
  authUser: { userId: string; role: string } | null,
  router: LLMRouter | null,
  storage?: ReturnType<typeof createMockStorage>,
  auditService?: ReturnType<typeof createMockAuditService>,
): { status: number; body: Record<string, unknown> } {
  // Step 1: requireAuth
  if (!authUser) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  // Step 2: llmRouter availability
  if (!router) {
    return { status: 503, body: { error: 'LLM router not available' } };
  }

  // Step 3: Session ownership check
  if (storage) {
    const session = storage.chatSessionRepo.getSession(sessionId);
    if (session && session.userId && session.userId !== authUser.userId) {
      const isAdminOrOwner = authUser.role === 'owner' || authUser.role === 'admin';
      if (!isAdminOrOwner) {
        return { status: 403, body: { error: 'Access denied: this session belongs to another user' } };
      }
    }
  }

  // Step 4: Router operation
  (router.clearSessionModel as ReturnType<typeof vi.fn>)(sessionId);

  // Step 5: Audit logging
  auditService?.record({
    orgId: 'system',
    type: 'settings_changed',
    action: 'session_model_override_clear',
    detail: `Session ${sessionId} model override cleared`,
    userId: authUser.userId,
    success: true,
    metadata: { sessionId },
  });

  return { status: 204, body: {} };
}

/**
 * Simulates GET /api/sessions/:sessionId/model
 */
function simulateGetModel(
  sessionId: string,
  authUser: { userId: string; role: string } | null,
  router: LLMRouter | null,
  storage?: ReturnType<typeof createMockStorage>,
): { status: number; body: Record<string, unknown> } {
  // Step 1: requireAuth
  if (!authUser) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  // Step 2: Session ownership check
  if (storage) {
    const session = storage.chatSessionRepo.getSession(sessionId);
    if (session && session.userId && session.userId !== authUser.userId) {
      const isAdminOrOwner = authUser.role === 'owner' || authUser.role === 'admin';
      if (!isAdminOrOwner) {
        return { status: 403, body: { error: 'Access denied: this session belongs to another user' } };
      }
    }
  }

  // Step 3: Router operation
  if (!router) {
    return { status: 200, body: { provider: undefined, model: undefined, setAt: undefined } };
  }

  const override = (router.getSessionModel as ReturnType<typeof vi.fn>)(sessionId) as SessionModelOverride | undefined;
  return {
    status: 200,
    body: {
      provider: override?.provider ?? null,
      model: override?.model ?? null,
      setAt: override?.setAt ?? null,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('POST /api/sessions/:sessionId/model', () => {
  it('returns 401 when not authenticated', () => {
    const result = simulatePostModel('sess-1', null, { provider: 'anthropic', model: 'claude-sonnet-4' }, createMockRouter());
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('Unauthorized');
  });

  it('returns 503 when llmRouter is not available', () => {
    const result = simulatePostModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      null, // router = null
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('router not available');
  });

  it('returns 403 when session belongs to another user (non-admin)', () => {
    const router = createMockRouter();
    const storage = createMockStorage([{ id: 'sess-other', userId: 'user-other' }]);
    const result = simulatePostModel(
      'sess-other',
      { userId: 'user-1', role: 'member' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      router,
      storage,
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toContain('Access denied');
  });

  it('allows admin/owner to modify other users session', () => {
    const router = createMockRouter();
    const storage = createMockStorage([{ id: 'sess-other', userId: 'user-other' }]);
    const result = simulatePostModel(
      'sess-other',
      { userId: 'admin-1', role: 'admin' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      router,
      storage,
    );
    expect(result.status).toBe(200);
    expect(router.setSessionModel).toHaveBeenCalledWith('sess-other', {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });

  it('returns 400 when provider is missing', () => {
    const result = simulatePostModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      { model: 'claude-sonnet-4' },  // no provider
      createMockRouter(),
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('provider');
  });

  it('returns 400 when model is missing', () => {
    const result = simulatePostModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      { provider: 'anthropic' },  // no model
      createMockRouter(),
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('model');
  });

  it('returns 200 and calls setSessionModel on success', () => {
    const router = createMockRouter();
    const auditService = createMockAuditService();
    const result = simulatePostModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      router,
      undefined,
      auditService,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      success: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(router.setSessionModel).toHaveBeenCalledWith('sess-1', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    // Verify audit log
    expect(auditService.getRecords()).toHaveLength(1);
    expect(auditService.getRecords()[0].action).toBe('session_model_override');
    expect(auditService.getRecords()[0].detail).toContain('sess-1');
  });

  it('allows setting model for non-existent session (no storage)', () => {
    const router = createMockRouter();
    const result = simulatePostModel(
      'sess-nonexistent',
      { userId: 'user-1', role: 'member' },
      { provider: 'openai', model: 'gpt-4o' },
      router,
      createMockStorage([]), // Storage exists but session does not
    );
    expect(result.status).toBe(200);
    expect(router.setSessionModel).toHaveBeenCalledWith('sess-nonexistent', {
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('supports setting model-only override (without provider validation)', () => {
    const router = createMockRouter();
    const result = simulatePostModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      { provider: 'nonexistent', model: 'custom-model-v1' },
      router,
    );
    expect(result.status).toBe(200);
    // The router stores even unknown providers — validation is deferred to routing time
    expect(router.setSessionModel).toHaveBeenCalledWith('sess-1', {
      provider: 'nonexistent',
      model: 'custom-model-v1',
    });
  });
});

describe('DELETE /api/sessions/:sessionId/model', () => {
  it('returns 401 when not authenticated', () => {
    const result = simulateDeleteModel('sess-1', null, createMockRouter());
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('Unauthorized');
  });

  it('returns 503 when llmRouter is not available', () => {
    const result = simulateDeleteModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      null, // router = null
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('router not available');
  });

  it('returns 403 when session belongs to another user (non-admin)', () => {
    const router = createMockRouter();
    const storage = createMockStorage([{ id: 'sess-other', userId: 'user-other' }]);
    const result = simulateDeleteModel(
      'sess-other',
      { userId: 'user-1', role: 'member' },
      router,
      storage,
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toContain('Access denied');
    expect(router.clearSessionModel).not.toHaveBeenCalled();
  });

  it('returns 204 and calls clearSessionModel on success', () => {
    const router = createMockRouter();
    // First set a model override
    (router.setSessionModel as ReturnType<typeof vi.fn>)('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4' });

    const auditService = createMockAuditService();
    const result = simulateDeleteModel(
      'sess-1',
      { userId: 'user-1', role: 'member' },
      router,
      undefined,
      auditService,
    );
    expect(result.status).toBe(204);
    expect(router.clearSessionModel).toHaveBeenCalledWith('sess-1');
    // Verify audit log
    expect(auditService.getRecords()).toHaveLength(1);
    expect(auditService.getRecords()[0].action).toBe('session_model_override_clear');
    expect(auditService.getRecords()[0].detail).toContain('sess-1');
  });

  it('allows admin/owner to clear model override on other user session', () => {
    const router = createMockRouter();
    const storage = createMockStorage([{ id: 'sess-other', userId: 'user-other' }]);
    const result = simulateDeleteModel(
      'sess-other',
      { userId: 'admin-1', role: 'admin' },
      router,
      storage,
    );
    expect(result.status).toBe(204);
    expect(router.clearSessionModel).toHaveBeenCalledWith('sess-other');
  });

  it('gracefully handles clearing non-existent override', () => {
    const router = createMockRouter();
    const result = simulateDeleteModel(
      'sess-never-set',
      { userId: 'user-1', role: 'member' },
      router,
    );
    expect(result.status).toBe(204);
    // clearSessionModel on a non-existent key is a no-op
    expect(router.clearSessionModel).toHaveBeenCalledWith('sess-never-set');
  });
});

describe('GET /api/sessions/:sessionId/model', () => {
  it('returns 401 when not authenticated', () => {
    const result = simulateGetModel('sess-1', null, createMockRouter());
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('Unauthorized');
  });

  it('returns 200 with null values when no override set', () => {
    const router = createMockRouter();
    (router.getSessionModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const result = simulateGetModel('sess-1', { userId: 'user-1', role: 'member' }, router);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      provider: null,
      model: null,
      setAt: null,
    });
  });

  it('returns 200 with override values when override is set', () => {
    const router = createMockRouter();
    (router.getSessionModel as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      setAt: '2026-07-02T00:00:00.000Z',
    });
    const result = simulateGetModel('sess-1', { userId: 'user-1', role: 'member' }, router);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      setAt: '2026-07-02T00:00:00.000Z',
    });
  });

  it('returns 403 when session belongs to another user (non-admin)', () => {
    const router = createMockRouter();
    const storage = createMockStorage([{ id: 'sess-other', userId: 'user-other' }]);
    const result = simulateGetModel(
      'sess-other',
      { userId: 'user-1', role: 'member' },
      router,
      storage,
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toContain('Access denied');
  });
});

describe('Session model override — full lifecycle integration', () => {
  it('set → get → clear → get works correctly', () => {
    const router = createMockRouter();
    const auditService = createMockAuditService();

    // Step 1: Set override
    const setResult = simulatePostModel(
      'sess-lifecycle',
      { userId: 'user-1', role: 'member' },
      { provider: 'openai', model: 'gpt-4o' },
      router,
      undefined,
      auditService,
    );
    expect(setResult.status).toBe(200);

    // Step 2: Verify get returns the override
    (router.getSessionModel as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o',
      setAt: new Date().toISOString(),
    });
    const getAfterSet = simulateGetModel('sess-lifecycle', { userId: 'user-1', role: 'member' }, router);
    expect(getAfterSet.status).toBe(200);
    expect(getAfterSet.body.provider).toBe('openai');
    expect(getAfterSet.body.model).toBe('gpt-4o');

    // Step 3: Clear override
    const clearResult = simulateDeleteModel('sess-lifecycle', { userId: 'user-1', role: 'member' }, router, undefined, auditService);
    expect(clearResult.status).toBe(204);

    // Step 4: Verify get returns null after clear
    (router.getSessionModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const getAfterClear = simulateGetModel('sess-lifecycle', { userId: 'user-1', role: 'member' }, router);
    expect(getAfterClear.status).toBe(200);
    expect(getAfterClear.body.provider).toBeNull();
    expect(getAfterClear.body.model).toBeNull();
    expect(getAfterClear.body.setAt).toBeNull();
  });
});
