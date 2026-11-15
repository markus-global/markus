# C8 遗留机制的第一性原理重构方案

> **状态**：**5/7 项已落地**（2026-11-15 19:05 实测，见 §0.5）· **日期**：2026-11-15 · **作者**：CTO
> **实施分支**：`feat/c8-residual-refactor`（从 `origin/feat/refactor-plan` 起；按主计划 §5.1 第 0 条：全部刀完成并验收前不进 main）
> **范围**：C8 收口后遗留的 9 项（DR3 / DR5 / DR6 / H4 / H7 / A1 / A2 / A3 / A4 / A5 中未完成部分）
> **取证方式**：四路只读调研（代码直读 + `~/.markus/data.db` 只读查询 + 仓库测试文件核对），
> 每条结论都带 `文件:行` 或可复现读数。**没有一条是凭计划文档的措辞推出来的** —— 相反，
> 调研过程中发现计划文档本身有 3 处与代码不符（见 §7.3）。

---

## 0. 一页结论

**这不是 9 个 bug，是 1 个结构病的 9 个实例。**

平台里存在大量「**声明**」——预算上限、策略位、守卫字段、场景参数、机制表、配置字段。
调研发现：**没有任何机制保证这些声明与它们的执行点同生同死。** 于是每一处声明都能独立存在、
独立漂移，而漂移不会报错、不会让测试变红，只会在某个时刻表现为「横幅在喊但没人动」「表建好了没人写」
「守卫问的是 A 却由 B 来答」。

一句话判据：

> **一条声明，要么有一个消费者（执行点 / 触发器 / 写者 / 读者），要么就该被删除。
> 没有见证者的声明不是「预留」，是谎言。**

| # | 症状（表面） | 本质（同一根因的不同形态） |
|---|---|---|
| DR5 | 注入段 111% 超预算却不触发整理 | 声明了一个 15000 的上限，**零个动作消费者**；且度量的对象不是它要保护的载荷 |
| DR3 | 两个守卫并存、重启行为不对称 | 一个时间戳被当成「某事件已发生」的布尔用；**写入者不是它问的事件，且在成功之前武装** |
| H7 | heartbeat 已不产生，策略位还在 | 策略表按「类型」建键，**表里没有「当前通道是否产生该类型」这一维** |
| H4 / A1 / A4 | `rest` 已落但底层仍轮询 | `TriggerEvent` 的唯一来源是 mailbox，**事件驱动没有事件源**，于是用 1 分钟轮询冒充 |
| A2 / A5 | agent 不知道自己负责什么、没有自主档位 | `AgentConfig` 声明了 agent 的一切**除了它要去做什么** |
| DR6 | `scenario` 由调用方自选（41 个传参点） | 「我是谁、我该有哪些工具」被拆成**每次调用由外部声明**，而不是执行主体的属性 |
| A3 | 建了表没流量 | 声明的对象**没有写者、或写者不可达、或写者被门控在它所记录的事件之后** |

**重构的主线动作只有一个**：把「声明」收敛成一张可被机器校验的表，让「无见证者的声明」在 CI 期变红，
而不是在半年后表现为一条永远亮着的告警（§4.1）。各项的具体方案在 §4.2–§4.8。

**优先级判据**（不是按计划编号，按「此刻是否在产生损失」）：

1. **DR5** —— 唯一一项**正在持续产生损失**的：我这个会话此刻注入段 111%，警示语在承诺一个已被删除的动作。
2. **DR3 / H7** —— 已在产生**错误的判断**（dream 该跑不跑、化石策略位仍在被读取），但频率低。
3. **A3** —— 不产生损失，但**每次 DDL diff 都在骗人**，成本最低（删）。
4. **DR6 / A2 / A5 / H4 / A1 / A4** —— 结构性欠账，改动面大，必须与 §4.1 的见证者表一起做，否则修完又是一批新声明。

---

## 0.5 实施状态与下一步（第一性原理推导，2026-11-15 19:05 实测）

### 0.5.1 已落地：7 个提交，5/7 项完成

| 提交 | 项 | 改的是什么 | 验证 |
|---|---|---|---|
| `a21998fb` | — | 本设计文档 | — |
| `4336851b` | 阶段 0 | `declarations.ts` 见证者表 + 四规则守卫 | 6/6 |
| `c6dcf35d` | **A3** | 删 8 张墓碑表 + 5 个不可达 repo 类（建表 45→37） | storage 347 |
| `98563e02` | **A2** | `[MY ASSIGNMENT]` 改为纯派生；任务板投影同一派生 | 73 |
| `d727b77f` | **DR5** | 记忆健康改量「本轮注入载荷」；`prepareKnowledgeForPrompt` 回报 `inlinedChars/omittedCount` | 3764 |
| `8e1c58ff` | **DR3** | dream 记录类型化 + 成功后武装 + 写失败上报 | 3764 |
| `1a44b033` | **H7** | 注册表加 `producedBy` 列；可丢集合按模式派生 | 4256 |

**累计验证**：`tsc packages/core packages/shared` 0 错；`vitest` **4256 通过 / 0 失败 / 10 跳过**；工作区干净。

**实施时对原方案的四处更正**（均已写进对应小节，此处汇总——它们是「文档也会撒谎」的证据）：

1. **A2 的第三源写错了**：原写「requirements where approved_by…state=pending」，但 `requirements` 没有 reviewer 列，而 `pending` 需求的 `approved_by` 按定义是 NULL。改为真实可派生、且此前完全缺失的一条轴：**待我裁决的任务**（`reviewer_agent_id=me` 且 `status='review'`）。
2. **H7 首选方案前提不成立**：删 `heartbeat` 类型以「退役 legacy 回滚通道」为前提，而该通道按设计仍可选（`MARKUS_HEARTBEAT_CLOCK=legacy`），`agent.ts` 的 `enqueue('heartbeat')` 就在 `if (mode === 'legacy')` 里。删类型等于静默移除文档化的回滚能力 → 走第二方案。
3. **DR5 的两处度量错误**：`inlinedChars` 必须在追加索引行**之前**取（索引行记的是「不在里面的东西」，算进正文会抬高它要报的数）；横幅原句「最大段落正被无损归档」在生产代码里没有任何执行点——注入器是**不内联并在索引行点名**，不是归档。
4. **H7 的测试原来钉的是化石本身**（`toContain('heartbeat')`）。改为真不变量：**任何模式下可丢集合 ⊆ 可产生集合**。

### 0.5.2 判据一：守卫自己有没有守卫？

阶段 0 建的见证者表，现在有两处**在撒谎**——它们把已修完的项仍记为「无消费者」：

| 表中条目 | 表里仍写着 | 实际状态 |
|---|---|---|
| `memory.curatedSoftBudget` | `witness: none`，理由「Superseded by DR5」，`removeBy: 2026-12-15` | **DR5 已落地**：注入上限由 `memory.injectedKnowledgeCap`（witness=`prepareKnowledgeForPrompt`）承载；策展区域已降级为 report-only |
| `mailbox.heartbeatTriageStaleDrop` | `witness: none`，理由「H7 retires it」 | **H7 已落地**：见证者是 `triageStaleDropTypes(mode)` / `producibleIn(mode, t)` |

更根本的一条（**此处更正我自己第一版的错误**）：我写了「`removeBy` 本身没有消费者」，那是凭推断下的断言——`declarations-witness.test.ts:102` 已经在检查 `removeBy` 是否过期（`toBeGreaterThan(now)`）。它是有消费者的。

真正的缺口在**相反方向**：**规则 4 只管「债是否到期」，不管「债是否已经还清」。** 没有任何检查会问「这条债是不是已经还了」。

后果可复现：我今天修完 DR5 和 H7，`declarationDebt()` 仍然把两条都算作债，要等到 `2026-12-15` 才会变红——而届时它报的原因是「过期」，不是「已还」。**一个只朝一个方向看的闸门，会让「已还的债」和「没还的债」长得一模一样。**

这比「`removeBy` 无人读」更难修，因为它需要知道「某项已完成」这个跨表事实（而作业状态存在 `tasks` 里，不在 `declarations.ts` 里）。所以 P0 不做花哨的跨表联动，只做两件确定的事：把两条已还的债在表里结清；然后以 `declarationDebt()` 的**条数**作为可判定验收（见 §0.5.4）。

### 0.5.3 判据二：剩下三项，哪一项不修会继续产生损失？

| 项 | 不修的代价 | 现在能不能动 |
|---|---|---|
| **H7 数据迁移** | 107 行（`task_assignment` 106 + `a2a` 1）正走 `UNKNOWN_ROUTE` 兜底 → 兜底在 L2 路由上当第二事实源 | 代码侧判据已就绪（`producibleIn`），但**动线上库需 Owner 拍板** |
| **DR6** | 34 处 `scenario:` 字面量由调用方声明，错一个就发错工具集（已记录现场：`background_exec` 完成被派成 `heartbeat` → reflex 包没有 `file_write`） | **无阻塞** |
| **H4 / A4** | `rest` 文档说事件驱动，实际由 60s sweep 冒充 | **卡在自己的前提**：`pendingCallbackRegistry` 在 `worker>1` 下是否会重复唤醒 |
| **A5** | 自主档位隐含散落在角色/间隔/调用点 | 共用 H4 的 `observe` 词汇，必须排其后 |

