/**
 * 浏览器侧的“形状归一”——实体字段在渲染前必须已经是它声明的类型。
 *
 * ## 为什么前端也要归一，而不是信任后端
 *
 * 服务端已经在仓储边界把 `tags` 收口成 `string[]`（见
 * `packages/storage/src/sqlite-storage.ts#arrayFromJson`）。但那是**新版后端**。
 * 前端面对的现实是：
 *
 *   • 用户的桌面壳里可能还跑着旧版后端（本次事故就是：包已装、服务未重建）；
 *   • 第三方/脚本可以直接 POST 一个脏值，或者历史数据还没跑完迁移；
 *   • 前端自己的缓存/离线快照可能来自任意版本。
 *
 * 结果是渲染路径必须自己扛住：`(req.tags ?? []).join(', ')` 只要拿到一个
 * `string` 就抛 TypeError，React 18 随即卸载整棵树 → 用户看到白屏。一个字段的
 * 形状问题不该有这种威力。
 *
 * ## 为什么归一在这里，而不是每个 `.join()` 前
 *
 * `api.ts` 是“任意 JSON → 前端类型化实体”的**唯一**边界。在这里归一一次，
 * 20 个消费点就可以继续按 `string[]` 写，不必各加一个 `Array.isArray` ——
 * 一个不变量、一个实现点。
 *
 * ## 与服务端实现的关系
 *
 * 语义与 `packages/shared/src/utils/tags.ts#toStringArray` 完全一致（三种历史
 * 编码：数组 / JSON 字符串 / 对象包装）。之所以不直接 import：web-ui 的包体是
 * 浏览器构建，不能把 `@markus/shared` 的 node 侧依赖（fs/crypto）拉进来。
 * 两边各有一份同口径测试（本目录 `entityShapes.test.ts` 与 shared 的
 * `tags.test.ts`），改一处必须同时改另一处，否则测试会指出不一致。
 */

/** 把任意存储形态的列表字段收敛成 `string[]`；永不抛错、永不返回非数组。 */
export function asStringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed);
      } else if (typeof item === 'number' || typeof item === 'boolean') {
        out.push(String(item));
      }
    }
    return out;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];
    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
      try {
        return asStringList(JSON.parse(raw) as unknown);
      } catch {
        /* 不是合法 JSON —— 当作纯文本列表处理 */
      }
    }
    return raw.split(',').map(tag => tag.trim()).filter(Boolean);
  }

  if (typeof value === 'object') {
    const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray);
    return arrays.length === 1 ? asStringList(arrays[0]) : [];
  }

  return [];
}

/** 需求：`tags` / `taskIds` 是渲染路径上的数组字段（`.join` / `.map`）。 */
export function normalizeRequirement<T>(r: T): T {
  if (!r || typeof r !== 'object') return r;
  const rec = r as Record<string, unknown>;
  return { ...rec, tags: asStringList(rec['tags']), taskIds: asStringList(rec['taskIds']) } as T;
}

/** 产出物：`tags` 在详情/分享弹窗里被 `.map`。 */
export function normalizeDeliverable<T>(d: T): T {
  if (!d || typeof d !== 'object') return d;
  const rec = d as Record<string, unknown>;
  return { ...rec, tags: asStringList(rec['tags']) } as T;
}

/** 任务：`blockedBy` 在依赖图与任务详情里被当成数组用。 */
export function normalizeTask<T>(t: T): T {
  if (!t || typeof t !== 'object') return t;
  const rec = t as Record<string, unknown>;
  return { ...rec, blockedBy: asStringList(rec['blockedBy']) } as T;
}
