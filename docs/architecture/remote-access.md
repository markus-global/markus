# Markus 远程访问重构 · 冻结契约（T1）

> **Moved** here from `docs/design/` on 2026-11-15. `design/` is for work that is not settled yet;
> this contract is frozen v1.0.0 and is the implementation SSOT, so it belongs with the architecture.
> User-facing how-to: [`guides/remote-access.md`](../guides/remote-access.md).

> 作者：CTO · 2026-10-14 · 状态：**冻结（frozen v1.0.0）**
> 地位：本文件 + `packages/remote/src/contract.ts` 是本重构**唯一实现依据（单一事实源 / SSOT）**。
> 上游依据：`remote-access-design.md`（v2，已并入 Owner 决策 D1–D4）、`remote-access-execution-plan.md`。
> 下游消费方：**T2 / T3 / T5 / T6 / T7 / T8 / T9 / T10** 全部按本契约实现。
> 约束：`markus` 仓（`feat/remote-access-tunnel`）与 `markus-hub` 仓（`feat/remote-endpoints`）**均不 push、不动 main**。

---

## 0. 本契约的地位与使用方式

| 项 | 约定 |
|---|---|
| 类型落地 | `packages/remote/src/contract.ts`，经 `packages/remote/src/index.ts` 全量导出（`export * from './contract.js'`） |
| 枚举权威 | 运行期 `const` 数组是**唯一的枚举权威**，`type` 由它派生（`(typeof X)[number]`）→ 列表与联合类型结构上不可能漂移 |
| Hub 对齐 | Hub 是**独立仓库**，无法 `import @markus/remote`。Hub 侧**逐字镜像**本契约的类型与常量；本文件是两侧的对齐源 |
| 契约版本 | `REMOTE_CONTRACT_VERSION = '1.0.0'`（见 §9 变更策略） |
| 编译门槛 | `pnpm typecheck`（`tsc -b`）必须全绿；契约由 `packages/remote/test/contract.test.ts` 探针锁死（14 条断言） |

**总原则（沿用设计 §7.5）**：**公开端点只回答「能不能进」，不回答「进哪里」。** 入口门的全部价值来自「隧道地址不被泄露」——泄露即门失效。

---

## 1. 数据模型 —— Hub 侧 `remote_endpoints`

语义：**通道端点注册表**（替代 `hub_instances` 的「在线实例」语义；`hub_instances` 保留为 legacy 兜底，见 §8.3）。

### 1.1 字段表（`remote_endpoints`）

| 字段 | 类型 | 必填 | 默认 | 说明 / 不变量 |
|---|---|---|---|---|
| `id` | text | ✓ | — | 主键，形如 `ep_<ulid>` |
| `userId` | text | ✓ | — | FK → `users.id`；归属校验与入口门唯一依据 |
| `instanceName` | text | ✓ | `'My Markus'` | 展示名 |
| `kind` | text(enum) | ✓ | — | 见 §1.2 枚举；写库前必须校验 |
| `publicUrl` | text | ✓ | — | 隧道公网地址；**仅 `https:`**、长度 ≤ 512（S5） |
| `verifyToken` | text | ✓ | — | 归属校验挑战串；**绝不回传给客户端**（S1） |
| `verifyPath` | text | ✓ | `/api/remote/verify` | 校验探测路径 |
| `verifiedAt` | text \| null | — | `null` | `null` = 未校验 → **入口映射不生效** |
| `secretHash` | text \| null | — | `null` | `sha256(secret)` hex；**绝不存明文、绝不回传** |
| `isActive` | integer | ✓ | `0` | 1 = 该用户当前唯一 active 端点 |
| `lastSeenAt` | text \| null | — | `null` | 心跳/最近在线 |
| `health` | text(enum) | ✓ | `'unknown'` | 见 §1.2 |
| `createdAt` | text | ✓ | now ISO | |
| `updatedAt` | text | ✓ | now ISO | 每次 PATCH 刷新 |

