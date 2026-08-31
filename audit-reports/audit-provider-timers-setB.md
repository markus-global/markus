# LLM 超时/挂起/异常处理审计报告

**范围（文件集 B）**：`packages/core/src/llm/` 下 minimax.ts、fireworks.ts、openai-codex.ts、proxy-fetch.ts、provider-helpers.ts、markus-provider.ts
**性质**：只读分析，未改动任何文件。
**前置说明**：`minimax.ts` 与 `fireworks.ts` 的**聊天/流式逻辑实际继承自 `openai.ts` 的 `OpenAIProvider`**（不在本文件集内），因此涉及这两个文件 chat 的结论需参照 `openai.ts` 的流式实现（已作为证据一并核验并标注来源 `openai.ts`）。

---

## 1. minimax.ts（309 行，extends OpenAIProvider）

**多媒体方法有绝对硬超时，但视频轮询无外部 abort、无背板。**

**Q1 硬超时**：每个多媒体 fetch 都有 `AbortSignal.timeout(...)` 绝对超时。
- 图片 `generateImage`：`signal: AbortSignal.timeout(120_000)`（L101）→ 120s。
- TTS `generateSpeech`：`signal: AbortSignal.timeout(180_000)`（L152）→ 180s。
- 视频创建 `generateVideo` create：`signal: AbortSignal.timeout(120_000)`（L199）；轮询 query L228、文件 retrieve L244 各 `AbortSignal.timeout(15_000)`。
- **聊天/流式**：继承 `openai.ts`，内部自建 `AbortController` + idle（streamTimeoutMs 180s，每 chunk 重置，同时覆盖 TTFB）+ 硬顶 15min（openai.ts L187-210）。

**Q2 流持续**：见 `openai.ts` L250-296——`reader.read()` 循环，JSON 解析 `try/catch` 跳过坏行（L276），idle 超时/硬超时优雅终止并设置 `finishReason='max_tokens'`（L283-285）。不会卡死。

**Q3 重试**：minimax.ts 自身无重试逻辑。视频轮询用 `if (!queryRes.ok) continue`（L231）做软重试，但**无退避**（固定 5s sleep）。聊天继承 `openai.ts`，其 `chatStream` 无重试（openai.ts L212-222 单次 fetch）。**多媒体方法无重试。**

**Q4 fail-loud/吞错**：
- `!res.ok` 全部显式抛错（L106、L157、L204）。
- `base_resp.status_code !== 0` 显式抛错（L115、L166、L211）。
- TTS 无 audio 抛错（L171）。
- **缺陷**：视频轮询 360 次后静默降级为 `return { taskId, status: 'processing' }`（L265），**url 为空也不抛错**——属静默降级（对调用方表现为"还在处理"，无完成信号机制，可能被误判/无后续处理）。

**Q5 abort 外部**：`generateImage/generateSpeech/generateVideo` 签名均**无 `signal` 参数**（L82、L132、L184），外部无法中途取消视频轮询（最长约 30 分钟占用）。

---

## 2. fireworks.ts —— 94 行

Image 生成有硬超时；聊天继承 OpenAI。

**Q1**：`generateImage` 有 `signal: AbortSignal.timeout(120_000)`（L67）。聊天继承 `openai.ts`（同上，idle 180s + hard 15min）。
**Q2**：流式继承 `openai.ts`，优雅终止（同 Q1-minimax）。
**Q3**：无重试/退避（fireworks.ts 全文件无 retry）。
**Q4**：`!res.ok` 显式抛错（L70-73）。**缺陷**：解析后 `data.data` 与 `data.base64` 都为空时**静默返回 `[]`**（L92），不报错——调用方可能以为生成了 0 张图而非失败。`base64` 的 data-URI 若格式异常，`m ? m[1] : dataUri`（L88）静默原样透传，不做校验。
**Q5**：无外部 abort（`generateImage(prompt, options)` 无 signal）。

---

## 3. openai-codex.ts —— 371 行 (CodexResponsesProvider)

### 单一一根整体 wall-clock 超时（默认 180s）；**无独立 TTFB/idle 超时**；无重试。

