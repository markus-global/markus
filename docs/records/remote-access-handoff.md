# 远程访问重构 · 交付说明与手动验证（T10 收口）

> 作者：CTO · 2026-10-14 · 状态：**交老板手动合入前的交付说明**
> 需求：`req_656422cc529a09e31cd04990` · 设计：`remote-access-design.md`(v2) · 契约：`docs/architecture/remote-access.md`（冻结 v1.0.0）
> 一句话：**用户自带隧道（Cloudflare / Tailscale）＋ Hub 只做入口域名 / 端点注册表 / 登录鉴权门**，数据通路不再经过我们的服务器。

---

## 1. 这次交付了什么

| 片 | 内容 | 分支 / 提交 |
|---|---|---|
| T1 | 冻结契约（枚举 / 错误码 / 签名串 / SSRF 表 / 探针阈值） | `feat/remote-access-tunnel` 基线 |
| T2 | Hub 端点注册表 schema + 迁移 | → `42b4385` |
| T6 / T7 | TunnelManager（cloudflared / tailscale provider）、RegistryClient + verify-server | 同上 |
| T8 | 本地 CLI / api-server 接线 + `RemoteStatusV2` | `ae16de96` |
| T9 | Web-UI 开通向导 + 就绪面板 + i18n(zh/en/es) + 文档 | `3af312d9` |
| T3 | Hub 端点 API + 归属校验（challenge-response + SSRF 防护 + secret 发放） | `feat/remote-endpoints` `a6d6241` |
| T5 | 入口域名 302 + 登录鉴权门 + legacy 灰度回落 | `feat/remote-endpoints` `88e6a61` |
| **T10** | **路径 B（一键交 Agent 代跑）+ 端到端集成收口**（本片） | `feat/remote-access-t10` |

**本片（T10）新增**
1. **路径 B**：向导「交给 Agent」→ 生成结构化任务契约（`goal / commands[{shell,run,purpose,sensitive,idempotent}] / successCriteria / rollback`）→ 用户**自选**接收 Agent → 派发 → 进度回报 → 完成后前端自动切「就绪」。复用平台既有 Agent + shell + task 能力，**不新增专用执行通道**。
2. **跨仓集成收口**：修掉 T8↔T9 的路由契约接缝（前端声明 `/tunnel/{restart,rotate,stop,register}` + `/detect`，T8 只实现了 `/restart`、`/rotate`）。
3. **T3⇄T5 语义漂移归零**：`health='unknown'` 曾出现 T3 判 `pending`、T5 判 503 `down` 的分歧 → 收敛为**单一事实源** `entry-status.ts#entryStatusOf()`，两个消费方共用，并配跨组件一致性测试（含变异检验）。
4. **本地端到端 harness**：真 Hub + 真 `cloudflared` 隧道 + 真归属探针（走公网往返）+ 真入口门 302 → **19/19 断言绿**。

---

## 2. 给老板的分步手动验证脚本

> 目标：在你自己的机器上亲手跑通「点一下 → 手机打开自己的 Markus，数据不经我们」。

### 2.1 一键端到端（推荐先跑这个）

```bash
cd <markus 仓库>/worktrees/markus-ra-t10     # 或合入后的主仓
bash scripts/e2e/remote-access-e2e.sh
```

它会自动：起一个"我的 Markus"替身 App → 起**真 cloudflared 快速隧道**指向它 → 起**真 Hub**（临时库）→ 注册用户/端点 → 让 Hub **经公网**探针校验归属 → 校验入口门四种分支。
期望输出结尾：`═══ RESULT: 19 passed, 0 failed ═══`

它逐条验证的关键行为：
- ✅ 公网隧道直达本机（**数据通路不经我们**）
- ✅ 未登录访问入口 → 302 到登录页，且**响应体与响应头都不含隧道地址**（S1）
- ✅ 公开状态端点 `/api/remote/entry/:username` 只回 `{status}`，**不含隧道地址**（S1）
- ✅ 登录用户访问自己入口 → **302，`Location` 逐字等于 `publicUrl`**（见 §3 已知行为）
- ✅ **他人**访问你的入口 → 403，且不泄露隧道地址

### 2.2 手动分步（想自己掐每一步时）

