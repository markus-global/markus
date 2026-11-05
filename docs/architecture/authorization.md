# 授权边界（Authorization）：Mandate × ResourceBinding

> **一句话**：**逐件事的许可（Mandate）** 与 **逐资源的授权（ResourceBinding）** 回答两个不同的问题，
> 任何一方都不能代替另一方。唯一判定点是 `authorizeAction()`（`packages/shared/src/types/thread.ts`）。
>
> 对应：需求 `req_2c95956482f0db9137b1255f` 的 A4 卡、契约 Q3 / **I5** / I8、设计 01 §7.4 / §7.6 / §7.8。

---

## 1. 两个轴，别混

| 概念 | 回答 | 粒度 | 落库 | 谁写 |
|---|---|---|---|---|
| **Mandate**（审批） | 这**一件事**能不能做 | 逐件事 | `approvals` 一行（`details.resource` + `details.actionScope`） | 审批链（人签字） |
| **ResourceBinding**（`scope` + `autonomy`） | 在这块地上我能**自主到什么程度** | 逐资源 | `resource_bindings` 一行 | `SqliteResourceBindingRepo.bind()` |

两个方向的混用都必须被拒：

| 错误方向 | 错误说法 | 判定点怎么拒 |
|---|---|---|
| ① autonomy 当审批用 | 「我是 `trusted` 档，所以这件事也算批了」 | `admin` 档动作只有 `mandate=approved` 才放行；`trusted` 不构成批准（`code: mandate-required`） |
| ② 审批当授权用 | 「这件事人批了，所以我可以越过 `observe`」 | `gateAction` 先判档位；`observe` 上限是 `record-only`，**不看 mandate**（`code: autonomy-observe`） |

设计 01 §7.4 的原话是这条边界的来源：**「`autonomy` 与 `scope` 必须正交」**。
本卡把第三条轴（mandate）也拆开，于是三者各占一个入参位：

```ts
authorizeAction({ binding, actionScope, mandate })
//  binding      ← resource_bindings 一行（逐资源上限 + 自主档）
//  actionScope  ← classifyToolAction()（这个动作有多难撤回）
//  mandate      ← approvals 里这件事批了没有（逐件事）
```

**把任意两者合成一个入参，当场编译不过。** 这是"不可互替"的结构表达，不是文档纪律。

---

## 2. 判定顺序（唯一，写死在函数里）

```
① binding 存在吗？            没有 → deny / no-binding      （缺 binding，不是"默认 observe"）
② 动作在 binding.scope 内吗？  不在 → deny / above-binding-scope（缺档位）
③ autonomy 允许这个动作吗？    off     → deny / autonomy-off
                              observe → record-only / autonomy-observe  ← 方向② 在这里被拒
                              auto/trusted + 非 admin → allow
④ 是 admin（L3）吗？           mandate=approved → allow
                              pending  → deny / mandate-pending
                              denied   → deny / mandate-denied
                              none     → deny / mandate-required     ← 方向① 在这里被拒
⑤ 以上都过 → allow
```

**为什么先 `scope`（逐资源）后 `mandate`（逐件事）**：binding 是**能力上限**，mandate 是**单次许可**。
反序会让人去批一件他根本授权不到的事 —— 白花人的注意力，而注意力是这套平台最贵的资源（Q4）。

顺序的唯一实现位置是函数体；行为测试 `packages/shared/src/types/thread.test.ts`
（「逐资源上限…先报缺档位而不是审批问题（顺序钉住）」）钉住它，改顺序会变红。

---

## 3. 唯一判定点在哪，谁在用它

