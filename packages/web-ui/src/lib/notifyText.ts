/**
 * 一条通知的**文案**：标题 / 正文，按后端附带的结构化 i18n 元数据渲染。
 *
 * 为什么从 `components/NotificationBell.tsx` 抽出来：铃铛与通知页已经移除（Owner 2026-11-02：
 * 通知入口并入概览「等你处理」+ 历史弹窗），但 Team 页的「待处理通知」卡片仍需要同一套文案。
 * 若把这两个函数留在铃铛文件里，就会为了两个纯函数保留一个 1700 行的死组件；
 * 若在 Team 页重写一遍，就是同一事实的第二个写者 —— 两处渲染迟早不一致。
 *
 * 规则（后端契约）：`metadata.i18n` 里带 `titleKey` / `bodyKey` 与参数时按当前语言渲染，
 * 旧通知没有这些字段则回落原文。枚举参数（status / priority）走 `common:*` 词表，
 * 其余参数（标题等用户内容）原样保留。
 */
import type { TFunction } from 'i18next';
import type { NotificationInfo } from '../api.ts';

interface NotifI18nMeta {
  titleKey?: string;
  titleParams?: Record<string, string>;
  bodyKey?: string;
  bodyParams?: Record<string, string>;
}

function notifI18n(n: NotificationInfo): NotifI18nMeta | undefined {
  const meta = n.metadata as Record<string, unknown> | undefined;
  if (!meta || typeof meta.i18n !== 'object' || !meta.i18n) return undefined;
  return meta.i18n as NotifI18nMeta;
}

/** 任务状态用 snake_case（in_progress），词表用 camelCase（inProgress）——两种键都试。 */
function camelizeEnum(value: string): string {
  return value.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export function notifTitle(n: NotificationInfo, t: TFunction): string {
  const i18n = notifI18n(n);
  if (!i18n?.titleKey) return n.title;
  const params = { ...(i18n.titleParams ?? {}) };
  return t(`team:${i18n.titleKey}`, { ...params, defaultValue: n.title });
}

export function notifBody(n: NotificationInfo, t: TFunction): string {
  const i18n = notifI18n(n);
  if (!i18n?.bodyKey) return n.body;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(i18n.bodyParams ?? {})) {
    // 枚举类参数（状态、优先级）用 common:* 本地化；其余（标题等用户内容）原样保留。
    // 任务状态是 snake_case（in_progress）、词表是 camelCase（inProgress）——两种都试，
    // 否则查不到会静默回落，留下「状态已变为 in_progress」这种半英半中的句子。
    if (k === 'priority') {
      params[k] = t(`common:priority.${v}`, { defaultValue: v });
    } else if (k === 'status' || k === 'statusKey') {
      const camel = camelizeEnum(v);
      params[k] = t(`common:status.${v}`, {
        defaultValue: camel === v ? v : t(`common:status.${camel}`, { defaultValue: v }),
      });
    } else {
      params[k] = v;
    }
  }
  return t(`team:${i18n.bodyKey}`, { ...params, defaultValue: n.body });
}

/**
 * 审批状态的显示文案。审批状态有**自己的词表**（`approvalStatus.*`），与任务/需求状态
 * （`common:status.*`）不是同一个空间 —— `changes_requested` 只存在于审批侧。
 * 共用一本字典正是「铃铛里出现原始英文 token」的成因。
 */
export function approvalStatusLabel(status: string, t: TFunction): string {
  return t(`common:approvalStatus.${status}`, { defaultValue: status });
}
