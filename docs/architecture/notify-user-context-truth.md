# 通知 ≠ 对话内容：`notify_user` 的上下文契约

> 事故：2026-10-28 GEO策略主管 在 90 秒内对同一条内容调用 `notify_user` 12 次（09:12:34 → 09:13:48，标题恒为「需要一条产品口径：Markus Free 层数量上限」，正文每轮改写）。
> 本文记录**实测证据链**、根因、被放弃的错误修法，以及这次的修法与测试。

## 1. 现象（真实数据）

| 观测 | 数据 | 来源 |
|---|---|---|
| 重复通知 | 12 次同标题 `notify_user`，间隔 5–15 秒 | `~/.markus/logs/runtime-2026-10-28.log` L10315–10402 |
| 模型自述 | 「我把给老板的话直接说在了 A2A 会话里」「我上几轮把内容当文本发在对话里，没有真正调用工具送达」 | LLM 日志 `responseContent` |
| 请求里没有回执 | `notify_user` 之后的下一次请求只 +1 条消息，且该条是**助手正文**；`shell_execute` 之后是 +2 条（assistant+tool） | `~/.markus/llm-logs/2026-10-28.jsonl` 逐次 delta |
| 内存里其实有回执 | 会话文件里有 21 条 `{"status":"ok","message":"Notification sent to user."}` | `agents/agt_cea.../sessions/channel_dm:a2a:...json` |

**关键矛盾**：回执确实写进了内存，却**没有出现在发给模型的请求里**。模型因此永远拿不到「已送达」的证据。

## 2. 根因（结构性）

`notify_user` 的处理函数把**通知载荷**当成了**对话消息**，插进了 `tool_call → tool_result` 的**中间**：

```
messages[60] assistant  toolCalls=[notify_user]      ← 结构：我调了工具
messages[61] assistant  "**需要一条产品口径…**"        ← 平台伪造的「我说的话」（载荷）
messages[62] tool       {"status":"ok", …}           ← 结构：工具结果
```

`ContextEngine.sanitizeMessageSequence()` 的职责是保证协议合法：只有「assistant(toolCalls) 紧跟其 tool 结果」才成对保留，否则整块丢弃。上面的顺序里，第 61 条打断了配对，于是：

1. 看到 60（toolCalls）→ pending；
2. 看到 61（普通 assistant）→ `flushPending(drop=true)` → **丢弃整个 toolCalls 块**；
3. 看到 62（tool）→ 没有 pending → 「Dropping orphaned tool message」→ **丢弃回执**。

净效果：模型看到的是「我说了 6 遍同样的话」，一次回执都没有 → 它按 R4/R3 的方式重新推导「我还没真正发出」→ 再发一次 → 再断一次配对。**这个循环与模型能力无关，任何模型掉进去都出不来。**

归类：**R3（结构从载荷推断）+ R1（同一事实两个写者：内存里伪造一份「我说的话」，DB 里又存一份真通知）**。

## 3. 被放弃的修法（`fix/context-role-honesty-full`）错在哪

| 改动 | 问题 |
|---|---|
| 新增 `notification-guard.ts`（按标题 10 分钟去重，133 行 + 3 个测试文件） | 在**副作用**上加闸，上下文仍是假的。模型还是不知道自己发过，只是第二次被拒。且会误杀合法的同标题再通知（日报、周期性告警）。**加机制，不是删机制。** |
| 重写 `context-engine.ts` 的 system 拼装（"segments"，-318 行），并删掉 `context-volatile-gating.test.ts`、`state-checkpoint-delta.test.ts` | 这两套机制正是**前缀字节稳定性**的守卫（易变状态只在内容变化时投递、状态检查点作为固定段落）。删掉它们 → 每轮 system 拼装随状态漂移 → **prompt 缓存命中率崩塌**。为修一个通知 bug，赔上了全局成本。 |

教训（已写入 ROLE）：**修 bug 的正确姿势是删掉那个让 bug 得以存在的机制，而不是在旁边加守卫；任何触碰 `context-engine` 拼装的改动，必须先证明前缀字节不变。**

## 4. 本次修法