### 0.5.4 行动计划（按此顺序）

**结论：下一步的第一步不是 DR6，也不是 H4 —— 是让守卫自己先站住。**

判据：**没有守卫的修复 = 下一次漂移的种子。** 已修 5 项，其中 2 项的表条目还说没人守；此时去做 DR6，等于在一条自己都不可信的守卫旁边继续加代码。而让守卫站住只需两件小改动，它会把 5 项点修变成 5 条不变量。

**P0 · 让守卫站住（无需决策）**
1. 回填两条已修项的见证者（DR5 → 策展区域的真实读者 `getMemoryHealth`；H7 → `triageStaleDropTypes`/`producibleIn`），删掉它们的 `reason`/`removeBy`。
2. 顺带结案 §7.2 的第 2 条（`marketplace_*` 去留）：A3 已按判删处理，那条待决项已过期。
3. **不在 P0 做**：跨表「已还债自动结清」的机制。它需要作业状态（在 `tasks` 里）与注册表（在 `declarations.ts` 里）联动，是个新抽象；在没有第二个受害者之前，不为此加机制。

**可判定验收**：做完 P0，`declarationDebt()` 只剩 3 条（`trigger.eventSource`→H4、`agent.autonomyLevel`→A5、`agent.scenarioIsDeclared`→DR6）——**剩下的正好是未修的三项，一条不多一条不少**。这就是守卫可信的证据。

**P1 · DR6（无阻塞，先测量再动手）**
先测量而不是先改代码：34 处 `scenario:` 字面量里，有多少能被「信号源 + 运行态」唯一确定？
- 绝大多数可派生 → 派生 + 余下显式标注「这是 override，理由是 X」，并把 override 数量本身登记为一条声明（超预算即红）。
- 不可派生占多数 → 放弃「删字面量」，改做「声明必须携带来源且可被校验」。

**先测再改，别把 34 处当 34 个 bug 打。**

**P2 · H7 数据迁移（需 Owner 拍板）**
107 行路由裁定 + 7 条退役 `heartbeat` 行 bounce。

**P3 · H4 → A5（先解前提）**
前提 `pendingCallbackRegistry` 在 `worker>1` 下重复唤醒**本身就是一个 bug**（重复投递 = 重复干活），与 H4 无关也值得单独修。修完它 H4 才有地基。

#### P3 前提的实测结论（2026-11-15 19:5）—— **前提未满足，且是结构级的**

§4.5 写着「仍待补：`pendingCallbackRegistry` 在 `worker>1` 下是否会重复唤醒 —— 实施本项前必须补」。查完了，答案是**会**：

| 事实 | 证据 |
|---|---|
| 回调是**落库**的，不是纯内存 | `api-server.ts:2046` → `pendingCallbackRegistry.setPersistence(storage.pendingCallbackRepo)` |
| 启动时全量读进**进程内 Map** | `pending-callback.ts:101-112`，`setPersistence` 内 `p.loadAll()` |
| 扫描是**纯本地**的，不重新读库 | `agent.ts:8715` `sweepDueWakeups()` 遍历 `getByAgentId(this.id)` |
| 先删后投，但只删**自己的内存 + 库** | `agent.ts:8719` `resolve(cb.id)` → `callbacks.delete` + `persistence.remove` |
| **该表没有认领/租约列** | `pending_callbacks` DDL（`sqlite-storage.ts:762-775`）只有 id/agent_id/…/wake_at/timeout_ms，**无 `claimed_by` / `lease_until`** |
| 对照组：`mailbox_items` **有** | 同文件 `445-446` / `610-611` / 迁移 `894` —— 同一个仓库已经为”多进程只能一个人处理“提供了标准做法 |
| 进程内不会重复 | `sweepDueWakeups` 是同步循环无 `await`，`resolve` 在 `deliverCallback` 之前 |

**结论**：单进程正确，**多进程重复投递**是可能的——两个进程各自 `loadAll()` 拿到同一条 wakeup，各自扫到、各自投递，而库里没有列可以让它们互斥。这不是“可能有问题”，而是“没有任何机制阻止”。

**为什么不能先做 H4 再说**：H4 要让 `rest` 从 60s 轮询改成事件驱动，即**唤醒从「被扫到」变成「被推送到」**。在一条没有租约的队列上把推送接上去，等于把原本低频率（60s 一次）的重复投递变成事件级的重复投递，而且 `observe` 模式下更难察觉。**这不会把一个 bug 变大，它会把一个已经很糟糕的东西放大**。

**修法（小、可验、不迁数据）**：给 `pending_callbacks` 补 `claimed_by` / `lease_until` 两列（照 `mailbox_items` 已有做法），扫之前先「认领」（`UPDATE … SET claimed_by=? WHERE id=? AND (claimed_by IS NULL OR lease_until < now)`），认领成功才投递。两列均 nullable，**旧行不动、照常可读**——与 Owner 的「不迁数据」约束一致。

**需 Owner 确认的一点**：这会给线上库加两列（可空、不改旧行）。你先前说的「不迁数据」，我理解为「不改写旧行」，而不是「不碰表结构」——如果连加列也不在这轮范围，H4/A5 就只能挂着，我不会在无租约的队列上接事件源。

**明确不做**（沿用 §7.1）：`worker>1` 并发正确性整体重构、`data.db` 12.9GB 分表归档、明文凭据治理。

### 0.5.5 需要 Owner 定的三件事

1. **P0 我直接做**（除非你反对）—— 它只让守卫可信，不改任何运行时行为。
2. **P1 DR6 是否现在做**：无阻塞，但要动 34 处 prompt 组装点；建议 P0 之后立刻做。
3. **P2 H7 数据迁移要不要执行**：107 行真实数据、动线上库，我不替你决定。

---

## 1. 判据：什么算「本质」

本仓库自己已经沉淀了四条判据，本方案全部沿用，不新发明：

| 判据 | 出处 | 在本方案里的用法 |
|---|---|---|
| **一个谓词回答几个问题？** 同形状 ⇒ 必有一个是冒名的 | 记忆/前端多次踩坑（传输结束≠回合结束、焦点≠可见性） | DR3（时间戳冒充布尔）、H7（可丢性冒充可产生性）、DR5（一个 70 阈值比两个对象） |
| **一个事实只能有一个写者；不变量只能有一个执行点** | 主计划 §1.3 三条硬规则 | DR3（写者混两类事件）、A3（多份手写类型名单） |
| **先问「这机制真需要存在吗」，优先删机制而不是加守卫** | ROLE 工程信念 §2 | H7（删类型而非加豁免）、A3（7 张表判删） |
| **补丁失败的判据：同一个 bug 换个记号能不能再犯** | ROLE 工程信念 §1 | 每一项的 §「为什么现有补丁无效」都是用这条判的 |

### 1.1 为什么这一类病上「打补丁」必然失败

有一个可复用的推论，本方案反复用到：

> **凡是「声明 X」与「执行 X」写在两处的地方，加守卫只能延缓分叉，不能消除分叉。
> 消除分叉的唯一办法是让其中一处**无法独立存在**（类型上不可达、或结构上必须成对出现）。**

证据：这 9 项里已有 3 项被修过，全部是加守卫：
- DR5 修过三轮（H1 把「整文件」改成「curated 区」、H14 把触发器扣到预算上、H19 归档）；
- DR3 修过一次（2026-10-15 重启重复）；
- H7 的生产者已关（C8-C），消费者原地保留。

三轮修完，DR5 的读数是 **111% 且不触发动作** —— 因为三轮都在改「比哪个数」，没改「这个数有没有消费者」。

---

## 2. 总根因：声明被执行点遗弃

### 2.1 定义

系统里每一条约束都存在两种半条命：

- **声明**（declaration）：一个常量、一个策略位、一个类型字段、一个配置项、一张表、一个入参。
- **见证者**（witness）：一个真实消费它的动作 —— 触发器、执行点、写者、读者、UI。

健康的系统里，任意一条声明都能回答「谁在消费我」。本平台的现状是：大量声明**没有见证者，也没有人发现它没有**。

### 2.2 同一根因的七个实例（全部有代码证据）

| 声明 | 见证者 | 现状 |
|---|---|---|
| `MEMORY_MD_CURATED_MAX_CHARS = 15000`（注入上限） | 应该有一个「超了就整理」的触发器 | **零个动作消费者**，只有 2 个展示字段 + 2 处 log（§3.1） |
| `lastConsolidatedAt`（整理时间戳） | 应该是「dream 已跑过本窗口」 | 写者混了两种事件（dream + organize），且在成功**之前**武装（§3.2） |
| `triageStaleDrop: true`（heartbeat 可丢） | 应该有当前通道会产生的该类型 | **生产者已关**，策略位仍在，靠 6 处文本特判维持（§3.3） |
| `TriggerEvent`（可等待的事件） | 应该有事件源 | 注释自承「Today the only source is the mailbox」，于是 `rest` 靠 1 分钟轮询扫表冒充（§3.4） |
| `AgentConfig`（agent 的一切属性） | 应该有「我负责什么」 | 有 id/role/orgId/teamId/skills/llmConfig/channels，**没有工作任务、没有自主档位**（§3.5） |
| `scenario`（我是谁、我该有哪些工具） | 应该是执行主体的属性 | 由调用方每次显式声明，`agent.ts` 内 34 处、7 个文件（§3.6） |
| 24 张表（机制对象） | 应该有写者且可达 | 10 张 0 行；其中 7 张**判删**（无写者/写者不可达/支线没合进来）（§3.7） |

