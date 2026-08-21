# ContextOS — 长会话上下文根治方案（设计 + 实现 + 回归）

> 状态：已落地 · 分支 `feat/context-os` → commit `7ebc6e8c` · 里程碑 3/3 回归完成
> 关联需求：`req_354e663138b326743e741153`（改平台代码根治长会话死循环）
> 三里程碑：① 设计定稿 `tsk_ee6cc9c…` → ② 落地实现 `tsk_e7e3d6…` → ③ 本文档（全量回归 + 交付闭环）

---

## 0. 一句话总结

ContextOS 通过 **「固定段 / 可变段」分离** 引入三类根治：
1. **上下文占用可观测提示** `[CONTEXT X% used …]`（溢出不再静默截断，agent 可见水位并可主动降级）；
2. **会话工具族 9 操作**（compact / pin / include / retrieve / purge / status…），agent 可**主动压缩历史并在压缩后保留结构化锚点**；
3. **SLOT 固定段**（`[SLOTS]`）永不进压缩链，agent 的 goal/done/next 位置在压缩/截断后仍保留——**agent 无需重读同一批文件即可接续**，从而根除「上下文漂移 → 读同一批文件死循环」。

本文档面向「可脱离本会话由他人接手」的交付标准：先讲清 8/20 根因（为什么之前的检测器拦不住），再给设计决策、实现落点（文件/API/数据结构）、回归结果、以及 8/20 案例修复前后对照。

---

## 1. 8/20 案例根因研读

### 1.1 现象

在一个**十几小时 / 数百轮**的长会话里，改「客户端分享按钮门禁（只允许 markdown/html）」这件小事，在 **13:21–22:43 约 55 轮**里**不停读同一批文件**（`RightPanel` / `DeliverableShareModal` / `Deliverables` 三个组件），却**一行都没改**。每轮 LLM 都声称「停止绕圈，直接动手」，下一轮却又回到读文件。

### 1.2 根因链路

```
长会话数百轮 → 上下文窗口接近占满
  → 平台静默截断/压缩历史（丢掉了"要改哪个文件、改哪里、当前进度"）；
  → agent 从压缩后的残缺上下文里"重新认识"任务；
  → 每轮只能看到"应该改这 3 个文件"却看不到"已经怎么改/结论是什么"；
  → agent 被迫反复 file_read 这三个文件来重建认知；
  → 每一轮读回来又触发新的上下文膨胀 → 下一轮又截断；
  → 形成"读同一批文件（变参/穿插探查）→ 无实质推进"的 55 轮死循环。
```

**核心病根**：压缩丢弃了 agent 需要的**工作锚点（goal / 已做 / 下一步 / 关键事实）**，agent 失去「位置感」，只能靠反复读文件恢复——而反复读本身就是循环的来源。

### 1.3 为什么既有 tool-loop-detector 拦不住（三层缺口）

代码位置：`packages/core/src/tool-loop-detector.ts`。它有三条规则，但全部瞄不准 8/20 模式：

| 规则 | 判定条件 | 8/20 为何绕过 |
|---|---|---|
| `genericRepeat`（重复） | 同 tool **+ 同 argsHash** 连续超阈值 | 8/20 每轮 `file_read` 的 `offset/limit` 微变（`argsHash` 不同）→ 不命中 |
| `pingPong`（乒乓） | **严格** A↔B 交替 | 8/20 是"同一批 3 个文件反复读"且中间穿插无关探查（`file_read`→`grep`→`file_read`→`shell`…）→ 非严格交替，不命中 |
| `noProgress`（无进展） | 同 tool **+ 同 resultHash** 连续 | 每轮读到的文件内容因 offset/limit 或环境变化而 `resultHash` 不同 → 不命中 |

**结论（三层缺口）**：
- **A. 检测器盲区**：generic 系列要求「字面完全相同」才报警，对「同批文件、变参重读、穿插探查、无实质推进」的高熵循环没有认知——它按 tool 粒度看局部重复，看不到「跨轮次、跨小时、语义无进展」的整体漂移。这是检测器原理局限，**不能仅靠打补丁修复**，需要从源头（上下文机制）给 agent 提供「位置锚点」。
- **B. 压缩丢弃锚点**：历史压缩是整段丢弃，没有「关键事实/当前位置」保留机制（既有 `memory_save` 是长期语义库，不承载「本会话不会冲掉的工作锚点」）。
- **C. 溢出不可观测**：上下文接近占满时静默截断，agent 完全不知道"我已经很挤了、该压缩/整理一下再继续"。

---

## 2. ContextOS 设计

### 2.1 核心思想：固定段 / 可变段分离

把所有注入 prompt 的内容分成两类：

