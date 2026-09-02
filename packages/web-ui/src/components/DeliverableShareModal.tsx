import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getHubToken, ensureHubAuth, hubApi, api } from '../api.ts';
import type { DeliverableInfo } from '../api.ts';
import {
  DeliverableShareService,
  createDeliverableShareService,
  DeliverableShareRecord,
  NotLoggedIntoHubError,
  DeliverableShareError,
  DELIVERABLE_SHARE_FORMATS,
  canShareDeliverableFormat,
  type ShareVisibility,
} from '../lib/deliverableShare.ts';
import {
  parseLocalMediaRefs,
  replaceMediaRefs,
  buildReplacementsFromUploads,
  type LocalMediaRef,
} from '../lib/mediaRefs.ts';

export interface DeliverableShareModalProps {
  item: DeliverableInfo;
  onClose: () => void;
  /** 分享结果（publish/poll/revoke 后）回调，供宿主面板回显状态。 */
  onShared?: (record: DeliverableShareRecord) => void;
  /** 注入服务实例（便于单测）；缺省使用真实 Hub token 服务。 */
  service?: DeliverableShareService;
}

/**
 * 抓取本地文件字节（经 Org Manager /api/files/stream）并转为 base64。
 * 供分享管线解析出的本地媒体引用批量上传到 Hub 使用。
 */
async function fetchLocalFileAsBase64(localPath: string): Promise<{ base64: string; filename: string } | null> {
  try {
    const src = api.files.streamUrl(localPath);
    const blob = await fetch(src).then(r => (r.ok ? r.blob() : null));
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    const name = localPath.split('/').pop() || 'media';
    return { base64: btoa(binary), filename: name };
  } catch {
    return null;
  }
}

/**
 * 把一组本地媒体引用上传到 Hub，返回 raw 片段 → 公网 URL 的映射。
 * 走批量接口 /api/hub/deliverables/media（JSON base64，一次请求完成全部上传）。
 * 失败项跳过（保持原路径），避免单个坏图阻塞整个分享。
 * @param refs 解析出的本地媒体引用（raw 片段 + 归一化本地路径）。
 * @param hubUrl Hub 站点来源（把 /uploads/xxx 相对路径补成绝对 URL，保证渲染不破图）。
 */
async function uploadMediaRefsToHub(
  refs: LocalMediaRef[],
  hubUrl: string,
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();
  if (refs.length === 0) return replacements;

  // 1) 读取每个本地媒体文件 → base64（key=localPath 唯一标识，避免同名文件映射错乱）
  const payload: Array<{ key: string; filename: string; base64: string }> = [];
  for (const ref of refs) {
    const file = await fetchLocalFileAsBase64(ref.localPath);
    if (!file) continue;
    payload.push({ key: ref.localPath, filename: file.filename, base64: file.base64 });
  }
  if (payload.length === 0) return replacements;

  // 2) 批量上传到 Hub
  const { files, errors } = await hubApi.uploadMediaBatch(payload);
  if (errors.length > 0) {
    console.warn('[deliverable-share] media upload errors:', errors);
  }

  // 3) 建立 raw 片段 → 绝对 URL 映射（按 key=localPath 匹配）
  return buildReplacementsFromUploads(refs, files, hubUrl);
}

/**
 * 读取产出物文件内容，供分享时传给 Hub（Hub 强制要求 fileBase64 或 content 之一）。
 * 复用现有 /api/files/preview —— 文本类直接返回 content 字符串；图片/音视频/二进制
 * 返回 path/streamUrl，由前端抓取字节转 base64。
 *
 * 对 markdown / html 文本类交付物，额外执行「本地媒体引用 → Hub 上传 → 路径替换」管线：
 *   1. 解析内容中的本地图片/音视频引用（绝对路径、file://、本地 API 形式、相对路径）
 *   2. 逐个上传到 Hub（复用资产上传能力 /api/hub/upload）拿到公网 URL
 *   3. 把原始路径替换为公网 URL，返回替换后的 content
 * 这样分享到 Hub 后，交付物中引用的图片在网站上也能正常显示。
 *
 * @returns 文本产出物返回 {content}；二进制类返回 {fileBase64}；读不到返回 {}。
 */
