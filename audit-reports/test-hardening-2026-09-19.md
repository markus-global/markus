# 测试加固交付报告 · v0.9.9 → 发版前

> 日期：2026-09-19
> 分支：`feat/ui-optimize-0917`
> 输入：`audit-reports/test-coverage-vs-0.9.9.md`（覆盖评估报告）
> 目的：把报告点名的测试缺口补上、把测试机制修好，为发新版本做质量准备

---

## 1. 一句话结论

评估报告点出的缺口**已全部处理**：新增 108 个用例、修复 4 个真实缺陷、修掉 2 处「假绿」测试，
并把 CI 从「门禁看起来在、其实没在」改成真正会拦人的门禁。
**唯一没能落地的是「前端覆盖率作门槛」**——原因见 §4 遗留项 F1，已降级为非阻塞并加了防假绿保护。

---

## 2. 补了哪些测试（按报告条目对应）

| 来源 | 新增用例 | 覆盖对象 |
|---|---|---|
| 适配器测试 | 15 | Gemini / OpenAI 兼容适配器的请求构造、响应解析、错误路径 |
| storage 事务原语 | 53 | `runInTransaction`（SAVEPOINT 嵌套 / 回滚 / 迁移路径），此前**完全无直接测试** |
| 两个「有码无测」新模块 | 20 | 评估报告点名但零覆盖的模块 |
| 适配器边界/异常 | 20 | 超时、非 JSON、缺字段、空响应 |
| 接线行为级验证 | 6 | token counter 接线（把源码文本嗅探升级为行为断言） |

合计 **108 个新用例**；全部做过「反向验证」（故意破坏被测逻辑 → 用例必须变红），不是只看绿。

---

## 3. 补测过程中发现的真实缺陷（已修）

这是本次最有价值的部分——**这些缺陷是补测试时当场抓出来的，不是猜的**：

| # | 缺陷 | 影响 | 处置 |
|---|---|---|---|
| D1 | `google.ts` `convertResponse()` 算出 `reasoningContent` 却没写进 `return` | Gemini 非流式调用时推理内容**静默丢失** | 已修 + 补断言 |
| D2 | `runInTransaction` 传入 `async fn` 时**立即 COMMIT**，`await` 之后的写入永不回滚 | 事务语义失效 → 数据不一致 | 已修（显式拒绝 async 回调） |
| D3 | `runInTransaction` 的 `catch` 里裸 `ROLLBACK` 会**吞掉原始错误** | 报错指向错误原因，排查被误导 | 已修（容错 ROLLBACK） |
| D4 | 嵌套事务 `ROLLBACK TO` 后未 `RELEASE`，残留 savepoint | 嵌套层级变深后行为异常 | 已修（补 RELEASE） |
| D5 | `syncHubCredits` 对 Hub 返回值无防御性解析 | 返回值异常时可能**误判余额为 0 → 误拦用户** | 已修（防御解析 + 反向用例：真·零余额仍必须拦截） |

前 4 个是「缺陷锁定」式测试写的——即先用量例把当前（错误）行为钉住，修完后把断言**反转**为期望行为。
这样每条修复都有回归证据，而不是「我改好了」。

---

## 4. 测试机制做了哪些优化

### 4.1 修掉两处「假绿」（比缺测试更危险）

- **Codex 用例**：断言写得太松，参数传错也过。已收紧为精确断言。
- **wiring 契约**：原来只做源码文本嗅探（`grep` 代码里有没有那行），守不住「调用了但不生效」。
  已升级为行为级用例：故意把 `new ContextEngine({tokenCounter})` 回退成单例 → 4 个用例立刻变红（突变验证通过）。

### 4.2 测试隔离（根治本机假红）

`vitest.setup.ts` 统一隔离所有 `MARKUS_*` 环境变量。
背景：本机 shell 里恰好有 6 个 `MARKUS_*` 变量，导致 `llm-markus-provider.test.ts` 在本机假红、CI 绿。
隔离后：**本机 68/68 全绿**，与 CI 一致。「本机跑不通」不再成为噪音。

### 4.3 前端测试通道（真实补上 0.9.9 的前端短板）

