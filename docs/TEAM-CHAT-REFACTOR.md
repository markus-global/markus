# Team Chat 页面重构：功能需求梳理 + 状态机设计

> 分支：`refactor/team-chat-state-machine`（基于 main #308，已领先 19 commits）
> 目标：梳理功能需求 → 重构状态管理 → 消灭脆弱赋值 → 修复所有状态冲突/数据问题
> 状态：设计文档 v1（评审中）

---

## 1. 现状体检（一句话结论）

Team chat 的核心页面 `pages/Team.tsx` 是一个 **5918 行的单体组件**：约 **78 个 useState、82 个解构状态、106 处 useRef/useCallback**，同一段「中断/清理」序列被复制粘贴 4+ 次，同一份状态（messages/sending/activities）在 4 处各有副本，靠手工保持同步——这正是「状态机不合理、脆弱赋值遍布」的直接体现。

上一轮已经搭了状态机的骨架（纯类 `ConversationBufferManager` + hook `useConversationBuffers`），**但只被部分采用**，Team.tsx 里新旧状态并存、互相同步靠约定。

---

## 2. 功能需求梳理（Team chat 页面到底做什么）

### 2.1 会话模型（四个会话形态）

| 形态 | convKey 规则 | 说明 |
|---|---|---|
| direct（1v1 agent） | agentId | 默认形态，流式回复 |
| channel（群聊/频道） | `ch:<channel>` | 独立频道，同步走 REST |
| dm（人类成员私聊） | `dm:<userId>` | 同 channel 语义 |
| session tabs（会话标签页） | 每个 agent 多个 session | 历史分页、标题编辑、模型覆盖 |

### 2.2 用户可见功能清单

**会话侧**
- 切换会话（direct agent / channel / dm / session tab）
- 会话历史分页加载（更早消息），`hasMore` 游标
- 会话标题编辑（session_rename）
- session 切换**加载态**（有历史但未加载完 → 显示 loading，而非空白新对话）
- 多会话流隔离（A 会话流式时切到 B，A 的流继续、B 独立渲染）

**发送/回复侧**
- 文本 + 图片 + @提及 发送
- 回复（replyTo）引用
- 发送中状态（sending）、输入防抖/防重复提交
- 会话模型覆盖、agent 绑定模型

**流式侧**
- SSE 分块渲染（文本 + thinking 分段 + 工具时间线）
- 工具调用进行中/完成折叠
- 中断（stop）/ 重试（retry）/ 续写（resume）
- SSE 断连后的指数退避轮询恢复
- 软断连 → reattach 续接

**状态/感知侧**
- 侧栏 agent「工作中」红点/忙碌状态（与 Chat 顶部徽章同源）
- 未读计数、新消息气泡、滚动跟随
- thinking agents 提示条

**其他**
- 通知卡片/用户输入审批弹窗
- 任务关联（linkedTaskId）、全局搜索
- 移动端响应式（L2 浮动面板、返回栈）

### 2.3 后台交互

- `api.agents.sendMessage`（REST + SSE 流）
- `api.sessions.*`（历史分页 / getMessages / streamStatus / rename）
- `api.channels.sendMessage`（channel/dm 走 REST 全量返回）
- WS 广播（agent:update / task:update / mailbox 等）

---

## 3. 状态机体检：脆弱赋值在哪里（病灶清单）

### A. 复制粘贴的中断/清理序列（最严重）
同一套 teardown 在至少 4 处重复：

```ts
resetSending(key);
actBuffers.delete(sessionId ?? key);
endStream(key);
if (sessionId) clearStreamSession(key, sessionId);
setSending(false);
setActivities([]);
```

出现于：stop 处理器（2652-2659）、send 重复提交重试（2701-2717）、send 同会话中断重发（2722-2751）、channel 中止（2762-2765）。**少写一步 = 状态泄漏**，且各处微妙的排列差异让人无法安全复用。

### B. 多重状态源（同一份数据 4 处副本）
`messages / sending / activities` 同时存在于：
1. `ConversationBufferManager` 内部 Map
2. `useConversationBuffers` hook 的 `setMessages/setSending/setActivities`
3. Team.tsx 自己的 `useState`（如 `sending`、`activities`、`loadingChat`、`streamingVisual`）
4. `chatStore`（useChatStore.ts 的全局 store）

