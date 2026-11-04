# Eval：gate + assessment 两段语义（B1）

> **这是什么**：`Eval` 回答第一性原理问题 **Q1「一个外部事件，该不该变成工作？」**。
> 它由**两段**组成：`gate`（第 1 层，零 LLM 确定性分流）与 `assessment`（第 2 层，LLM 研判）。
> 本文是这两段的 living 契约 —— 单一事实源，改语义先改这里。
>
> **为什么需要它**：在此之前只有 gate，assessment 是"空壳"——`matchedRule` 全仓 0 命中，
> 于是「Eval 做了」含义不明：到底规则命中了哪条？判不了的时候去哪了？本文把这两问变成可判定事实。

---

## 1. 两段的职责与边界

| 段 | 名字 | 是否用 LLM | 单一执行点 | 产出 |
|---|---|---|---|---|
| 第 1 层 | **gate**（确定性分流） | 否（零 LLM） | `gateVerdict()` — `packages/shared/src/types/thread.ts` | 六条规则里命中哪一条（`GateVerdict`） |
| 第 2 层 | **assessment**（研判） | 是（可插拔） | `ThreadService.decisionFor()` — `packages/core/src/thread-service.ts` | 一个 `Disposition`（最终处置） |

> **单一决策点**：两段的**合并结论**只在 `ThreadService.decisionFor()` 一处产生，并只经一次
> `record()` 落库（连带 `matchedRule`）。`route()` 只调它一次 —— 没有第二个地方能产出处置结论。

---

## 2. Gate 六条（契约 §5，逐字对齐）

顺序即语义，不可重排（实现见 `gateVerdict()`）：

```
1. 幂等命中                                    → duplicate       （丢弃，记 duplicated）
2. addressing ∈ {direct, mention} 且 actor 是人 → dispatch        （人已指定，不研判）
3. 命中已订阅 Thread                            → direct-through  （直通，不产生 Disposition）
4. 带 tsk_/req_/cs_ id 或资源键                 → attach
5. bot/CI 事件 + thread 已结束                  → ignore-ended    （只记录，不唤醒）
6. 其余                                         → assess          （进入第 2 段 assessment）
```

两个实测细节**不得回退**：
- `mention` 必须算 explicit（只认 `direct` 会把每条 `@bot` 都送去研判）；
- sessionId 解析必须读 `payload.extra.sessionId` 与 `metadata.sessionId` 两处。

### `matchedRule` —— 规则命中的可解释载体

每次处置在 `thread_dispositions.matched_rule` 记录**命中的规则 id**（类型 `MatchedRule`，
值域 = `GateVerdict`）。这样一条 SQL 就能回答「Eval 为什么走了这条」：

```sql
SELECT matched_rule, COUNT(*) FROM thread_dispositions GROUP BY matched_rule ORDER BY 2 DESC;
```

- 值 = 六条规则之一（`duplicate|dispatch|direct-through|attach|ignore-ended|assess`）；
- `NULL` = 该处置不是 Gate 规则产生的（历史行 / 外部直接写入）；
- 「为什么命中」的人话落在同一行的 `reason`（I4 强制非空），两者互补：`matched_rule` 机器可读、`reason` 人读。

> ⚠️ `assess` 作为 `matchedRule` 的含义是 **「规则 1–5 全部未命中、进入了第 2 段」**，
> 不是「命中了规则 6」。规则 6 本身是兜底，不是一条会"赢"的规则。

---

## 3. Assessment（第 2 段）：可插拔 + 降级

`assessment` 引擎**由调用方注入**（`ThreadService` 的 `deps.assess`，仿 `autonomyFor` 的注入模式）。
core 不依赖任何 LLM 实现。

```ts
type AssessOutcome =
  | { decided: true;  disposition: Disposition }   // 引擎给出结论
  | { decided: false; reason: string };            // 引擎存在但判不了
```

### 降级矩阵（有/无 LLM × 命中/未命中）