### 2.3 判据的落地形态

> **给每条声明配一个机器可校验的见证者；没有见证者的声明在 CI 期变红。**

这不是加一层文档，而是把「声明 ↔ 消费点」写成一张表，让编译器和 CI 分别守两半：
- **类型层**：`Record<声明Key, …>` 的完整性检查（漏改即 TS 错误）；
- **CI 层**：`scripts/declaration-witness.mjs`（新写）对每条声明断言「至少一个消费者，且消费者引用的常量/类型存在」（详见 §4.1）。

---

## 3. 逐项调研

### 3.1 DR5 —— 注入段 111% 超预算却不触发整理

#### 现象（可复现）

```
$ cd ~/.markus/agents/agt_b56cd6208342f8502d7bdd4d
$ wc -m knowledge.md           # 16673  ← 横幅里的那个数
$ grep -c '_observations' knowledge.md   # 0，文件里没有观察区 → curated == 整个文件

# 用真实注入器实测「这一轮真正进 prompt 的字符数」
prepareKnowledgeForPrompt(raw, 6000) → 6691 chars, truncated=true
prepareKnowledgeForPrompt(raw, 4800) → 5542 chars, truncated=true
```

**同一时刻三个数字**：横幅说 `16673 / 15000 = 111%`；真实注入 **6691**（按 15000 算是 45%）；
dream 触发器真正看的那个量是 **76%**（observations 22804/30000，**已过 70% 阈值**）。

#### 代码事实

- 度量：`packages/core/src/memory/store.ts:577-592` `getMemoryHealth()`
  ```ts
  const { curated } = splitKnowledgeSections(content);
  const curatedChars = curated.length;
  return {
    curatedChars, curatedCap: MEMORY_MD_CURATED_MAX_CHARS,     // 15000
    percent: Math.round((curatedChars / MEMORY_MD_CURATED_MAX_CHARS) * 100),
    observationChars, observationCap: MEMORY_OBSERVATIONS_MAX_CHARS,  // 30000
    observationPercent: Math.round((observationChars / MEMORY_OBSERVATIONS_MAX_CHARS) * 100),
  };
  ```
- 常量：`packages/shared/src/limits.ts:237` `15000`；`:264` `MEMORY_HEALTH_WARN_PERCENT = 70`；`:281` `MEMORY_DREAM_TRIGGER_PERCENT = MEMORY_HEALTH_WARN_PERCENT`。
- 三处消费者（全仓仅此三处）：
  | 位置 | 比什么 | 后果 |
  |---|---|---|
  | `context-engine.ts:1079` | `percent >= 70`（curated/15000） | 只出横幅 |
  | `context-engine.ts:1100` | `observationPercent >= 70` | 只出横幅 |
  | `dream-trigger.ts:87` | `observationPercent >= 70` | **唯一产生动作的谓词** |
- `DreamTriggerInput`（`dream-trigger.ts:58-75`）**没有 curated 字段** —— 注入段压力在**类型上无法表达**，所以它永远不可能成为触发条件。
- 横幅文案（`context-engine.ts:1086-1087`）承诺：「**已超预算 N 字符**——最大段落的正文**正被无损归档**」。而 `archiveSection`（`store.ts:636`）在生产代码里**零调用**（H19 注释自承 "no production caller"）。**这是一句现在时语态的假陈述。**
- 上限本身对不上：注入上限是 `min(SYSTEM_KNOWLEDGE_CHARS = 8000, knowledgeTokCap * 4)`（`context-engine.ts:1071`），三种场景分别是 `6000 / 4800 / 0`（`limits.ts:1000/1005/1007`）。**15000 在结构上永远不可能是注入上限。**
- 文档自相矛盾：`docs/architecture/memory-system.md:198` 说 curated 软预算 15000 是 **report-only**，`:206` 说 15000 chars 会 **injected**；`docs/records/platform-hardening-2026-10.md:43` 说会被 `SYSTEM_KNOWLEDGE_CHARS`（8000）切片注入。三句话在同一仓库存活。

#### 本质

**三层错位，叠在一条没有执行点的上限上：**

1. **度量对象错位**：`percent` 量的是「磁盘上一个文本区有多大」，不是「这一轮注入了多少字符」。两者在这台机器上差 2.5 倍（16673 vs 6691）。
2. **一个谓词回答了两个问题**：`>= 70` 同时被用来问「注入段压力大吗」和「观察缓冲压力大吗」，动作只挂在后者。而 `MEMORY_DREAM_TRIGGER_PERCENT === MEMORY_HEALTH_WARN_PERCENT` 这句「同源」承诺，只保证**数字相等**，不保证**被比的对象相同**。
3. **上限没有见证者**：`MEMORY_MD_CURATED_MAX_CHARS` 的全部消费者是 2 个展示字段 + 2 处 log —— 零个动作消费者。它是一条**只报告、不执行**的上限，而横幅用的是「正在自动处理」的语态。

#### 为什么现有补丁无效

三轮补丁各自修对了一半，且互相抵消：

| 轮次 | 改了什么 | 为什么不够 |
|---|---|---|
| H1 | 「整文件」→「curated 区」 | 方向对，但仍量**区域**。本机没有 `## _observations` 段（观察已迁 JSON），`curated === 整个文件`，H1 在这里**退化为零** |
| H14 | 把触发器扣到「预算」上 | 选的预算是 **observations** 的，不是注入的 |
| H19 | 归档能力 | `archiveSection` 至今零生产调用，横幅却已经是现在时 |

**测试用「数字相等」冒充「对象同源」**：`packages/core/test/memory-budget-invariants.test.ts:331` 只断言
`expect(MEMORY_DREAM_TRIGGER_PERCENT).toBe(MEMORY_HEALTH_WARN_PERCENT)`，**没有任何测试把「横幅的输入」喂给「触发器的输入」**——因为类型里没有那个入口，想写也写不出来。

#### 重构方案

见 §4.2。核心动作：**让报数的人就是产数的人**，并删掉那个与执行点无关的影子上限。

---

### 3.2 DR3 —— 两个守卫并存、重启行为不对称

#### 现象

```jsonc
// ~/.markus/agents/<id>/memory-meta.json
{ "lastConsolidatedAt": "2026-11-15T03:33:50.026Z" }   // 只有一个裸时间戳，没有「是什么事件」
```
volatile 侧：`agent.ts:10884` `private lastDreamDate = ''`（进程内，不落盘）。
今天 03:33 已 dream 过一次 ⇒ 当天后续所有 tick 全部 `ran:false`，**尽管 observationPercent 已 76%**（受压）。

#### 代码事实

| | durable | volatile |
|---|---|---|
| 定义 | `memory-meta.json#lastConsolidatedAt`（`store.ts:601-610` 读） | `agent.ts:10884` `lastDreamDate` |
| 写者 | `markConsolidated()`（`store.ts:613-625`），**两个调用点**：`agent.ts:10935`（dream 后）、`tools/memory.ts:596`（`memory_organize` 后） | `agent.ts:10917`，**一个调用点**，在 dream **执行之前** |
| 读者 | `dream-trigger.ts:94-97`、`context-engine.ts:1076`、`tools/memory.ts:490` | 仅 `dream-trigger.ts:93` |
| 回答什么 | 「任意一次**记忆整理**发生在什么时候」 | 「本进程为哪个窗口跑过 dream」 |

```ts
// agent.ts:10911-10917
if (shouldRunDreamCycle({
      observationPercent: health.observationPercent,
      entryCount: entries.length,
      now,
      lastConsolidatedAt: this.memory.getLastConsolidatedAt?.() ?? null,
      lastInMemoryWindowKey: this.lastDreamDate,
    })) {
  this.lastDreamDate = windowKey;      // ← 在 dream 执行之前就武装
```

#### 三条可实际发生的矛盾

1. **手动整理吞掉当天 dream**：09:00 agent 按横幅建议跑 `memory_organize` → 写 `lastConsolidatedAt=09:00`；10:00 tick，observationPercent=76 受压、当日窗口键 `2026-11-15`、volatile 仍空 → durable 命中同窗口 ⇒ `return false`。**当天 dream 永不运行。** 守卫问的是「dream 跑过吗」，字段答的是「有人整理过吗」。
2. **重启后的不对称**（2026-10-15 那个 bug 的镜像）：dream 在 03:00 抛错 → `lastDreamDate` 已等于窗口键（10917 先执行）、`markConsolidated()` 从未到达 ⇒ **本进程今天不重试；重启后立刻重试**。同一个问题两个答案，取决于进程活了多久。
3. **durable 写入失败被吞**：`store.ts:622-624` 只 `log.warn` ⇒ 重启重复 dream 的原始 bug 静默复活，无任何信号。