`vitest.config.ts` 拆成两个 project：
- **根因**：旧配置的 `include` 只到 `*.ts`，**`.tsx` 文件从未被收集**——前端测试等于不存在。
- 现在 `--project web-ui` 能发现并运行 **~480 个前端用例**（27 个文件），1 秒级跑完。
- 配套引入了 happy-dom + @testing-library，`.tsx` 用例有了夹具。

### 4.4 CI 门禁：从装饰性变成真拦人

| 项目 | 改造前 | 改造后 |
|---|---|---|
| 覆盖率阈值 | CI 跑 `vitest run`（不带 `--coverage`）→ **阈值根本不执行** | 显式跑覆盖率 + 棘轮（baseline 入库，只升不降） |
| 跳过用例 | 无人统计 → `.skip` 可让套件常绿而行为退化 | 新增跳过审计：整文件被跳过 → **失败** |
| 前端用例 | `.tsx` 不收集 | `pnpm test:web-ui` **阻塞** |
| 覆盖率假绿 | 无保护 | 收集为 0% 时棘轮 **exit 2** 并明确报告「门禁失效」 |

新增脚本：
- `scripts/report-skipped-tests.mjs` — 跳过用例审计（区分整文件跳过 vs 零星跳过）
- `scripts/check-coverage-ratchet.mjs` — 覆盖率棘轮（baseline 入库、防静默下调、防 0% 假绿）

---

## 5. 遗留项

### F1（唯一未落地）前端覆盖率门槛

- **现象**：`vitest run --project web-ui --coverage` 在 481 个用例全绿的情况下报告
  **0/49045 语句**——v8 provider 一个命中都没记录到。
- **已尝试**：根级 coverage、project 级 coverage、专用配置文件、CLI 覆盖参数、
  `include` 不加花括号 glob、显式 `enabled: true`。**均仍为 0%。**
- **决策**：**不发布一个永远 0% 的门禁**。那比没有门禁更危险——它会把「坏掉」伪装成「绿色」。
  因此该项降级为「测量中、不阻塞」，并且棘轮脚本在检测到 0% 收集时直接 exit 2，
  让「坏掉」无法冒充「无回退」。
- **下一步建议**（择一）：
  1. 换 `coverage.provider: 'istanbul'` 验证是否为 v8 provider 的路径解析问题；
  2. 把 web-ui 覆盖率单独放进一个不依赖 monorepo 解析的 workspace 跑；
  3. 若短期不解决，就以「前端用例数 + 跳过审计」作为前端质量门禁（当前已生效）。

### F2 后端覆盖率暂不阻塞

`vitest run --project node --coverage` 实测 **>7 分钟仍未写出报告就被杀**（v8 插桩 + source-map 重映射开销）。
跑不完的门禁比没有门禁更糟。已按需提供 `pnpm coverage:node`，等运行时可控后再提升为阻塞。

### F3 一条慢用例

`multimodal-providers.test.ts` 中 `generates speech with tts-1` 单例耗时 **10.5 秒**，
疑似真发了网络请求。建议后续改为 mock 或标记为外部依赖用例。当前不影响门禁。

---

## 6. 变更文件清单

**新增**
- `vitest.setup.ts`、`vitest.web-ui.setup.ts`
- `scripts/report-skipped-tests.mjs`、`scripts/check-coverage-ratchet.mjs`
- `coverage-baseline.json`
- 4 个测试文件（适配器 / storage 事务 / 接线行为 / 边界）

**修改**
- `vitest.config.ts`（拆 project）
- `package.json`（scripts）
- `.github/workflows/ci.yml`（门禁重写）
- `packages/core/src/llm/google.ts`、`packages/core/src/llm/markus-provider.ts`
- `packages/storage/src/sqlite-storage.ts`
- `packages/core/test/llm-google.test.ts`、`llm-openai-codex.test.ts`、
  `llm-markus-provider.test.ts`、`packages/storage/test/sqlite-transaction.test.ts`
- `docs/AUDIT-FIXES-2026-09.md`（同步两处已过期结论 + 一处口径更正）

---

## 7. 发版建议

- 后端（core / storage / org-manager）：**够硬**，可以发版。
- 前端：`.`tsx` 通道打开 + 480 用例是真进步，但**覆盖率仍不可度量** →
  发版可以，但要如实说明前端质量证据当前是「用例数 + 跳过审计」，不是覆盖率数字。
- 建议：F1 在下一个迭代专门排一次（半天量级），在此之前不要对外声称前端有覆盖率门槛。