```bash
# ① 起本机 App 替身（真机可换成 `markus start` 后的本地端口）
node scripts/e2e/tunnel-target-stub.mjs &
# ② 起隧道，记下打印的 https://xxx.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:18056
# ③ 起 Hub（临时库，避免污染）
cd <markus-hub 仓库> && DATABASE_PATH=/tmp/hub-e2e.db JWT_SECRET=e2e npx tsx src/server/index.ts
# ④ 注册用户（拿会话 cookie）
curl -i -X POST localhost:3003/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"you","email":"you@example.com","password":"<pw>"}'
# ⑤ 注册端点 → 记下 verifyToken / verifyPath，让替身 App 在该路径回 {"token":"<verifyToken>"}
curl -X POST localhost:3003/api/remote/endpoints -H "Cookie: hub_token=<t>" \
  -H 'content-type: application/json' -d '{"kind":"cloudflare_quick","publicUrl":"<隧道URL>"}'
# ⑥ 触发归属校验（Hub 会经公网探针回访）
curl -X POST localhost:3003/api/remote/endpoints/<id>/verify -H "Cookie: hub_token=<t>"
# ⑦ 入口门（本地用 ?_remote_user= 模拟 Vercel 边缘把 Host 改写成的形态）
curl -i 'localhost:3003/api?_remote_user=you'                        # 期望 302 → /auth/login
curl -i -H "Cookie: hub_token=<t>" 'localhost:3003/api?_remote_user=you'  # 期望 302 → 隧道URL
```

> 本地是用 `?_remote_user=` **模拟**边缘改写；生产由 Vercel `middleware.ts` 把 `Host: {user}.remote.markus.global` 改写成该查询参数。这是 §4 风险 ④ 的来源。

---

## 3. 已知行为（措辞与实现严格一致）

1. **入口门 302 的 `Location` 逐字等于该端点的 `publicUrl`，不拼接任何深链 path/query。**
   即：你请求 `https://{user}.remote.markus.global/some/deep/path?a=1`，`Location` 仍然是 `https://xxx.trycloudflare.com`（根），**深链由隧道侧自行处理**。这是当前实现，不是"将来会做路径拼接"。
2. `health='unknown'`（尚未探针过的瞬态）在**所有**展示口径下都读作"尚未就绪"（`pending`），**绝不**读作"通道离线"。
3. 入口门对 **非 GET/HEAD** 与非法用户名**不做处理**（交还后续路由）。
4. 未校验（pending）的端点走 **200「尚未开启」**页，不是 302。
5. 未鉴权一律不返回隧道地址：**响应体与响应头都没有 `publicUrl` / target**。

---

## 4. 待部署验证项（**未在本地端到端环境验证**）

### 4.1 跨子域 cookie（`Domain=.markus.global`）

入口子域 `{user}.remote.markus.global` 要能读到主站登录态，`hub_token` 必须带 `Domain=.markus.global`（T5 已改）。**本地 localhost 下 Domain 属性会被浏览器省略，因此本地无法证伪，必须在真实域名上复验。**

最小验证步骤：
```bash
# ① 直测 Set-Cookie 三属性（放到真实域名上跑）
curl -i -X POST https://www.markus.global/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"you","password":"<pw>"}' \
  | grep -i '^set-cookie'
# 期望看到：hub_token=…; Path=/; Domain=.markus.global; HttpOnly; Secure; SameSite=Lax(或 Strict)
# 注意：不要用 __Host- 前缀 —— 它与 Domain 互斥（契约已冻结该取舍）
```
```
# ② 浏览器跨子域登录态可达
#   在 www.markus.global 登录后，直接访问 https://{user}.remote.markus.global
#   期望：不再跳登录页，而是 302 到隧道地址（说明入口子域读到了主站 cookie）
```

### 4.2 其余部署复验

| 项 | 为什么本地测不了 | 怎么验 |
|---|---|---|
| 真实 `{user}.remote.markus.global` 边缘改写 | 本地用 `?_remote_user=` 模拟 | 部署后直接访问入口域名，看是否 302/403/200 分支正确 |
| Cloudflare **命名**隧道（自有域名） | 需自有域名 + CF 账号 | 向导选「命名隧道」，跑通后确认 URL 稳定不轮换 |
| Tailscale Funnel / Serve | 需 tailnet | 分别验「公网可达」与「仅 tailnet 内」两种形态 |
| 轮换（rotate）后入口跟随 | 需真实 tunnel 生命周期 | 轮换 URL 后重访入口，`Location` 应指向新地址 |
| legacy 旧中继灰度回落 | 需真有旧 `hub_instances` 用户 | 老用户未开通新隧道时，入口应回落到旧壳而非报错 |

---

