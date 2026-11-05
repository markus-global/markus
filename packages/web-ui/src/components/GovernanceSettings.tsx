/**
 * GovernanceSettings — Settings 里的「主动模式」页：来源 / 主动模式 / 责任域 三组。
 *
 * 设计依据（实现文档 §5.5「Settings：新增来源 / 主动模式 / 责任域三组」，按概念分不按页面分）：
 * 这三件事回答的是同一个问题 —— **这套系统自己会动哪些东西，谁允许的**。
 * 拆成三页会让人来回跳；放一页才能形成判断。
 *
 * 数据源（全部只读，零新增写入）：
 *   GET /api/events/sources        外部来源：谁在往平台送信号
 *   GET /api/resources/bindings    责任域：谁管哪个资源、到哪一档、放开到什么程度
 *
 * 为什么「主动模式」不是一个可编辑开关：升档必须走审批（`autonomyNeedsApproval`）。
 * 这里只呈现**现状与规矩**，把「改」留给有权限的流程 —— 在设置页给个下拉框等于
 * 绕过审批，那是把安全机制做成了一个装饰品。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchEventSources, fetchResourceBindings, type EventSourceAPI, type ResourceBindingAPI } from '../api.ts';

/** 主动模式的四档 —— 与 @markus/shared 的 Autonomy 同名同义，不另起说法。 */
const AUTONOMY_LEVELS: Array<{ key: string; label: string; detail: string; tone: string }> = [
  { key: 'off', label: '关闭', detail: '永不自主行动，每次都问人', tone: 'bg-surface-overlay text-fg-tertiary' },
  { key: 'observe', label: '观察', detail: '记录判断，但不执行（默认档）', tone: 'bg-sky-500/15 text-sky-600' },
  { key: 'auto', label: '自动', detail: '先执行，再向人汇报', tone: 'bg-amber-500/15 text-amber-600' },
  { key: 'trusted', label: '托管', detail: '静默执行，不逐次汇报', tone: 'bg-rose-500/15 text-rose-600' },
];

const AUTONOMY_LABEL: Record<string, string> = Object.fromEntries(
  AUTONOMY_LEVELS.map(l => [l.key, l.label]),
);
const AUTONOMY_TONE: Record<string, string> = Object.fromEntries(
  AUTONOMY_LEVELS.map(l => [l.key, l.tone]),
);

function fmtDate(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一组的小标题 —— 三组共用，避免三处各写一套间距。 */
function GroupHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-2">
      <h4 className="text-[13px] font-semibold text-fg-primary">{title}</h4>
      <p className="mt-0.5 text-[11px] text-fg-tertiary leading-relaxed">{hint}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2.5 text-[11px] text-fg-tertiary">
      {children}
    </div>
  );
}

