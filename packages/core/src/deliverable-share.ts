/**
 * Deliverable Sharing Service — 产出物分享到 Hub 的客户端封装。
 *
 * 职责（对应设计文档 docs/DELIVERABLE-SHARING-DESIGN.md 第 7.1 节 API 契约）：
 *  - 构造分享请求并校验 Hub 登录态（强制 Hub 账号，未登录禁用分享）
 *  - 字段补全：visibility / producerAgent 等
 *  - 经本地 org-manager 的 Hub 代理透传（/api/hub/deliverables/*，避免 CORS）
 *  - 轮询审核状态 / revoke
 *  - 将分享结果回写本地 DeliverableRow（hubShareId/shareStatus/shareUrl/shareVisibility）
 *
 * 本模块为纯逻辑层，不含 UI。所有外部依赖（Hub 鉴权、HTTP 传输、本地回写）
 * 通过依赖注入传入，便于单元测试。
 */

import { createLogger } from '@markus/shared';

const log = createLogger('deliverable-share');

/** 单产出物文件大小上限（设计文档建议 50MB）。 */
export const HUB_DELIVERABLE_MAX_BYTES = 50 * 1024 * 1024;

export type ShareVisibility = 'public' | 'link';
export type ShareStatus = 'none' | 'pending_review' | 'published' | 'rejected' | 'revoked';

/** 产生该产出物的 Agent 溯源信息。source=hub_asset 时可跳转 Hub Agent/Team 页；local 仅显示名字。 */
export interface ProducerAgentInfo {
  id: string;
  name: string;
  source: 'hub_asset' | 'local';
}

/** 分享请求入参（客户端渲染层补齐 title/summary/tags，本模块补齐 visibility/producerAgent 契约）。 */
export interface ShareDeliverableInput {
  /** 本地 DeliverableRow.id，用于回写与去重。 */
  localId: string;
  title: string;
  summary: string;
  tags: string[];
  visibility: ShareVisibility;
  filename: string;
  format: string;
  /** 抽取的纯净内容（文本类产出物，供 Hub 搜索/SEO 使用），可选。 */
  content?: string;
  /** 文件内容（base64 编码），与 content 二选一。 */
  fileBase64?: string;
  /** 文件字节数（可选；缺省时由 base64 推算）。 */
  fileSizeBytes?: number;
  producerAgent: ProducerAgentInfo;
}

/** 回写本地 DeliverableRow 的分享字段。 */
export interface DeliverableShareWriteBack {
  id: string;
  hubShareId: string | null;
  shareStatus: string | null;
  shareUrl: string | null;
  shareVisibility: string | null;
}

/** 分享记录（Hub 返回契约），字段做防御性解析。 */
export interface DeliverableShareRecord {
  id: string;
  slug?: string;
  visibility: ShareVisibility | string;
  status: ShareStatus | string;
  url?: string | null;
  reason?: string | null;
}

/** 依赖注入契约。 */
export interface DeliverableShareDeps {
  /**
   * 返回 Hub 登录态；返回 null 表示未登录 Hub 账号（强制 Hub 账号，未登录禁止分享）。
   * hubUrl 与 token 由上层（渲染层/服务层）注入。
   */
  getHubAuth(): { hubUrl: string; token: string } | null;
  /**
   * 本地 org-manager 服务源（Hub 代理所在）。浏览器同源可传 location.origin 或留空。
   * 留空时使用相对路径 /api/hub/...（浏览器可用）；Node 环境请显式传入绝对源。
   */
  proxyBaseUrl?: string;
  /** HTTP 传输（默认 globalThis.fetch；测试注入 mock）。 */
  fetch?: typeof fetch;
  /** 分享结果回写本地 DeliverableRow（依赖客户端存储任务，可空注入）。 */
  writeBack?: (fields: DeliverableShareWriteBack) => Promise<void>;
}

/** 分享服务错误基类。 */
export class DeliverableShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliverableShareError';
  }
}

/** 未登录 Hub 账号（强制 Hub 账号约束）。 */
export class NotLoggedIntoHubError extends DeliverableShareError {
  constructor() {
    super('需要登录 Markus Hub 账号后才能分享产出物。');
    this.name = 'NotLoggedIntoHubError';
  }
}

/** 产出物文件超过大小上限。 */
export class DeliverableTooLargeError extends DeliverableShareError {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`产出物文件大小 ${bytes} 字节超过上限 ${limit} 字节（50MB），请压缩或拒绝分享。`);
    this.name = 'DeliverableTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Hub 代理 / Hub 端返回错误（含 HTTP 状态与错误信息）。 */