1. **删掉伪造的 assistant 载荷写入**（`agent.ts` 的 `notify_user` 分支）。通知载荷的合法落点是**人类的聊天记录**（`start.ts` 已经把它写进 `chat_messages` 并在 UI 显示），不属于 agent 自己的对话流。删掉它，配对不再被打断，回执自然留在上下文里。
2. **回执即证据**：工具返回值携带真实送达信息（`notification.id / to / priority / title / delivered_at`），让模型看到的是**事实**而不是自己的复述。
3. **不动 `context-engine`**：本次改动不触碰任何 prompt 拼装 / 缓存断点 / 尾块投递逻辑。
4. **测试锁不变量**（新增 `packages/core/test/notify-user-context-truth.test.ts`）：
   - 通知正文**不得**以 assistant 消息形式出现在会话里；
   - `assistant(toolCalls)` 的下一条必须是它的 `tool` 回执（配对不被打断）；
   - 经过 `ContextEngine.prepareMessages()` 打包后，回执**仍然存活**（这才是真正咬人的断言——回归的正是被打包器丢掉的那一层）；
   - 回执内容包含送达 id 与目标人。

## 5. 已知残余

- `chat_messages` 里通知行仍是 `role='assistant'` + `metadata.notifyUser`。会话从 DB 重建（`restoreSessionFromHistory`）时这条会被当成 agent 说过的话重放 —— 同一条谎言的第二个入口。当前重建只接受 `{role, content}`，没有 metadata 通道；**下一步**应把 `notifyUser` 标记穿透到重建链路并跳过，属于独立的、可单独审查的改动。
- `injectActivityToMainSession()` 仍会对 `notify_user` 类型向主会话追加 assistant 文本（跨场景活动摘要）。它在轮次边界追加、不打断配对，但同样是"载荷冒充发言"，需要单独评估。

## 6. 回滚

单一提交，改动集中在 `agent.ts` 的 `notify_user` 分支 + 一个测试文件 + 本文。`git revert` 即回到原状。

---

## 7. 第二轮：`request_user_input` 的「回答」契约（多问题 / 需要文字）

第一轮只修了通知侧。同样的事实在请求侧还有四个洞 —— **同一类谎话换了个形状**：
一个「回答」只要点了按钮就算答了，不管它有没有真的回答那个问题。

| 层 | 洞（2026-10-28 实测） | 修法（单一判据，删歧义） |
|---|---|---|
| 渠道选项来源 | agent 用 `questions[]` 提问时审批顶层 `options` 为空 → 卡片只剩「同意/拒绝」，模型给的真实选项没到人眼前 | `start.ts`：仅当**一次点击能答完**时，把该问题的选项提到渠道层（用 `isAnswerableByTap`，与 `formOnly` 同源） |
| 渠道渲染 | 多问题/多选/文本题同样只给「同意/拒绝」—— 一次点击把整张表单「批准」了 | `hitl-service` 在通知 metadata 打 `formOnly`；`dispatcher` 收到就不发动作行，改说「请在 Markus 应用内回答」 |
| 服务端校验 | 只校验「选了要求补字的选项」，**不校验每个问题都答了**；多问题跳过一问照样被接受 | `assessResponseCompleteness` 重写：①每个问题都必须被回答（text 非空 / choice 至少一项或以自由文本作答）；②选中项声明 `requiresFreeform` 时，**该问题自己的**文字必须非空 |
| 应用内 UI | `isAnswered` 只看「选了没有」，选了「直接给你数字」不填也算答完 | `UserInputModal`：选项级必填提示 + 输入框在需要时出现 + 提交按钮在必填未满足时不可用 |

**唯一判据**：`isAnswerableByTap(questions, options)` ——「这个请求能不能被一次点击完整回答」。
渲染器用它决定发不发按钮，CLI 用它决定提不提选项，服务端用它决定打不打 `formOnly`。
一个事实，一个执行点，不存在「卡片能点、服务端却拒收」的组合。

**服务端兜底**：`respondToApproval` 是唯一写者，它自己再判一次（返回 `undefined`，审批保持
pending），所以任何新入口（短信、Slack、未来的 card input）都不会绕过契约。

**残余（诚实列出）**：
1. 飞书若要**真正在卡片里收文字**，需要 card input 组件或「回消息补答」的回传链路 —— 目前的行为是**不提供那个按钮**并指路，而不是假装收到了。
2. `injectActivityToMainSession()` 仍以 assistant 文本写活动摘要（跨场景提示），属同一类「载荷冒充发言」，需要单独评估。
3. `chat_messages` 里的通知行仍是 `role='assistant'` + `metadata.notifyUser`，会话从 DB 重建时会被当成 agent 说过的话重放（同一条谎言的第二个入口）；重建链路目前只吃 `{role, content}`，没有 metadata 通道。