**Q1**：
- `this.timeoutMs = config.timeoutMs ?? 180_000`（L33，可配置，`configure` L41 可改）。
- L92-94：`const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);` —— **单个整体超时计时器**。覆盖整个请求生命周期（含流的全程）。
- **无独立 idle/TTFB 超时**：不像 markus/openai 那样"每收到 chunk 就重置"。一旦首 chunk 很慢但整体 <180s，或中途某次断流间歇（> 整体剩余）……实际上整体 180s 是全局墙钟，任何慢速都会被它兜底，不会无限挂。
- abort 在 fetch 失败分支 `clearTimeout`（L114）/非 2xx `clearTimeout`（L120）/读完后 `clearTimeout`（L172）。读流中途若超时触发 abort → `reader.read()` reject 抛错（走通用 fetch ？不，reader.read 抛错在 L138 while 循环未被 try/catch 包裹，异常会向上抛出到调用方）→ 会退出，不卡死。

**Q2 流式**：L138-170 逐行读，`buffer.split('\n')` 处理半行（保留末尾到 buffer，L144）；`JSON.parse` 包 `try/catch` 跳过坏 chunk（L168）；半截 tool_calls JSON 在 L177-178 用 `try/catch` 回退空对象。**能从损坏 chunk 恢复，不卡死。** 唯一"无活动下限"：若服务端静默停流（不 close），靠 180s 整体超时兜底（无 idle 重置，188s 内必断）——不挂死，但超时粒度粗。

**Q3 重试**：**无重试/退避**（openai-codex.ts 全文件无 retry/backoff）。token 解析失败也只抛一次（L113-117）。

**Q4 fail-loud**：
- fetch/网络错 → `Codex API request failed: ${msg}`（L116）透传原始 msg。
- !res.ok → `Codex API error ${status}: ${errText}` 透传 body（L122）。
- 流内坏 JSON 行被静默跳过（L168），tool args 半截 JSON 静默回 `{}`（L178）——属有意的弹丸性降级，非真错误吞没。

**Q5 abort 外部**：**支持**。`chatStream(..., signal?: AbortSignal)`（L73），L94 `signal.addEventListener('abort', () => controller.abort())`。

---

## 4. proxy-fetch.ts —— 174 行

### 无自身整体超时；**确实把外部 signal 透传**给底层 fetch；abort 传播 OK。

**Q6a proxy-fetch 整体超时/abort 传播**：
- **自身无超时**：`proxyFetch` 只负责"选代理 + 构造 dispatcher"，不设任何 timeout（L161-174）。
- **abort 传播**：`init`（含调用方传的 `signal`）通过 `{ ...init, dispatcher: agent }`（L172）透传给 `undici.fetch`。若 `proxyUrl` 为空，直接 `return fetch(url, init)`（L163），signal 同样透传。**即：abort 可正常传播，前提是调用方传了 signal**。proxy-fetch 自身不添加"兜底超时"。
- 但注意：调用方能获得保护的来源是调用方自己的 `AbortSignal.timeout`/timer，proxy-fetch 只是"管道"，自身不具备防挂属性。
- **额外风险**：`proxyUrl` 每次调用都经由 `resolveProxyUrl()` → `getEffectiveProxy()` → 可能 `readSystemProxy()`，后者执行同步 `execSync('scutil --proxy', {timeout:3000})`（L45）/ `reg query` / `gsettings`（L63、L89-96）。这是每次代理路径请求都触发的一次**同步阻塞子进程**，带 timeout 兜底（2-3s），不算无限挂，但会引入每请求的进程启动延迟，且阻塞 event loop。`readNetworkConfig` 每次 `readFileSync ~/.markus/markus.json` L15（同步读盘）。无缓存。
- ProxyAgent 每次请求 `new undici.ProxyAgent`（L168），无池化/复用，连接开销大。

---

## 5. provider-helpers.ts —— 412 行

**纯函数，无 I/O，无计时器。**按设计（文件头 L10-15 声明 "No I/O, no provider state"，createSSEAccumulator 注释 L320 "owns no timeouts"）。

**Q1/Q2/Q3 不适用**（不发起网络请求、不设超时、无重试）。流式状态机 `createSSEAccumulator.feed`（L336）由 provider 每 chunk 驱动；`finalizeToolCalls` 用 `safeParseJson`（L407-413）**对半截 tool call 就 JSON 安全回退 `{}` 而非抛错**（L401 注释明确），很好地支持了"断流半截 JSON 优雅终止"。无缺陷，属加分项。

---

## 6. markus-provider.ts —— 1861 行

### 超时治理最完善：非流式 90s + 流式 idle(180s，逐 chunk 重置，覆盖 TTFB) + 硬顶(15min) + 可配置重试。