| 角色 | 位置 | 说明 |
|---|---|---|
| **判定（唯一）** | `packages/shared/src/types/thread.ts` → `authorizeAction()` | 纯函数，零 IO。判定逻辑**只有这一份** |
| 工具名 → 档位 | `packages/shared/src/types/action-class.ts` → `classifyToolAction()` | 动作分级的唯一事实源（沿用） |
| 档位 × 动作语义 | `packages/shared/src/types/thread.ts` → `gateAction()` | 四档语义的唯一事实源（沿用，判定点内部调用它，**不重写**） |
| **执行入口（工具面）** | `packages/core/src/action-gate.ts` → `authorizeToolCall()`；由 `Agent.enforceRedLine()`（`packages/core/src/agent.ts`）调用 | 工具执行的唯一收口 |
| **读取入口（HTTP / 人 / UI）** | `GET /api/resources/authorization?agent=&resource=&action=` | 只读；回显输入 + 结论 + hint |
| 逐件事审批的读取（唯一） | `SqliteApprovalRepo.findMandate()` | 查不到 = `none`，不是"可能批了" |
| L3 唯一性（唯一执行点） | DB 部分唯一索引 `uniq_rbd_l3`（`resource_bindings(resource) WHERE scope='admin'`） | 见 §5 |

**`authorizeToolCall` 的适用范围（刻意的边界，不是漏洞）**

- 只对**点名了资源**（`args.resource` / `resource_key`）的调用生效；
- **绑定管理类工具豁免**（`RESOURCE_CLAIM_TOOLS`：`resource_bind` / `resource_release` /
  `resource_owners` / `resource_status`）—— 不能要求「先有绑定」才能创建绑定，否则
  第一次认领在结构上不可能发生（bootstrap）。它们的闸门在别处：升档需人批
  （`autonomyNeedsApproval` + 审批通道）、L3 唯一性由 DB 约束守；
- 没有点名资源的调用（`tsk_…` / `proj_…` 等平台实体）走**任务/需求/审查**那条授权链，
  不受绑定影响 —— 硬套绑定会把没有任何绑定的 agent 全判死。

豁免是**名字白名单（默认拒绝）**：新增工具自动被判定覆盖，只有显式加进集合才豁免。

---

## 4. Mandate 的取得与复用（审批为什么不再是噪音）

```
红线动作（admin 档）且点名资源、mandate=none
   ├─ 没有审批通道 → deny / mandate-required（hint: 需要人为这一件事签字）
   └─ 有审批通道   → 发审批卡（带上 resource + actionScope）
                        ├─ 人批准 → 执行；这张单被 `findMandate` 认成 approved
                        └─ 人拒绝 → 执行被拒；下次同一件事直接 mandate-denied，不再发新卡
```

审批单要**能被判定点消费**，必须带 `details.resource` + `details.actionScope`：

- 只有这两项同时匹配，`findMandate` 才认为"这件事批过"；
- 普通工具确认（如「同意跑一次 shell」）**不会**被当成资源授权 —— 它的 `details` 里没有这两项；
- 状态取**最近一条**：重新申请可以覆盖旧结论。

刻意**没有**新增 `approvals.type` 枚举值：那个联合类型是 UI 渲染链（标签 / i18n / 分支）的输入，
而"哪块地、哪一档"已被两个 details 字段唯一表达。判据留在数据里，不新增概念。

---

## 5. I8：同一资源只能有一个 L3 责任人（由数据库守）

```sql
CREATE UNIQUE INDEX uniq_rbd_l3 ON resource_bindings(resource) WHERE scope = 'admin';
```

- **删掉了** `bind()` 里的「先查有没有别的 admin，再插入」预检。那是 check-then-insert：
  只在单进程单连接内成立，并发下两个调用各自查到"还没有 admin"然后都插进去（R4：靠排队保证正确性）。
- 索引让「两个 admin」**在结构上不可表达**：任何写路径（`INSERT` / `UPDATE scope`）都被同一条约束守住。
- 约束冲突被翻译成**可行动提示**（谁占着、怎么接管），不是抛一个 `SQLITE_CONSTRAINT`。
- 存量去重：老库若已有重复 admin（正是约束缺位的证据），保留每个资源**最早**那条，其余降为
  `publish` 并在日志点明（`I8 backfill: demoted N …`）。不静默改数据，也不因此让 storage 起不来。

