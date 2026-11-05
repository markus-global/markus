# 缓存键 / 指纹构造函数：禁时钟规约（P4）

**日期**：2026-11-05
**基线**：`8ac0ad84`（`feat/thread-trigger-router` tip，审计文档所在树）
**任务**：`tsk_07659f0f7f753edece650522`（`req_410d823e89f19d6df27e578d`）

---

## 1. 判据（唯一一条，可判定）

> **时间参与「键的构成」→ 违规（A 类）；时间参与「新旧的比较」→ 合法（B 类）。**

这条判据是对「键构造函数内不得出现 `Date.now()`」字面实现的反驳。实测数据：全仓 `Date.now()` 553 处，其中绝大多数是 TTL 记账、超时、节流、id 生成——照字面做会产生大量假阳性，然后**有人会去关掉守卫**。守卫的误报比漏报更致命。

推论（本次落地的三条）：

1. 键的构成 = 键名/键值里出现的**结构化字段**；时钟、随机数、自增计数都不得参与。
2. 「按天/按小时失效」是**档位**语义：档位由**调用方**计算并作为**显式入参**传入单一纯函数，而不是让构造点自己拼时间。
3. 唯一性令牌（每次都必须不同的值）**不是**键：稳定化会折叠事实。它走显式豁免通道，且豁免在门禁输出里可见。

---

## 2. 普查：键构造点清单（逐处读实现后分类，不靠命名猜）

### A 类 · 时钟进入键（违规，已修）

| # | 位置 | 改前 | 代价 |
|---|---|---|---|
| A1 | `packages/web-ui/src/pages/ChatHelpers.ts:831` | `cacheKey = \`${rawCreatedAt}\|${todayStart}\|${isoOrLocale}\|${yesterdayLabel}\`` —— 「今天起点」折进键 | 每天换一次键 = **每天整表冷一次缓存** |
| A2 | `packages/shared/src/types/thread.ts:611` | `contentHashIdempotencyKey(kind, subject, windowMs = 60_000, now = Date.now())` —— 参数默认值读时钟 | 缺参时键不可复现；「同一逻辑输入 → 同一键」无法测试 |

### B 类 · 时间只做 TTL 记账（合法，守卫不得误伤）

| 位置 | 键 | 时间的用途 |
|---|---|---|
| `org-manager/src/skill-service.ts:65`、`routes/skills.ts:1037` | `'skillhub-data'`（常量） | `now - cached.ts < TTL` |
| `org-manager/src/skill-service.ts:121`、`routes/skills.ts:1147` | `` `skillssh-${query}` `` | 同上 |
| `org-manager/src/routes/skills.ts:259` | `` `skill-registry-${source}` `` | 同上 |
| `org-manager/src/routes/skills.ts:1094` | `'skillhub-owner-map'`（常量） | 同上 |
| `web-ui/src/api.ts:590/620` | `path`（请求路径） | `_dedupCache` 的 `ts` 做 TTL |
| `web-ui/src/prefetchCache.ts:11` | `PREFETCH_KEYS` 常量 | 一次性预取，无时间 |
| `core/src/tool-hooks.ts:85` | `ctx.idempotencyKey`（调用方给） | 时间只作为 value 的一个字段 |
| `core/src/tools/file.ts:167`、`tools/mcp-client.ts:233` | `path` / `serverName` | 无时间 |

**判据切片**：这些点的 `Date.now()` 与键**没有任何数据流关系**，所以守卫必须按语义判，不能按「同一函数里出现 `Date.now()`」判。

### C 类 · 已有正确形态（复用，不另造）

| 位置 | 形态 |
|---|---|
| `shared/src/types/wakeup-events.ts:82-90` | `wakeupDedupKey`：键的字段由**登记表** `WAKEUP_EVENTS` 声明，不是调用方随手拼；未登记即 fail-closed |
| `core/src/mailbox.ts:108-140` | `mailboxDedupKey`：只取结构化字段（`sourceType`/`taskId`/`round`/`from→to`），轮次别名收在这一个函数里 |
| `core/src/heartbeat.ts:79-89` | `heartbeatStateFingerprint`：注释明确「特意不含 lastHeartbeat 时间戳（含则指纹恒变化 → 永远巡检）」 |
| `core/src/context-engine.ts:2880` | `hashSection`：先 `normalizeSectionForHash` 剥掉「7h ago」这类相对时间标签再哈希——**时间不进键**的正确做法 |
| `storage/src/sqlite-storage.ts:6487` | `stableGatewayId`：sha1 over NUL-joined tuple（NUL 分隔避免 `a`+`b_c` 与 `a_b`+`c` 碰撞） |
| `org-manager/src/instance-integrations.ts:213/222` | `instanceIdFor` / `bindingIdFor`：与迁移方案同一 hash 口径 |
| `web-ui/src/components/NotificationBell.tsx:115` | `templateUpdatesFingerprint`：内容派生（`name@version` 排序后 join） |
| `web-ui/src/lib/platformIntegrations.ts:361` | `statusFingerprint`：状态字段派生 |

### D 类 · 明确定义为「残余」的（不在本卡）

- 其余 500+ 处 `Date.now()`：id 生成、超时、节流、TTL 记账、日志时间戳。
- `org-manager/src/thread-ensure.ts:77`：`idempotencyKey: event.eventId ? \`evt:${eventId}\` : \`evt_${Date.now()}_${Math.random()}\`` —— **唯一性令牌**（无稳定 id 时每条消息必须是新行），稳定化会丢事实。已用 `key-clock-ok` 行内豁免并写明理由；门禁输出里以 `·` + 「已用 key-clock-ok 豁免」可见，不是静默放行。