另有一处不对称：**窗口键推导方式**——volatile 的键是运行时**记录值**，durable 的键每次用**当前** `entryCount` 重新推导（`dream-trigger.ts:95`）。同一个事实有两条推导路径。

#### 本质

**一个 durable 字段被当成两个问题的答案，volatile 字段只是为绕开「多读一次文件」而存在的影子。**

判据：守卫的输入必须 ① 由**它问的那个事件**写入；② 在该事件**成功之后**写入；③ 落盘的应是**当时算出的键**而不是事后回推。当前三条中违反了两条。

所以 2026-10-15 的补丁只解决了「守卫读易失来源」这一个症状，**单一事实源仍未成立**。这不是「两个守卫并存」，是**一个事件时间戳被当作一个布尔用，再加一个进程内缓存副本**。

#### 为什么现有补丁无效

`packages/core/test/dream-guard-durable.test.ts:52` 把 durable 语义钉死在「它一定代表 dream」；
更关键的是 `packages/core/test/dream-single-trigger.test.ts:97`：
```ts
internals.memory.getLastConsolidatedAt = () => null;
internals.memory.markConsolidated = () => {};
```
**测试把 durable 守卫和 `markConsolidated` 一起 stub 掉**，于是「organize 写的时间戳会不会抑制 dream」这条路在测试里**不可见**。补丁把守卫接上了，同时把「写入者是谁」这个维度从测试视野里删掉了。**修复方向对，验证口径错。**

---

### 3.3 H7 —— heartbeat 已不产生，策略位还在

#### 现象（真实库）

```
source_type=heartbeat: completed 165,610 | dropped 3,615 | processing 1 | queued 6
max(queued_at) = 2026-11-14T09:58:40Z   ← 恰好停在 C8-C 切换点，此后 0 行
```
生产侧确实停了（169,233 行历史，小时级节奏戛然而止）；残留 7 条孤儿行全部是 **2026-04-11 / 05-03** 的休眠 agent。
注册表仍写着 `triageStaleDrop: true`（`packages/shared/src/types/mailbox.ts:189`）。

#### 代码事实

**唯一两个运行时消费者**：
- `core/src/mailbox.ts:739`（重启恢复时选 TTL：4h vs 3天）
- `core/src/mailbox.ts:2262` `purgeStaleItems`（由 `attention.ts:675` 在每轮 triage 前调用）

**生产者已关，消费者没关**（与 dream 的处理**不对称**）：
```ts
// agent.ts:1374-1390
if (mode === 'legacy') { this.mailbox.enqueue('heartbeat', {...}); return; }
// C8-C: a tick is a liveness beat, not a message. Run the patrol directly —
this.runHeartbeatPatrol(triggeredAt);
```
对照：`case 'memory_consolidation'`（`agent.ts:3327-3334`）**有 mode gate**（"clock mode owns the dream trigger"），而 `case 'heartbeat'`（`agent.ts:3287`）**没有 gate**，直接 `handleHeartbeat(...)`。

**没有结构性豁免**：`routeMailboxItem` 是 `sourceType → 静态 policy` 的纯函数（`types/mailbox.ts:290-305`），**看不见「当前通道模式」这一维**；`purgeStaleItems` 同样无 mode 参数。所谓「豁免」是散落各处的 **6 处 `sourceType === 'heartbeat'` 文本特判**。

#### 本质

**一张按「类型」建键的策略表，被要求回答「这个类型在当前通道下是否可能到达」——而表里没有那一维。**

`triageStaleDrop` 声称回答「该类型陈旧时可否丢弃」，但对 clock 模式下的 heartbeat 而言，**该类型的总体为空**，这个布尔没有任何可能成立的指称。真实事实「heartbeat 只在回滚通道产生」住在 `heartbeatTimerMode()`（`agent.ts:224`）里，与注册表**互不知情** —— 于是「某类型是否可丢」有两个写者（注册表 + 模式函数），今天一致、明天分叉。

#### 为什么现有补丁无效

```ts
// packages/core/test/mailbox-batch-and-purge.test.ts:134-136
expect(TRIAGE_STALE_DROP_TYPES).not.toContain('memory_consolidation');
// 对照组：信息噪音仍在名单里 —— 否则「dream 不在」可能只是名单整体空了。
expect(TRIAGE_STALE_DROP_TYPES).toContain('heartbeat');
```
**测试在字面上要求这个已死的条目保持为真**，理由只是「需要一个对照组」。想删这个 flag 的人会先撞到这条测试。此外 `limits.ts:550-552` 的 docstring 仍把 `memory_consolidation` 列为可丢，与其下方 `:565-573` 自相矛盾。

#### 附带发现（同类，更严重）

`routeMailboxItem` 对「不在注册表里的类型」走 `UNKNOWN_ROUTE`（`types/mailbox.ts:275-286`，`triageStaleDrop:false`）。**库里已经有两个这样的类型活着**：`task_assignment`(106 行)、`a2a`(1 行)。它们按「跑，别丢」处理——这是「注册表是唯一事实源」的反例，且无人知道。

---

### 3.4 H4 / A1 / A4 —— 主动性：`rest` 已落，但事件驱动没有事件源

#### 现象

`rest` / `list_waits` / `cancel_wait` 三个工具存在（`packages/core/src/tools/trigger.ts`，4.9KB），
`TriggerRegistry` 也落地了（`packages/core/src/trigger.ts`，6.1KB，含 `WakeCondition`、`TriggerEvent`、
`Subscription`、`SubscribeInput`、`SUBSCRIPTION_DEFAULT_TTL_MS = 6h`、`matchesWakeCondition`）。
但：

- `TriggerRegistry` **全仓只在 `agent.ts:1076` 被 new 一次**，没有任何地方向它 `emit` 真实事件；
- `rest` 声明的等待，靠的是 `agent.ts:8690-8697` 的 `clock.register({ name: 'wakeup-sweep', everyMs: WAKEUP_SWEEP_INTERVAL_MS })` ——
  注释自承「Runs on a coarse **~1-minute sweep**」；
- `TriggerEvent` 的类型注释是一句自白：
  > `/** An event the registry can be matched against. **Today the only source is the mailbox.** */`

#### 代码事实（调用链）

```
rest(wakeOn)  →  tools/trigger.ts:43   写 Subscription（落 pendingCallbackRegistry）
              →  agent.ts:8705 sweepDueWakeups()   ← 每 ~60s 时钟 tick 扫一遍
              →  pendingCallbackRegistry.getByAgentId() 过滤 type==='wakeup' && wakeAt <= now
              →  deliverCallback(...) 走 mailbox 投递
```

也就是说：**「等待一个事件」实现成了「每 60 秒问一次表」**。`observe`（观察但不行动）轴在工具面里
**完全不存在** —— `rest` 只有「等某事件叫醒我」和「超时」两种出口，没有第三种「我看到了但我不动」。

#### 本质

**`TriggerEvent` 声明了「可被匹配的事件」这个抽象，但没有事件源为它供给。**
抽象存在、类型存在、注册表存在，唯独**没有人往里推事件**。于是系统用轮询把「没有事件源」这件事掩盖起来——
一个语义问题（事件驱动）用调度问题（轮询频率）回答了。

这与 §2 的总根因是同一形态：`TriggerEvent` 是一条**没有见证者的声明**（它是被消费的，但没有生产者）。
区别只在于：这次的见证者缺的是**写端**而不是读端。

#### 为什么现有补丁无效

C8-D 的卡叫「工具可达性：行动类工具恒在」，它保证的是**工具在工具面里存在**（模型能看见 `rest`）。
但「工具能看见」与「机制成立」是两件事：测试锁的是前者（工具在清单里），没有一条测试要求
「`rest` 声明后，一个真实事件到达时必须在 **1 个 tick 内** 而非 60 秒内唤醒」。
用「工具可见性」冒充「机制有效性」，是这条补丁的失效点。

#### 已取证（原先列为待补，已补齐）

1. `WAKEUP_SWEEP_INTERVAL_MS = 60_000`（`agent.ts:1084`）—— **确认 60 秒**，不是 45/90。
2. `observe` 的原始语义（主计划 §4.3 line 688）：**`observe / act` 一条权限轴**；
   四档自主度是产品语义、**留到 Owner 单独拍板，不混进本轮**（§7.8）。
   → 所以本方案的 A5（自主档位）**不能自作四档**，只能先落 `observe | act` 二值，与 §4.5 共用词汇。
3. 仍未知（**只阻断阶段 2 实施，不阻断阶段 0/1**）：`pendingCallbackRegistry` 在 `worker > 1`
   下是否会重复唤醒（并发正确性）。实施 §4.5 前必须补。

---

### 3.5 A2 / A5 —— agent 不知道自己负责什么，也没有自主档位

#### 现象与代码事实

`AgentConfig` 的完整字段（`packages/shared/src/types/agent.ts:3-19`）：