---

## 6. I5：直通不改变授权

`authorizeAction()` 的入参里**没有**「这个事件是直通来的 / 是研判来的」这一位。
想让直通减免授权，必须先改函数签名 —— 那是评审看得见的改动，不可能顺手做掉。

行为测试（`packages/core/test/authorization.test.ts` → 「I5」组）用真实 `ThreadService.route()`
造出「已订阅 → `direct-through` → 叫醒」，再断言同一 agent 对同一资源的越权动作仍被拒。

直通只改变「**谁先读到**」，不改变「**能做什么**」（设计 01 §7.6 第 1 条）。

---

## 7. 拒绝必须可行动（平台规则第 5 条）

判定结果不是布尔值，而是 `{ verdict, code, reason, hint }`：

| code | hint 指向 |
|---|---|
| `no-binding` | 先用 `resource_bind` 声明负责这块地到哪一档 |
| `above-binding-scope` | 请人把绑定升到需要的档位，或交给已持有该档位的人 |
| `autonomy-off` | 请人把 autonomy 从 off 升到至少 observe |
| `autonomy-observe` | 要执行需要两步：升 autonomy **且**在档位范围内（只批其中一样都不够） |
| `mandate-required` | 需要人为**这一件事**签字（逐件事，不被下次同类动作复用） |
| `mandate-pending` | 等审批结论；不要换写法重试同一件事 |
| `mandate-denied` | 不要重复请求；若有新理由，先说清新依据再重新发起 |

---

## 8. 测试对应表

| 断言 | 文件 | 会咬人的点 |
|---|---|---|
| 方向①：`trusted` 不构成批准 | `packages/shared/src/types/thread.test.ts` + `packages/core/test/authorization.test.ts` | 把 mandate 分支改成 allow → 两处同时变红 |
| 方向②：审批不能抬 autonomy | 同上 | 把 `record-only` 改成 `allow` → 变红 |
| 判定顺序（先 scope 后 mandate） | `thread.test.ts`「顺序钉住」 | 改顺序 → 报 `mandate-*` 而非 `above-binding-scope` → 红 |
| 工具面真的拦（工具本体未执行） | `packages/core/test/authorization.test.ts`（断言 `calls === 0`） | 只测纯函数测不出「先执行再拒绝」 |
| I5 直通不改变授权 | 同上「I5」组 | — |
| I8 DB 约束（绕过 `bind()` 直接插也不行） | `packages/storage/test/authorization.test.ts` | 只测 `bind()` 会被 JS 预检蒙混过去 |
| L3 提示指向真实持有者 | 同上 | — |
| `findMandate` 口径（查不到= none，别人的/普通确认不算） | 同上 | — |

---

## 9. 刻意不做（残余与重评条件）

| 不做 | 理由 | 重评条件 |
|---|---|---|
| Mandate 的**单次消费**（用掉即失效） | 需要 mandate 成为独立实体 = 新增一个系统（H1）。当前粒度 = (agent, resource, actionScope) [+ 可选 eventKey] | 出现「一次批准被复用做多次不可撤回动作」的真实事故 |
| 资源动作类工具（发帖 / 合 PR / 改账号设置）暂不存在，工具面判定今日只覆盖「点名资源」的调用 | 生产里点名的资源动作工具目前只有绑定管理类，且按 bootstrap 豁免 | 新增资源动作工具时**默认已被判定覆盖**（fail-closed），无需改本机制 |
| 按「当前正在处理的 thread」自动确定资源 | 需要把 turn 与 thread ref 绑定进 agent 上下文（跨 dispatch/agent 的改动） | 出现「agent 在被唤醒的资源上越权动手」的真实事故 |
| `transfer`（L3 接管，带审计） | I8 只要求「第二个被拒 + 可行动提示」；接管是独立能力 | 出现「必须换 L3 责任人」的真实诉求 |