### 1.2 枚举（与 `contract.ts` 逐字一致）

```ts
REMOTE_ENDPOINT_KINDS = [
  'cloudflare_quick',   // cloudflared --url 零配置，随机域名，重启会变
  'cloudflare_named',   // 自有域名 + 命名隧道，稳定（非随机，一等公民）
  'tailscale_funnel',   // tailscale funnel，公网 *.ts.net，稳定
  'tailscale_serve',    // 仅 tailnet 内，不经 Hub（仅引导用 kind）
  'custom',             // 自建反代 / FRP / ngrok / 其他（P3 高级项归此类，暂不单列）
]

REMOTE_ENDPOINT_HEALTH = ['unknown', 'up', 'down']
```

> **冻结决策**：设计稿 §7.4 的 `mode` 曾列出 `frp`/`ngrok`。本期（P0+P1）**注册表 kind 只有上表 5 个**；FRP/ngrok 统一落 `custom`。**不新增 kind**，直到有任务显式扩表。

### 1.3 约束与索引（S2）

- **partial unique index**：`uniqueIndex('idx_endpoints_active').on(userId).where(sql\`isActive = 1\`)`
  - 语义 = **每用户至多 1 个 active**；**非 active 不限**。
  - ⚠️ **不得**写成 `uniqueIndex(...).on(userId, isActive)`：SQLite 下同一用户的第 2 个非 active 行会因 `(uid, 0)` 重复而插入失败 → 实际退化成「每用户至多 2 行」。
- 普通索引：`idx_endpoints_user(userId)`、`idx_endpoints_puburl(publicUrl)`。
- `MAX_ENDPOINTS_PER_USER = 5`（每用户端点数量上限）。
- 迁移必须**幂等**（跑两次同结果）。

### 1.4 对外投影 `RemoteEndpointDTO`（API 响应形状）

`RemoteEndpointDTO` **只含**：`id, kind, instanceName, publicUrl, verifyPath, verified, verifiedAt, isActive, lastSeenAt, health, createdAt, updatedAt`。
**绝不包含** `verifyToken` / `secretHash` —— 任何 API 响应漏出二者即违反 S1。

---

## 2. Hub API 契约