export function GovernanceSettings() {
  const [sources, setSources] = useState<EventSourceAPI[]>([]);
  const [bindings, setBindings] = useState<ResourceBindingAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // 两个接口互不依赖：一个挂了不该把另一个也变成空白（那会让人以为「什么都没配」）。
    Promise.allSettled([fetchEventSources(), fetchResourceBindings()])
      .then(([s, b]) => {
        if (!alive) return;
        const errs: string[] = [];
        if (s.status === 'fulfilled') setSources(s.value.sources ?? []);
        else errs.push(`来源读取失败：${String(s.reason).slice(0, 80)}`);
        if (b.status === 'fulfilled') setBindings(b.value.bindings ?? []);
        else errs.push(`责任域读取失败：${String(b.reason).slice(0, 80)}`);
        setError(errs.length ? errs.join('；') : null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  /** 各档位分别有多少条绑定 —— 「放开到什么程度」一眼可见，不用逐条数。 */
  const autonomyCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of bindings) m[b.autonomy] = (m[b.autonomy] ?? 0) + 1;
    return m;
  }, [bindings]);

  return (
    <div className="space-y-7">
      <section>
        <h3 className="text-sm font-semibold text-fg-secondary uppercase tracking-wider mb-3">主动模式</h3>
        <p className="mb-4 text-xs text-fg-tertiary leading-relaxed">
          这三组回答同一个问题：<strong className="text-fg-secondary">系统自己会动哪些东西，谁允许的</strong>。
          默认观察档；升到自动 / 托管需要人批准；红线动作不可自主（见各组说明）。
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
            {error} —— 下方为该接口可读到的部分，缺的部分不等于「没有」。
          </div>
        )}
        {loading && <div className="text-xs text-fg-tertiary">读取中…</div>}
      </section>

      {/* ── 组 1：来源 ───────────────────────────────────────────────────── */}
      <section>
        <GroupHead
          title="来源"
          hint="外部谁在往平台送信号。配了 secret 的会校验签名，未配置的来源一律 404 —— 不解析载荷。"
        />
        {!loading && sources.length === 0 && (
          <Empty>
            还没有登记外部来源。要让某个系统（如 RSS / webhook）把信号送进来，先在这里登记它的前缀与密钥。
          </Empty>
        )}
        {sources.length > 0 && (
          <div className="divide-y divide-border-default/40 rounded-lg border border-border-subtle bg-surface-secondary">
            {sources.map(s => (
              <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px]">
                <code className="rounded bg-surface-overlay px-1.5 py-0.5 text-fg-primary">{s.prefix}</code>
                <span className={s.hasSecret ? 'text-emerald-600' : 'text-amber-600'}>
                  {s.hasSecret ? '已配密钥' : '未配密钥（拒绝接收）'}
                </span>
                <span className="text-fg-tertiary">登记于 {fmtDate(s.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 组 2：主动模式（档位说明 + 现状分布）────────────────────────── */}
      <section>
        <GroupHead
          title="主动模式"
          hint="每个责任域都有一个档位。默认「观察」：系统会记录判断但不执行；升到「自动 / 托管」需人批准。"
        />
        <div className="grid gap-1.5 sm:grid-cols-2">
          {AUTONOMY_LEVELS.map(l => (
            <div key={l.key} className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${l.tone}`}>{l.label}</span>
              <div className="min-w-0">
                <div className="text-[11px] text-fg-secondary leading-relaxed">{l.detail}</div>
                <div className="mt-0.5 text-[10px] text-fg-tertiary">
                  {autonomyCounts[l.key] ?? 0} 个责任域
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-fg-tertiary">
          红线动作（对外发布 / 删除 / 支付）在任何档位都不会自主执行 —— 这是平台硬约束，不是配置项。
        </p>
      </section>

      {/* ── 组 3：责任域 ─────────────────────────────────────────────────── */}
      <section>
        <GroupHead
          title="责任域"
          hint="谁（agent / team）负责哪个外部资源、被授权到哪一档（read &lt; draft &lt; publish &lt; admin）。"
        />
        {!loading && bindings.length === 0 && (
          <Empty>
            还没有责任域绑定。让 agent 用 <code className="text-fg-secondary">resource_bind</code> 声明它要长期盯的资源，
            或在任务中由人授权。
          </Empty>
        )}
        {bindings.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-secondary">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="border-b border-border-default/50 text-[10px] uppercase tracking-wider text-fg-tertiary">
                  <th className="px-3 py-1.5 font-medium">负责方</th>
                  <th className="px-3 py-1.5 font-medium">资源</th>
                  <th className="px-3 py-1.5 font-medium">权限</th>
                  <th className="px-3 py-1.5 font-medium">主动模式</th>
                  <th className="px-3 py-1.5 font-medium">授权人</th>
                  <th className="px-3 py-1.5 font-medium">起始</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default/30">
                {bindings.map(b => (
                  <tr key={b.id}>
                    <td className="px-3 py-1.5 text-fg-secondary">
                      <span className="text-fg-tertiary">{b.holder.kind === 'team' ? '团队' : 'Agent'} ·</span>{' '}
                      <code className="text-fg-primary">{b.holder.id.slice(0, 14)}</code>
                    </td>
                    <td className="px-3 py-1.5 text-fg-primary">{b.resource}</td>
                    <td className="px-3 py-1.5"><code className="text-fg-secondary">{b.scope}</code></td>
                    <td className="px-3 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${AUTONOMY_TONE[b.autonomy] ?? 'bg-surface-overlay text-fg-tertiary'}`}>
                        {AUTONOMY_LABEL[b.autonomy] ?? b.autonomy}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-fg-tertiary">{b.grantedBy}</td>
                    <td className="px-3 py-1.5 text-fg-tertiary">{fmtDate(b.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
