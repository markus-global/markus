/**
 * 流 → 它能点回的那个真实页面。
 *
 * 为什么需要这一层：
 * Thread 视图和路由台原本把 `tsk_d0dd96f6b846b0c3e51b52f6` 直接铺在界面上。
 * 对人来说那不是「信息」，那是**数据库的视角**：既不可读，也点不动，
 * 看完只知道"有这么个东西"，不知道它是什么、要去哪儿处理。认知负担多于价值。
 *
 * 正确的单位是**人能认出的实体**：「GEO 可见度基线快照」这张任务卡。
 * 所以显示层要把它翻译成「任务 · GEO 可见度…」，并且**可点**——
 * 点进去就是既有页面（Work / Team），不新造目的地。
 *
 * 只映射**确定存在**的入口。不确定的不猜：宁可显示成不可点的文字，
 * 也不要给一个点了没反应的链接（假链接比没有链接更伤信任）。
 */
import { PAGE } from '../routes.ts';

export interface EntityTarget {
  page: string;
  params?: Record<string, string>;
}

/** a2a_<agentA>__<agentB> → 对方 agent（自己那一半不参与导航）。 */
function peerOfA2A(ref: string): string | null {
  const body = ref.slice('a2a_'.length);
  const [a, b] = body.split('__');
  if (!a || !b) return null;
  return a;
}

/**
 * 这条流该跳到哪个页面。
 *
 * 返回 null = 没有确定的目标（那就渲染成纯文字，不做成按钮）。
 */
export function entityNavTarget(ref: string | null | undefined): EntityTarget | null {
  if (!ref) return null;

  if (ref.startsWith('tsk_')) return { page: PAGE.WORK, params: { openTask: ref } };
  if (ref.startsWith('req_')) return { page: PAGE.WORK, params: { openRequirement: ref } };
  if (ref.startsWith('proj_')) return { page: PAGE.WORK, params: { projectId: ref } };

  if (ref.startsWith('a2a_')) {
    const peer = peerOfA2A(ref);
    return peer ? { page: PAGE.TEAM, params: { agentId: peer } } : null;
  }

  // `cs_` 会话没有稳定的「直接打开某条会话」参数（会话归属在 Team chat 的运行时状态里），
  // 外部资源键（`gh:` / `xhs:`）更是指向平台外的对象。
  // 这两类不编造入口 —— 显示成文字，不做成假链接。
  return null;
}

/** 这个 ref 是否可点回既有页面。 */
export function isNavigable(ref: string | null | undefined): boolean {
  return entityNavTarget(ref) !== null;
}