四处手工同步 → **状态冲突的直接来源**。

### C. 可变 session id 被闭包捕获
```ts
let streamSessionId: string | null = ...; // 运行中由 SSE 事件改写
```
流式过程中 session 归属随时可能变，所有 `updateConvMsgs(..., streamSessionId)` 都依赖这个会变的变量——一旦流被切走/合并，写入目标就会错。

### D. 手动消息 flag 变换
`isStopped / isError / isStreaming` 和 tool segment 的 `running → stopped` 在十几个地方手工 map 变换，缺少统一的「结束态收敛」函数。

### E. 定时器/视觉状态
`thinkingAgents`（120s 超时）、`streamingVisual`（STREAMING_MIN_DISPLAY_MS）、`streamingTimerRef`——都是「临时视觉状态」，与真实流状态分离，容易不同步。

---

## 4. 目标状态机设计

### 4.1 单一事实源（Source of Truth）
- **每个 convKey 一份状态**，全部收敛进 `ConversationBufferManager`（纯类，可单测）。
- hook 层（`useConversationBuffers`）只做「管理器的 React 桥」——把 Map 变化转成渲染快照，**不再持有独立副本**。
- Team.tsx 不再新建 `messages/sending/activities` 的 useState；一律读 hook 暴露的渲染态。
- `chatStore` 只保留「跨会话」的东西（流式 agent 集合、未读），会话内数据不进 store。

### 4.2 会话生命周期状态机（每会话）
```
        ┌────────┐  select/load ┌─────────┐
        │  idle  │─────────────▶│ loading │
        └────────┘              └─────────┘
          ▲                         │ applyLoad / completeLoad
          │                         ▼
        reset                        ┌───────┐   send    ┌───────────┐
          ◀─────────────────────────│ ready │──────────▶│ streaming │
          │                         └───────┘           └───────────┘
          │                             ▲  done / stop / abort / 断连恢复
          └─────────────────────────────┴──────────────┘
```
- 不变式：**streaming 态下，DB 加载结果只写缓存、不覆盖显示缓冲**（已实现）。
- 新增不变式：**任何离开 streaming 的路径必须且只能经过 `completeStream(key, { stopped | done | error | detached })` 一个收敛点**，由它统一处理：endStream、clearStreamSession、resetSending、tool running→stopped、消息 isStopped/isError 标记。

### 4.3 中断/清理的单一入口
把 A 组重复序列收敛为一个方法：

```ts
manager.abortStream(key, opts: { markStopped?: boolean; sessionId?: string })
```

内部保证「幂等」：已经是 ready/idle 时直接 no-op；每个子步骤都检查前置条件。所有调用点（stop / 重复提交重试 / 同会话中断 / channel 中止 / 组件卸载）只调这一个方法。

### 4.4 流式会话归属
`streamSessionId` 不再用「闭包可变变量」，改为管理器内按 `convKey` 追踪的**活跃流会话**（`activeStreamSession.get(key)`），SSE `session_start` 通过 `manager.setStreamSession` 单一写入点更新，所有读取走 `manager.getActiveStreamSession(key)`。天然规避 C 病灶。

### 4.5 结束态收敛（D）
提供 `manager.finalizeAgentMessage(msg, outcome)` 统一处理 isStopped/isError + tool segment 收敛，替代 12+ 处手工 map。

---

## 5. 迁移顺序与验收标准

> 原则：**每步一个可回滚 commit，typecheck + 相关单测通过后再进入下一步**；不做「一次性大爆炸重写」。