常量（L230-242）：
- `CHAT_TIMEOUT_MS = 90_000`，`STREAM_TIMEOUT_MS = 180_000`，`STREAM_HARD_TIMEOUT_MS = 15*60_000`，`MAX_RETRIES = 3`，`RETRY_BASE_DELAY_MS = 500`，`MAX_RETRY_AFTER_MS = 60_000`。

**Q1 per-call 超时**：
- 非流式 `chat`：L774-779 `signal: AbortSignal.timeout(this.chatTimeoutMs)`（`config.timeoutMs ?? 90s`）。
- 流式 `chatStream`：L839-859 自建 `AbortController`，两枚定时器：
  - **idle 超时**（`streamTimeoutMs` 默认 180s，`bumpIdleTimeout` 每个 chunk 重置 L853-858）→ 同时覆盖 TTFB 首字超时；
  - **硬顶** `STREAM_HARD_TIMEOUT_MS`（15min）。
- `chatTimeoutMs`/`streamTimeoutMs` 均可通过 config 配置（L341-344），可分开设。这层**明显设计正确**。

**Q2 流中断流/半截**：L923-1022。reader 循环；坏 JSON 行 `catch` 静默忽略、仅重抛以 `Markus stream error` 前缀开头的硬错误（L972-977）；半截 tool_call 由 `finalizeToolCalls` 安全兜底。断流时走 idle 超时 → abort → 若已有部分输出则**优雅返回 `finishReason='max_tokens'` 让 agent 自动续接**（L1004-1011，并丢弃半截 tool_calls），无部分输出则抛错（L1012-1016）。中途断流后触发 timeout 都是终结的，不卡死。取舍：**idle 超时返回 max_tokens 是吞错（见 Q7）**。

**Q3 重试/退避可配置性**：`fetchWithRetry`（L1161-1213）提供指数退避 + 尊重 `Retry-After`（封顶 60s），429/503 与 5xx/网络错重试，其它 4xx 不重试。
- **可配置性：否**——`MAX_RETRIES`、`RETRY_BASE_DELAY_MS`、`MAX_RETRY_AFTER_MS` 是顶层 const（L239-242），构造函数不读取覆盖项；`fetchWithRetry` 只暴露可选的 `retries` 参数（L1165），但 chat/chatStream 均未传入（用默认 3）。
- **重试时超时是否重新计时**：
  - 非流式 chat：`AbortSignal.timeout(chatTimeoutMs)` 在调用 fetchWithRetry **之前**只创建一次（L778），而 fetchWithRetry 内部对每次 attempt 复用 `init`（同一个 signal，L1172）。`AbortSignal.timeout()` 的计时在 signal 创建时开始且**跨重试不重置**——即 90s 预算是 3 次尝试共享的总预算，重试不重新计时。⚠️
  - 流式 chatStream：`controller.signal` 与 idle/hard timer 在 **chatStream 入口创建一次**（L839-859），fetchWithRetry 重试（仅 429/503，L1191 skipRetry 会放行 429/503）复用同一 controller.signal；idle/hard 定时器不因重试而重置。同样**跨重试共享总预算**。⚠️（对 stream 因 429/503 发生在 body 前，影响相对小，但对超时度的语义仍是"不重新计时"）。
- 流式用 `skipRetry=true`（L873）→ 只在 429/503（body 前失败）重试，5xx 直接放行避免重复 chunk，正确。

**Q4 fail-loud/透传**：整体良好。大量显式 throw + log.warn + 原因透传（含供应商 CAU/错误体 `Markus proxy error ${status}: ${errText}` L904；429 加前缀 L893；credit 事件 L271-282）。网络错误经 fetchWithRetry 的 `lastError` 抛出（L1203-1212）。**不足**：详见 Q7。

**Q5 abort 外部**：
- 流式 `chatStream`：**支持**，`signal?: AbortSignal`（L831），L864 转发到内部 controller。
- 非流式 `chat`：**不支持**——签名 `chat(request, _retried=false)`（L767），无 signal 参数，外部无在中途中止非流式请求的办法（只能靠 90s 超时）。⚠️ 与 codex 形成对比（codex chatStream 支持）。