---

## 3. 修复（A 类 → 0）

### A1 · `ChatHelpers.ts`：档位显式化

```ts
// 唯一把时钟折算成档位的地方
export function dayBucketOf(now: Date): number { … }
// 键构造函数：纯函数，只由入参构成
export function smartTimeCacheKey(isoOrLocale, rawCreatedAt, dayBucket, yesterdayLabel): string
// 调用点：档位可由调用方钉住（测试 / 跨午夜一致性）
export function formatSmartTime(isoOrLocale, rawCreatedAt?, labels?, dayBucket?: number)
```

要点：**档位仍是键的一部分**（否则跨午夜会读到昨天的标签），但它是**入参**而不是构造点自己读的时钟。缓存的正确性不变，可测试性恢复。

### A2 · `thread.ts`：去掉默认值

```ts
export function contentHashIdempotencyKey(kind, subject, windowMs: number, now: number): string
```

`arity = 4`：缺参在编译期报错，而不是在运行期静默读时钟。时间窗仍是「档位」，由调用方决定用哪个时刻折算。

---

## 4. 静态守卫（规则 6 `key-constructor-no-clock`）

落点：`scripts/architecture-guard.mjs`（既有门禁，`npm run quality` 已接线）。

**语义切片**（区分 A 与 B 的实现方式）：

1. **键函数**（名字以 `cacheKey`/`dedupKey`/`idempotencyKey`/`fingerprint` 结尾，或函数体含 `createHash(`）：整个函数体 + 签名默认值即键构造器 → 出现时钟/随机源即违规。
2. **键声明**（`const cacheKey = …` 等）：只有右值是键构造器 → 对右值做污点分析（时钟派生变量进入右值即违规）。B 类天然不命中：`now` 是脏的，但它不出现在键右值里。
3. **键属性**（对象字面量 `idempotencyKey: …`）：只认「构造出来的值」（模板串/拼接/调用）+ **直接**时钟源。类型签名（`dedupKey: string;`）与纯字段读取（`dedupKey: r['dedup_key'] as string | null`）不命中——实测这两类是最主要的误报来源。
4. **委派形态**：右值若调用键函数（`raw ? smartTimeCacheKey(…) : null`），声明只是调用点，由规则 1 检查该函数 —— 这正是本卡要求的正确形状，不得误判。
5. **不穿过容器字面量**：`const item = { queuedAt: new Date().toISOString(), … }` 里的时间戳是**载荷数据**，不是键成分；否则 `mailboxDedupKey(item)` 会被误报（实测 `mailbox.ts:772`）。

**豁免通道**：行内 `key-clock-ok: <理由>`（同行或紧邻上一行）。豁免计入 `allowed`，但打印时以 `·` + 「已用 key-clock-ok 豁免」**可见**——残余项必须可观测，不是静默放过。

**自检夹具**（门禁每次运行都跑，检测器失效即 exit 2，拒绝静默放行）：A 类必红 / B 类必绿 / C 类必绿 / 键函数默认值必红 / 委派形态必绿 / 行内豁免生效。

---

## 5. 验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| 守卫（清） | `node scripts/architecture-guard.mjs` | ✅ 35 处命中全部在白名单内；契约不变量 **17/17** |
| 守卫（反例必红） | 放入 `packages/core/src/__probe_keyclock.ts`（`cacheKey` 折入 `todayStart`） | ✅ `✗ __probe_keyclock.ts:6 [key-constructor-no-clock] cacheKey —— 时钟派生变量 todayStart 进入键` → `门禁失败：有 1 处新违规` |
| 守卫（撤销必绿） | `git clean` 删除探针后重跑 | ✅ 回到 `✓ 通过` |
| 行为测试 · shared | `vitest run packages/shared/src/types/thread.test.ts` | ✅ 53/53（含 arity=4、跨时刻同键） |
| 行为测试 · web-ui | `vitest run packages/web-ui/src/pages/ChatHelpers.test.ts` | ✅ 102/102（含同输入同键、跨时刻同键、`dayBucketOf` 纯函数、档位可钉住） |
| 类型检查 | `tsc -b` | ✅ exit 0 |

行为测试的关键断言（会咬人）：

- `contentHashIdempotencyKey.length === 4` —— 默认值回来就红（源码文本断言做不到这一点）。
- `vi.setSystemTime(10:00)` 与 `vi.setSystemTime(18:00)` 两次构造 → `toBe` 相同（构造函数不读时钟）。
- `dayBucketOf`：同一天任意两时刻 → 同一档位；跨天 → 不同档位。

---

## 6. 残余与后续触发阈值

- **范围声明**：其余 500+ 处 `Date.now()`（id 生成 / 超时 / 节流 / TTL 记账 / 日志）**不在本卡**。本卡只保证「键构造点」这一类在结构上不再复发。
- **触发阈值**：新增任何键构造点（键名/键属性/键函数）→ 门禁自动覆盖，违规即红。也就是说残余的风险面已经从「每次 review 靠人眼」变成「新增即拦」。
- **观测方式**：`npm run quality`（已含 guard）；本地与 CI 同一入口。豁免项在输出里以 `·` 可见，数量可数（当前 1 处：`thread-ensure.ts:77`）。
- **已知边界**：守卫是启发式的，不做完整数据流分析。已知不覆盖：`const k = x ? \`${Date.now()}\` : ''` 之后再被键使用的间接形态（键名不含 key 语义）、跨文件传播。判定原则是**宁可漏报也不误报**——漏报由行为测试兜（键必须是纯函数），误报会让人关掉守卫。