基址：Hub 服务（生产 `https://www.markus.global`）。除标注 **PUBLIC** 外，全部需 Hub 登录令牌。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/remote/endpoints` | Hub 令牌 | 创建/替换端点 → 返回 `{endpointId, verifyToken, verifyPath}` |
| `GET` | `/api/remote/endpoints` | Hub 令牌 | 列出当前用户全部端点（`RemoteEndpointDTO[]`） |
| `PATCH` | `/api/remote/endpoints/:id` | **Hub 令牌 _或_ HMAC 签名** | 轮换 `publicUrl` / 心跳 `lastSeenAt` / 改 `health` / 置 `isActive` |
| `DELETE` | `/api/remote/endpoints/:id` | Hub 令牌 | 注销端点，同时下线入口映射 |
| `POST` | `/api/remote/endpoints/:id/verify` | Hub 令牌 | 触发/重试归属校验；成功时**一次性**发放 `secret` |
| `GET` | `/api/remote/entry/:username` | **PUBLIC** | 仅返回 `{status}`；响应体/头**绝不含** `target`/隧道地址（S1） |
| `GET` | `/api/remote/verify` | 无（**本地** verify-server） | 经隧道可达；返回待校验 `verifyToken` |

### 2.1 `POST /api/remote/endpoints` → 201

请求体 `CreateEndpointRequest`：`{ kind: RemoteEndpointKind, publicUrl: string, instanceName?: string }`

响应 `CreateEndpointResponse`：
```json
{ "endpointId": "ep_…", "verifyToken": "…", "verifyPath": "/api/remote/verify" }
```
- `verifyToken` **仅此一次**返回；客户端须持久化（本地配置）后经隧道回显。
- 校验失败：`invalid_kind` / `invalid_public_url` / `invalid_body` / `rate_limited`(429) / `conflict`(409，超出 `MAX_ENDPOINTS_PER_USER`)。
- 若带 `instanceName` 命中既有端点 → 视为「替换」（更新 `publicUrl`、重置 `verifiedAt=null`、重新发 `verifyToken`）。

### 2.2 `GET /api/remote/endpoints` → 200

`{ "endpoints": RemoteEndpointDTO[] }`（仅本人；按 `createdAt` 升序）。

### 2.3 `PATCH /api/remote/endpoints/:id` → 200

请求体 `UpdateEndpointRequest`（≥1 字段）：
```ts
{ publicUrl?: string; lastSeenAt?: string; health?: RemoteEndpointHealth; isActive?: boolean }
```
响应 `{ "endpoint": RemoteEndpointDTO }`。

- 鉴权二选一（见 §3）：**(a)** `Authorization: Bearer <hub-token>`；**(b)** HMAC 签名头（仅轮换场景，无 Hub 令牌）。
- 归属铁律：端点必须属于该 `userId`，否则 `forbidden`(403)。
- `publicUrl` 变更须重跑 S5 校验；变更后 `verifiedAt` **重置为 `null`**（地址换了要重新证明归属）→ 触发重新校验。
- `isActive: true` 要求端点已 `verified`，否则 `conflict`(409)。
- 频率：复用 `rate-limit.ts`。

### 2.4 `DELETE /api/remote/endpoints/:id` → 200

`{ "ok": true }`。幂等：重复删除同一 id 亦返回 `{ ok: true }`（端点不存在 → `{ ok: true }`，不泄露存在性）。

### 2.5 `POST /api/remote/endpoints/:id/verify` → 200

响应 `VerifyEndpointResponse`：
```json
{ "verified": true, "secret": "…", "verifiedAt": "2026-10-14T…Z" }
```
- `secret` **仅在本次 status 从「未校验」变为「已校验」时出现**；重复校验成功时**不再返回 `secret`**（`secret` 只发一次）。
- 失败 → `verify_failed`(502)，`message` 携带失败原因（见 §4.3 枚举 `VerifyFailureReason`）；目标被 SSRF 拦截 → `verify_target_blocked`(400)。

### 2.6 `GET /api/remote/entry/:username` → 200 ｜ PUBLIC

响应 `EntryStatusResponse`：`{ "status": "inactive" | "pending" | "down" | "ready" }`

| status | 含义 |
|---|---|
| `inactive` | 该用户名下无端点 |
| `pending` | 有端点但未校验 / 未 active |
| `down` | 已校验 + active，但 `health = 'down'` |
| `ready` | 已校验 + active + `health = 'up'` |

- **严格约束（S1）**：响应体与响应头**绝不含** `target` / `publicUrl`；`target` 只允许出现在**鉴权通过后的 302 `Location`**（见 §2.8）。
- 防枚举：IP 级限流 + 恒定响应时延；未知用户名与存在但无端点返回**同一形状**。

### 2.7 `GET /api/remote/verify`（本地 verify-server）→ 200

响应 `LocalVerifyResponse`：`{ "token": "<verifyToken>" }`，`Content-Type: application/json; charset=utf-8`。
- **仅**由本地 API 提供；经隧道对外可达；本地回环也允许读（自测）。
- 无待校验 token 时返回 `{ "token": "" }`。

### 2.8 入口域名路由（中间件 · 含鉴权门）

替换现有 `_remote_user` 壳逻辑；针对 `Host: {username}.remote.markus.global`：

```
① 验 Hub 会话 cookie（Domain=.markus.global，见 S6）→ userId
     无/失效 → 302 https://www.markus.global/auth/login?redirect=<入口URL>