export class HubApiError extends DeliverableShareError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Hub 请求失败 (HTTP ${status}): ${message}`);
    this.name = 'HubApiError';
    this.status = status;
  }
}

/** 由 base64 字符串推算解码后字节数。 */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  if (!clean) return 0;
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** 从 Hub 响应体防御性提取分享记录（兼容嵌套 share/deliverable 结构）。 */
function normalizeShareRecord(data: unknown): DeliverableShareRecord {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const nested = (raw['share'] ?? raw['deliverable'] ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => raw[k] ?? nested[k];
  return {
    id: String(pick('id') ?? ''),
    slug: pick('slug') !== undefined ? String(pick('slug')) : undefined,
    visibility: (pick('visibility') as ShareVisibility) ?? 'public',
    status: (pick('status') as ShareStatus) ?? 'pending_review',
    url: pick('url') !== undefined && pick('url') !== null ? String(pick('url')) : null,
    reason: pick('reason') !== undefined && pick('reason') !== null ? String(pick('reason')) : null,
  };
}

/**
 * 产出物分享服务。
 * 通过本地 org-manager 的 Hub 代理透传所有请求，避免跨域（CORS）。
 */
export class DeliverableShareService {
  private readonly deps: Required<Pick<DeliverableShareDeps, 'fetch'>> & DeliverableShareDeps;

  constructor(deps: DeliverableShareDeps) {
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      ...deps,
    };
  }

  /** 是否已登录 Hub 账号。 */
  isHubLoggedIn(): boolean {
    return !!this.deps.getHubAuth();
  }

  /** 未登录时抛出 NotLoggedIntoHubError（用于 UI 层禁用分享/gate 入口）。 */
  assertHubLoggedIn(): void {
    if (!this.deps.getHubAuth()) throw new NotLoggedIntoHubError();
  }

  /** 构造本地 Hub 代理可用的绝对/相对 URL。 */
  private proxyUrl(path: string, params?: Record<string, string>): string {
    let url = path;
    if (this.deps.proxyBaseUrl) {
      const base = this.deps.proxyBaseUrl.replace(/\/+$/, '');
      url = `${base}${path}`;
    }
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  private async doFetch(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; data: unknown }> {
    const res = await this.deps.fetch(url, init);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
          ? String((data as Record<string, unknown>)['error'])
          : res.statusText || `HTTP ${res.status}`;
      throw new HubApiError(res.status, message);
    }
    return { status: res.status, data };
  }

  /**
   * 上传并分享产出物。
   * @throws NotLoggedIntoHubError / DeliverableTooLargeError / HubApiError
   */
  async share(input: ShareDeliverableInput): Promise<DeliverableShareRecord> {
    const auth = this.deps.getHubAuth();
    if (!auth) throw new NotLoggedIntoHubError();

    const bytes = input.fileSizeBytes ?? (input.fileBase64 ? base64ByteLength(input.fileBase64) : 0);
    if (bytes > HUB_DELIVERABLE_MAX_BYTES) {
      throw new DeliverableTooLargeError(bytes, HUB_DELIVERABLE_MAX_BYTES);
    }

    const payload: Record<string, unknown> = {
      localId: input.localId,
      visibility: input.visibility,
      title: input.title,
      summary: input.summary,
      tags: input.tags,
      filename: input.filename,
      format: input.format,
      producerAgent: {
        id: input.producerAgent.id,
        name: input.producerAgent.name,
        source: input.producerAgent.source,
      },
    };
    if (input.content) payload['content'] = input.content;
    if (input.fileBase64) payload['fileBase64'] = input.fileBase64;

    log.info('Sharing deliverable to Hub', {
      localId: input.localId,
      visibility: input.visibility,
      hubUrl: auth.hubUrl,
    });

    const { data } = await this.doFetch(this.proxyUrl('/api/hub/deliverables/publish'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(payload),
    });

    const record = normalizeShareRecord(data);
    await this.writeBackFromRecord(record, input.localId);
    return record;
  }

  /**
   * 轮询审核状态。
   * @throws NotLoggedIntoHubError / HubApiError
   */
  async pollStatus(localId: string): Promise<DeliverableShareRecord> {
    const auth = this.deps.getHubAuth();
    if (!auth) throw new NotLoggedIntoHubError();

    const { data } = await this.doFetch(
      this.proxyUrl('/api/hub/deliverables/status', { localId }),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${auth.token}` },
      },
    );

    const record = normalizeShareRecord(data);
    await this.writeBackFromRecord(record, localId);
    return record;
  }

  /**
   * 取消分享（public/link → revoked，仅 owner 可）。
   * @throws NotLoggedIntoHubError / HubApiError
   */
  async revoke(localId: string): Promise<DeliverableShareRecord> {
    const auth = this.deps.getHubAuth();
    if (!auth) throw new NotLoggedIntoHubError();

    const { data } = await this.doFetch(this.proxyUrl('/api/hub/deliverables/revoke'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ localId }),
    });

    const record = normalizeShareRecord(data);
    // revoke 语义：无论 Hub 返回什么，本地回填为 revoked（若已有 hubShareId）。
    await this.writeBack({
      id: localId,
      hubShareId: record.id || null,
      shareStatus: 'revoked',
      shareUrl: null,
      shareVisibility: record.visibility ?? null,
    });
    return record;
  }

  private async writeBackFromRecord(record: DeliverableShareRecord, localId: string): Promise<void> {
    await this.writeBack({
      id: localId,
      hubShareId: record.id || null,
      shareStatus: record.status,
      shareUrl: record.url ?? null,
      shareVisibility: record.visibility,
    });
  }

  private async writeBack(fields: DeliverableShareWriteBack): Promise<void> {
    if (this.deps.writeBack) {
      try {
        await this.deps.writeBack(fields);
      } catch (err) {
        // 回写失败不阻塞主流程，记录日志。
        log.warn('Failed to write back deliverable share fields', { id: fields.id, err });
      }
    }
  }
}
