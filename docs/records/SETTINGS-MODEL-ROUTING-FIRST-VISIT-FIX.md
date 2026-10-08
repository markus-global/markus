# 设置页模型路由首访「选项先空后填」问题 — 调研结论与修复方案

> 任务：tsk_c280fee9f5a231f5f93e7bf0
> 分支：feat/ui-optimize-0815 · commit `ccdc74e6`
> 日期：2026-08-15

## 一、症状

用户首次进入 设置 → Providers → 模型路由（Model Routing）时，所有下拉框（默认模型、能力分配）显示为空选项；约 2 秒后选项才「自动填充」。虽然最终数据正确，但首访看起来像「配置未生效」，误导性强。

## 二、根因分析

### 1. 前端渲染时序（ModelRoutingSection.tsx）

- 组件挂载后并发发 3 个请求：`/api/settings/llm/routing`（快）、`/api/models/routing-candidates`（慢）、`/api/models/suggested-assignments`。
- `loaded` 状态**只依赖最快的 `routing` 接口** → 首帧就渲染真实 UI。
- 选项数据源：`allModels = fullModelList ?? fallbackModels`
  - `fullModelList` ← 慢接口 `/api/models/routing-candidates`
  - `fallbackModels` ← 父级 `Settings.tsx` 传入的 `configuredProviders[].models`（即 `/api/settings/llm` 返回的 `llm.providers[p].models`）
- 两个数据源在冷启动时**都可能为空**：
  - `fullModelList`：`routing-candidates` 冷缓存首访需完整构建（慢）。
  - `fallbackModels`：`markus` provider 的后台 Hub 目录（`customModelCatalog`）在 `LLMRouter.createDefault` 里是 fire-and-forget 刷新；若目录未就绪，`getEnhancedSettings()` 的 `markus.models` 为空数组 → `fallbackModels` 为空。
- 于是首帧 → 空下拉；约 2s 后 `fullModelList` 到达 → 填充。复现「先空后填」。

### 2. routing-candidates 首访慢的主因（api-server.ts）

原实现（已重构）对**每个** enabled+configured provider **串行** `await validateProviderKey()`，每个都是真实网络请求（权限校验 + `/models` 拉取，单请求最长 15s 超时）：

```ts
for (const [providerName, providerSettings] of Object.entries(settings.providers)) {
  ...
  const liveResult = await this.validateProviderKey(providerName, apiKey, providerBaseUrl); // 串行！
}
```

配置 N 个 provider 时，冷缓存构建耗时 ≈ Σ(各 provider 网络延迟)，典型 1-2s+。而 `routingCandidatesCache` 冷启动为空，无预热。

### 3. 启动时序

- `start.ts` → `LLMRouter.createDefault()` 内部对 markus 执行 `void router.refreshMarkusCatalog()`（fire-and-forget）。
- `apiServer.setLLMRouter(llmRouter)` 在 `start.ts ~797`，`apiServer.start()` 在 `~1364`，两者之间没有候选缓存预热。
- 因此首次进设置页几乎必然打到冷缓存构建路径。

### 4. 运行时不依赖设置页（澄清）

**结论：运行时的 LLM 路由不依赖「访问设置页」。** 启动即从 config 加载 `capabilityRouting` / `routingDefaultModel` / providers（`start.ts` 在 `LLMRouter.createDefault` 后 `applyCapabilityRouting` 等），设置页只是查看/编辑 UI。

**但存在一个冷启动竞态需知晓**：`getModelContextWindow('markus')` 在 agent 每次消息打包时调用（agent.ts:2023 / subagent.ts:190），若 markus 的 Hub 目录尚未随启动的 fire-and-forget `refreshMarkusCatalog()` 完成加载，且 `FALLBACK_MODELS` 为空数组（markus-provider.ts:1844），会触发上次 context_window 修复引入的 fail-loud：
`Cannot resolve context_window for markus model "…": it is not in the loaded Hub catalog`。

- 该失败**不因设置页而触发**，也与设置页是否访问无关；只要启动后有 agent 在目录加载完成前发起首次 LLM 调用就可能发生（网络慢/目录接口慢时窗口变长）。
- 落点建议（本次未改，因属运行时行为且与 fail-loud 语义相关，需单独评审）：在首次 LLM 路由前等待/重试 markus 目录加载（如启动时 `await refreshMarkusCatalog()` 或让 `getModelContextWindow` 对「目录尚未加载」做短暂重试而非直接抛错），并在 UI 给出「目录未就绪」提示。列为后续优化建议。