```ts
export interface AgentConfig {
  id; name; roleId; orgId; teamId?;
  agentRole: 'manager' | 'worker';
  skills: string[];
  profile?: AgentProfile;
  concurrent?: AgentConcurrentConfig;
  llmConfig: LLMAssignment;
  channels: ChannelBinding[];
  heartbeatIntervalMs; createdAt; updatedAt;
}
```

**它声明了 agent 的一切属性，唯独没有「它要去做什么」。** 没有 `assignedTasks`、没有 `ownedRequirements`、
没有 `autonomyLevel`。真正的归属住在 `tasks.assigned_agent_id`（注意：**不是** `assignee_id`）和
team 关系中，分散在另外几张表里，且**没有任何字段把「我负责什么」推到 agent 自己的 prompt 里**。

#### 本质

**执行主体缺少主语。** 于是一个 agent 要「知道自己在干什么」，只能靠每轮被投喂 mailbox item
（外部告诉它），或者靠读 task board（自己去找）。这两条都不是它的**属性**，而是**每次现查的外部事实**。

这与 §3.6 的 `scenario` 由调用方声明是**同一根因的两端**：
- 缺主语 ⇒ 谁都能替我声明「你是谁、你该有哪些工具」（DR6）；
- 缺档位 ⇒ 没有地方声明「你能自主到什么程度」（A5）。

#### 为什么现有补丁无效

主计划 §4.3 设计了 Trigger / Subscription / rest(wakeOn)，但那是**唤醒机制**，不是**身份机制**。
`rest` 解决「我在等什么」，A2/A5 要解决「我是谁、我能自己决定到哪一步」。
用唤醒机制去补主语缺失，是层次错位（L1 治理问题用 L3 执行手段回答）。

---

### 3.6 DR6 —— `scenario` 由调用方自选

#### 现象（计数）

```
agent.ts 内显式 `scenario:` 传参   34 处
涉及文件（packages/*/src）         7 个：agent.ts / agent-manager.ts / context-engine.ts /
                                      capability-packs.ts / distillation.ts /
                                      org-manager/api-server.ts / org-manager/task-service.ts
```

#### 本质

`scenario` 决定了：能力包选择（`capability-packs.ts#pack()`）、prompt profile、工具面预算与淘汰。
也就是说 —— **「我是谁、我该有哪些工具」这件事，每次由调用方用字面量声明一遍。**

这与 §2 的表里那行完全对应：`scenario` 是「执行主体的属性」，却实现成了「调用方的入参」。
当有 34 个调用点时，其中任何一个传错都**不会报错**（类型上 `scenario` 是合法枚举值），
只会表现成「这个回合的工具面和它该有的不一样」——一个静默的、无法从日志看出的偏差。

计划 §5.1 纪律 3「先改机制，再接入口」在这里正好被违反：入口（34 个调用点）先接了，
机制（scenario 该由谁决定）还没定。

#### 方向（详细方案见 §4.7）

`scenario` 应当从**信号源派生**——mailbox item 的类型、或者触发这次回合的实体类别，本来就是已知的。
`MailboxItem.sourceType → scenario` 是一个纯函数映射，不需要调用方再声明一次。
`allowedTools` 同理：它应该是 `scenario` 的函数，而不是一个独立入参。

#### 已取证（原先列为待补，已补齐）

1. **两种都有**（抽样 6 处）：上游透传 —— `agent.ts:1870` `scenario: options?.scenario`；
   调用点自造 —— `agent.ts:2899` `scenario: 'a2a' as const`、`:3101` `'requirement_action'`、
   `:3123` `'comment_response'`、`:3085` `buildHandleOpts({ scenario: 'a2a' })`。
2. `allowedTools` 在 `packages/core/src` 内出现 **42 处**，传入点包括
   `agent.ts:1867`（`options?.allowedTools`）、`:3102`（`REQUIREMENT_ACTION_ALLOWED_TOOLS`）、
   `:3124`（`COMMENT_RESPONSE_ALLOWED_TOOLS`）、`tools/subagent.ts:740/893`。
3. **存在「调用方声明/铸造」的真实迹象**：`agent.ts:2767` 的现有注释自承
   "`scenario:` default, so an unvalidated cast here silently becomes the …" ——
   **已经有人意识到 cast 会静默变成 scenario**。这意味着 §4.7 的风险等级是**高**：
   先要收掉这些 cast，再改成派生，否则会把一个已存在的偏差固化成映射规则。

---

### 3.7 A3 —— 墓碑群：建了对象没流量

#### 结论先行：计划里对 A3 的指代是错的

主计划 A3 写「外部入口墓碑群：表还在，流量未起」——容易读成 `resource_bindings` / `event_sources` / `channels`。
**实测：这三张表在实库里不存在、在 C8 代码里一处都没有**（`git grep` 空）。它们只活在**未合并支线**
`feat/thread-trigger-router` 上（DDL + 写者 + 读者齐全，2026-11-06）。这属于另一类病：**整条支线墓碑**——
机制在分支上完整、主干上空白。

**真正的 A3 成员**（实库 25 行、6 个月零写入、来自从未合并的 `feat/customer-facing-agent-design` / `0978ba22`）：

| 表 | 行数 | 最后写入 |
|---|---|---|
| `external_services` | 2 | 2026-05-09 |
| `external_sessions` | 4 | 2026-05-09/10 |
| `external_messages` | 19 | 2026-05-09/10 |
| `external_service_stats` | 0 | — |
| `external_agent_registrations` | 0 | — |
| `share_tokens` | 2 | 2026-05-09/10 |

#### 判据：墓碑 = 建了对象没流量。怎么量？

**先立一把尺子**（本仓库自己的对照实验）：`mailbox_items.work_unit_ref` 的每日覆盖率

| 日期 | mailbox 行数 | `work_unit_ref` 非空 | 覆盖率 |
|---|---|---|---|
| 2026-11-12 | 157 | 0 | 0% |
| 2026-11-13 | 217 | 0 | 0% |
| 2026-11-14 | 230 | 122 | 53%（C7 当天切流） |
| 2026-11-15 | 114 | 114 | **100%** |

→ **真接线的对象在当日流量上必须是 100%**，不是「有个写者就算活」。下面全部用这把尺子。

#### 三类结论

**判删（7 张 + 3 张资料残留）**

| 表 | 依据 |
|---|---|
| `messages`（0 行） | 已被 `channel_messages`(8,461) + `chat_messages`(15,429) 完全替代；`messageRepo` 在 `storage-bridge.ts:251` 是 `as any` 赋值且**全仓无读取点** —— 死写者的化石 |
| `memories` / `memory_embeddings`（均 0 行） | C8 连 `SqliteMemoryRepo` 类都不存在了；记忆已迁到 `knowledge.md` + `facts`(18 行，写者可达)。**概念搬走了，DDL 没搬** |
| `iterations`（0 行） | commit `1311e646` 明确 "remove iteration concept"；C8 无 DDL、无读写 |
| `agent_knowledge`（0 行）+ `marketplace_templates`(2) / `skills`(1) / `ratings`(0) | 4 个 repo 类**从未被 new**（只被 `storage/index.ts` 再导出）。按 §5.1：这不是「缺入口」，是**根本没机制** |
| `gateway_message_queue`（0 行） | 最纯的墓碑：DDL + 索引，**零 SQL、零 repo、零调用**。现役 A2A 走 `mailbox_items` + agent-delivery，不需要第二套队列 |
| `external_*` 五件套 + `share_tokens`（25 行） | 出自未合并分支，`merge-base --is-ancestor` 对 main / C8 均为 **NO**。**这不是「流量未起」，是「支线没合进来」**。`share_tokens` 的语义替代物已存在（`deliverables.hub_share_*` 五列，9,368 行在用） |
| `lost_and_found`(27,026) / `chat_messages_endturn_leak_20261007`(9) | 运维残留：前者是 `sqlite .recover` 产物，后者是一次事故的临时快照。非业务表 |

**判「接线」——机制必要但写者位置错（1 张，这是最有价值的一条）**

`workflow_schedules`（0 行）：机制必要（跨重启记住计划），写者存在且可达，**但调用点放错了**：
`refreshScheduleStates()` 只写内存 `scheduleStates.set()`；`persistState()` 仅在 `tick()`（max_runs 暂停）
与 `triggerScheduledRun()`（计划运行**成功后**）才被调。
→ **持久化被门控在它所记录的事件之后**：该表无法记住「第一次运行之前」的计划，重启即丢。
印证：`workflow_runs` 5 行**全部 `triggered_by='manual'`**，schedule 触发 **0 次**。

这与 §2 的总根因完全同构：声明（表）与见证者（写者）都在，但写者**被放在事件之后**，等于永远等不到第一次。

**判「保留但标注」（2 组）**

