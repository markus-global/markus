# 两个问题的根因与修复（2026-11-12）

分支：`fix/auth-expiry-and-mention-thinking`（worktree，基于 `origin/main` @ d7a17730）

---

## 问题一：长时间闲置后「能发消息但一直报错，报错说模型 API 认证失败」，重启重登才恢复，期间消息全部丢失

### 结论先说

**是本地会话（前端 ↔ 本地后端）的认证过期，不是模型 API 的密钥问题。** 你的判断方向是对的，但准确的链路比「前后端认证有效期」更具体：

会话 JWT 的寿命被写死为 **7 天**，且**没有任何续期机制**（cookie 是 `HttpOnly`，前端想续也续不了）。桌面版会一直开着，7 天不动之后 cookie 就死了，而渲染进程里的 `authUser` 仍是登录态 —— 于是界面看起来完全正常，**每一条写请求都在服务端被 401 挡掉，什么也没落库**。

那条「模型 API 认证失败」是**误诊**：聊天失败时前端把任何 `401 / unauthorized / invalid api key` 统一映射成 `errors.ai401`（"AI 服务认证失败"）。本地会话的 401 也走进这条分支 —— 于是你被送去查模型密钥，而真正的动作只是重新登录。

### 三个根因（按性质分类）

| 编号 | 根因 | 证据 |
|---|---|---|
| R1 | **会话只有绝对寿命、没有滑动续期**，且 `HttpOnly` ⇒ 只有服务端能续，而服务端从不续 | `api-server.ts` 里 6 处手写 `Date.now()/1000 + 7*24*3600` + `Set-Cookie`，无刷新端点 |
| R2 | **两种 401 被合并成一种显示**：本地会话过期 vs 模型供应商拒绝密钥 | `ChatComponents.tsx#friendlyAgentError` 对 `status===401 \|\| /unauthorized\|invalid api key/` 一律返回 `ai401` |
| R3 | **发送路径先清空输入框、失败后仍保留乐观气泡**，失败的信息没有回到用户手上 | `useChatStream.ts` 发送前 `setInput('')`；catch 只追加一条错误气泡，用户气泡留在列表里"假装发出去了" |

R1 决定「会不会坏」，R2 决定「坏了以后你被告知的是错的信息」，R3 决定「坏了以后消息丢不丢」。三者叠加才是你看到的完整现象。

### 修复

**服务端（`packages/org-manager/src/api-server.ts`）**

- 会话签发收敛为**唯一实现点** `issueSessionCookie()`（原来 6 份手写副本，正是寿命无法推理的原因）。
- 闲置寿命 **7 天 → 30 天**：这是"打开着、几天没用"的真实使用模式；被彻底遗弃的会话仍然会退休。
- **滑动续期** `renewSessionIfStale()`：token 超过 1 天后，任一鉴权请求都会重签 cookie。新不变量：**会话在被使用期间永不失效**。
- 401 响应带上机器可读的 `code: 'AUTH_REQUIRED'`（`requireAuth` 与 `/auth/me`），让前端能把"请重新登录"和"模型密钥有问题"区分开。

**前端（`packages/web-ui`）**

- `request()` 收到非 `/auth/*` 的 401 ⇒ 派发一次 `markus:auth-expired`；`App.tsx` 监听后回到登录页（并清掉锁存，登录成功后复位）。**离开登录态才是诚实的反应**，而不是留一个"看起来已登录、写什么都失败"的空壳。
- `friendlyAgentError()` 先判 `isAuthExpiredError()` ⇒ 显示「登录状态已过期，这条消息没有发出去。内容仍在输入框里 —— 重新登录后按发送即可。」（zh/en/es 三语）。
- 发送失败且是认证过期 ⇒ **输入框内容与图片原样还回**、**移除乐观用户气泡**（服务端没落库，就不该显示成已发送）。

### 为什么这样算修到根因

判据是「同一个 bug 换个记号会不会再犯」：

- 再加一个端点、再加一处登录，都不会再产生第 7 份手写 TTL（唯一签发点）。
- 任何"看起来已登录却写不进去"的状态，都会在第一次请求时把用户送回登录页（单一权威：服务端 401）。
- 任何一条没落库的消息都不会再被乐观气泡冒充成已发送。

