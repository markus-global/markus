# 任务注意力经济（Task Attention Economy）

> 状态：IMPLEMENTED on `feat/task-attention-economy`
> 依据：2026-10-17 ITM/Anteum 复盘（128 条评论 / 0 条人发言 / 60% 唤醒最终 `end_turn` / 单条均 2870 字）

## 1. 现象（实测，非推断）

| 事实 | 数值 |
|---|---|
| 单日项目评论 | 128 条，全部由 agent 发起 |
| 集中度 | 2 张卡吃掉 79 条（62%） |
| 单条长度 | 均 2870 字，最长 5974 |
| 唤醒量（单 agent） | ≈125 次/天 |
| 无效唤醒 | 20 次里 12 次结论 `end_turn`（60%） |
| 走评审闸的卡 | 评论 0–2 条（评审闸本身健康） |

## 2. 根因：一个谓词回答了两个问题

平台把「有人说话了」当成「需要你动作」。具体有三处执行点（R2）：

| # | 位置 | 现状 |
|---|---|---|
| E1 | `postTaskComment` | 纯评论（无 @）也向 assignee / creator 各投递一个 mailbox 项 |
| E2 | `injectCommentIntoRunningTask` | `in_progress` 时把评论**逐条**插进在跑的会话，并写「IMPORTANT: address this comment」 |
| E3 | `handlePostTaskComment` | `completed` 时**为每条评论起一整个新 LLM 回合** |

外加提示词层：`comment_response` 的 `MANDATORY outcome — you MUST end with task_comment or end_turn`，
以及通知模板 `MANDATORY before replying ... Only THEN use task_comment`。
→ 默认动作是「回」，沉默要额外成本；而「必须在评论里把话说全」决定了 2870 字这个长度。

## 3. 设计：把「信号」与「留痕」拆开

**不变量（单一执行点 = `task-attention.ts#resolveCommentAttention`）**

> 一条评论只有在**它点名了某人**、或**它改变了某人必须知道的状态**时，才唤醒那个人；
> 其余情况它是**留痕**（record-only）：留在 thread 里，不唤醒任何人。

| 触发条件 | 处理 |
|---|---|
| `mentions` 命中 | 立即唤醒（`mention`） |
| 作者是 human | 唤醒 assignee / creator（人很少，高优先） |
| reviewer 在 review 期发 | 唤醒 assignee（打回） |
| 其他（agent 对 agent 的普通评论） | **不唤醒**，仅留痕（record-only） |

### 3.1 在跑会话的评论注入（实际实现）

> 注（2026-10-18）：本节早期设计的「摘要投递」（`CommentDigest` 窗口合并投递）**未落地** —— 代码中不存在 `COMMENT_DIGEST_*`。
> 实际落地的规则更窄：`injectCommentIntoRunningTask` 只把 **human** 作者的评论注入在跑会话；agent 对 agent 的评论一律不注入（`shouldInjectIntoSession`）。

`completed` 的卡：只有 directive（mention / human / reviewer 打回）才起 post-task 回合；普通评论不再起 turn。

### 3.2 一卡一个未决问题 + 单点裁决

> Superseded (2026-10-18): replaced by the blocking `agent_ask_agent` tool. The ask_decision/decide mechanism was removed.

### 3.3 提示词（系数层）

- `comment_response`：默认沉默。只有「被点名 / 被直接提问」才回；否则 `end_turn`。
- 通知模板：删掉两条 `MANDATORY`，改为「这是留痕，不是请求」。
- 保留逃生口：口径异议仍可用一次 `task_comment` + mention。

## 4. 顺带修复：completed 卡不可被 agent 回退

**现象**：T25 `tsk_42eac81086d837787aec398b` 完成后 94s 被一次游离 `task_update` 拉回 `in_progress`
（status_transitions 实测：`review→completed` @07:15:19，`completed→in_progress` @07:16:53，actor=agent），
`blockedBy` 依赖链因此**静默断裂**（非 failed、非 rejected，肉眼不可见）。

**为什么既有 guard 没挡住**（guard 早已在 10-15 加上，且已在运行中的 app.asar 里）：
`resolveActorTypeForGuard()` 用 `agentManager?.hasAgent(updatedBy)` 反推身份；解析不到就**默认 human** ⇒ fail-open。
而 agent 工具面的 `ctx.updateTaskStatus(taskId, status)` **从不传 actorType**，于是每一次 agent 回退都在赌这个可选协作者是否就位。

**修法（三层，去机制而非加守卫）**：
1. **结构在调用点声明**：agent 工具面显式传 `'agent'`（`agent-manager.ts` 两处 ctx），不再反推。
2. **fail-closed**：`resolveActorTypeForGuard` 解析不到就按 `'agent'` 处理（拒绝），不再默认 human；`system` 路径本来就显式传 `'system'`。
3. **工具面直接不可表达**：`task_update` 对 `completed → in_progress` 返回 `denied` + 可行动指引（关单后要返工 = 找 human 重开，或关单前走 `request_revision`）。

## 5. 测试计划

- `task-attention.test.ts`：信号判别表（mention / human / reviewer / 普通评论）+ `shouldInjectIntoSession`（human 进 / agent 不进）。
- `task-terminal-revert.test.ts`：agent 回退 completed → 抛错；human → 允许；system 恢复路径 → 允许。
- 回归：`postTaskComment` 普通评论**不再**产生 mailbox 项（红→绿）。

## 6. 已知残余

- 摘要/消息投递的细节仍以 code 为准（`task-attention.ts`、`injectCommentIntoRunningTask`）。
- 库里 `tasks.open_question` / `tasks.decisions` 两列作为**死列**保留（删列需要重建表），代码既不读也不写。

## 7. 回滚

单一分支 `feat/task-attention-economy`，无 DB 迁移破坏性：新增列用 `ALTER TABLE ... ADD COLUMN`（幂等、旧库可读）。
回滚 = revert 单个 squash commit。注：`tasks.open_question` / `tasks.decisions` 两列在「未决问题」机制移除后仍留在表里（死列，代码已不读写），删列需重建表，本轮不做。