- `external_agent_registrations`：唯一「门真开着」的（`markus start` 无条件 `gateway.setStore()`），需外部 agent 走 HTTP 注册。0 行是**市场问题不是代码问题**。标注移除条件：若 2 个发布周期仍 0 行，随 external 支线一并删。
- `integrations`(1) / `platform_instances`(3) / `pending_callbacks`(1) / `channel_bindings`(1)：都有活写者活读者，行数少是「用户只配了 1–3 个平台」的正常低频。但 `channel_bindings` 要单独注意：唯一 1 行是迁移写的 `scope='global'`，**`scope='channel'`=0、`scope='address'`=0**（36 天），且该表已因「建了路由没建写者」修过一次（`repo-binding-lookup.ts` 注释自承 "A route with no writer is not a route"）。

#### 安全发现（顺带，但必须报）

查 `platform_instances` / `integrations` 时发现：Feishu `appSecret`、Telegram `botToken` **明文存本地库**，
且 `.bak` 备份若干份同样明文。这是独立的安全问题，不在本方案范围内，但建议单独立项。

---

## 4. 重构方案

### 4.1 结构性修复：见证者表（先做这一层，否则各项修完又是一批新声明）

**这是唯一一条「不针对任何单项、但决定其余七项能否长期成立」的动作。**

新增 `packages/shared/src/declarations.ts`，把平台里所有「声明」登记成一条记录，每条必填见证者：

```ts
export interface Declaration {
  key: string;                      // 'memory.curatedBudget' | 'mailbox.triageStaleDrop' | ...
  kind: 'limit' | 'policy' | 'guard' | 'object' | 'param';
  witness:
    | { type: 'trigger'; at: string }      // 有动作消费者
    | { type: 'writer';  at: string }      // 有写者（对象类声明）
    | { type: 'reader';  at: string }       // 只被读（纯展示）
    | { type: 'none';    reason: string; removeBy?: string };  // 显式承认没有见证者
  onExceed?: 'act' | 'report';      // 仅 limit 类：超了会怎样
}
```

**两条不变量，分别由类型和 CI 守：**

| 层 | 断言 | 违反后果 |
|---|---|---|
| 类型层 | `DECLARATIONS` 是 `Record<DeclarationKey, Declaration>`，新增常量必须登记 | 漏登 → `tsc` 报错 |
| CI 层 | 新增 `scripts/declaration-witness.mjs`：① 每条 `witness.type !== 'none'` 的 `at` 必须能在源码里 grep 到；② `kind === 'limit' && onExceed === 'act'` ⇒ 该 limit 的常量必须在某个 `dream-trigger`/`attention`/`throttle` 类判定里出现；③ `onExceed === 'report'` ⇒ 文案不得含「正被 / 自动 / 已归档」这类现在时承诺 | CI 变红 |

> **为什么这一层必须先做**：§1.1 的推论说「加守卫只能延缓分叉」。但如果**守卫本身是一条登记的声明**，
> 它自己也有见证者（CI 脚本），就不再是无主守卫。**这是把「靠人记住」换成「靠结构记住」的唯一落地方式。**

**成本估计**：`declarations.ts` 约 150 行；CI 脚本约 120 行；登记现有声明约 40 条。**一天量级**。

---

### 4.2 DR5 方案 —— 让报数的人就是产数的人

**目标结构**：把「注入段预算」的定义从「磁盘区域大小」改成「本轮注入载荷」。

1. **注入器返回自己的度量**
   ```ts
   prepareKnowledgeForPrompt(): { text, inlinedChars, omittedTitles }
   ```
   `ContextEngine` 把 `inlinedChars` 回写：`store.recordInjectedKnowledge(inlinedChars, omittedTitles.length)`（本轮测量，不重算）。

2. **字段改名 + 换分母**
   `percent` → `injectionUsedPercent`，分母改用**注入上限本身**（`knowledgeCapChars`），
   而不是第二个常量。`MEMORY_MD_CURATED_MAX_CHARS = 15000` **删除或改为派生**
   （`= KNOWLEDGE_PROMPT_MAX_TOKENS * 4`），因为它现在是一个与执行点无关的影子上限。

3. **删掉假陈述**
   `context-engine.ts:1086-1087` 的「正被无损归档」必须删（`archiveSection` 零生产调用）。
   改为报告**被挤出 prompt 的段数**（`omittedTitles.length`）——这个数既可执行（合并段落能立刻降它），
   又不会因文件多大而说谎。

4. **登记到 §4.1 的见证者表**
   - `memory.injectionBudget` → `{ type: 'trigger', at: 'dream-trigger' }`，`onExceed: 'act'`
   - `memory.observationCap` → `{ type: 'trigger', at: 'dream-trigger' }`，`onExceed: 'act'`
   - `memory.curatedRegionSize` → `{ type: 'none', reason: '区域大小已被注入器限住，不是成本' }`，**删**

**让逆例变红**（当前实现必挂）：
```ts
it('横幅报的数 = 本轮注入的字符数（同一个度量对象）', () => {
  const injected = prepareKnowledgeForPrompt(knowledge(16_000), capFor('execute')).text;
  const h = store.getMemoryHealth();
  expect(h.injectedChars).toBe(injected.length);           // 区域口径无法满足
  expect(h.injectionUsedPercent).toBeLessThanOrEqual(120);
});
it('report 类声明的文案不得承诺自动动作', () => {
  for (const d of Object.values(DECLARATIONS)) {
    if (d.onExceed === 'report') expect(bannerFor(d.key)).not.toMatch(/正被|自动归档/);
  }
});
```

**迁移风险（必须说清）**：上线当天这台机器的读数会从 111% **掉到约 45%**，横幅熄灭。对
「区域很大但注入被限住」的 agent 是正向纠偏；但会**静默取消**那些「区域刚过 15000」的告警，
因此**必须同时上线 `omittedTitles` 信号**，否则等于把警报换成沉默。
`MEMORY_MD_CURATED_HARD_MAX_CHARS`（45000 写拒绝）不受影响，保留。

---

### 4.3 DR3 方案 —— 落盘「哪一次事件、哪个窗口」，而不是裸时刻

```jsonc
// memory-meta.json（新）
{ "dream":     { "at": "2026-11-15T03:33:50Z", "windowKey": "2026-11-15" },
  "organized": { "at": "2026-11-15T09:00:00Z" } }
```

- **删**：`agent.ts:10884 lastDreamDate`（volatile 影子）；`markConsolidated()` 这个含义模糊的单一写入口；`dreamWindowKey` 对 durable 时间戳的**重算**路径（`dream-trigger.ts:95`）。
- **加四条不变量**：
  1. **事件类型化**：`recordDream(windowKey)` / `recordOrganize()` 两个写者，各写各的字段；守卫只读 `dream`。
  2. **成功后武装**：`lastDreamDate = windowKey` 移到 `dreamConsolidateMemory` **成功返回之后**；失败必须留下「未运动」状态。
  3. **键即事实**：落盘的是写者当时算出的 `windowKey` 字符串，守卫做纯字符串比较，**不再重新推导**。
  4. **写入必须可见**：durable 写失败时本次 dream 记 `ran:false` 并上报，而不是「跑了但没记住」。

**让逆例变红**：
```ts
it('手动 organize 不得满足 dream 的窗口守卫', () => {
  store.recordOrganize();
  expect(shouldRunDreamCycle({ ...OVER, now, dream: store.getDreamRecord() })).toBe(true); // 今天必挂
});
it('dream 抛错 ⇒ 同进程内下一 tick 可重试', async () => {
  const r = await agent.consolidateMemory({ forceRun: () => { throw new Error('boom'); } });
  expect(r.ran).toBe(false);
  // 当前被 lastDreamDate 挡住，无法重试
});
it('重启后同窗口不重跑（回归保留）', () => { /* 现有用例保留 */ });
```
**并且必须删掉 `dream-single-trigger.test.ts:97` 的 `markConsolidated = () => {}` stub** —— 正是它让这条路径在测试里不可见。

**迁移**：现存 `memory-meta.json` 只有裸时间戳。按 `kind='dream'` 兼容（保守，保住去重），
写一次性迁移 marker。`context-engine.ts:1076` 的「上次整理 N 天前」改读 `max(dream, organized)`，
以保持 `api-server.ts:6491` 已暴露的 `lastConsolidatedAt` 不断供。

---

### 4.4 H7 方案 —— 把「可产生性」做成与「可丢性」同一张表的两列

```ts
producedBy: readonly ChannelMode[]          // heartbeat → ['legacy']
policy:    { triageStaleDrop: boolean }
```
派生：`producibleIn(mode, t) = registry[t].producedBy.includes(mode)`

**做法（按优先级二选一）**：

- **首选：删类型。** `'heartbeat'` 从 `MailboxItemType` 与 `MAILBOX_TYPE_REGISTRY` 删除（前提：先退役 legacy 回滚通道）。连带删：`PLATFORM_INTERNAL_SOURCES` 字面量、`MAILBOX_CATEGORIES.system` 条目、`deduplicateQueue` 心跳折叠（`mailbox.ts:795-812`）、入队折叠（`1083-1100`）、`_processingHeartbeatId`（`1546/1570`）、`heartbeat.ts:84` filter、`agent.ts:3287` 的 dispatch case。**编译器就是迁移清单**（`Record<MailboxItemType, …>` 完整性检查会把每处漏改变成 TS 错误）。
- **若必须保留 legacy**：不删类型，改为 `producedBy: ['legacy']`，把 `TRIAGE_STALE_DROP_TYPES` 改成 `triageStaleDropTypes(mode)`，clock 模式下集合里没有 heartbeat。

