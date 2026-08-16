/**
 * Deliverable Sharing — 产出物分享到 Hub 的客户端封装（web-ui）。
 *
 * 本模块与 @markus/core 的 DeliverableShareService（客户端分享服务模块）保持同一
 * API 契约（见 docs/DELIVERABLE-SHARING-DESIGN.md 第 7.1 节）：
 *  - POST   /api/hub/deliverables/publish   上传并发布（JSON+base64）
 *  - GET    /api/hub/deliverables/status    查询分享状态
 *  - POST   /api/hub/deliverables/revoke    取消分享
 *
 * web-ui 为自包含的浏览器 SPA（不依赖 @markus/core 包，沿用 Work.tsx 镜像共享契约的
 * 既有做法），因此这里按 core 模块同一契约实现轻量客户端。所有请求经本地 org-manager
 * 的通用 Hub 代理透传（/api/hub/*，避免 CORS），并附 Hub Bearer token（强制 Hub 账号）。
 *
 * 纯逻辑层，不含 UI，外部依赖（getHubToken / fetch）可注入以便单测。
 */

export type ShareVisibility = 'public' | 'link';
export type ShareStatus = 'none' | 'pending_review' | 'published' | 'rejected' | 'revoked';

/** 产生该产出物的 Agent 溯源信息。source=hub_asset 时可跳转 Hub Agent/Team 页；local 仅显示名字。 */
export interface ProducerAgentInfo {
  id: string;
  name: string;
  source: 'hub_asset' | 'local';
}