async function readDeliverableContent(
  reference: string,
  type: string,
  hubUrl: string,
): Promise<{ content?: string; fileBase64?: string; uploadedMedia?: number }> {
  if (!reference || type === 'directory' || reference.startsWith('http://') || reference.startsWith('https://')) {
    return {};
  }
  try {
    const resp = await api.files.preview(reference);
    // 文本类：直接取 content 字符串（利于 Hub 搜索/SEO），并处理本地媒体引用
    if ((resp.type === 'text' || resp.type === 'markdown' || resp.type === 'html' || resp.type === 'json' || resp.type === 'csv')
        && typeof resp.content === 'string') {
      const isTextLike = resp.type === 'markdown' || resp.type === 'html';
      if (!isTextLike) {
        return { content: resp.content };
      }
      // markdown/html：解析本地媒体引用并上传替换。baseDir=交付物所在目录，支持相对路径引用
      const dir = reference.replace(/[/\\]/g, '/').split('/').slice(0, -1).join('/');
      const { refs } = parseLocalMediaRefs(resp.content, dir);
      if (refs.length === 0) {
        return { content: resp.content };
      }
      const replacements = await uploadMediaRefsToHub(refs, hubUrl);
      if (replacements.size === 0) {
        return { content: resp.content };
      }
      const content = replaceMediaRefs(resp.content, replacements);
      return { content, uploadedMedia: replacements.size };
    }
    // 图片/音视频/二进制：抓取原始字节转 base64
    if (resp.type === 'image' || resp.type === 'audio' || resp.type === 'video' || resp.type === 'binary') {
      const src = resp.streamUrl || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(reference));
      const blob = await fetch(src).then(r => r.blob());
      const buf = await blob.arrayBuffer();
      // 构造 base64（分块避免大文件栈溢出）
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
      }
      return { fileBase64: btoa(binary) };
    }
    return {};
  } catch {
    return {};
  }
}

/** 0=初始/未分享 1=填写中 2=提交中 3=审核中 4=已发布 5=已拒绝/需重提 6=已撤销 */
type UiStatus = 'form' | 'busy' | 'pending_review' | 'published' | 'rejected' | 'revoked';