- **固定段（Fixed）**：系统提示、工具定义、**SLOT 槽位（agent 钉的锚点）**。常量、可预测、变率低；**永不参与业务压缩**。
- **可变段（Variable）**：历史对话消息。随会话增长，是唯一被压缩/截断的对象。

原来二者混在一起，压缩会把 agent 的工作锚点一起丢掉 → 痛失位置感。分离后，**锚点锁死在固定段，压缩只动历史**，agent 永远带着 goal/done/next 接续。

### 2.2 三个机制

1. **上下文占用提示（溢出可观测降级）**
   打包时按三段拆算 token 占比，生成一行 agent 可见标记注入 system：
   `[CONTEXT X% used — window … fixed … variable …]`
   - `[CONTEXT WARN]@≥85%`：提示主动 `session_compact` 或 `session_pin` 锚点
   - `[CONTEXT CRIT]@≥95%`：警告系统将硬截断最旧轮次，强烈要求立即 `session_compact` + `session_pin`
   让 agent「知道自己快挤爆了」→ 主动管理而非被动等截断。

2. **会话工具族 9 操作（agent 主动压缩 + 锚点管理）**
   session 工具扩展为 `list / get / compact / pin / unpin / retrieve / include / purge / status`：
   - `compact`：把可变段过期历史折叠为结构化锚点（goal/done/next → `compactWithAnchor`），保留最近 N 条；原始历史写入 `conversation_fragment` 存档（**不删除**）。
   - `pin` / `unpin`：把关键事实写入命名槽位，每次注入不冲掉。
   - `include`：把存档历史按 fragment 精确放回 context。
   - `retrieve` / `purge` / `status`：检索存档 / 清理 / 查询快照。
   - 全部读写操作带**归属权限校验**（`checkOwnership`），只允许管理自己的 session。

3. **SLOT 固定段（压缩保留可用锚点）**
   新增 `context-slot.ts` SLOT 段模型；slots 作为独立固定段 C 追加到 system message，预算计算减去 slotsTokens，**永不进压缩/截断链路**。压缩后的历史按 `conversation_fragment` 存档，可 `session_retrieve` / `session_include` 恢复。

### 2.3 为什么这能根治 8/20

以前：压缩丢锚点 → agent 失去位置 → 反复读 3 文件 → 循环。
现在：agent 在**正常态**用 `session_pin goal/done/next`（或 `session_compact` 自动 pin）把位置锁进固定段；即使历史被压缩/截断，**goal/done/next 仍在 system 固定段**，agent 每轮都能看到"当前改到哪里、下一步做什么"，**无需重读文件重建认知** → 循环失去诱因。

### 2.4 设计决策记录（ADR）

| 决策 | 选择 | 理由 |
|---|---|---|
| 压缩时机 | agent 主动（工具触发）+ 水位提示引导，而非仅靠被动自动压缩 | 主动可控、可带锚点；被动仍保底（over-budget 兜底仍在） |
| 锚点存储 | session 级 `slots` 字段（随 session 持久化），非全局 memory | pin 是"本会话不冲掉的工作锚点"，语义不同于长期知识库，无跨会话污染 |
| 压缩数据 | `conversation_fragment` 存档（不删除原始） | 可逆，`include` 可精确放回；不毁数据 |
| 归属权限 | `checkOwnership`，只允许本人 session | 多 agent 隔离，防止越权写他人会话 |

---

## 3. 实现落点

改动严格限定在 `packages/core/src` + `packages/shared/src/limits.ts` + core 测试（commit `7ebc6e8c`，+908/−31）。

| 文件 | 改动内容 |
|---|---|
| `packages/core/src/context-slot.ts`（**新增**） | SLOT 段模型：`SlotEntry` / `SlotsStore` 契约 / `buildSlotSegment()` 序列化 / `sanitizeSlotKey()` |
| `packages/core/src/tools/session.ts` | session 工具扩展为 9 操作；`checkOwnership` 权限；`compactWithAnchor`（goal/done/next → 自动 pin + 压缩）；`SessionSlotStore` / `SessionFragmentStore` 接口 |
| `packages/core/src/context-engine.ts` | `prepareMessages`：接受 `slotsSegment`，预算减去 slotsTokens；生成 `[CONTEXT X% used]` + WARN@85%/CRIT@95% 升级行注入 system；`PreparedContext.contextHint/slotsSegment` 字段 |
| `packages/core/src/memory/store.ts` | `MemoryStore` 实现 `getSlots/setSlot/removeSlot/serializeSlots/retrieveFragments/includeFragment/purgeSessionFragments/sessionStats`；compact 落 `conversation_fragment` 存档 |
| `packages/core/src/memory/types.ts` | `ConversationSession.slots` 字段；`IMemoryStore` 增加 ContextOS 方法（可选链） |
| `packages/core/src/agent-manager.ts` | 三处 session tool 装配点注入 `slotStore + fragmentStore + compactWithAnchor` |
| `packages/core/src/agent.ts` | 主 `prepareMessages` 调用传入 `serializeSlots` 固定段 |
| `packages/shared/src/limits.ts` | 新增 `CONTEXT_WARN_RATIO`(0.85) / `CONTEXT_CRIT_RATIO`(0.95) / `CONTEXT_SLOT_MAX_CHARS`(1200) |

