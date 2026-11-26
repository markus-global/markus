# C7 真机事故：装配顺序 + 负缓存 → 整套 WorkUnit 静默失效

> 2026-11-14 · CTO · 关联：PR #444（cut7 C7-A + C7-B）

## 1. 现象

Owner 编译重启后，`work_units` 表**建好了**（列、唯一索引、父子索引齐全），但：

- `work_units` 一直是 **0 行**；
- 一条真实 A2A 投递成功落库（`mbx_f009a18e…`，日志 `A2A delivered to mailbox dlv_mwg1mg2w_2`），但该行 `work_unit_ref` 为 **NULL**；
- 整条链路**没有任何错误日志**。

## 2. 排查路径（每一步都以真实数据为准）

| 步骤 | 读数 | 结论 |
|---|---|---|
| 运行进程 | `Markus.app`（Electron），PID 7877，写 `~/.markus/data.db` | 不是仓库 `cli/dist` 起点，但库是同一个 |
| 包内符号 | `app.asar` 含 `linkExecutionEpoch`×4、`WORK_UNIT_REF`×12、`CREATE TABLE ... work_units`、`workUnitRepo`×4、`NULL_WORK_UNITS`×4 | **代码在包里**，不是没编译 |
| 库副本复现 | `repo.ensure` 在 `parent_id` 指向不存在行时抛 `FOREIGN KEY constraint failed`（FK=ON） | 一个**可能的**失败点，但 A2A 路径会把未解析的父置 NULL，不构成根因 |
| 运行时日志 | 探针时刻只有 `A2A send` / `A2A delivered`，无任何 `work_unit` 警告 | `ensure` 与 `linkMailboxItem` **都没生效**，且失败没留痕 |

## 3. 根因（两处叠加，缺一不成立）

**① 负缓存**：`APIServer.workUnits` 是一个惰性 getter，旧写法把「这会儿还没有 storage」的答案也缓存了：

```ts
if (this._workUnits !== undefined) return this._workUnits;   // ← null 也被记住
this._workUnits = repo ? new WorkUnitService(...) : null;     // ← 永久 null
```

**② 装配顺序**：`start.ts` 在 `setStorage(storage)`（:1435）**之前**就读了一次 `apiServer.workUnits`（:1148）。于是：

- `if (apiServer.workUnits)` 判假 → `taskService.setWorkUnitService()` 与 `agentManager.setWorkUnitPort()` **从未执行**（C7-B 的委派/预算一并死掉）；
- chat 生产者 `const units = this.workUnits; if (units)` 跳过；
- A2A 投递器构造时 `this.workUnits` 为 null → 拿到 `NULL_WORK_UNITS` **静默空实现** → `ensure` 返回 null、`linkMailboxItem` 返回 false，**零日志**。

三条现象同时成立，且都能由这两点解释。

## 4. 修法（修结构，不加守卫）

1. **getter 不再负缓存**（`api-server.ts`）：只缓存「有」；repo 缺席时直接返回 null 且不落缓存。判据写进注释：**「暂时没有」不是事实，惰性装配的依赖晚到是常态，缺席不得被冻结成属性。**
2. **装配回到正确一侧**（`start.ts`）：C7 装配块整体移到 `setStorage()` 之后，并在注释里写明为什么必须如此。
3. **回归测试**（`packages/org-manager/test/work-unit-wiring.test.ts`，3 例）：
   - 首次读到 null 之后，storage 接入仍必须拿到服务（**这条先见过红**）；
   - 接线后 `ensure` 真的落库（不是空实现）；
   - CLI 无 storage 路径仍安静返回 null。

## 5. 验证

| 项 | 读数 |
|---|---|
| 新回归测试 | 修前 2 failed / 1 passed → 修后 **3/3 passed** |
| WorkUnit 生产链探针 | `work-unit-producers.integration.test.ts` 8/8 |
| org-manager 全量 | **97 files / 1650 tests passed** |
| `tsc -b` | 0 |
| `eslint packages/*/src/` | 0 errors |
| `architecture-guard` | 18/18 |

## 6. 教训（可复用判据）

- **把「此刻没有」写成缓存 = 把一个时序事实钉成永久属性**，而且它不会报错，只会让整套观测静默失效。
- **具名空实现（`NULL_WORK_UNITS`）是好设计，但它必须只出现在「确实没有」的装配路径上**；一旦被拿来做时序错误的兜底，它就把 bug 变成了沉默。
- **"表在、无数据、无日志"这三个同时成立时，先怀疑装配接线，不要先怀疑业务逻辑。**
- 真实库副本复现（`sqlite3 .backup` + 直接调 repo）比读代码推断快得多：它当场排除了 FK 这条假设。