export function DeliverableShareModal({ item, onClose, onShared, service }: DeliverableShareModalProps) {
  const { t } = useTranslation(['deliverables', 'common']);
  const share = useMemo(
    () => service ?? createDeliverableShareService(getHubToken, hubApi.getUrl()),
    [service],
  );

  const [loggedIn, setLoggedIn] = useState<boolean | null>(() => (share ? share.isHubLoggedIn() : null));
  const [loggingIn, setLoggingIn] = useState(false);

  // 初始状态由产出物既有分享字段决定
  const [ui, setUi] = useState<UiStatus>(() => {
    const s = item.shareStatus;
    if (s === 'published') return 'published';
    if (s === 'pending_review') return 'pending_review';
    if (s === 'rejected') return 'rejected';
    if (s === 'revoked') return 'form';
    return 'form';
  });
  const [visibility, setVisibility] = useState<ShareVisibility>('public');
  const [title, setTitle] = useState(item.title || '');
  const [summary, setSummary] = useState(item.summary || '');
  const [tags, setTags] = useState<string[]>(Array.isArray(item.tags) ? [...item.tags] : []);
  const [tagInput, setTagInput] = useState('');

  // 状态回显字段
  const [record, setRecord] = useState<DeliverableShareRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSharedRef = useRef(onShared);
  onSharedRef.current = onShared;

  // 订阅打开的产出物状态（供宿主回显）；内部状态变化后同步宿主
  const sync = useCallback((r: DeliverableShareRecord) => {
    setRecord(r);
    const s = r.status;
    if (s === 'published') setUi('published');
    else if (s === 'rejected') setUi('rejected');
    else if (s === 'revoked') setUi('revoked');
    else if (s === 'pending_review') setUi('pending_review');
    else setUi('form');
    onSharedRef.current?.(r);
  }, []);

  // 登录态检查
  useEffect(() => {
    setLoggedIn(share.isHubLoggedIn());
  }, [share]);

  const doLogin = useCallback(async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await ensureHubAuth({ force: true });
      setLoggedIn(share.isHubLoggedIn());
    } catch {
      setLoggedIn(share.isHubLoggedIn());
    } finally {
      setLoggingIn(false);
    }
  }, [share]);

  const addTag = useCallback(() => {
    const v = tagInput.trim().replace(/^#/, '');
    if (v && !tags.includes(v)) setTags(prev => [...prev, v]);
    setTagInput('');
  }, [tagInput, tags]);

  const removeTag = useCallback((tag: string) => {
    setTags(prev => prev.filter(x => x !== tag));
  }, []);

  const onKeyDownTag = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !tagInput && tags.length) {
      setTags(prev => prev.slice(0, -1));
    }
  }, [addTag, tagInput, tags.length]);

  const copyLink = useCallback(() => {
    const url = record?.url ?? item.shareUrl;
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [record, item.shareUrl]);

  const doPublish = useCallback(async () => {
    // 客户端侧格式门禁：分享格式必须命中白名单（markdown / html），与 Hub 服务端一致。
    // 这是最后一道防线——即使上游入口（RightPanel / Deliverables 分享按钮）漏放行了
    // 非文本格式，这里也会拒绝提交，避免把 text/json/二进制等推给 Hub 得到 400。
    if (!canShareDeliverableFormat(item.format)) {
      setError(`分享仅支持 ${[...DELIVERABLE_SHARE_FORMATS].join(' / ')} 格式`);
      return;
    }
    setError(null);
    setUi('busy');
    try {
      const filename = item.reference.replace(/[/\\]/g, '/').split('/').pop() || 'deliverable';
      // 读取产出物实际文件内容（Hub 强制要求 fileBase64 或 content 之一）；
      // markdown/html 时会自动把引用的本地图片上传到 Hub 并替换为公网 URL。
      const hubOrigin = hubApi.getUrl();
      const { content, fileBase64, uploadedMedia } = await readDeliverableContent(item.reference, item.type, hubOrigin);
      if (uploadedMedia) {
        // 提示用户：分享内容中的本地媒体已自动上传（非阻塞，仅日志记录）
        console.info(`[deliverable-share] uploaded ${uploadedMedia} local media reference(s) to Hub`);
      }
      // 溯源：用 agent 的可读名（displayName/name）而非 agent ID，作为 producerAgent.name
      const agentId = item.agentId ?? '';
      let producerName = agentId;
      if (agentId) {
        try {
          const { agents } = await api.agents.list();
          const ag = agents.find((a: { id: string }) => a.id === agentId);
          if (ag) producerName = ag.name || agentId;
        } catch {
          /* 取不到名字则回退 agentId */
        }
      }
      const r = await share.publish({
        localId: item.id,
        title: title.trim() || item.title,
        summary: summary.trim(),
        tags,
        visibility,
        filename,
        format: item.format || 'markdown',
        content,
        fileBase64,
        producerAgent: { id: agentId, name: producerName, source: 'local' },
      });
      sync(r);
      if (r.status === 'rejected') {
        setError(typeof r.reason === 'string' && r.reason ? r.reason : '分享被拒绝');
      } else {
        // 发布成功：关闭弹窗，宿主侧通过 onShared 回显状态徽标（审核中/已发布）
        onClose();
      }
    } catch (err) {
      setUi('form');
      if (err instanceof NotLoggedIntoHubError) {
        setLoggedIn(false);
        return;
      }
      setError(err instanceof DeliverableShareError
        ? err.message
        : (err instanceof Error ? err.message : String(err)));
    }
  }, [share, item, title, summary, tags, visibility, sync]);

  const doRevoke = useCallback(async () => {
    setError(null);
    try {
      const r = await share.revoke(item.id);
      sync({ ...r, status: 'revoked', url: null });
    } catch (err) {
      setError(err instanceof DeliverableShareError ? err.message : String(err));
    }
  }, [share, item.id, sync]);

  const resubmit = useCallback(() => {
    setUi('form');
    setError(null);
  }, []);

  // 审核中 → 轮询状态
  useEffect(() => {
    if (ui !== 'pending_review') return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const r = await share.pollStatus(item.id);
        if (cancelled) return;
        if (r.status !== 'pending_review') sync(r);
      } catch {
        /* 轮询失败静默重试 */
      }
    }, 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [ui, share, item.id, sync]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isLinkVisible = visibility === 'link';
  const publishedUrl = record?.url ?? item.shareUrl;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-surface-primary rounded-2xl shadow-2xl border border-border-default w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary/95 backdrop-blur-sm border-b border-border-default px-5 py-4 flex items-center justify-between rounded-t-2xl z-10">
          <h3 className="text-base font-semibold text-fg-primary">
            {t('deliverables:share.title', { defaultValue: '分享到 Markus Hub' })}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary hover:text-fg-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 登录门禁 */}
          {loggedIn === false ? (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 rounded-xl bg-amber-500/10 border border-amber-500/25 p-3">
                <span className="text-lg">🔑</span>
                <p className="text-sm text-fg-secondary">
                  {t('deliverables:share.needHubLogin', { defaultValue: '需登录 Markus Hub 账号后才能分享产出物。' })}
                </p>
              </div>
              <button
                onClick={() => void doLogin()}
                disabled={loggingIn}
                className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 transition-colors disabled:opacity-60"
              >
                {loggingIn
                  ? t('deliverables:share.loggingIn', { defaultValue: '正在打开登录…' })
                  : t('deliverables:share.loginHub', { defaultValue: '登录 Markus Hub 账号' })}
              </button>
              <p className="text-[11px] text-fg-tertiary">
                {t('deliverables:share.loginHint', { defaultValue: '解锁后将支持一键公开/链接分享产出物。' })}
              </p>
            </div>
          ) : (
            <>
              {/* 已发布 → 状态回显 */}
              {ui === 'published' ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[11px] rounded-full bg-green-500/15 text-green-500 font-medium">
                      {t('deliverables:share.published', { defaultValue: '已发布' })}
                    </span>
                    <span className="text-[11px] text-fg-tertiary">
                      {visibility === 'link'
                        ? t('deliverables:share.linkVisibility', { defaultValue: '有链接可见' })
                        : t('deliverables:share.publicVisibility', { defaultValue: '公开' })}
                    </span>
                  </div>
                  {publishedUrl ? (
                    <div className="flex items-center gap-2 bg-surface-elevated rounded-lg px-3 py-2">
                      <span className="text-xs text-fg-secondary font-mono break-all flex-1 select-all">{publishedUrl}</span>
                      <button
                        onClick={copyLink}
                        className={`px-2 py-1 text-[10px] rounded transition-colors shrink-0 ${copied ? 'bg-green-500/20 text-green-500' : 'bg-brand-600/20 text-brand-500 hover:bg-brand-600/30'}`}
                      >
                        {copied
                          ? t('common:copied', { defaultValue: '已复制' })
                          : t('common:copy', { defaultValue: '复制链接' })}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-fg-tertiary">
                      {t('deliverables:share.urlPending', { defaultValue: '链接生成中，稍后刷新查看…' })}
                    </p>
                  )}
                  <button
                    onClick={() => void doRevoke()}
                    className="w-full px-3 py-2 text-xs font-medium rounded-lg text-red-500 border border-red-500/30 hover:bg-red-500/10 transition-colors"
                  >
                    {t('deliverables:share.revoke', { defaultValue: '取消分享' })}
                  </button>
                </div>
              ) : ui === 'pending_review' ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
                    <span className="px-2 py-0.5 text-[11px] rounded-full bg-amber-500/15 text-amber-500 font-medium">
                      {t('deliverables:share.pendingReview', { defaultValue: '审核中' })}
                    </span>
                    <span className="text-[11px] text-fg-tertiary">
                      {visibility === 'link'
                        ? t('deliverables:share.linkVisibility', { defaultValue: '有链接可见' })
                        : t('deliverables:share.publicVisibility', { defaultValue: '公开' })}
                    </span>
                  </div>
                  <p className="text-sm text-fg-secondary">
                    {t('deliverables:share.pendingHint', { defaultValue: '你的产出物已公开，其他人现在就能通过链接访问。管理员审核通过后，内容将进入搜索引擎收录。' })}
                  </p>
                  {publishedUrl ? (
                    <div className="flex items-center gap-2 bg-surface-elevated rounded-lg px-3 py-2">
                      <span className="text-xs text-fg-secondary font-mono break-all flex-1 select-all">{publishedUrl}</span>
                      <button
                        onClick={copyLink}
                        className={`px-2 py-1 text-[10px] rounded transition-colors shrink-0 ${copied ? 'bg-green-500/20 text-green-500' : 'bg-brand-600/20 text-brand-500 hover:bg-brand-600/30'}`}
                      >
                        {copied
                          ? t('common:copied', { defaultValue: '已复制' })
                          : t('common:copy', { defaultValue: '复制链接' })}
                      </button>
                    </div>
                  ) : null}
                  <button
                    onClick={() => void doRevoke()}
                    className="w-full px-3 py-2 text-xs font-medium rounded-lg text-red-500 border border-red-500/30 hover:bg-red-500/10 transition-colors"
                  >
                    {t('deliverables:share.revoke', { defaultValue: '取消分享' })}
                  </button>
                </div>
              ) : ui === 'rejected' ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[11px] rounded-full bg-red-500/15 text-red-500 font-medium">
                      {t('deliverables:share.rejected', { defaultValue: '已拒绝' })}
                    </span>
                  </div>
                  {error && (
                    <div className="rounded-lg bg-red-500/10 border border-red-500/25 px-3 py-2 text-xs text-red-500">
                      {error}
                    </div>
                  )}
                  <button
                    onClick={resubmit}
                    className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 transition-colors"
                  >
                    {t('deliverables:share.resubmit', { defaultValue: '重新提交' })}
                  </button>
                </div>
              ) : ui === 'revoked' ? (
                <div className="space-y-3">
                  <p className="text-sm text-fg-secondary">
                    {t('deliverables:share.revoked', { defaultValue: '已取消分享，该产出物不再公开可访问。' })}
                  </p>
                  <button
                    onClick={resubmit}
                    className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 transition-colors"
                  >
                    {t('deliverables:share.shareAgain', { defaultValue: '重新分享' })}
                  </button>
                </div>
              ) : (
                /* 填写表单 */
                <>
                  {/* 可见性 */}
                  <div className="space-y-2">
                    <div className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">
                      {t('deliverables:share.visibility', { defaultValue: '可见性' })}
                    </div>
                    <label className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${!isLinkVisible ? 'border-brand-500/50 bg-brand-500/5' : 'border-border-default hover:bg-surface-elevated'}`}>
                      <input
                        type="radio"
                        name="visibility"
                        checked={!isLinkVisible}
                        onChange={() => setVisibility('public')}
                        className="mt-0.5 accent-brand-500"
                      />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium text-fg-primary">
                          {t('deliverables:share.public', { defaultValue: '公开（所有人可见 + 搜索引擎）' })}
                        </span>
                        <span className="block text-[11px] text-fg-tertiary">
                          {t('deliverables:share.publicHint', { defaultValue: '公开产出物需经 Hub 审核后发布，发布后所有人可见并参与搜索' })}
                        </span>
                      </span>
                    </label>
                    <label className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${isLinkVisible ? 'border-brand-500/50 bg-brand-500/5' : 'border-border-default hover:bg-surface-elevated'}`}>
                      <input
                        type="radio"
                        name="visibility"
                        checked={isLinkVisible}
                        onChange={() => setVisibility('link')}
                        className="mt-0.5 accent-brand-500"
                      />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium text-fg-primary">
                          {t('deliverables:share.link', { defaultValue: '有链接可见' })}
                        </span>
                        <span className="block text-[11px] text-fg-tertiary">
                          {t('deliverables:share.linkHint', { defaultValue: '仅获得链接的人可查看，不参与搜索引擎；同样需经 Hub 审核' })}
                        </span>
                      </span>
                    </label>
                  </div>

                  {/* 标题 / 摘要 */}
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">
                      {t('deliverables:share.titleField', { defaultValue: '标题' })}
                    </div>
                    <input
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder={t('deliverables:share.titlePlaceholder', { defaultValue: '清晰、可检索的标题' })}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-surface-elevated border border-border-default focus:border-brand-500/60 outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">
                      {t('deliverables:share.summary', { defaultValue: '摘要' })}
                    </div>
                    <textarea
                      value={summary}
                      onChange={e => setSummary(e.target.value)}
                      rows={3}
                      placeholder={t('deliverables:share.summaryPlaceholder', { defaultValue: '简要描述该产出物…' })}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-surface-elevated border border-border-default focus:border-brand-500/60 outline-none resize-y"
                    />
                  </div>

                  {/* Tags */}
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">
                      {t('deliverables:share.tags', { defaultValue: '标签' })}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {tags.map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-surface-elevated rounded-md text-fg-secondary">
                          {tag}
                          <button onClick={() => removeTag(tag)} className="text-fg-tertiary hover:text-red-500" aria-label="remove">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                          </button>
                        </span>
                      ))}
                    </div>
                    <input
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={onKeyDownTag}
                      onBlur={addTag}
                      placeholder={t('deliverables:share.tagsPlaceholder', { defaultValue: '输入标签后回车添加' })}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-surface-elevated border border-border-default focus:border-brand-500/60 outline-none"
                    />
                  </div>

                  {/* 错误 */}
                  {error && (
                    <div className="rounded-lg bg-red-500/10 border border-red-500/25 px-3 py-2 text-xs text-red-500">
                      {error}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void doPublish()}
                    disabled={ui === 'busy' || !title.trim()}
                    className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {ui === 'busy' && (
                      <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    )}
                    {ui === 'busy'
                      ? t('deliverables:share.sharing', { defaultValue: '分享中…' })
                      : t('deliverables:share.shareToHub', { defaultValue: '分享到 Hub' })}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default DeliverableShareModal;