**必须一起做的 DB 迁移**：现存 7 条孤儿行（6 queued + 1 processing）一次性 `bounce(stale_signal, 'type-retired')`。
同时处理**附带发现**：`task_assignment`(106) 与 `a2a`(1) 两个不在注册表的类型正走 `UNKNOWN_ROUTE` 兜底，
必须逐个裁定「补进注册表」或「按退役 bounce」——**不能让兜底继续当第二事实源**。

**让逆例变红**：
```ts
it('不可产生的类型不得携带可丢策略位（否则是化石）', () => {
  for (const [t, d] of Object.entries(MAILBOX_TYPE_REGISTRY))
    if (!producibleIn(activeMode(), t))
      expect(d.policy.triageStaleDrop, `${t} 在 ${activeMode()} 不产生却声明可丢`).toBe(false);
});
it('每个已退役类型在库中无残留行', () => {
  expect(dbCount(['heartbeat', 'task_assignment', 'a2a'])).toBe(0);
});
```
并把 `mailbox-batch-and-purge.test.ts:136` 的对照组从 `toContain('heartbeat')` 改成
**一个确实可产生的噪音类型**（如 `task_status_update`）——不要用死条目当对照物。

---

### 4.5 H4 / A1 / A4 方案 —— 让事件驱动有事件源，而不是把轮询调快

**核心判断：不要先做 `observe`。先解决「`TriggerEvent` 没有生产者」。**

1. **`TriggerRegistry` 接上唯一事件源**：mailbox 入队（`mailbox.ts` 的 enqueue 成功处）与
   `WorkUnit` 状态转移（`status_transitions` 写入处）是两个天然事件源。`emit(event)` 必须在这两处各调一次，
   并由 §4.1 登记 `trigger.eventSource` 的见证者。
2. **`rest` 不再依赖 sweep**：`Subscription` 命中时由 `emit` 直接 `deliverCallback`；
   `wakeup-sweep` 降级为**只处理超时**（`SUBSCRIPTION_DEFAULT_TTL_MS` 到期），不再是唤醒的唯一路径。
   验收判据：**事件到达后 1 个 tick 内唤醒**（不是 60 秒）。
3. **`observe` 是第三个出口，不是新机制**：`Subscription` 加 `mode: 'act' | 'observe'`，
   observe 命中时只写一条 observation（不建卡、不发消息、不改内容），
   与 `docs/architecture/mailbox-system.md` 的去向分类对齐。
4. **已知的前提（原先列为待补，已补齐）**：`WAKEUP_SWEEP_INTERVAL_MS = 60_000`（`agent.ts:1084`）；
   `observe` 的语义是主计划 §4.3 的 `observe / act` **一条权限轴**（四档自主度归 Owner 拍板，本轮不混入）。
   **仍待补**：`pendingCallbackRegistry` 在 `worker>1` 下是否会重复唤醒 —— 实施本项前必须补。

**让逆例变红**：
```ts
it('rest 声明后，事件到达必须在 1 个 tick 内唤醒（不是 60s sweep）', async () => {
  await tools.rest({ wakeOn: { kind: 'mailbox-type', type: 'human_chat' }, timeoutMs: 60_000 });
  await mailbox.enqueue('human_chat', {});          // 不等时钟
  expect(delivered).toHaveBeenCalledTimes(1);
});
it('observe 命中的等待不得产生任何投递或建卡', async () => { /* … */ });
```

---

### 4.6 A2 / A5 方案 —— 给执行主体一个主语和一根档位

**A2：把「我负责什么」变成派生视图，而不是新表。**
`AgentConfig` 不新增 `assignedTasks`（那是状态，会与 `tasks.assigned_agent_id` 形成第二写者）。
正确做法：在 prompt 组装处注入一个**纯派生**段 `[MY ASSIGNMENT]`，数据来自现有唯一事实源：

```
我对什么负责（派生，不落盘）：
- 我负责的任务：tasks where assigned_agent_id = me and status not in (闭集)
- 我待裁决的任务：tasks where reviewer_agent_id = me and status = 'review'
- 我等着的回调：pendingCallbackRegistry where agent_id = me
```
派生函数放 `packages/core/src/derive-assignment.ts`（纯函数，无 IO），由 `context-engine` 调。
**判据**：这个段的每一行都必须能指到现有表的一行；任何一行需要「新存一个字段」才能算出来，说明设计错了。

**实施时的一处更正（原文写错了，此处留痕）**：初稿写的第三源是
「我审批的需求：requirements where approved_by in my team and state=pending」——这行按本节的判据
**不成立**：`requirements` 表根本没有 reviewer 列，只有 `created_by` / `approved_by`；而一条
`pending` 需求的 `approved_by` 按定义仍是 NULL。也就是说「待我审批的需求」**没有任何一列可以派生**，
写出来就是一个背后没有表的机制。需求审批在本平台是**人的闸门**（`requirement_propose` → UI Approve）。
因此改为真实存在、且此前完全缺失的一条轴：**待我裁决的任务**（`reviewer_agent_id = me` 且
`status = 'review'`）。它此前不存在不是巧合——任务板的「My Tasks」只按 `assigned_agent_id` 分组，
所以一张「别人做完了、等我签字」的卡在 agent 眼里读起来像别人的活，唯一一句「有人在等你裁决」
从来没有出现过。

**实施后的结构（避免第二派生）**：`deriveAssignment()` 是本段唯一的谓词与正文格式；
任务板的「My Tasks」格子直接**投影** `assignment.assigned`，不再自己 filter/sort/拼字符串
（原来的 `myActive` 与 `deriveAssignment` 是同义第二份，已删）。`[MY ASSIGNMENT]` 段只渲染
`tasks` 板结构上表达不出的两条轴（待裁决、待回调），并显式 `include: { assigned: false }`，
否则同一张卡在 prompt 里出现两次——那正是本节要消灭的浪费。

**A5：自主档位放进 `AgentConfig`，且只影响一个判定点。**
```ts
autonomy: 'observe' | 'act-on-assignment' | 'act-proactively';   // 三档，默认 'act-on-assignment'
```
- 它不是新机制，而是**收口一个已存在的隐式档位**：现在「能不能自己开工」散在 `agentRole`、
  `heartbeatIntervalMs`、以及各个调用点的判断里。
- 唯一消费点：`AttentionController` 的路由判定（`decide()` 对非 assignment 类信号的处置）。
  **一个档位只能有一个消费点**，否则又是第二写者。
- 与 §4.5 的 `observe` 出口共用同一词汇：`autonomy='observe'` ⇒ 所有 Subscription 默认 observe 模式。

**让逆例变红**：
```ts
it('[MY ASSIGNMENT] 的每一行都能回溯到现有表的一行（无新字段）', () => {
  const seg = deriveAssignment(agentId, db);
  for (const line of seg.lines) expect(line.source).toMatch(/^(tasks|requirements|pending_callbacks)$/);
});
it('autonomy 只有一个消费点（新增消费点必须改本测试）', () => {
  expect(grepAll('src', /\\.autonomy\\b/).filter(notIn('types/agent.ts', 'attention.ts'))).toHaveLength(0);
});
```

---

### 4.7 DR6 方案 —— `scenario` 从信号源派生，而不是由调用方声明

**目标：让「调用方声明 scenario」这个机制在结构上不存在。**

1. **建立唯一映射**（纯函数，一个文件）：
   ```ts
   // packages/core/src/scenario.ts
   export function scenarioOf(signal: MailboxItem | TurnSignal): Scenario
   ```
   输入是**信号本身**（`sourceType` / `requirement_id` 是否存在 / 是否 review 请求 / 是否回调），
   输出 scenario。这本来就是已知信息，不需要第二次声明。
2. **34 处 `scenario:` 传参逐个改成 `scenarioOf(signal)`**。编译器可帮一半：
   把 `Agent.handleMessage(…, opts.scenario)` 的 `scenario` 改成**必填但类型为 `Signal`**，
   传字面量的地方立刻报错（要的就是这个效果）。
3. **`allowedTools` 不再是入参**，改为 `toolsFor(scenario)` 的派生结果。任何需要「本回合额外放开某工具」的
   场景，说明 scenario 分类错了，修 scenario 而不是开口子。

**让逆例变红**：
```ts
it('不存在调用方直接声明 scenario 的入口', () => {
  expect(grepAll('packages', /scenario:\\s*'/)).toHaveLength(0);   // 字面量 scenario 归零
});
it('同一信号源永远派生出同一 scenario（纯函数）', () => {
  expect(scenarioOf(sig('task_execution'))).toBe(scenarioOf(sig('task_execution')));
});
```

**风险（必须说清）**：这条改动面最大（34 处 + 42 处 `allowedTools` + 7 文件）。已证实
`agent.ts:2767` 存在「未校验 cast 静默变成 scenario」的现有隐患 → **必须先收掉 cast，再改派生**，
否则会把一个已存在的偏差固化成映射规则。

