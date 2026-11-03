# Source — 事件从哪来、读到哪儿、什么算事件

> **一句话**：`Source` 是**领域概念**，不是「适配器」的同义词。它回答三个问题：
> ① 这条来源的**哪些**事件值得进入领域（准入）？② 上游**读到哪儿**了（位点）？
> ③ 加一条新来源要改哪里（答案：**只加一行配置 + 一个适配器**）。
>
> 代码入口：`packages/core/src/event-source.ts`（适配器）、`source-admission.ts`（什么算事件）、
> `source-cursor.ts`（位点推进）、`packages/core/src/event-ingress.ts`（唯一顺序）、
> `packages/org-manager/src/event-routes.ts`（HTTP 面）、`packages/storage/src/thread-store.ts`（`SqliteEventSourceRepo`）。

---

## 1. 三个概念各有唯一位置

| 概念 | 唯一定义点 | 说明 |
|---|---|---|
| 「怎么进来」（传输/验签/归一化） | `SourceAdapter`（`event-source.ts`） | 每平台一个适配器；`prefix` 是注册键，**不是枚举**（设计 01 §7.9） |
| 「什么算事件」（准入） | `admitEvent()`（`source-admission.ts`） | 纯函数；规则是**数据**（`config.policy`），不是平台名分支 |
| 「读到哪儿」（位点） | `event_sources.cursor` + `SqliteEventSourceRepo.advanceCursor()` | 一列一个问题；唯一写语句 |

进入领域的顺序只有一个（`EventIngress.ingest`）：
**验签 → 归一化 → 准入（进领域之前丢）→ 登记触发器 → 路由 → 投递**。

---

## 2. 位点（读取位点）

### 2.1 语义

- `event_sources.cursor TEXT`：**这条来源的上游读到哪儿了**。
  - `NULL` = 没有位点（推送式来源，或历史行从未拉取过）。
- `event_sources.last_polled_at INTEGER`：最近一次拉取尝试时间，**纯观测**，不参与任何判定。

### 2.2 什么时候推进（唯一推进点）

```
packages/core/src/source-cursor.ts      consumeBatch()            ← 唯一调用方（且只在“全部成功”分支）
packages/storage/src/thread-store.ts    advanceCursor()           ← 唯一写语句
```

推进的三个前提，每一个都不是靠调用方自觉：

1. **凭证**：入参 `CursorAdvance` 带私有 symbol 品牌，只能由 `mintCursorAdvance(evidence)` 铸造；
   该函数在 `failed > 0` 时**直接抛错**（`CURSOR_ADVANCE_AFTER_FAILURE`）。消费失败 → 拿不到凭证。
2. **CAS**：`UPDATE event_sources SET cursor=?, last_polled_at=? WHERE id=? AND cursor IS ?`
   —— 调用方必须交回「它读取时的位点」。重复/乱序/并发推进 = 0 行 no-op，位点永不回退。
3. **一列一个问题**：推送式 webhook 路径**不写** `cursor`（它没有「读到哪儿」）。所以写这一列的
   只有拉取侧那一个调用点。

绕过路径为什么做不到：想推进位点，必须（a）拿到 `CursorAdvance`（类型层：私有品牌；
运行期：`failed > 0` 抛错），（b）通过 CAS（值层：期望位点必须等于库里的现值）。
唯一能同时满足两者的代码路径就是 `consumeBatch()` 的成功分支。

### 2.3 空批次也推进

拉取成功但这一页没有新事件 = **读过了**。若空批次不推进，同一页会被永远重拉。
判据只看「消费是否失败」，不看「有没有事件」。

---

## 3. 什么算事件（准入规则）

`config.policy`（可选；缺省 = 全收）。顺序即优先级，第一个拒绝胜出：

| 顺序 | 规则 | 字段 | 拒绝时的 `rule` |
|---|---|---|---|
| 1 | **自激**：机器人自己发的消息 | `selfActorIds: string[]` | `self` |
| 2 | 事件类别 | `acceptKinds: string[]` | `kind` |
| 3 | 监听范围（`ref` 前缀） | `refPrefixes: string[]` | `scope` |
| 4 | 时间条件（每天的时间窗） | `activeWindow: {fromMinute, toMinute, utcOffsetMinutes?}` | `window` |

三条纪律：

- **`self` 永远排第一**。自激循环（agent 发出去的消息又被收回来）是唯一会**自我放大**的失效模式，
  它不能排在任何其他过滤器后面 —— 否则「事件本来也不在监听范围内」会掩盖它，监听范围一扩大就又漏回来。
- **按身份匹配，不按「是不是机器人」**。通用信封默认 `actorKind: 'bot'`（内部脚本都是 bot），
  一刀切会把所有内部事件丢掉。所以只有 `actorKind === 'bot' && actorId ∈ selfActorIds` 才丢。
- **被丢弃的事件不占幂等键**：过滤发生在 `triggers.insertOrGet` **之前**。否则「同 id 先被过滤、
  后来又在监听范围内」会被错认成重复而永久丢失。