② 查 users.username={username} → ownerUserId
     端点 verified && active && endpoint.userId === 登录 userId   ← 鉴权门
        否     → 403「无权访问此入口」（响应体不含隧道地址）
        无端点 → 200 友好页「尚未开启远程访问」
        端点 down → 503 友好页「通道离线，正在恢复」
③ 通过 → 302 Location: {endpoint.publicUrl}   ← 仅此分支才回传隧道地址
```

> legacy 灰度为**兜底**：无可用隧道端点时，入口回落旧壳（`relay_legacy`）。见 §8.3。

### 2.9 错误码表（冻结 · 与 `REMOTE_ERROR_CODES` 逐字一致）

所有非 2xx 响应使用统一信封 `{ "error": RemoteErrorCode, "message": string }`。

| code | HTTP | 触发 |
|---|---|---|
| `unauthorized` | 401 | 缺/无效 Hub 令牌或 HMAC 签名 |
| `forbidden` | 403 | 已鉴权但非端点所有者 |
| `not_found` | 404 | 端点 / 用户名不存在 |
| `invalid_kind` | 400 | 未知 `kind` |
| `invalid_public_url` | 400 | `publicUrl` 未过 S5 校验 |
| `invalid_body` | 400 | JSON 畸形 / 缺必填 |
| `signature_expired` | 401 | 时间戳超 ±300s 时钟窗（S3） |
| `signature_replayed` | 401 | nonce 复用（S3） |
| `verify_failed` | 502 | 探测失败/token 不匹配 |
| `verify_target_blocked` | 400 | SSRF 拦截 |
| `rate_limited` | 429 | 触发限流 |
| `conflict` | 409 | 未校验却置 active / 超数量上限 |
| `method_not_allowed` | 405 | 方法不支持 |

---

## 3. 鉴权口径

### 3.1 模式 (a) · Hub 令牌（owner 作用域全路由）

`Authorization: Bearer <hub-token>`。令牌即 CLI 保存在 `~/.markus/hub-token` 的同一串；Hub 侧 `ctx.getAuth(req)` 解得 `{ userId, username }`。所有 owner 作用域路由用它。

### 3.2 模式 (b) · HMAC 轮换签名（仅用于 `PATCH` 轮换 URL）

用途：快速隧道重启后 URL 变了，CLI 需要**在无 Hub 令牌往返的前提下**改自己端点的地址。凭据 = 校验通过时一次性发放的 **per-endpoint `secret`**。

**签名请求头**（常量 `SIGNATURE_HEADERS`，值即下方小写字面量；HTTP 头名大小写不敏感）：

| 头（`SIGNATURE_HEADERS` 常量值） | 内容 |
|---|---|
| `x-markus-timestamp` | Unix **秒**（十进制字符串） |
| `x-markus-nonce` | 随机串，长度 16–64，字符集 `[A-Za-z0-9_-]` |
| `x-markus-signature` | `v1=<hex>`，`<hex>` = `hex(HMAC-SHA256(secret, canonical))` |

**规范串 `canonical`（唯一算法，由 `buildRotationCanonicalString()` 生产）**——6 行，LF (`\n`) 连接，**无尾随换行**：

```
v1
<METHOD 大写>
<path，不含 query>
<bodyHash，小写 hex sha256(原始 body)；无 body 时为空串 ''>
<timestamp>
<nonce>
```

**为什么用 `\n` 而不是设计稿写的 `|`**：URL path 或字段值里可合法出现 `|`，用 `|` 连接会产生**歧义规范串**（两个不同输入得出同一 canonical）。LF 不可能出现在任一字段中，故无歧义。**这是契约冻结时的正式决定，覆盖设计稿草稿里的 `|` 记法。**

**服务端校验顺序（缺一不可）**：
1. 头齐全，否则 `unauthorized`。
2. `|now - timestamp| <= SIGNATURE_MAX_SKEW_SECONDS (300)`，否则 `signature_expired`。
3. nonce 未在**新鲜度窗口内**用过（短期去重表，容量 = 窗口内请求量上界），否则 `signature_replayed`。
4. 用该 `id` 对应端点的 `secret`（DB 里存的是 `secretHash`，需按端点持有的明文校验路径来确定比对——实现口径：Hub 存 `secretHash`，故用「候选明文 → 比对 hash」不可行；**实现须为端点保存可用于 HMAC 的密钥材料**）。→ **见下方实现注意**。
5. 重算 `canonical` → **常量时间比较**签名，不等 → `unauthorized`。
6. 端点 `userId` 与签名绑定者一致（由 secret 归属保证）。

> **实现注意（T3 必须落实）**：`secret` 用于 **HMAC（对称）**，服务端**必须能拿到密钥明文**才能验签。因此 DB 除 `secretHash`（用于「只存储不自证」的审计口径）外，还须保存 `secret` 的可逆/直接副本，**或**改为「服务端存 `secret` 明文、对外只发一次」的单一口径。**冻结选择**：`remote_endpoints` 增列 `secretCipher`（服务端加密存储，密钥来自环境），HMAC 验签用解密后的 `secret`；`secretHash` 仅用于「发放一次性 / 防重复发放」判定。**T2 迁移须包含 `secretCipher` 列**（本契约的字段表 §1.1 之外，T2 需补该列并在 T3 落地验签）。见 §9 变更记录 CR-1。

### 3.3 凭据落盘（密钥纪律）

`hub-token`、per-endpoint `secret` **绝不写 `markus.json`**；统一走 `provider-secrets.ts` → `~/.markus/.env`（唯一密钥写入口）。

---

## 4. challenge-response 归属校验协议

### 4.1 时序

```
① CLI  POST /api/remote/endpoints {kind, publicUrl}
        ◄─ {endpointId, verifyToken, verifyPath}      ← verifyToken 持久化到本地配置