---

### 4.8 A3 方案 —— 删、接线、标注，三选一并写明移除条件

| 动作 | 对象 | 具体操作 |
|---|---|---|
| **删** | `messages`、`memories`、`memory_embeddings`、`iterations`、`agent_knowledge`、`marketplace_templates/skills/ratings`、`gateway_message_queue`、`external_*` 五件套、`share_tokens` | DDL 从 `SCHEMA_SQL` 删除 + 删对应 `SqliteXxxRepo` 类 + 删 `storage/index.ts` 导出 + 删 `storage-bridge.ts:251` 的 `as any` 赋值。**编译器当迁移清单**。运维残留表（`lost_and_found`、`chat_messages_endturn_leak_20261007`）另走一次性 DROP |
| **接线（改位置，不是加写者）** | `workflow_schedules` | `refreshScheduleStates()` 里对新增/变更的 key 调 `persistState()`；`remove()` 接上（接口 `:36` 已声明但无调用点）。验收：`workflow_runs` 出现 `triggered_by='schedule'` 的行 |
| **接线（验入口是否真交付）** | `channel_bindings` | `scope='address'` 与 `scope='channel'` 各 0 行。**先确认工具/UI 是否真的到了使用者面前**，再决定是接线还是删 scope。该文件已因「建了路由没建写者」修过一次，不要再犯 |
| **保留但标注** | `external_agent_registrations`、`integrations`、`platform_instances`、`pending_callbacks` | 加注释写明「入口已接、无使用者」+ 移除条件（2 个发布周期仍 0 行则随支线一并删） |

**迁移安全**：以上删除的表在 C8 代码里**零引用**（已逐表 grep 验证），删表不破坏任何读写路径。
`share_tokens` 的语义替代物已存在（`deliverables.hub_share_*` 五列，9,368 行在用）。
`external_*` 若将来重启对外模式，**从分支取代码而不是取数据**（那 25 行是测试残留）。

**让逆例变红**：
```ts
it('SCHEMA_SQL 里每张表都有一个可达写者（否则是墓碑）', () => {
  for (const t of tablesInSchema()) expect(reachableWriter(t), `${t} 无写者`).toBeDefined();
});
it('每日新增行里，机制字段覆盖率必须 100%（墓碑尺子）', () => {
  // 以 mailbox_items.work_unit_ref 为模板：切流当天起必须 100%
});
```

---

## 5. 施工顺序与依赖

```
阶段 0（先决，无业务改动）
  §4.1 见证者表 + CI 门禁  ──────────────┐
                                         │ 没有它，后面每一项修完都会新增一批无主声明
阶段 1（此刻在损失，独立可做）            │
  DR5（§4.2）──────────────────────────┤ 只碰 memory 度量 + 文案
  DR3（§4.3）──────────────────────────┤ 只碰 dream 守卫 + memory-meta 迁移
  H7  （§4.4）──────────────────────────┘ 只碰 mailbox 类型表 + DB 迁移
                ↓（三项互不依赖，可并行；共享的只有阶段 0 的登记）
阶段 2（机制补全，互相耦合）
  H4/A1/A4（§4.5）→ 必须先补证 3 项 → 再做「事件源接入」
                ↓
  A2/A5（§4.6）   ← 依赖 §4.5 的 observe 词汇统一
                ↓
  DR6（§4.7）     ← 改动面最大，放最后；且要先确认「声明 A / 信号源 B」是否已存在
阶段 3（清理，零风险，可随时插队）
  A3（§4.8）删除类 → 接线类 → 标注类
```

**纪律**：一次提交 = 一个可回滚单元；阶段 0 必须先落地，否则阶段 1 的三项修完就会各自新增一条未登记声明
（这正好是 §1.1 推论说的形态）。

---

## 6. 「会咬人」的测试清单（汇总）

每一项在论证里已给出具体断言。这里只强调**当前实现必挂**的三条，它们是本方案是否真的生效的试金石：

1. `expect(h.injectedChars).toBe(injected.length)` —— 横幅的数必须等于注入器实际放进去的数（DR5）
2. `expect(shouldRunDreamCycle({...OVER, dream: store.getRecord('organized')})).toBe(true)` —— 手动 organize 不得满足 dream 守卫（DR3）
3. `expect(grepAll('packages', /scenario:\s*'/)).toHaveLength(0)` —— 不再有调用方声明 scenario（DR6）

**变异自证要求**：每项实施时，必须做一次「把修复改回原状 ⇒ 该用例变红」的实验并把失败原文贴进交付说明。
只写绿不写红，等于没验证（本仓库已因此被 DR3/H7 骗过两次）。

---

## 7. 边界与需要 Owner 决定的事

### 7.1 明确不做

- **不新增抽象层**。本方案净效果是**删**：删 1 条影子上限、删 1 个 volatile 字段、删 1 个含义模糊的写入口、
  删 1 个 mailbox 类型、删约 13 张表、删 34 处 `scenario:` 字面量。新增的只有一个 `declarations.ts` 和三个纯函数。
- **不碰 L1 治理层**（requirement / task / approval 的状态机与闸门）。A2 只做**派生视图**，不新增归属字段。
- **不在本方案里做**：`worker>1` 并发正确性重构、`data.db` 12.9GB 的分表/归档、明文凭据治理（§3.7 已单独标注）。

### 7.2 需要 Owner 拍板的两件事

1. **legacy 回滚通道是否退役**：H7 的首选方案（删 `heartbeat` 类型）以「退役 legacy timer mode」为前提。
   若你要保留回滚能力，则走 §4.4 的第二方案（`producedBy: ['legacy']`），代价是那个类型条目继续存在。
2. ~~**`marketplace_*` 四张表是「真要做但还没做」还是「放弃」**~~ —— **已结案**：A3 已按判删处理
   （四张表 + 4 个从未被 new 的 repo 类已删，见 `c6dcf35d`）。若 Marketplace 回到路线图，重建表是
   新工作量，不是本方案要保留的待决项。**本方案的待决项只剩第 1 条**。

### 7.3 顺带更正的三处计划文档错误（本方案已按代码为准）

| 计划原文 | 实测 |
|---|---|
| A3 = 「外部入口墓碑群：表还在，流量未起」（易读成 `resource_bindings` / `event_sources` / `channels`） | 这三张表在实库与 C8 代码里**都不存在**（只在未合并支线）。真正的 A3 是 `external_*` 五件套 + `share_tokens` |
| `memory-system.md` 说 curated 预算 15000 report-only（`:198`） | 同文件 `:206` 说 15000 **injected**；实际注入上限是 6000/4800/0，15000 结构上不可能是注入上限 |
| DR5「只量 observations、不量 curated 注入段」 | 更准确的说法是：**度量对象错位**（量磁盘区域 vs 量注入载荷）+ **上限没有动作消费者**。按原措辞去接「curated 触发器」会接错对象 |

---

## 8. 证据索引

| 主题 | 关键位置 |
|---|---|
| DR5 度量与三处消费者 | `packages/core/src/memory/store.ts:577-592`；`context-engine.ts:1079/1100`；`dream-trigger.ts:87`；`limits.ts:237/264/281` |
| DR5 假陈述 | `context-engine.ts:1086-1087`；`store.ts:636`（`archiveSection` 零调用） |
| DR3 两个守卫 | `store.ts:601-610/613-625`；`agent.ts:10884/10911-10917/10935`；`tools/memory.ts:596`；`dream-trigger.ts:85-99` |
| DR3 测试盲区 | `packages/core/test/dream-single-trigger.test.ts:97` |
| H7 策略位与消费者 | `packages/shared/src/types/mailbox.ts:189/290-305`；`core/src/mailbox.ts:739/2262`；`agent.ts:3287/3327-3334/1374-1390` |
| H4/A1/A4 | `packages/core/src/trigger.ts`（`TriggerEvent` 注释）；`tools/trigger.ts:43/86/102`；`agent.ts:1076/8690-8712` |
| A2/A5 | `packages/shared/src/types/agent.ts:3-19` |
| DR6 | `agent.ts` 内 34 处 `scenario:`；`capability-packs.ts#pack()` |
| A3 表清单与写者 | `packages/storage/src/sqlite-storage.ts`（各 `SqliteXxxRepo`）；`storage/index.ts:36-39`；`storage-bridge.ts:251` |
| A3 墓碑尺子 | `~/.markus/data.db`：`mailbox_items.work_unit_ref` 每日覆盖率（11-14 53% → 11-15 100%） |
| 实库快照 | 54 张表逐表行数；10 张 0 行、11 张 1–4 行（2026-11-15 17:35 只读快照） |

---

## 9. 一句话

**这七项没有一项是「功能没做完」，全都是「声明还在、见证者没了」。**
所以修法不是把功能补上，而是**让没有见证者的声明无法存在** —— 先建见证者表（§4.1），
再逐项把「度量对象错位」「写者不是那个事件」「策略表缺一维」「主体没有主语」四类形态逐个拆掉。
净效果应当是**代码变少**，而不是多出一层守卫。