丢弃必须是**可观测的**，不是静默：`IngressResult.filteredBy`（`self|kind|scope|window`）+
`event_sources.health.lastFiltered / lastFilterReason`。

写入路径严格、读路径宽容：`validateSourcePolicy()` 在 `POST /api/events/sources` 时把写错的配置
变成 400 + 具体字段名；`policyOf()` 在读路径永不抛错（一条配置写错不该让整条来源收不了事件）。

---

## 4. 位点与幂等键的分工（不可互替）

| | 位点 `cursor` | 幂等键 `idempotency_key` |
|---|---|---|
| 回答 | 「上游读到哪儿」 | 「这条投递我见过」 |
| 位置 | 拉取侧（`consumeBatch`） | 入口侧（`triggers` 表唯一约束） |
| 顺序性 | 依赖上游顺序 | 与顺序无关 |
| 失败时 | **不推进**（宁可重拉，不可漏） | 已成功那部分不再重复处理 |
| 不能替代对方的原因 | 位点回退就会重放 → 靠幂等键兜底 | 幂等键不知道「下一页从哪开始」；用它会丢「读到哪」 |

一句话：**位点负责不重复拉，幂等键负责重复投递只留一行**。

---

## 5. 两条入口（同一条链路）

| 入口 | 用途 | 写位点？ |
|---|---|---|
| `POST /api/events/:prefix` | 推送式 webhook（单条或 `{events:[...]}` 批量） | 否（推送来源没有位点） |
| `POST /api/events/:prefix/batch` | 拉取式：`{events:[...], nextCursor}` → 全部成功才提交 | 是（唯一写入路径） |
| `GET /api/events/sources` | 来源清单（含 `cursor` / `lastPolledAt`，`secret` 永不返回） | — |

`nextCursor` 必填（显式 `null` = 上游已到末尾）：缺省不推进，避免调用方忘传一次就把位点重置成 `NULL` → 下次全量重拉。

批量入口的状态码：`200 committed` / `409 not-committed`（有失败，位点不动，重试同一位置）/
`401` 签名不对 / `404` 来源未登记 / `400` 缺少 `nextCursor` 或配置非法。

---

## 6. 加一条新来源（H2）

1. `POST /api/events/sources {prefix, secret, config:{policy}}` —— **一行配置**；
2. 若信封够用（`GenericWebhookPayload`），**不需要写代码**；平台的 payload 差异超过一个信封时，
   才写一个 `SourceAdapter`（`normalize` + `verify`，约 60 行）并 `registry.register()`。

不改调度核心、不改枚举、不改准入规则 —— 这是 H2 的可判定判据。

---

## 7. 刻意不做（附移除/重评条件）

| 不做 | 理由 | 重评条件 |
|---|---|---|
| 平台内置 fetcher（RSS 轮询器、GitHub 分页拉取） | 平台只拥有**位置**，取数是适配器/外部脚本的事；内置 fetcher 会把「加实例不改调度核心」(H2) 破掉 | 出现第 3 个需要分页的拉取来源，且它们的分页语义完全相同 |
| 位点写进 `health` JSON（02 §2.1 原写法） | `health` 多写者、可被 `updateHealth` 合并覆盖 → 无法 CAS、无法审计 | 永不（这是结构性问题，不是风格问题） |
| `event_sources.kind` 枚举（`EventSourceKind` 11 值） | 是适配器清单不是类型（01 §7.9） | 永不 |
| 位点自动重试 / 死信队列 | 位点停住 + `lastPolledAt` 可观测就够；重试策略属于调用方 | 出现「拉取方不重试 → 事件永久丢失」的真实事故 |

---

## 8. 验证（可复跑）

```bash
pnpm --filter @markus/core exec tsc -b --force
pnpm --filter @markus/storage exec tsc -b --force
pnpm --filter @markus/org-manager exec tsc -b --force

npx vitest run packages/core/test/source-admission.test.ts \
               packages/core/test/source-cursor.test.ts \
               packages/core/test/event-ingress.test.ts \
               packages/storage/test/event-source-cursor.test.ts \
               packages/org-manager/test/event-source-pull.test.ts

node scripts/probe-source-cursor.mjs   # 真库探针：建 source → 喂两批 → 查 cursor 与 triggers
```

测试与契约的对应：

| 验收要求 | 测试 |
|---|---|
| 两轮消费，第二轮只拿到新增（位点生效） | `source-cursor.test.ts`「两轮消费只拿新增」+ `event-source-pull.test.ts`「两批事件」 |
| 消费失败 → 位点**未推进** | `source-cursor.test.ts`「失败位点一动不动」（断言**零次写入**）+ `event-source-pull.test.ts`「消费失败」 |
| 机器人自己的消息**不产生** trigger | `source-admission.test.ts`（规则）+ `event-source-pull.test.ts`「真实载荷 + 真实库」 |
| 单一推进点 | `source-cursor.test.ts`「失败拿不到凭证」+ `event-source-cursor.test.ts`「CAS 推进」 |
| 升级不动旧行 | `event-source-cursor.test.ts`「老库升级后两列存在，旧行 cursor 为 NULL」 |