| 步骤 | 内容 | 验收 |
|---|---|---|
| S1 | 文档 + 状态机缺陷清单 | 本文件，typecheck 通过 |
| S2 | `abortStream` 单一收敛入口落地，替换 4 处复制粘贴 teardown | ✅ `b0dd2c93`：停止/中断/重发/切会话行为不变，5 个幂等单测 |
| S3 | 流式会话归属收敛（C 病灶） | ✅ `682d0df7`：`streamSessionId` 与 `effectiveSessionId` 重复公式合一；归属仍是 send() 局部正确状态（路由到正确缓存所需），多会话流隔离行为不变 |
| S4 | 结束态收敛 `finalizeAgentMessage`（D 病灶） | ✅ `9ecd655e`：12+ 处手工 isStopped/isError/tool 变换收敛为 4 个辅助函数 + 8 个单测。**后续补全**（`d63f3c75` 之后）：原 done/error 收尾路径并不经过 finalize，`finalizeStreamEnd`/`finalizeLastStreamingBubble` 补齐直连流 done/error/软断连 + reattach 中断的 isStreaming 收敛（新增 5 个单测） |
| S5 | 消除隐性双源（B/E 病灶），chatStore 单一职责 | ✅ `682d0df7`：chatStore 删除 8 个从未读写的死状态字段（226→110 行），只保留流式 agent 集合 + 版本号；`messages/sending/activities` 本就收敛于 manager，Team 无重复 useState |
| S6 | 视觉状态收敛（E 病灶） | ✅ `50065608`：`chatStreamActive` 尾部扫描提取为 `hasStreamingTail` 纯函数（3 个单测）；thinkingAgents 生命周期自洽（WS 事件 + 120s 兜底）无需改造 |
| S7 | 拆分 tab 面板（会话/流式渲染/审批/搜索） | ⬜ 未做：消息渲染已内聚在 ChatComponents/ExecutionTimeline，Team.tsx 为编排层；拆分收益 < 风险，留作后续独立 PR |
| S8 | 流编排迁移 `useChatStream` hook | ✅ 本次：`send`(~780 行) / `stopSending` / `tryReattachActiveStream`(~390 行) / `loadSessionMessages` 全部搬出 Team.tsx，逻辑经 typecheck + 239 单测 + vite build 全绿 |
| S9 | 多 session tab 并发串台修复 | ✅ `614f419f`：`resetConv(key, repinTo?)` 原子化 reset + activeSession re-pin，消除「reset 后未 re-pin → 旧 session 流混入新 buffer」的顺序 bug（handleRememberConfirm 先 pin 后 reset 反序、tab 新对话漏 pin）。新增 2 个回归单测，246 单测 + build 全绿 |

### S8 说明：`useChatStream` 迁移
- **所有权模型**：Team.tsx 仍持有全部应用 state；hook 只通过 `ctx`（稳定句柄）+ `ctx.stateRef.current`（易变只读态，每 render 刷新）借用。hook 私有持有流专属 ref（`abortControllerRef`/`reattachAbortRef`/`reattachCooldownRef`/`userStoppedSessionsRef`/`lastSendGuardRef`/`lastSseEventTimeRef`），因它们的每个写入点都在搬入的函数内。
- **接线**：`loadSessions` 上移规避 TDZ；Team 从 hook 解构 `hookSend / stopSending / tryReattachActiveStream / loadSessionMessages` 并接线到 `sendRef` 与 5 处 UI 事件。
- **状态问题收敛**（本次一并解决）：流会话 id 不再依赖闭包可变变量（hook 局部 `streamSessionId`）；结束态统一经 `finalizeStreamEnd`/`finalizeAgentMessage`；侧栏忙碌态经 chatStore 幂等 Set（见 S5）；`thinkingTimeoutRef`/`sessionSwitchSeqRef`/`oldestMsgId` 等跨非流代码的共享 ref 维持在 Team 并注入 ctx。

> **已知遗留（平台工具限制）**：file 编辑工具的 `old_string` 无法匹配含 `<thinking>`/`</thinking>` 标签的文本（渲染层清洗），因此 Team.tsx 中原 `send`/`tryReattachActiveStream`/`stopSending` 被重命名为 `*Legacy` 保留（未接线，`void` 引用豁免），确保 diff 可审且异常可回滚。hook 为唯一生效实现。清理 legacy 需在 IDE 人工删除或使用能原始匹配标签的工具。

**UI/UX 优化（随重构一并落地）**：加载中显示会话名副标题（切换有历史的 session 不再像空白新建）；流式生成中发送键→停止键；空态 greeting；回到最新按钮 + 新消息计数；IME 组合守卫；mention/slash 下拉；多会话流互不污染。