**Q6b provider 编排对单个 provider 挂起是否有保护（markus-provider 自身）**：
- markusProvider **不调用 `proxyFetch`**——`fetchWithRetry` 直接 `fetch(url, init)`（L1172），`openai-codex.ts` 才是唯一走 `proxy-fetch.ts（L107）的 LLM provider。因此 markus 的流式挂起保护完全由自身 idle/hard 计时器承担（已具备）。若外部需要经过代理（proxy），markus idx和 openai idx 的"代理路径"其实走的是默认 global fetch——这里与 proxy-fetch 存在不一致（markus/openai 无代理支持），但**超时方面自身兜得住**。

**Q7 明显缺口清单（markus-provider）**：
1. **单个 provider 挂起保护**：流式有 idle+hard 两杆；非流式有 90s `AbortSignal.timeout`。`fetchModels`、credit sync、models 等次要请求也有独立超时（L463 10s、L608 15s、L1496 180s）。但 **非流式 `chat` 无外部 abort**（见 Q5）。
2. **重试不重置超时预算**（非流式共享同一 90s timer；流式共享 idle/hard timer 不算新一次）。
3. **idle 超时部分输出→静默转 max_tokens**：(L1004) 返回非真错误。调用方只看到 finishReason=max_tokens，无法区分"真满"与"我中途断流/欠输出"。偏静默，虽为有意设计，但有信息损失。

---

## ════════════ 缺口清单汇总（按优先级） ════════════

**A. 存在真实"永挂/无超时"风险点**
1. **[高危] minimax.generateVideo 轮询最长 ~30 分钟，不可外部取消**（L221-263，maxAttempts=360*5s）。轮询自身无总量超时上限，仅靠 attempt 计数；若中途在某次 query.fetch 挂起，有 15s timeout 兜底，但整段无 abort 信号。外部无法中断、无法复用/分配。
2. **[中] minimax/fireworks/openai 的**非流式/多媒体方法无外部 abort**（minimax L128/132/184、fireworks L34、codex 例外为有 signal）。`OpenAIProvider` 非流式 `chat` 亦无外部 abort（openai.ts 未见 signal 参数；构造内部 controller）。
3. **[中] proxy-fetch 自身无超时兜底、无探活** —— 若不传 signal 的调用方（如 oauth-manager 部分调用若无 signal）会把挂起责任完全交给 `undici`/系统。`proxyFetch` 只在调用方带 signal 时才有 abort；缺失时无任何兜底。

**B. 超时/重试语义缺口**
4. **[中] 重试不重置超时预算**：markus `chat`（非流式）单 90s 预算共享给 MAX_RETRIES=3；`openai`/codex 无重试。跨重试共享导致总尝试窗口被压缩。
5. **[low] 重试参数不可配置**：markus `MAX_RETRIES/退避基数/上限` 为顶层常量，config 无从覆盖。

**C. 静默吞错/信息损失**
6. **[中] minimax generateVideo 轮询耗尽后静默降级返回 status:'processing'（url 空，不抛错）**；fireworks 图空时静默返回 `[]`。
7. **[低] markus idle 超时部分输出→静默转 max_tokens**（有 warn log，但对调用方无显式"断流"标记；codex/openai 相同路径只是 led 于 max_tokens 无法区分故障）。

**D. 系统/性能风险（非严格挂起，但异常处理相关）**
8. **[低] proxy-fetch 每次调用同步 `execSync(scutil/gsettings/reg)` + `readFileSync`，无缓存**（proxy-fetch.ts L44-101 / L18），高并发请求下有同步阻塞与进程迸发开销。
9. **[低] `new undici.ProxyAgent` 每请求新建、无复用**（L168）。

**E. 未覆盖路径（编排保护）**
10. **[中] markus/openai（OpenAI）与 minimax/fireworks 的 fetch 走全局 fetch 而非 proxy-fetch**（unlike openai-codex L107 & oauth），若用户依赖系统/企业代理时这些路径可能绕开代理；但各自自带超时兜底，故标记"编排一致性"而非超时缺陷。

**总评 / 隐患结论**：
- **超时治理梯队**：markus（idle 180s 逐 chunk 重置 + hard 15min + 外部 abort）与 openai.ts（同款 double timer）为最佳实现，可作为其它 provider 对齐基准；codex 有单根硬超时 180s + 外部 abort，但无 idle-reset、无重试（兜底在，粒度粗）；minimax/fireworks 多媒体各带绝对硬超时但无外部 abort；proxy-fetch 无自带超时。
- **真正的永挂风险**：
  1. minimax video 轮询最长 ~30 分钟、无条件长度、不可外部取消（单次 15s 超时兜底但不阻挡长轮询）。
  2. 走到 proxy-fetch 且调用方未传 signal 的请求（proxy-fetch 无自带兜底超时）。
- 其余流式路径（markus / openai / codex）即使中途断流，也会由 idle 或单根整体超时终结；损坏 chunk / 半截 JSON 均被 try/catch + safeParse 优雅吸收，不卡死。