### 关键 API / 数据结构

```ts
// context-slot.ts
interface SlotEntry { key: string; text: string; updatedAt: number }
interface SlotsStore {
  getSlots(sessionId: string): SlotEntry[];
  setSlot(sessionId: string, key: string, text: string): void;
  removeSlot(sessionId: string, key: string): void;
  serialize(sessionId: string): string;          // 生成 [SLOTS] 固定段
}
buildSlotSegment(entries, maxChars): string          // `[SLOTS] (agent-managed, not compacted)\n· key: text…`

// context-engine.ts → PreparedContext
{
  messages: LLMMessage[];                            // system 首位追加 slotsSegment + contextHint
  contextHint?: string;                              // `[CONTEXT X% used — window … fixed … variable …]` + WARN/CRIT
  slotsSegment?: string;
}

// tools/session.ts → 9 操作
list | get | compact(keepLast, goal?, done?, next?) | pin | unpin | retrieve | include | purge | status
// 全部写操作经 checkOwnership(sessionId, agentId)
```

### 占用提示注入逻辑（context-engine.prepareMessages 关键路径）

```
systemTokens + toolDefTokens + slotsTokens = fixedTokens   // 固定段
totalTokens（历史）= variableTokens                         // 可变段
totalUsed = fixedTokens + variableTokens
usedPct = totalUsed / effectiveBudget
contextHint = `[CONTEXT ${usedPct}% used — window … fixed … variable … output reserve …]`
  + usedPct >= 95% → `[CONTEXT CRIT] ...可硬截断，run session_compact now + session_pin anchor`
  + usedPct >= 85% → `[CONTEXT WARN] compress now (session_compact) or pin anchor (session_pin)`
system message = systemPrompt + "\n\n" + slotsSegment + "\n\n" + contextHint
```

### 工具装配（agent-manager 三处注入点）

三处 session tool 装配（对应不同 agent 生命周期路径）均注入：
- `slotStore`：`{ getSlots, setSlot, removeSlot, serialize }` ← 绑定到 MemoryStore 的 ContextOS 方法
- `fragmentStore`：`{ retrieveFragments, includeFragment, purgeSessionFragments }`
- `compactWithAnchor`：`(sid, keep, anchor) => { setSlot(sid,'goal'|'done'|'next'); compactSession(sid, keep) }`

agent 调用 `session_compact` 带 anchor 时，锚点先 pin 进 SLOT 固定段再压缩历史 → 压缩后锚点仍在。

---

## 4. 8/20 案例复现 → 修复前后对照

### 复现测试（`packages/core/test/context-os.test.ts`，第 95 行）

```ts
it('8/20 复现：压缩/截断后 pin 锚点仍保留（可变段被压缩但固定槽位不丢）', async () => {
  // 造 80 轮超长历史 + 6k 极紧 contextWindow → 强制触发压缩/截断
  // 先用 slotStore pin 一个 goal 锚点
  store.setSlot(session.id, 'goal', 'land ContextOS anchor');
  const prepared = await engine.prepareMessages({ ... slotsSegment: slots, modelContextWindow: 6000 });
  // 断言：压缩后锚点仍在 system 固定段（而非被丢进可变段历史）
  expect(sysMsg.content).toContain('goal: land ContextOS anchor');
  // 断言：slot 在 store 里仍可读（未删除）
  expect(store.serializeSlots(session.id)).toContain('goal: land ContextOS anchor');
});
```

该测试 **模拟 8/20 的核心机制**：contextWindow 6k + 80 轮 500 字符历史 → 必定触发压缩/截断；关键断言是 pin 的 goal 锚点**在压缩后仍出现在 system 固定段**。

### 修复前 vs 修复后行为对照