② CLI  本地暴露 GET {verifyPath}（经隧道对外）→ { token: <verifyToken> }
③ Hub  SSRF 防护下 GET https://{host}{verifyPath}
        ◄─ { token }  ；比对 token === verifyToken
        一致 → verifiedAt 落库 + 发放 secret（一次性，存 secretHash/secretCipher）
        不一致/失败 → verifiedAt 保持 null（入口映射不生效），报 verify_failed
④ 校验通过前：入口 status = pending；入口域名不返回隧道地址
```

### 4.2 关键不变量

- Hub **绝不信任**客户端的「我拥有它」声明；归属永远由**回程探测**证明。
- `verifyToken`/`secret` **只发一次**；重复 `verify` 成功**不再回传 `secret`**。
- 探测目标 = `publicUrl + verifyPath`；`verifyPath` 默认 `/api/remote/verify`。

### 4.3 失败原因（`VerifyFailureReason`，随 `verify_failed` 的 `message` 返回）

`unreachable` · `non_https` · `blocked_target` · `too_many_redirects` · `response_too_large` · `token_mismatch` · `malformed_response`

### 4.4 探测口径常量

| 常量 | 值 |
|---|---|
| `VERIFY_FETCH_TIMEOUT_MS` | 5000 |
| `VERIFY_MAX_REDIRECTS` | 3 |
| `VERIFY_RESPONSE_MAX_BYTES` | 65536 |
| `VERIFY_SECRET_BYTES` | 32（base64url，无 padding） |
| 协议版本 | `SSRF_POLICY_VERSION = '1.0.0'` |

---

## 5. 状态事件 `RemoteStatusV2`（`remote:status` WS 载荷）

前端复用既有 `remote:status` WebSocket 事件，**载荷字段扩展为 V2**：

```ts
interface RemoteStatusV2 {
  enabled: boolean;
  mode: RemoteMode;          // = RemoteEndpointKind ∪ {'relay_legacy'}
  state: RemoteState;        // idle|installing|starting|verifying|ready|degraded|error
  entryUrl:  string | null;  // https://{user}.remote.markus.global（稳定入口）
  publicUrl: string | null;  // 隧道实际地址（302 目标）
  health: RemoteEndpointHealth;   // unknown|up|down
  latencyMs?: number;
  message?: string;          // 可操作提示，如「未检测到 cloudflared」
}
```

- `mode` = 注册表 `kind` 全集 **+ `relay_legacy`**（灰度期旧中继上报）。**不新增其它 mode**。
- `state` 语义：`idle` 未开 · `installing` 装依赖 · `starting` 拉进程 · `verifying` 待归属校验 · `ready` 就绪 · `degraded` 在线但降级 · `error` 失败（`message` 给可行动提示）。
- 既有 `RemoteAccessStatus`（`agent.ts`）**仅保留给 `relay_legacy`**；新代码一律用 V2。
- 广播点：`packages/org-manager/src/api-server.ts`（现有 `ws.broadcast({type:'remote:status', payload})`）——V2 为唯一载荷形状。

---

## 6. Agent 代跑任务契约（路径 B · 一键交给 Agent）

向导可把「安装并配置隧道」派发给某个 Agent。任务**必须以固定结构表达**（不得自由散文），保证 Agent 可确定性执行、用户可预期。

```ts
interface AgentTunnelTaskContract {
  goal: string;                                  // 一句话目标
  commands: AgentTunnelTaskCommand[];            // {shell, run, purpose, sensitive, idempotent}
  successCriteria: AgentTunnelTaskSuccessCriterion[]; // {id, description, check}
  rollback: AgentTunnelTaskRollbackStep[];       // {description, run|null}
}
```

| 字段 | 约束 |
|---|---|
| `goal` | 单句、可判定 |
| `commands[].shell` | `'sh'` \| `'powershell'` |
| `commands[].run` | **可原样复制执行**的完整命令行 |
| `commands[].sensitive` | `true` → Agent 执行前**必须取得用户显式同意**（写 `~/.markus/.env`、装系统服务等） |
| `commands[].idempotent` | 重试安全性提示 |
| `successCriteria[].check` | 一条「退出码 0 / 输出即可判定」的核验命令 |
| `rollback[].run` | 反向命令；纯说明步骤可为 `null` |

- 安全：Agent 执行安装**不绕过同意**（用户是点「交给 Agent」的人）；敏感操作在任务里显式列出。
- 复用平台既有 Agent + shell + task 能力，**不新增专用执行通道**。
- 完事后 Agent **回报 `RemoteStatusV2`**，前端据此切「就绪」。

---

## 7. 安全条款（S1–S6 · 每片实现须给「先红 → 后绿」证据）

| # | 条款 | 可测判据 |
|---|---|---|
| **S1** | 未授权响应体绝不出现隧道地址 | 未鉴权请求入口域名 / `GET /api/remote/entry/*` → 响应体与头 **grep 不到** `publicUrl`；`target` 仅出现在鉴权通过后的 302 `Location` |
| **S2** | partial unique index | 同用户可插 N 个非 active 端点；插第 2 个 active 必失败；迁移幂等（跑两次同结果） |
| **S3** | 轮换 HMAC 新鲜度 | 签名含 `timestamp+nonce`；超时钟窗(±300s) 或 nonce 复用 → 401；**原样重放必失败** |
| **S4** | SSRF 完整黑名单 + IP pin | 见 §7.1 黑名单全集；**解析一次 → pin 到该 IP → 连接**（禁止二次解析，防 DNS rebinding）；重定向**每跳复检**；≤3 跳 / 5s / ≤64KB |
| **S5** | `publicUrl` / `Location` 严格校验 | 仅 `https:`；拒 userinfo（`@`）；拒 CRLF 与 `%0d%0a` 及编码绕过；长度 ≤512；非法 → 400 **且不落库** |
| **S6** | 会话 cookie | `Domain=.markus.global` **必须带** `HttpOnly; Secure; SameSite=Lax`；本契约明确跨子域暴露面与是否用 `__Host-` 前缀，**不留到实现期**（见 §7.2） |

### 7.1 SSRF 拒绝网段全集（`SSRF_BLOCKED_CIDRS`）

`0.0.0.0/8` · `10.0.0.0/8` · `127.0.0.0/8` · `169.254.0.0/16` · `172.16.0.0/12` · `192.168.0.0/16` · `100.64.0.0/10`(CGNAT) · `::1/128` · `fc00::/7` · `::ffff:0:0/96`(IPv4-mapped) · `64:ff9b::/96`(NAT64)

**探测顺序（`SSRF_POLICY_VERSION 1.0.0`，常量声明一次）**：
1. scheme 必须 `https:`；
2. 目标主机**只解析一次**，任一解析结果落上述网段 → 拒绝；
3. **pin 到该 IP 再连接**（禁止二次解析）；
4. 每跳重定向重跑 1–3，超 `VERIFY_MAX_REDIRECTS` 停；
5. 强制 `VERIFY_FETCH_TIMEOUT_MS` 与 `VERIFY_RESPONSE_MAX_BYTES`。

### 7.2 S6 定死（跨子域会话，对应设计开放项 O3）

- **定死**：入口域名与登录页共享登录态，cookie `Domain=.markus.global`，属性 `HttpOnly; Secure; SameSite=Lax`。
- 暴露面：**仅 `*.markus.global` 子域可读**，绝不跨外部域；不使用 `__Host-` 前缀（该前缀要求 `Domain` 为空，与跨子域需求冲突——二者不可兼得，**本契约选跨子域**）。
- 未登录/非所有者：入口**服务端**返回 302→登录 / 403；**壳可被绕过**，鉴权绝不放前端。
- 诚实边界（写入 UI 与文档）：**302 一跳后隧道地址落入地址栏，地址一旦暴露即收不回** → 入口门是**第一道**，隧道侧 Markus 自身登录是**根本防线**；强烈建议叠加 Cloudflare Access / Tailscale ACL。**不得**让用户误以为「入口有门 = 绝对安全」。

---

## 8. 本地侧契约（CLI）

### 8.1 `RegistryClient`（新增 · T7）

对上述 Hub API 的薄封装，方法集与 §2 一一对应：

| 方法 | 对应 |
|---|---|
| `register(input: CreateEndpointRequest): Promise<CreateEndpointResponse>` | §2.1 |
| `list(): Promise<RemoteEndpointDTO[]>` | §2.2 |
| `update(id, input: UpdateEndpointRequest, opts?: { signWithSecret?: string }): Promise<UpdateEndpointResponse>` | §2.3（`signWithSecret` 存在时走 HMAC） |
| `remove(id): Promise<void>` | §2.4 |
| `verify(id): Promise<VerifyEndpointResponse>` | §2.5 |

HUb 基址：`config.remote.hubUrl ?? config.hub.url ?? 'https://www.markus.global'`；令牌：`~/.markus/hub-token`。

### 8.2 `verify-server`（本地 `/api/remote/verify` · T7）

返回 `LocalVerifyResponse`（§2.7）。数据源 = `TunnelManager` 当前持有的 `verifyToken`（单一事实源，不得二次缓存）。

### 8.3 `config.remote` 扩展（T8）

现状：`{ enabled?, autoConnect?, hubUrl?, instanceName? }`。
扩展（意图 + 当前隧道信息；**端点权威状态在 Hub 注册表，本地不重复写**）：

```ts
remote?: {
  enabled?: boolean;
  autoConnect?: boolean;
  hubUrl?: string;
  instanceName?: string;
  // ── 新增 ──
  mode?: RemoteEndpointKind;     // 用户选择的通道
  localPort?: number;            // 隧道指向端口，默认 server.apiPort ?? 8056
  activeEndpointId?: string;     // 当前端点 id（权威状态仍在 Hub）
  // 注意：secret 绝不落 markus.json → 走 provider-secrets.ts → ~/.markus/.env
}
```

### 8.4 `RemoteStatusV2` 事件接线（T8）

`RemoteAccessAgent.getStatus()` 的 V2 实现 + `api-server.ts` 广播点载荷切换为 `RemoteStatusV2`（`type:'remote:status'` 不变，仅 `payload` 形状升级）。

### 8.5 legacy 兜底

`hub_instances` / `/api/remote/instances` / `remote-shell.ts` / signal / TURN **本期保留**（`relay_legacy`）；入口「优先隧道，无隧道回落旧壳」。P2 删除（见设计 §8）。

---

## 9. 契约变更策略 & 冻结记录

### 9.1 版本与变更

- `REMOTE_CONTRACT_VERSION`：破坏性变更递增主/次版本；改动**必须**同时更新本文件 + `contract.ts` + `contract.test.ts` 探针。
- **漂移防线**：`packages/remote/test/contract.test.ts` 逐值锁死枚举 / CIDR / 限值 / canonical 算法；下游任务改契约而不改探针 → 探针变红。
- Hub 仓镜像：本契约变动时，`markus-hub` 侧镜像类型须同步（T2/T3/T5 责任）。

### 9.2 冻结记录（相对设计稿的**正式决定**）

| CR | 项 | 决定 | 理由 |
|---|---|---|---|
| **CR-1** | 服务端 HMAC 验签密钥 | `remote_endpoints` 除 `secretHash` 外**增列 `secretCipher`**（服务端加密存储）；HMAC 用解密后的 `secret`，`secretHash` 仅用于「一次性发放 / 防重复发放」判定 | HMAC 是对称验签，服务端必须持有密钥明文；仅存 hash 无法验签。T2 迁移须含该列 |
| **CR-2** | canonical 分隔符 | 用 **LF (`\n`)**，不用设计稿的 `|` | `|` 可合法出现在 path/值中 → 歧义规范串；LF 不可能出现在任一字段 |
| **CR-3** | `mode` 枚举 | = `RemoteEndpointKind ∪ {'relay_legacy'}`，**删去**设计稿草列的 `frp`/`ngrok` | P0/P1 不落地 FRP/ngrok；统一归 `custom`，避免「枚举列了却不实现」的漂移 |
| **CR-4** | cookie 前缀 | 用 `Domain=.markus.global`，**不用** `__Host-` 前缀 | `__Host-` 要求 `Domain` 为空，与跨子域共享登录态**不可兼得**；本需求选跨子域（O3 定死） |
| **CR-5** | `GET /api/remote/verify` 响应 | JSON `{ token }`（`application/json; charset=utf-8`） | 可扩展、无编码歧义；空 token 返回 `{ "token": "" }` |

### 9.3 与设计稿的关系

- 本契约**覆盖** `remote-access-design.md` 中与本文件冲突的草稿记法（上表 CR-2/CR-3/CR-4）。
- 设计稿 §7.4 的 `mode` 列表、§3.4 的 `HMAC(secret, method|path|...)` 记法以**本契约**为准。
- 其余（入口鉴权门 §3.5、选型 §4、TunnelManager §5、向导 §6）保持设计稿不变。

### 9.4 待定项（不阻塞 P0 · 沿用设计 §10.2.1）

- **O1**：入口门是否支持「非所有者成员访问」（团队共享）？—— 建议 P3，归属判定扩展为 `endpoint.userId===userId || allowedUserIds.includes(userId)`。
- **O2**：Agent 代跑（路径 B）的默认接收 Agent —— 建议指定一个运维/秘书类 Agent（T10 定）。
- **O3**：跨子域 cookie —— 本契约 §7.2 已按「允许」定死口径，实现期若安全评审否决，须回来走 CR。




