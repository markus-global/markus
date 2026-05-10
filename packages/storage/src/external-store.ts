/**
 * SQLite repositories for External Mode tables.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ExternalServiceConfig,
  ExternalSession,
  ExternalMessage,
  ShareToken,
  ExternalServiceStats,
  ExternalServiceStatus,
  ExternalSessionStatus,
  ShareTokenStatus,
} from '@markus/shared';

type SqlParams = SQLInputValue[];

function generateId(prefix = ''): string {
  const uuid = randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function now(): string {
  return new Date().toISOString();
}

function toJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function fromJson<T = unknown>(v: string | null | undefined): T {
  return v ? (JSON.parse(v) as T) : (null as T);
}

// ─── External Service Repo ──────────────────────────────────────────────────

export class SqliteExternalServiceRepo {
  constructor(private db: DatabaseSync) {}

  create(data: Omit<ExternalServiceConfig, 'id' | 'createdAt' | 'updatedAt'>): ExternalServiceConfig {
    const id = generateId('extsvc');
    const ts = now();
    this.db.prepare(`
      INSERT INTO external_services (
        id, agent_id, snapshot_id, version, status, name, description, avatar_url,
        max_concurrent_sessions, session_timeout_ms, max_messages_per_session,
        tool_policy, input_validation, content_filter,
        token_budget_per_session, token_budget_per_day,
        ui_mode, ui_config, middlewares, welcome_message, input_placeholder,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.agentId, data.snapshotId, data.version, data.status,
      data.name, data.description ?? null, data.avatarUrl ?? null,
      data.maxConcurrentSessions, data.sessionTimeoutMs, data.maxMessagesPerSession,
      toJson(data.toolPolicy), toJson(data.inputValidation), toJson(data.contentFilter),
      data.tokenBudgetPerSession, data.tokenBudgetPerDay,
      data.uiMode, data.uiConfig ? toJson(data.uiConfig) : null,
      toJson(data.middlewares), data.welcomeMessage ?? null, data.inputPlaceholder ?? null,
      ts, ts, data.publishedAt ?? null,
    );
    return this.findById(id)!;
  }

  findById(id: string): ExternalServiceConfig | undefined {
    const row = this.db.prepare('SELECT * FROM external_services WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  findByAgentId(agentId: string): ExternalServiceConfig | undefined {
    const row = this.db.prepare(
      'SELECT * FROM external_services WHERE agent_id = ? AND status != ? ORDER BY version DESC LIMIT 1'
    ).get(agentId, 'archived') as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  findActiveByAgentId(agentId: string): ExternalServiceConfig | undefined {
    const row = this.db.prepare(
      'SELECT * FROM external_services WHERE agent_id = ? AND status = ? ORDER BY version DESC LIMIT 1'
    ).get(agentId, 'active') as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  listByAgentId(agentId: string): ExternalServiceConfig[] {
    const rows = this.db.prepare(
      'SELECT * FROM external_services WHERE agent_id = ? ORDER BY version DESC'
    ).all(agentId) as Record<string, unknown>[];
    return rows.map(r => this._map(r));
  }

  listAll(): ExternalServiceConfig[] {
    const rows = this.db.prepare('SELECT * FROM external_services ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map(r => this._map(r));
  }

  updateStatus(id: string, status: ExternalServiceStatus): void {
    const ts = now();
    const params: SqlParams = [status, ts];
    let extra = '';
    if (status === 'active') {
      extra = ', published_at = ?';
      params.push(ts);
    }
    params.push(id);
    this.db.prepare(`UPDATE external_services SET status = ?, updated_at = ?${extra} WHERE id = ?`).run(...params);
  }

  update(id: string, patch: Partial<ExternalServiceConfig>): void {
    const fields: string[] = [];
    const params: SqlParams = [];

    if (patch.name !== undefined) { fields.push('name = ?'); params.push(patch.name); }
    if (patch.description !== undefined) { fields.push('description = ?'); params.push(patch.description ?? null); }
    if (patch.avatarUrl !== undefined) { fields.push('avatar_url = ?'); params.push(patch.avatarUrl ?? null); }
    if (patch.maxConcurrentSessions !== undefined) { fields.push('max_concurrent_sessions = ?'); params.push(patch.maxConcurrentSessions); }
    if (patch.sessionTimeoutMs !== undefined) { fields.push('session_timeout_ms = ?'); params.push(patch.sessionTimeoutMs); }
    if (patch.maxMessagesPerSession !== undefined) { fields.push('max_messages_per_session = ?'); params.push(patch.maxMessagesPerSession); }
    if (patch.toolPolicy !== undefined) { fields.push('tool_policy = ?'); params.push(toJson(patch.toolPolicy)); }
    if (patch.inputValidation !== undefined) { fields.push('input_validation = ?'); params.push(toJson(patch.inputValidation)); }
    if (patch.contentFilter !== undefined) { fields.push('content_filter = ?'); params.push(toJson(patch.contentFilter)); }
    if (patch.tokenBudgetPerSession !== undefined) { fields.push('token_budget_per_session = ?'); params.push(patch.tokenBudgetPerSession); }
    if (patch.tokenBudgetPerDay !== undefined) { fields.push('token_budget_per_day = ?'); params.push(patch.tokenBudgetPerDay); }
    if (patch.uiMode !== undefined) { fields.push('ui_mode = ?'); params.push(patch.uiMode); }
    if (patch.uiConfig !== undefined) { fields.push('ui_config = ?'); params.push(toJson(patch.uiConfig)); }
    if (patch.middlewares !== undefined) { fields.push('middlewares = ?'); params.push(toJson(patch.middlewares)); }
    if (patch.welcomeMessage !== undefined) { fields.push('welcome_message = ?'); params.push(patch.welcomeMessage ?? null); }
    if (patch.inputPlaceholder !== undefined) { fields.push('input_placeholder = ?'); params.push(patch.inputPlaceholder ?? null); }
    if (patch.snapshotId !== undefined) { fields.push('snapshot_id = ?'); params.push(patch.snapshotId); }
    if (patch.version !== undefined) { fields.push('version = ?'); params.push(patch.version); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(now());
    params.push(id);

    this.db.prepare(`UPDATE external_services SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM external_services WHERE id = ?').run(id);
    return (result as unknown as { changes: number }).changes > 0;
  }

  private _map(row: Record<string, unknown>): ExternalServiceConfig {
    return {
      id: row['id'] as string,
      agentId: row['agent_id'] as string,
      snapshotId: row['snapshot_id'] as string,
      version: row['version'] as number,
      status: row['status'] as ExternalServiceStatus,
      name: row['name'] as string,
      description: (row['description'] as string) || undefined,
      avatarUrl: (row['avatar_url'] as string) || undefined,
      maxConcurrentSessions: row['max_concurrent_sessions'] as number,
      sessionTimeoutMs: row['session_timeout_ms'] as number,
      maxMessagesPerSession: row['max_messages_per_session'] as number,
      toolPolicy: fromJson(row['tool_policy'] as string),
      inputValidation: fromJson(row['input_validation'] as string),
      contentFilter: fromJson(row['content_filter'] as string),
      tokenBudgetPerSession: row['token_budget_per_session'] as number,
      tokenBudgetPerDay: row['token_budget_per_day'] as number,
      uiMode: row['ui_mode'] as 'default' | 'custom',
      uiConfig: row['ui_config'] ? fromJson(row['ui_config'] as string) : undefined,
      middlewares: fromJson(row['middlewares'] as string) ?? [],
      welcomeMessage: (row['welcome_message'] as string) || undefined,
      inputPlaceholder: (row['input_placeholder'] as string) || undefined,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      publishedAt: (row['published_at'] as string) || undefined,
    };
  }
}

// ─── External Session Repo ──────────────────────────────────────────────────

export class SqliteExternalSessionRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    serviceId: string;
    agentId: string;
    participantId: string;
    participantType: 'human' | 'agent';
    participantName?: string;
    participantMetadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): ExternalSession {
    const id = generateId('extsess');
    const ts = now();
    this.db.prepare(`
      INSERT INTO external_sessions (
        id, service_id, agent_id, participant_id, participant_type,
        participant_name, participant_metadata, status, ip_address, user_agent,
        created_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      id, data.serviceId, data.agentId, data.participantId, data.participantType,
      data.participantName ?? null, data.participantMetadata ? toJson(data.participantMetadata) : null,
      data.ipAddress ?? null, data.userAgent ?? null, ts, ts,
    );
    return this.findById(id)!;
  }

  findById(id: string): ExternalSession | undefined {
    const row = this.db.prepare('SELECT * FROM external_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  listByService(serviceId: string, status?: ExternalSessionStatus): ExternalSession[] {
    if (status) {
      const rows = this.db.prepare(
        'SELECT * FROM external_sessions WHERE service_id = ? AND status = ? ORDER BY last_activity_at DESC'
      ).all(serviceId, status) as Record<string, unknown>[];
      return rows.map(r => this._map(r));
    }
    const rows = this.db.prepare(
      'SELECT * FROM external_sessions WHERE service_id = ? ORDER BY last_activity_at DESC'
    ).all(serviceId) as Record<string, unknown>[];
    return rows.map(r => this._map(r));
  }

  countActive(serviceId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM external_sessions WHERE service_id = ? AND status = ?'
    ).get(serviceId, 'active') as { cnt: number };
    return row.cnt;
  }

  updateActivity(id: string, messageCount: number, tokensUsed: number): void {
    this.db.prepare(`
      UPDATE external_sessions SET message_count = ?, tokens_used = ?, last_activity_at = ? WHERE id = ?
    `).run(messageCount, tokensUsed, now(), id);
  }

  close(id: string, reason: ExternalSession['closeReason']): void {
    const ts = now();
    this.db.prepare(`
      UPDATE external_sessions SET status = 'closed', closed_at = ?, close_reason = ?, last_activity_at = ? WHERE id = ?
    `).run(ts, reason ?? null, ts, id);
  }

  expireInactive(serviceId: string, timeoutMs: number): number {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const result = this.db.prepare(`
      UPDATE external_sessions SET status = 'expired', closed_at = ?, close_reason = 'timeout'
      WHERE service_id = ? AND status = 'active' AND last_activity_at < ?
    `).run(now(), serviceId, cutoff);
    return (result as unknown as { changes: number }).changes;
  }

  totalTokensByService(serviceId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(tokens_used), 0) as total FROM external_sessions WHERE service_id = ?'
    ).get(serviceId) as { total: number };
    return row.total;
  }

  private _map(row: Record<string, unknown>): ExternalSession {
    return {
      id: row['id'] as string,
      serviceId: row['service_id'] as string,
      agentId: row['agent_id'] as string,
      participantId: row['participant_id'] as string,
      participantType: row['participant_type'] as 'human' | 'agent',
      participantName: (row['participant_name'] as string) || undefined,
      participantMetadata: row['participant_metadata'] ? fromJson(row['participant_metadata'] as string) : undefined,
      status: row['status'] as ExternalSessionStatus,
      messageCount: row['message_count'] as number,
      tokensUsed: row['tokens_used'] as number,
      ipAddress: (row['ip_address'] as string) || undefined,
      userAgent: (row['user_agent'] as string) || undefined,
      createdAt: row['created_at'] as string,
      lastActivityAt: row['last_activity_at'] as string,
      closedAt: (row['closed_at'] as string) || undefined,
      closeReason: (row['close_reason'] as ExternalSession['closeReason']) || undefined,
    };
  }
}

// ─── External Message Repo ──────────────────────────────────────────────────

export class SqliteExternalMessageRepo {
  constructor(private db: DatabaseSync) {}

  create(data: { sessionId: string; role: string; content: string; tokens?: number; metadata?: Record<string, unknown> }): ExternalMessage {
    const id = generateId('extmsg');
    const ts = now();
    this.db.prepare(`
      INSERT INTO external_messages (id, session_id, role, content, tokens, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.sessionId, data.role, data.content, data.tokens ?? null, data.metadata ? toJson(data.metadata) : null, ts);
    return { id, sessionId: data.sessionId, role: data.role as ExternalMessage['role'], content: data.content, tokens: data.tokens, metadata: data.metadata, createdAt: ts };
  }

  listBySession(sessionId: string, limit?: number): ExternalMessage[] {
    const sql = limit
      ? 'SELECT * FROM external_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM external_messages WHERE session_id = ? ORDER BY created_at ASC';
    const rows = (limit
      ? this.db.prepare(sql).all(sessionId, limit)
      : this.db.prepare(sql).all(sessionId)
    ) as Record<string, unknown>[];
    return rows.map(r => this._map(r));
  }

  countBySession(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM external_messages WHERE session_id = ?').get(sessionId) as { cnt: number };
    return row.cnt;
  }

  tokensBySession(sessionId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(tokens), 0) as total FROM external_messages WHERE session_id = ?').get(sessionId) as { total: number };
    return row.total;
  }

  private _map(row: Record<string, unknown>): ExternalMessage {
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      role: row['role'] as ExternalMessage['role'],
      content: row['content'] as string,
      tokens: (row['tokens'] as number) || undefined,
      metadata: row['metadata'] ? fromJson(row['metadata'] as string) : undefined,
      createdAt: row['created_at'] as string,
    };
  }
}

// ─── Share Token Repo ───────────────────────────────────────────────────────

export class SqliteShareTokenRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    token: string;
    serviceId: string;
    agentId: string;
    createdBy: string;
    permissions: ShareToken['permissions'];
    maxUses?: number;
    expiresAt?: string;
  }): ShareToken {
    const id = generateId('shr');
    const ts = now();
    this.db.prepare(`
      INSERT INTO share_tokens (id, token, service_id, agent_id, created_by, status, permissions, max_uses, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, data.token, data.serviceId, data.agentId, data.createdBy, toJson(data.permissions), data.maxUses ?? null, data.expiresAt ?? null, ts);
    return this.findById(id)!;
  }

  findByToken(token: string): ShareToken | undefined {
    const row = this.db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token) as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  findById(id: string): ShareToken | undefined {
    const row = this.db.prepare('SELECT * FROM share_tokens WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this._map(row) : undefined;
  }

  listByService(serviceId: string): ShareToken[] {
    const rows = this.db.prepare('SELECT * FROM share_tokens WHERE service_id = ? ORDER BY created_at DESC').all(serviceId) as Record<string, unknown>[];
    return rows.map(r => this._map(r));
  }

  incrementUsage(token: string): void {
    this.db.prepare('UPDATE share_tokens SET usage_count = usage_count + 1 WHERE token = ?').run(token);
  }

  revoke(id: string): void {
    this.db.prepare('UPDATE share_tokens SET status = ?, revoked_at = ? WHERE id = ?').run('revoked', now(), id);
  }

  migrateToService(oldServiceId: string, newServiceId: string): number {
    const result = this.db.prepare(
      'UPDATE share_tokens SET service_id = ? WHERE service_id = ? AND status = ?'
    ).run(newServiceId, oldServiceId, 'active');
    return (result as unknown as { changes: number }).changes;
  }

  isValid(token: ShareToken): boolean {
    if (token.status !== 'active') return false;
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) return false;
    if (token.maxUses && token.usageCount >= token.maxUses) return false;
    return true;
  }

  private _map(row: Record<string, unknown>): ShareToken {
    return {
      id: row['id'] as string,
      token: row['token'] as string,
      serviceId: row['service_id'] as string,
      agentId: row['agent_id'] as string,
      createdBy: row['created_by'] as string,
      status: row['status'] as ShareTokenStatus,
      permissions: fromJson(row['permissions'] as string) ?? { canChat: true, canUploadFiles: false },
      maxUses: (row['max_uses'] as number) || undefined,
      usageCount: row['usage_count'] as number,
      expiresAt: (row['expires_at'] as string) || undefined,
      createdAt: row['created_at'] as string,
      revokedAt: (row['revoked_at'] as string) || undefined,
    };
  }
}

// ─── External Service Stats Repo ────────────────────────────────────────────

export class SqliteExternalStatsRepo {
  constructor(private db: DatabaseSync) {}

  upsert(serviceId: string, date: string, stats: Partial<ExternalServiceStats>): void {
    this.db.prepare(`
      INSERT INTO external_service_stats (service_id, date, total_sessions, active_sessions, total_messages, total_tokens_used, average_session_duration, average_messages_per_session, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id, date) DO UPDATE SET
        total_sessions = COALESCE(?, total_sessions),
        active_sessions = COALESCE(?, active_sessions),
        total_messages = COALESCE(?, total_messages),
        total_tokens_used = COALESCE(?, total_tokens_used),
        average_session_duration = COALESCE(?, average_session_duration),
        average_messages_per_session = COALESCE(?, average_messages_per_session),
        error_count = COALESCE(?, error_count)
    `).run(
      serviceId, date,
      stats.totalSessions ?? 0, stats.activeSessions ?? 0,
      stats.totalMessages ?? 0, stats.totalTokensUsed ?? 0,
      stats.averageSessionDuration ?? 0, stats.averageMessagesPerSession ?? 0,
      stats.errorCount ?? 0,
      stats.totalSessions ?? null, stats.activeSessions ?? null,
      stats.totalMessages ?? null, stats.totalTokensUsed ?? null,
      stats.averageSessionDuration ?? null, stats.averageMessagesPerSession ?? null,
      stats.errorCount ?? null,
    );
  }

  getByDateRange(serviceId: string, startDate: string, endDate: string): ExternalServiceStats[] {
    const rows = this.db.prepare(
      'SELECT * FROM external_service_stats WHERE service_id = ? AND date >= ? AND date <= ? ORDER BY date ASC'
    ).all(serviceId, startDate, endDate) as Record<string, unknown>[];
    return rows.map(r => ({
      serviceId: r['service_id'] as string,
      date: r['date'] as string,
      totalSessions: r['total_sessions'] as number,
      activeSessions: r['active_sessions'] as number,
      totalMessages: r['total_messages'] as number,
      totalTokensUsed: r['total_tokens_used'] as number,
      averageSessionDuration: r['average_session_duration'] as number,
      averageMessagesPerSession: r['average_messages_per_session'] as number,
      errorCount: r['error_count'] as number,
    }));
  }
}