**回归范围**：直连流式、channel/dm、会话标签页切换、历史分页、stop/retry/resume、断连恢复、侧栏忙碌态、未读计数、移动端。

---

## 6. 与既有提交的关系

分支上已有 19 个提交，其中 web-ui 侧已解决：流式 refcount 泄漏、侧栏工作中残留（单一事实源）、会话历史分页、session 切换加载态、多会话流隔离。本设计文档的 S2-S7 是在此基础上的**纵深重构**，不推翻已有成果，只收敛剩余的新旧并存与复制粘贴。

---

## 7. Interaction Reliability Contracts (`feat/ui-optimize-1008`, 2026-10)

Three user-reported failures in the Team Chat page — a **stalled tool approval**, a **notification that
landed nowhere**, and an **unreliable "jump to search result"** — turned out to be the same two
structural faults in different clothes:

- **R1 — one fact, several writers.** Two independent async writers could publish the same fact, and
  whichever finished last won. (Which session tab is active; where the viewport is; how much history a
  window still has.)
- **R2 — one invariant, several measures.** The same invariant was computed in more than one place, so
  the places could disagree — and one of them was cached past the point of being true. (`hasMore` read
  from a React render-time projection; "the target session finished loading" inferred from
  `!loadingChat`.)

Both are cured the same way: **delete the second writer / the second measure**, or move the fact into the
scope that actually owns it. The contracts below are the durable outcome; the round-by-round chase is
recorded in the commit message, and the invariants are pinned by unit tests in
`packages/web-ui/src/lib/*.test.ts` + `packages/web-ui/test/*.test.ts`.

### 7.1 The message scroll container has exactly two write paths

`pages/Team.tsx` drives a single scroll container, and it may only be written by:

1. **bottom-follow** while a stream is appending, and
2. **one pending scroll intent** for the view (`pendingRestoreRef`, keyed by the scroll-memory key).

There is deliberately **no third path**. In particular the virtualizer's `scrollToIndex` / `measure()`
are forbidden: `scrollToIndex` arms an uncancellable internal rAF reconcile loop (≤ 5 s) that re-pushes
the viewport every time the measured offset of that index changes — which is exactly while lazy row
measurement is still settling — and `measure()` resets every cached row height to an estimate, causing
overlap and drift.

**Intent priority** (`ScrollIntentPriority`; the single arbiter is `shouldAcceptRestoreIntent`):

| priority | intent | meaning |
|---|---|---|
| 3 | `jump` | the user explicitly asked to see this message |
| 2 | `prepend` | pagination layout compensation (scrolled to top → older page inserted above) |
| 1 | `restore` | "bring me back to where I was" |

A later intent replaces an in-flight one **only if its priority is ≥** (equal ⇒ later wins) and only for
the same view. Consequence: an unsatisfied `jump` is never overridden by a `prepend` / `restore`.

**Viewport ownership** (`mayChangeViewportOwner`): only `jump` / `restore` may change who owns the
viewport. `prepend` moves pixels and nothing else — a pure layout compensation must not hand control
back to bottom-follow. `decideScrollFollow` takes `intentPending` so a pending intent also blocks
hand-back while the jump is still travelling.

**Release condition** (`anchorStability` + `planIntentPass`): an intent is released by **stability, not
by a timer**. "Rendered in the DOM" is not "at rest" — with estimated row heights, the first measurement
pass pushes the target away. `planIntentPass` therefore returns `refine` (correct now, keep retrying)
until the anchor is measured at its target position in **two consecutive passes**. While unsettled,
`RESTORE_INTENT_TTL_MS` (10 s) is not a release reason, and a `jump` / `prepend` is never downgraded to
"scroll to bottom". `GOTO_ROW_INSET` (12 px) parks the hit just below the viewport top so its trailing
context stays visible.

### 7.2 Window bounds are per-buffer, owned by the buffer manager

`{ hasMore, oldestCursor }` used to live in **two globals** on `Team.tsx` while message content lived in
`ConversationBufferManager`, keyed per `bufferId`. Any session's load then overwrote the current view's
bounds → the loader read another session's `hasMore=false` / `oldestCursor=null`, spanned zero pages, and
a `jump` concluded "target not found → go to bottom". This is why it worked the first time (empty
buffer → the guarded path) and broke from the second visit onward.