| 场景 | gate 结果 | 注入 assess？ | assess 返回 | 最终结局 | `matchedRule` |
|---|---|---|---|---|---|
| **规则命中** | dispatch/attach/ignore-ended/direct-through | **任意**（有/无） | **从不调用** | 采用 gate 规则处置 | 该规则 id |
| **未命中 · 无引擎** | assess | ❌ 未注入 | —（不调用） | `needs-assessment`（ignore + `wouldAccept=true`） | `assess` |
| **未命中 · 有引擎判不了** | assess | ✅ | `decided:false` | `needs-assessment`（reason 带引擎原因） | `assess` |
| **未命中 · 有引擎给结论** | assess | ✅ | `decided:true` | 采用引擎的 `disposition` | `assess` |

**两条硬约束**（有测试守）：
1. **规则命中时绝不调用 assessment** —— spy 断言零调用（`packages/core/test/eval-assessment.test.ts`）。
2. **降级不静默放行** —— 无引擎 / 判不了时是**显式 `needs-assessment`**，绝不当成 `accept`。
   把降级分支改成"默认 accept"会被行为测试拉红。

> **v1 的生产形态**：org-manager 的 `serviceOf()` **不注入 assess** → 未命中的事件降级 `needs-assessment`。
> 这是**合法且默认**的配置，不是错误：没有 observe 数据就上模型 = 闭眼分类（02 §334 的设计取舍）。

---

## 4. 「两者都缺」= 显式状态，不是默认放行

当 **无确定性规则命中**（verdict=`assess`）**且** **无研判结论**（无引擎或引擎判不了）时：

- 结局是一条**显式的 `needs-assessment`** 处置：`action='ignore'`、`wouldAccept=true`、
  `reason` 含 `needs-assessment` + 原因文本、`matchedRule='assess'`；
- **不是** `accept`、**不是** `dispatch`、**不是**空处置。

判据：`reason` 永远非空（不变量 I4，repo 在 `record()` 强制），且 `action` 明确是 `ignore` 而非放行。

---

## 5. 加一条新规则 / 接一个新研判引擎

**加 Gate 规则**：只会改 `gateVerdict()`（单一执行点）+ `GateVerdict` 枚举 + `matchedRule` 值域
（= `GateVerdict`，自动跟随）。**不要**在 `decisionFor()` 里另开辟分支判断——那是第二执行点。

**接研判引擎**：实现一个 `(input: AssessInput) => AssessOutcome | undefined` 的函数，注入
`new ThreadService({ ..., assess })`。引擎内部抛错不会穿透（`decisionFor` 视同"判不了"降级，
见测试「无引擎不抛异常」）；返回值缺 `reason` 会被 repo 的 I4 拦。

---

## 6. 测试对应表

| 判据 | 测试文件 | 用例 |
|---|---|---|
| Gate 六条逐条 + matchedRule | `packages/core/test/eval-assessment.test.ts` | 「Gate 六条逐条」describe |
| 命中→assessment 零调用 | 同上 | 「规则命中 → assessment 零调用」describe（spy） |
| 未命中→assessment，无引擎降级不抛异常 | 同上 | 「未命中 → assessment；无引擎降级」describe |
| 「两者都缺」显式 + I4 | 同上 | 「「两者都缺」显式状态」describe |
| matched_rule 列回环 | `packages/storage/test/thread-store.test.ts` | 「matched_rule 回环」 |
| 真库分布 | `packages/org-manager/test/eval-matched-rule-probe.test.ts` | 「真库探针 · matched_rule 分布」 |

---

## 7. 刻意不做（重评条件）

- **不内置真实 LLM 研判引擎**：本卡交付的是"可插拔的缝 + 降级矩阵"，不是模型本体。
  重评条件：累计 ≥ 一周的 `needs-assessment` observe 数据可用于校准时。
- **不从裸 ingress 触发 dispatch/attach**：`event-ingress.ts` 的 `routeInputOf` 目前不携带
  `entityRef` / `directTargetAgentId`（`NormalizedEvent` 也没有这两个字段）——这是入口/适配器侧
  的既存缺口（归 Source 解析），不是 Eval 的职责。Eval 在 `ThreadService.route()` 层对这两条规则
  完整生效（见 `eval-assessment.test.ts`）。重评条件：适配器开始产出"指向既有实体/指定处理者"的事件时。