## 5. 残余风险清单（**必须保留，不得在文档中消失**）

1. **第三方隧道可达性 / 快速隧道不稳。** Cloudflare Quick Tunnel 是随机的 `*.trycloudflare.com`，**重连后 URL 会变**。我们靠「隧道地址自动同步 + 轮换」兜底，但同步窗口内入口可能短暂指向失效地址。用户长期使用应引导到**命名隧道**（自有域名，一等公民）。
2. **公开 entry 状态端点仍暴露侧信道。** `GET /api/remote/entry/:username` 返回 `{status}`，会泄露「该用户名是否存在 + 其隧道 up/down」。当前缓解仅靠 **IP 限流（60/min）+ 常量底延迟（默认 250ms，可 env 调）**，属**尽力而为**、**非密码学恒定时间**。**这是已知且被接受的取舍**——如实记录于此，不因为"看起来是安全问题"就从文档里删掉。
3. **跨子域 cookie（`Domain=.markus.global`）。** 见 §4.1：真机未验；且 `__Host-` 前缀与跨子域不可兼得（已选跨子域）。若未来要 `__Host-`，必须改为在入口子域单独发一份 cookie。
4. **本地端到端环境与生产存在差异。** 本地用 `?_remote_user=` 模拟边缘改写，生产走真实 DNS + Vercel middleware；本地 temp DB，生产是远程 Turso（**libsql 事务语义不同**——本地嵌入式与远程 hrana 行为不一致，已在别处踩过坑）。**绿在本地 ≠ 绿在生产。**
5. **边界说明：入口门是「第一道」，隧道侧登录才是「根本」。** 302 一跳后，隧道地址进入浏览器地址栏，地址本身即凭据（持有者可直连）。因此生产必须叠加 **Cloudflare Access / Tailscale ACL** 作为第二道防线。入口门解决的是"从我们域名进不来"，**不等于**"隧道绝对安全"。

---

## 6. 未做项（P2 / P3，如实列出）

- **P2**：团队共享访问（多成员访问同一入口，契约中的 O1）——本期只做「一人一入口」。
- **P2**：入口门 302 **深链透传**（现在 `Location` 只到根，深链 path/query 丢失，依赖隧道侧自行处理）。
- **P2**：旧 WebRTC 中继代码的**物理删除**（现仅灰度不回落到新路径，代码仍在）。
- **P3**：nonce 防重放的**共享存储**（现为进程内窗口，容量 10000 / 窗口 2×300s）——Hub 多实例部署前必须替换，代码注释已标注。
- **P3**：`pricing.test.ts` 的 `SQLITE_BUSY`（迁移期多进程争用默认 DB）——**既有缺陷**，已在基线复现，与本需求无关，建议另立修复单。
- **P3**：路径 B 的**真机端到端**（真 cloudflared + 真 Agent 跑完安装）——本期以「集成级 E2E（真 HTTP 处理器 + 真 Agent 注册表）」+「隧道/Hub 半程真 cloudflared E2E」覆盖，**Agent 真正执行安装那一步未在真机跑通**。

---

## 7. 合入前状态

- 两个仓均为**本地分支，未 push、未动 main**（遵循本重构硬约束）。
- markus：`feat/remote-access-t10`；markus-hub：`feat/remote-endpoints`。
- 逐片保留独立可回滚提交（T2 → T8 → T9 → T3 → T5 → T10）。
- 验证结论见 §8。

## 8. 本片验证证据（摘要）

| 验证 | 结果 |
|---|---|
| 跨仓本地端到端 harness（真 cloudflared + 真 Hub + 真 302） | **19/19 断言绿** |
| Hub 目标测试（ssrf 44 + 端点 API 29 + 入口门 16 + 一致性 6） | **95/95 绿** |
| Hub `tsc --noEmit` 首方错误 | **0**（vendored 23 条为既有） |
| Hub 全量单测 | 1069/1070（唯一失败 `billing-gaps` cu_reset_at，**已在 merge-base 复现 = 既有**） |
| markus 全量单测 | 6969/6984（失败仅 1 条既有 `commands-start-integration` 端口冲突 + 若干负载型 timing flake，均在 pristine HEAD 复现） |
| markus `tsc -b` + web-ui typecheck | **exit 0** |
| 架构守卫 | ✓ 通过（31 命中全在白名单，契约不变量 11/11） |
| 牙齿检验 | 把 `entryStatusOf` 的 unknown 分支改成 `down` → 一致性测试**精确变红**；复原即绿 |