Contract: bounds live **next to the messages they describe** — `windowBounds: bufferId → { hasMore,
oldestCursor }` inside the manager, same key, same storage, same lifetime (reset on eviction). The single
writer is the loader for **that** buffer. `loadMore()`'s return value is the only progress signal, and
`hasMore` is never re-derived from a render-time value.

### 7.3 "Jump to message" is self-fetching and never shares the pagination channel

`loadMore()` returns `0` for three unrelated reasons — end of history, page dropped because the view
changed mid-flight, or "I joined someone else's in-flight request". A caller cannot tell them apart, so
`jumpToMessage` does **not** use that channel:

- `collectJumpWindow` — if the target is already in the buffer, **no fetch at all** (the fast path; this
  is why same-session jumps always worked). Otherwise it pages from newest backwards until the target is
  found, the target's own timestamp (`targetCreatedAt`) is passed, or the page cap (40) is hit.
- The collected ascending window plus its bounds are installed **in one write**; the scroll intent then
  positions the view.
- `trimJumpWindow` — when the display cap trims, the target must survive (the cap keeps the newest, and
  deep-history targets sit at the oldest end).
- Anchor resolution is **by row identity, not index** (`resolveRowAnchor`): the rendered list is a
  projection of the buffer (activity-log rows and acknowledged notifications are filtered out), so a
  buffer index does not address a rendered row.

### 7.4 Session selection has one owner while a navigation is in flight

`navigationOwnsSessionChoice` — while a navigation intent is pending, the agent-switch effect must **not**
pick a session tab and must **not** schedule its own scroll restore. Otherwise two async writers race for
"which tab is active" (the late one wins → "it flashes the right message, then moves"), and a spurious
background load for the previously-viewed session can write bounds that the jump then reads.
`await switchSession()` resolves *after* messages are loaded, so callers must never infer "loaded" from
`!loadingChat`.

### 7.5 Blocking approvals and notifications get a near-field entry point

Focus arbitration: **tool approval (it blocks the agent turn) > user input > notification.** One arbiter,
one modal at a time.

- **Tool approvals** (`hitlService.requestApprovalAndWait` suspends the whole agent turn) now get the same
  treatment as `request_user_input`: an **amber banner above the composer** plus an auto-opened
  `ToolApprovalModal`. Selection uses `details.toolName` — the marker unique to tool approvals — which
  naturally excludes task/requirement structured approvals from the chat surface. The banner is scoped to
  `activeSessionId` via `details.sessionId`, falling back to `agentId` for rows written before that field
  existed. Auto-open happens once per approval, and only while the Team page is active on the chat tab.
- **Notifications**: clicking an agent in the roster (L1) opens **one review queue modal** — progress
  `1 / N`, button "Next" → "Done" on the last — rather than N stacked modals. Closing it still performs
  the landing. Only unread notifications auto-pop, and only on an explicit roster click (live arrivals
  still go to the banner). Landing (`resolveReviewLanding`) prefers the session the notifications came
  from and locates the earliest one, falling back to the main session only when they span sessions. The
  notification's own time is shown via the single `lib/timeAgo.ts` implementation shared with the bell.

### 7.6 Diagnostics

`lib/scrollDebug.ts` is an **opt-in, zero-overhead-when-off** trace for the intent path. Enable it once
in DevTools with `localStorage.setItem('markus.scrollDebug', '1')` (remove the key to disable). It prints
about ten decisions per jump (`jump:collected` / `jump:located` / `intent:apply` / `intent:refine` /
`intent:release-*`). This link is only truly observable in a live Electron window; the switch exists so
the next report can be diagnosed from evidence instead of inference.

### 7.7 Known residuals

- Cross-agent jumps where the target session is not on the first page of that agent's session list still
  switch by id; the left-hand tab title renders empty until refresh.
- Very deep targets need several sequential page fetches, so there is a brief wait between click and
  landing (the viewport is pinned meanwhile — it does not bounce).
- A target that genuinely does not exist (deleted, or beyond the page cap) falls back to bottom with a
  `console.warn` — an honest fallback, not a silent wrong jump.