### 已知取舍

- 30 天闲置寿命是安全性与可用性的折中。LAN 暴露实例（默认 `bind 0.0.0.0`）下，被盗 cookie 的有效窗口从 7 天变成最多 30 天（滑动续期只在**有合法请求**时才延）。若你要求更短，把 `SESSION_TTL_SECONDS` 调回 7 天也不会回到"几天不用就坏"的老问题——只要它 < 30 天、且你天天用，滑动续期就会一直续着；真正受影响的只有"闲置超过 N 天"的场景。
- 本次没有引入 refresh token 机制：本地单用户桌面场景下，HttpOnly cookie + 服务端滑动续期的机制更少、状态更少。

---

## 问题二：任务/需求评论里 @mention 了某个 agent，却显示「任务创建者 正在思考」

### 根因

**「谁在思考」是前端猜的，而且猜错了两次。**

`Work.tsx` 提交评论后，用本地推断构造 `thinkingAgents`：

```ts
for (const name of mentions) {
  const a = agents.find(ag => ag.name.toLowerCase() === name.toLowerCase());  // ①
  if (a) tryAdd(a.id);
}
if (task.assignedAgentId) tryAdd(task.assignedAgentId);
if (task.createdBy?.startsWith('agt_') && task.status !== 'in_progress') tryAdd(task.createdBy);  // ②
```

- ① **`mentions` 传的是 agent id，不是名字**（`CommentInput` 用 `candidate.id`）。按名字匹配永远落空 ⇒ **你 @ 的那个 agent 根本不会出现在"思考中"**。
- ② 于是列表只剩"兜底猜出来"的 assignee / **任务创建者** ⇒ 你看到的就是创建者在思考。

服务端侧其实是正确的：`postTaskComment` 按 id 精确把 `mention` 投进对方 mailbox。**错的只有那块 UI 的推断**。

### 修复（删机制，不是加守卫）

- 服务端 `postTaskComment` / `postRequirementComment` 返回 **`notifiedAgentIds`** —— 本次评论**真的被 enqueue 唤醒**的 agent 列表（只包含确实投递成功的；未知 id、人、未唤醒者都不会出现）。
- 路由把该字段透传给前端（`/api/tasks/:id/comments`、`/api/requirements/:id/comments`）。
- 前端三处评论提交点（任务详情、需求详情、旧版评论框）**删掉全部本地推断**，改为 `agentsFromIds(result.notifiedAgentIds, agents)`（`lib/commentThinking.ts`）。

**判据**：没有推断 = 不会猜错。想显示"谁在思考"就必须由服务端点名；服务端点不出名字时，界面显示 **什么都没有**，这正是你说的"哪怕不显示也比显示错误信息好"。

### 覆盖范围

- `packages/org-manager/src/task-service.ts`（两个 comment 入口）
- `packages/org-manager/src/routes/tasks.ts`、`api-server.ts`（需求评论路由）透传
- `packages/web-ui/src/pages/Work.tsx`（三处）、`lib/commentThinking.ts`

---

## 测试

新增（均已跑通）：

- `packages/org-manager/test/task-comment-notified-agents.test.ts`：mention 命中的是**被 @ 的 agent**、不包含未被 enqueue 的 agent、未知 id 不产生幽灵条目、纯记录型评论返回空数组。
- `packages/web-ui/src/lib/commentThinking.test.ts`：只渲染服务端点名的 agent、未知 id 丢弃、去重且保序、空列表不猜。

回归：`tsc -b` 全绿；`friendlyAgentError.test.ts`（9 项，含"400 报文里的 token 数含 401 不得误判"）仍全绿。

## 残余与后续（已决定，不需你等我）

- 真正的 401 语义分离只有本地 `/api` 这条链：Hub 代理（`hubRequest`）的 401 仍只清 hub token，那是另一套凭证，语义本来就不同。
- 会话滑动续期在 HTTP 层生效；WebSocket 若因会话过期断开，重连时会被 401 挡住并触发回到登录页 —— 与 HTTP 行为一致。
- 30 天这个数值是我的判断（可用性优先），不是不可改的契约；要更短/更长只改 `SESSION_TTL_SECONDS` 一处。