## 三、修复方案（本次落地）

### 后端（packages/org-manager/src/api-server.ts）

1. **提取 `buildRoutingCandidatesPayload()`**（公共方法，单一数据源）
   - Pass 1：configured models（`getEnhancedSettings().providers[].models`，廉价、始终可用）。
   - Pass 2：**并行** live 校验 —— 所有带 apiKey 的 provider 用 `Promise.allSettled` 并发 `validateProviderKey`，总预算 `ROUTING_LIVE_VALIDATION_TIMEOUT_MS = 4s`（`Promise.race` 兜底，慢 provider 不再拖住整个响应）。
   - **markus 跳过实时校验**：markus 模型来自 Hub 目录（`customModelCatalog`，由 `refreshMarkusCatalog()` 填充），是唯一数据源；再打一次 OpenRouter `/models` 纯属重复且慢。安全的「用目录已知模型避免重复网络校验」。
   - Pass 3：modelCatalog（LiteLLM 24h 目录）追加 extras。
   - 每个 provider 内顺序保持 原「configured → live → catalog」，设置页下拉顺序不变。

2. **新增 `warmRoutingCandidates()`**（启动预热）
   - `start()` 的 listen 回调里 `void this.warmRoutingCandidates()` 后台触发，fire-and-forget。
   - 若 markus 已配置但目录未就绪：先 `await refreshMarkusCatalog()` 再构建缓存，**避免把空 markus 列表缓存 5 分钟**。
   - 未配置任何 provider 时保持冷缓存（不缓存空 payload）。

3. **Handler 瘦身**：`/api/models/routing-candidates` GET → 缓存命中直接返回；未命中 `buildRoutingCandidatesPayload()` + 写缓存。

### 前端（packages/web-ui/src/components/ModelRoutingSection.tsx）

- 新增 `candidatesLoading` 状态（初始 `true`，候选请求 then/finally 置 `false`；`reloadRouting()` 同步）。
- 渲染分支：`loaded` 后若 `candidatesLoading && allModels.length === 0` → 渲染「正在加载模型列表…」（`modelRouting.loadingModels`，中/英文 i18n 已加），**不再渲染空下拉**。
- 候选请求失败 → 正常渲染（fallback 方案兜底），避免永久 loading；`noModelAvailable` 等既有空态提示继续生效。

## 四、测试与验证

- 新增 `packages/org-manager/test/api-server-routing-cache.test.ts`（4 用例）：
  1. `buildRoutingCandidatesPayload` 并行校验非 markus provider、跳过 markus、保留 catalog/live 合并；
  2. `warmRoutingCandidates` 后缓存非空，首个 GET 命中缓存不再发 live 校验；
  3. 未配置任何 provider 时保持冷缓存；
  4. 缓存未过期时 `warmRoutingCandidates` 提前返回。
- 回归：
  - org-manager 全部测试：42 文件 / 1033 tests 通过；
  - core llm-router 相关：89 tests 通过；
  - `tsc -b packages/org-manager` 与 `tsc --noEmit -p packages/web-ui` 通过。

## 五、效果

- 首访设置页模型路由：`routing-candidates` 大概率命中启动预热缓存 → 下拉即刻有值；即使缓存失效（配置变更后 5 分钟窗口），并行 + 4s 预算也把构建从「Σ串行延迟」降到「max(单 provider) ≤ 4s」。
- 极端情况（候选确实未就绪）前端不再显示「空配置」错觉，而是明确「正在加载模型列表…」。

## 六、后续优化建议（未在本任务范围）

1. **运行时冷启动竞态**（见 二.4）：启动首个 LLM 调用前等待 markus 目录就绪，或 fail-loud 前短暂重试；UI 提供「目录未就绪」提示。
2. `suggested-assignments` 端点每次请求都会 `fetchHubRecommendations(modelsUrl)`（网络调用、无缓存）——可加同 5 分钟 TTL 缓存，进一步降低设置页首访网络开销。
3. 观察实际首访耗时，若仍 >500ms 可把 `ROUTING_LIVE_VALIDATION_TIMEOUT_MS` 下调（当前 4s 上限，通常各 provider 并发几百 ms 内完成）。