/** 分享请求入参（UI 层补齐 title/summary/tags/visibility，服务层补全 producerAgent 契约）。 */
export interface ShareDeliverableInput {
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

/** Hub 返回的分享记录（字段防御性解析，兼容嵌套 share/deliverable 结构）。 */
export interface DeliverableShareRecord {
  id: string;
  slug?: string;
  visibility: ShareVisibility | string;
  status: ShareStatus | string;
  url?: string | null;
  reason?: string | null;
  /** 来源本地产出物 id（Hub mine/status 返回 localDeliverableId 时回填；用于把 Hub 记录映射回本地交付物） */
  localId?: string | null;
}

/** 单产出物文件大小上限（与 core 一致，50MB）。 */
export const HUB_DELIVERABLE_MAX_BYTES = 50 * 1024 * 1024;

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

/** Hub 代理 / Hub 端返回错误。 */
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

/** 依赖注入契约。 */
export interface DeliverableShareDeps {
  /** 返回当前 Hub token；未登录返回 null（强制 Hub 账号，未登录禁止分享）。 */
  getHubToken: () => string | null;
  /** Hub 站点来源（用于由 slug 构造公开分享链接 {hubUrl}/deliverable/{slug}）。 */
  hubUrl?: string;
  /** HTTP 传输（默认 globalThis.fetch；测试注入 mock）。 */
  fetch?: typeof fetch;
  /** Hub 代理基础路径（默认相对 /api/hub/...，浏览器可用）。 */
  proxyBasePath?: string;
}

/**
 * 从 Hub 响应体防御性提取分享记录。
 * 对齐 Hub 真实契约（见 QA 联调 tsk_84bc6db0ebf59752061dc3e5）：
 *  - publish 平铺返回 `{ shareId, shareUrl, slug, status }`
 *  - status 返回 `{ share: publicDto }`，publicDto 含 `id`/`slug` 但无 `url`
 * 兼容读 id/url（flat 或嵌套 share/deliverable）作为兜底。
 * @param hubOrigin Hub 站点来源，用于 status 场景由 slug 兜底构造公开链接。
 */
export function normalizeShareRecord(data: unknown, hubOrigin?: string): DeliverableShareRecord {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const nested = (raw['share'] ?? raw['deliverable'] ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => raw[k] ?? nested[k];
  const id = pick('id') ?? pick('shareId') ?? '';
  const slugRaw = pick('slug');
  const slug = slugRaw !== undefined && slugRaw !== null ? String(slugRaw) : undefined;
  const urlRaw = pick('url') ?? pick('shareUrl');
  let url: string | null = null;
  if (urlRaw !== undefined && urlRaw !== null) {
    url = String(urlRaw);
  } else if (slug && hubOrigin) {
    // status 场景：Hub 不返回 url，由 slug + 站点来源兜底构造
    url = `${hubOrigin.replace(/\/+$/, '')}/deliverable/${encodeURIComponent(slug)}`;
  }
  const reasonRaw = pick('reason') ?? pick('rejectNote');
  const localIdRaw = pick('localDeliverableId') ?? pick('localId');
  return {
    id: String(id),
    slug,
    visibility: (pick('visibility') as ShareVisibility) ?? 'public',
    status: (pick('status') as ShareStatus) ?? 'pending_review',
    url,
    reason: reasonRaw !== undefined && reasonRaw !== null ? String(reasonRaw) : null,
    localId: localIdRaw !== undefined && localIdRaw !== null ? String(localIdRaw) : null,
  };
}

/** 本地回写字段（与 DeliverableInfo 分享字段一致）。 */
export interface DeliverableShareWriteBack {
  id: string;
  hubShareId: string | null;
  shareStatus: string | null;
  shareUrl: string | null;
  shareVisibility: string | null;
}

/**
 * 产出物分享服务（web-ui）。经本地 org-manager 的 Hub 代理透传所有请求。
 */
export class DeliverableShareService {
  private basePath: string;
  private fetchImpl: typeof fetch;
  private hubOrigin: string | undefined;
  constructor(deps: DeliverableShareDeps) {
    this.getHubToken = deps.getHubToken;
    this.hubOrigin = deps.hubUrl;
    this.basePath = (deps.proxyBasePath ?? '/api/hub').replace(/\/+$/, '');
    this.fetchImpl = deps.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : (() => { throw new Error('fetch unavailable'); }) as unknown as typeof fetch);
  }
  private getHubToken: () => string | null;

  /** 是否已登录 Hub 账号。 */
  isHubLoggedIn(): boolean {
    return !!this.getHubToken();
  }

  /** 未登录抛 NotLoggedIntoHubError。 */
  assertHubLoggedIn(): void {
    if (!this.getHubToken()) throw new NotLoggedIntoHubError();
  }

  private async doFetch(path: string, init: RequestInit): Promise<{ status: number; data: unknown }> {
    const token = this.getHubToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await this.fetchImpl(`${this.basePath}${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });
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
  async publish(input: ShareDeliverableInput): Promise<DeliverableShareRecord> {
    this.assertHubLoggedIn();

    const bytes = input.fileSizeBytes ?? (input.fileBase64 ? base64ByteLength(input.fileBase64) : 0);
    if (bytes > HUB_DELIVERABLE_MAX_BYTES) {
      throw new DeliverableTooLargeError(bytes, HUB_DELIVERABLE_MAX_BYTES);
    }

    const payload: Record<string, unknown> = {
      localDeliverableId: input.localId,
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

    const { data } = await this.doFetch('/deliverables/publish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return normalizeShareRecord(data, this.hubOrigin);
  }

  /** 轮询审核状态。@throws NotLoggedIntoHubError / HubApiError */
  async pollStatus(localId: string): Promise<DeliverableShareRecord> {
    this.assertHubLoggedIn();
    const { data } = await this.doFetch(
      `/deliverables/status?localId=${encodeURIComponent(localId)}`,
      { method: 'GET' },
    );
    return normalizeShareRecord(data, this.hubOrigin);
  }

  /** 拉取当前用户（owner）的全部产出物分享及审核状态。对应 Hub GET /api/deliverables/mine。 */
  async listMine(): Promise<DeliverableShareRecord[]> {
    this.assertHubLoggedIn();
    const { data } = await this.doFetch('/deliverables/mine', { method: 'GET' });
    const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const shares = Array.isArray(raw['shares']) ? (raw['shares'] as unknown[]) : [];
    return shares.map(s => normalizeShareRecord(s, this.hubOrigin));
  }

  /** 取消分享（public/link → revoked）。@throws NotLoggedIntoHubError / HubApiError */
  async revoke(localId: string): Promise<DeliverableShareRecord> {
    this.assertHubLoggedIn();
    const { data } = await this.doFetch('/deliverables/revoke', {
      method: 'POST',
      body: JSON.stringify({ localId }),
    });
    const record = normalizeShareRecord(data, this.hubOrigin);
    // revoke 语义：本地回填为 revoked。
    return { ...record, status: 'revoked', url: null };
  }
}

/** 便捷工厂：传入 web-ui 的 Hub token 访问器创建服务实例。 */
export function createDeliverableShareService(getHubToken: () => string | null, hubUrl?: string): DeliverableShareService {
  return new DeliverableShareService({
    getHubToken,
    hubUrl,
    proxyBasePath: '/api/hub',
  });
}