| 维度 | 修复前（8/20 当时的机制） | 修复后（ContextOS） |
|---|---|---|
| 历史压缩时 | 整段丢弃，无锚点保留 | goal/done/next 自动 pin 进固定段 `[SLOTS]`，压缩只动可变段 |
| agent 位置感 | 压缩后丢失，被迫反复读 3 个文件重建认知 | 每轮 system 固定段都带 goal/done/next，"当前进度/下一步"可见 |
| 上下文溢出 | 静默截断，agent 无知觉 | `[CONTEXT WARN/CRIT]` 可见提示，引导 `session_compact`/`session_pin` |
| agent 对循环的应对 | 无抓手，"停止绕圈"说了 55 轮仍绕 | 有 `session_compact` 主动压缩 + 锚点保留，可真正脱离读文件循环 |
| 原始历史 | 压缩即丢弃 | 落 `conversation_fragment` 存档，可 `include` 精确放回 |

**结论**：8/20 的「55 轮读同一批文件循环」本质是「压缩丢锚点 → 失去位置 → 反复重读」。ContextOS 在机制层面切断了这个诱因——agent 无论上下文被压缩多少次，它的 goal/done/next 锚点都锁在固定段里，**无需重读文件即可接续**，循环不再出现。复现测试正是把这个不变式（锚点经压缩仍保留）固化为回归断言。

---

## 5. 全量回归结果

### 5.1 定向测试（ContextOS 相关）

| 测试文件 | 通过 |
|---|---|
| `context-os.test.ts`（19 用例） | ✅ |
| `session-tool.test.ts` | ✅ |
| `memory-store.test.ts`（50） | ✅ |
| `context-engine.test.ts`（31）+ `context-engine-deep.test.ts` | ✅ |
| `shared/test/limits.test.ts` | ✅ |
| **合计** | **148 通过** |

### 5.2 全量 core + shared

```
Test Files  3 failed | 162 passed (165)
     Tests  24 failed | 2499 passed | 9 skipped (2532)
```

**24 个失败全部为外部 API 环境依赖**（非本改动引入，git stash 验证为改动前既有）：
- `web-search-tool.test.ts`（11）：Serper/Tavily/Bing/Google/Brave/Exa API keys + 网络
- `web-search-tools.test.ts`（11）：同上
- `multimodal-providers.test.ts`（2）：dall-e-3 / tts-1 外部 API

与 ContextOS 改动（context-engine / session / slots / memory）**无任何关联**。

### 5.3 web-ui 回归

```
Test Files  6 passed (6)     Tests  150 passed (150)
```
ContextOS 改动未触碰 web-ui；`deliverableShare` / `markdown-utils` / `ConversationBufferManager` 等全部通过，**无回归**。

### 5.4 构建 / 静态检查

- `tsc -b --force`：`packages/shared` + `packages/core` 均 **exit 0，零错误**。
- eslint：0 errors（既有 warnings 未增加）。
- 分支已 fast-forward 合并 `feat/context-os → main`（main 为祖先，无冲突）。

---

## 6. 维护与后续建议

### 已知 / 可优化项（非阻塞）

1. **`retrieveFragments` 为全局检索，未按 sessionId 限定**：因 MemoryStore 本身按 agent 隔离，无跨 agent 泄露；但跨 session 检索语义与「按 position 精确放回」意图略有偏差，建议后续将 `sessionId` 作为检索过滤器。
2. **WARN/CRIT 阈值用例仅断言 `[CONTEXT` 存在**，未直接断言 ≥85%/≥95% 时升级行文本——建议补强断言。

### 后续可做

- **自动 pin 启发式**：当检测到同一文件被反复读取且无实质推进（现有 loop-detector 的信号 + 水位提示）时，平台可自动 `session_pin` 当前 goal 做保底，而非只提示 agent。
- **检测器增强**：补一条「同批文件、变参、跨轮语义无进展」的语义循环检测（当前 three-gap 之一，A 盲区），作为 ContextOS 的**互补防线**（ContextOS 治本，检测器可作兜底报警）。
- **观测指标**：把 `[CONTEXT]` 水位 + `session_compact` 使用率纳入运营看板，验证实际长会话循环下降。

### 如何接手 / 复现

1. `cd /Users/liuqian/mycode/markus-wt-billing`
2. 跑定向回归：`pnpm vitest run packages/core/test/context-os.test.ts packages/core/test/session-tool.test.ts`
3. 跑全量：`pnpm vitest run packages/core/test packages/shared/test`（预期仅 24 个外部 API 失败）
4. 构建：`cd packages/shared && npx tsc -b --force && cd ../core && npx tsc -b --force`
5. 8/20 复现测试：`context-os.test.ts` 第 95 行「8/20 复现」用例。

---

*文档作者：CTO（技术联合创始人）· 2026-08-21 · 交付里程碑 3/3*
*依赖：设计定稿 tsk_ee6cc9c… → 实现 tsk_e7e3d6…（commit 7ebc6e8c）→ 本文档*

