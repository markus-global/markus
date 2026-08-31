# LLM Provider 超时/挂起/异常响应处理审计报告

范围：`packages/core/src/llm/` 下 5 个文件（anthropic.ts / google.ts / openai.ts / dashscope.ts / ollama.ts）
方法：只读代码分析。证据以「行号 → 代码」给出。未改动任何文件。

---

## 通用结论（跨文件速览）

| 维度 | anthropic | google | openai | dashscope | ollama |
|---|---|---|---|---|---|
| 非流式 chat 整体超时 | ❌ **无** | ✅ 60s | ✅ 90s（可配） | ✅ 继承 openai | ✅ 120s |
| 流式整体/首字超时 | ✅ 120s（单定时器） | ✅ 120s | ✅ idle 180s + hard 15min（双定时器） | ✅ 继承 openai | ✅ 120s（单定时器） |
| 流式 idle 每 chunk 重置 | ❌ | ❌ | ✅ | ✅（继承） | ❌ |
| 流式中途断流优雅结束 | ❌ 裸抛错 | ❌ 裸抛错 | ✅ 部分时优雅收尾 | ✅（继承）| ❌ 裸抛错 |
| 重试逻辑 | 无 | 无 | 无 | 无 | 无 |
| fail-loud | 是 | 是 | 是 | 是 | 是 |
| 外部 abort 支持 | 仅 stream | 仅 stream | 仅 stream | 仅 stream | 仅 stream |

---

## 1. anthropic.ts

### 超时机制
- **非流式 `chat()`：完全没有超时。** L91-95 直接裸 `fetch` 且 `await res.json()`，无 `AbortController`、无 `AbortSignal.timeout`、无手动 `setTimeout`。若服务端不返回，`chat()` 将无限挂起。
  ```ts
  91  const res = await fetch(`${this.baseUrl}/v1/messages`, {
  92    method: 'POST', headers, body: JSON.stringify(body),
  95  });                              // 无 signal，无定时器
  102 const data = (await res.json()) as AnthropicResponse;  // 同样无超时
  ```
- **流式 `chatStream()`：单一定时器（整体/首字共用，120s）。** L136-138。
  ```ts
  136 const controller = new AbortController();
  137 const timeout = setTimeout(() => controller.abort(), 120_000);
  138 if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  ```
  机制：`AbortController` + 手动 `setTimeout`。**首字 TTFB 与整体共用一个 120s 定时器**，无独立的 TTFB 检测，也不按 chunk 重置（不是 idle 超时）。默认值 120_000ms，**不可配置**。`clearTimeout` 只在正常完成后 L232 执行。

### 流式处理
- 断行/半截行：用换行 buffer 累积（L170-173：`buffer.split('\n')` 且 `buffer = lines.pop() ?? ''`），半行 JSON 留在 buffer 等下一 chunk，处理正确。
- 损坏 chunk：L179-228 外层 `try/catch { /* skip unparseable */ }`（L228）静默跳过，不崩溃。**但会静默丢数据。**
- **读取循环 L167-231 没有任何 `try/catch`。** 一旦 aborted/timeout，`reader.read()`（L168）会 reject，`AbortError` 直接裸抛给调用方 —— **不是优雅结束**。注意：abort 触发的超时路径上 `clearTimeout(timeout)`（L232）不会执行（循环在 L230 之前就抛了）；若是在流中途发生真实网络错误，定时器也会残留到 120s 才触发。

### 重试
- 无。grep `retry|attempts|backoff|maxRetries` 命中 0。不可配置。

### 错误传播
- HTTP 非 2xx：L149 抛 `Error('Anthropic API error ${res.status}: ${errText}')`，fail-loud 且带状态码。
- **超时/中断：抛的是浏览器的裸 `AbortError`（DOMException），不携带任何 timeout 时长、状态码或重试信息。**
- **流末尾工具参数 `JSON.parse` 无保护**：L242 `arguments: tc.args ? (JSON.parse(tc.args) ...)` 位于 try/catch 之外。若流因中断以半截 `partial_json` 结束且 `content_block_stop` 已触发，这里会在流“看似正常结束”后抛出裸 `SyntaxError`。
  ```ts
  242  arguments: tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {},
  ```

### abort 支持
- 仅 `chatStream` 接受外部 `signal?: AbortSignal`（L106、L138），可外部取消。
- `chat()`（非流式）不接受 signal，无法外部取消。

### 缺口 / 漏洞
1. **`chat()` 无任何整体超时** —— 挂死风险最高。
2. 流式超时/中断抛裸 `AbortError`，无错信息、无优雅收尾，调用方难以区分「超时」与「主动取消」。
3. 流循环非正常退出时 `clearTimeout` 不执行（资源泄漏到 120s）。
4. 工具参数结尾 `JSON.parse` 未防护，截断的工具调用会抛原始 `SyntaxError`。
5. 超时时长写死 120s，不可配置。

---

## 2. google.ts

### 超时机制
- **非流式 `chat()`：`AbortController` + 60s。** L75-76，`clearTimeout` 在 `finally`（L93-95）确保清理。机制为手动 `setTimeout`。默认 60_000ms，**不可配置**。
  ```ts
  75  const controller = new AbortController();
  76  const timeout = setTimeout(() => controller.abort(), 60_000);
  ...
  93  } finally { clearTimeout(timeout); }
  ```
- **流式 `chatStream()`：单一定时器 120s，非 idle 重置。** L118-119。`clearTimeout` 在 L196（正常）、L131/L136（fetch 错误路径）清理。
  ```ts
  118 const controller = new AbortController();
  119 const timeout = setTimeout(() => controller.abort(), 120_000);
  ```
- `generateImage`：`AbortSignal.timeout(90_000)`（L371），整体调用超时。

### 流式处理
- 断行处理正确（L158-159 buffer + newline）。
- 损坏 chunk：L192 `catch { /* skip unparseable */ }` 静默跳过。
- **读取循环 L153-197 无 `try/catch`**：超时/中断 → `reader.read()`（L154）reject → 裸 `AbortError` 抛出，**非优雅结束**。流循环内抛错时 `clearTimeout`（L196）不执行（fetch 错误路径 L131/136 有清理，循环内路径没有）。

### 重试
- 无（grep 0 命中）。不可配置。

### 错误传播
- HTTP 非 2xx：L138 `Error('Gemini API error ${res.status}: ${errText}')`，带状态码。
- 超时/中断：裸 `AbortError`，无 timeout/状态/重试信息。
- 无候选时 `convertResponse` 抛 `Error('No response candidate from Gemini')`（L287），fail-loud。

### abort 支持
- 仅 `chatStream` 接受外部 `signal`（L98、L120）。`chat()` 与 `generateImage` 不接受外部 signal（后者用内部 `AbortSignal.timeout`）。

### 缺口 / 漏洞
1. 流式超时抛裸 `AbortError`，无信息、非优雅收尾。
2. 流循环内异常路径不清理定时器。
3. 超时时长写死，不可配置；只用一个 120s 总定时器，无按 chunk 的 idle 检测（中途断流最长可吞 120s 才被中断）。

---

## 3. openai.ts（5 个文件中处理最完善）

### 超时机制
- **非流式 `chat()`：`AbortController` + `this.chatTimeoutMs`（默认 90_000，可配 `config.timeoutMs`）**。L55、L66、L116-117，`finally` 清理 L147。
  ```ts
  55  this.chatTimeoutMs = config?.timeoutMs ?? 90_000;
  66  if (config.timeoutMs) this.chatTimeoutMs = config.timeoutMs;
  116 const controller = new AbortController();
  117 const timeout = setTimeout(() => controller.abort(), this.chatTimeoutMs);
  ```
- **流式 `chatStream()`：双定时器（唯一具备 idle 语义的实现）**。
  - **idle 超时**：`this.streamTimeoutMs`（默认 180_000，可配 `config.streamTimeoutMs`，L57/L67），**每次收到 chunk 都重置**（`bumpIdleTimeout`，L199-205，读循环 L254 每 chunk 调用）。L191-194。
  - **硬上限**：`STREAM_HARD_TIMEOUT_MS = 15 * 60_000`（15 分钟，L188），**硬编码、不可配置**。L195-198。
  ```ts
  188 const STREAM_HARD_TIMEOUT_MS = 15 * 60_000;
  191 let idleTimeout = setTimeout(() => { idleTimedOut = true; controller.abort(); }, this.streamTimeoutMs);
  195 const hardTimeout = setTimeout(() => { hardTimedOut = true; controller.abort(); }, STREAM_HARD_TIMEOUT_MS);
  199 const bumpIdleTimeout = () => { clearTimeout(idleTimeout); idleTimeout = setTimeout(...this.streamTimeoutMs); };
  ```
- 媒体方法用 `AbortSignal.timeout`：generateImage 120_000（L420）、generateSpeech 180_000（L465）、transcribeSpeech 120_000（L497）。

### 流式处理
- 断行正确（L257-258）；`data: [DONE]` 处理（L262）；损坏 chunk `catch {}` 跳过（L276）。
- **读取循环 L250-296 有 `try/catch` + `finally`**，行为最细致：
  - **idle 超时且已有部分输出 → 优雅收尾**：L283-285 清空 toolCalls、`finishReason = 'max_tokens'`，把中断当作正常结束返回已累积内容（不抛错）。
  - **idle/hard 超时且无输出 → 抛描述性错误**：L286-290。
    ```ts
    286 } else if (idleTimedOut || hardTimedOut) {
    287    const kind = hardTimedOut ? 'hard' : 'idle';
    288    throw new Error(`OpenAI stream ${kind} timeout after ${hardTimedOut ? STREAM_HARD_TIMEOUT_MS : this.streamTimeoutMs}ms`);
    290 }
    292 } else { throw err; }
    295 } finally { clearStreamTimeouts(); }
    ```
  - `bumpIdleTimeout` 在 fetch 成功后（L237）与每个 chunk（L254）调用。
- 工具参数结尾：`finalizeToolCalls` 用 `safeParseJson`（provider-helpers L401/407-412），**截断的 tool JSON 不会抛错**（安全回退 `{}`）。

### 重试
- openai.ts 内无重试逻辑（grep 0 命中）。不可配置。
- **注意**：idle 超时 + 部分输出被降级成 `max_tokens` 成功返回，可能会把「中途挂起」误判为正常完成，调用方无法感知需要重试。

### 错误传播
- HTTP 非 2xx：L234 带状态码。
- 超时：**L288-290 携带 timeout 类型（hard/idle）与时长**；fetch 阶段错误经 L223-228 包装（含 `cause` 细节）。
- 部分输出场景 fail-soft（优雅 max_tokens），无输出超时场景 fail-loud。

### abort 支持
- `chatStream` 接受外部 `signal`（L163、L210）。`chat()` 非流式不接受外部 signal。媒体方法只依赖内部 `AbortSignal.timeout`，不可外部取消。

### 缺口 / 漏洞
1. 硬上限 15 分钟写死，不可配置。
2. 部分输出 + idle 超时 → 静默降级为 `max_tokens`，可能掩盖真实断流（错误信息丢失）。
3. 非流式 `chat()` 不支持外部取消。
4. 媒体调用（image/tts/stt）不支持外部 abort，仅靠内部 `AbortSignal.timeout`。

---

## 4. dashscope.ts（继承 OpenAIProvider）

继承自 `openai.ts`，因此 **chat / chatStream 的超时、双定时器、优雅收尾、无重试、错误传播** 全部与 openai 一致（含其缺口）。

### 自有方法超时（多模态）
- `generateImage`：`AbortSignal.timeout(120_000)`（L110-115）。
- `generateSpeech`：`AbortSignal.timeout(60_000)`（L167-172）；**音频下载另设 `AbortSignal.timeout(30_000)`**（L194）。

### 错误传播 / fail-loud
- HTTP 非 2xx：L119（image）、L176（tts）带状态码。
- **业务错误显式抛**：`data.code` 存在时抛 `DashScope XX error: code - message`（L132-134、L185-187）。
- 无音频 URL 抛错（L190-192）；下载失败抛错（L195-197）。全部 fail-loud。

### 重试
- 无（继承 openai，无重试）。

### abort 支持
- 继承的 `chatStream` 支持外部 signal；自有 image/tts 仅内部 `AbortSignal.timeout`，不可外部取消。

### 缺口 / 漏洞
- 同 openai 的全部缺口；多模态方法（image/tts）用 `AbortSignal.timeout` 固定写死，不可配置、不可外部取消。

---

## 5. ollama.ts

### 超时机制
- **非流式 `chat()`：`AbortController` + 120s**（L65-66），`finally` 清理 L83-85。
  ```ts
  65  const controller = new AbortController();
  66  const timeout = setTimeout(() => controller.abort(), 120_000);
  ...
  83  } finally { clearTimeout(timeout); }
  ```
- **流式 `chatStream()`：单一定时器 120s，非 idle 重置**（L106-107）。`clearTimeout` 在 L177（正常）、L119/L124（fetch 错误路径）清理。默认 120_000ms，写死不可配置。

### 流式处理
- 断行：按行 buffer 处理（L145-146），Ollama 走行分隔（非 SSE `data:` 前缀），L149-153 对整行 JSON.parse。半行留在 buffer，正确。
- 损坏 chunk：L173 `catch { /* skip */ }` 静默跳过。
- **读取循环 L140-185 无 `try/catch`**：超时/中断 → `reader.read()`（L141）reject → 裸 `AbortError` 抛出，非优雅结束。流循环内异常路径不清理定时器。

### 重试
- 无（grep 0 命中）。不可配置。

### 错误传播
- HTTP 非 2xx：L126 带状态码。
- 超时/中断：裸 `AbortError`，无 timeout/状态/重试信息。
- 工具参数在流里已是对象（L163），`convertResponse` 直接使用（L230），无 JSON.parse 风险。

### abort 支持
- `chatStream` 接受外部 `signal`（L88、L108）。`chat()` 非流式不支持外部 signal。

### 缺口 / 漏洞
1. 流式超时/中断抛裸 `AbortError`，非优雅、无错信息。
2. 流循环内异常不清理定时器。
3. 单一 120s 总定时器，无按 chunk idle 检测（中途断流最多吞 120s）。
4. 超时时长写死不可配置。

---

## 汇总：最高优先级风险

1. **[严重] anthropic `chat()` 完全无超时**（L91-102）→ 可永久挂起。
2. **[中] anthropic / google / ollama 流式超时/中断抛裸 `AbortError`**，非优雅、无超时/状态信息，调用方无法区分超时与主动取消。
3. **[中] anthropic 流式工具参数 `JSON.parse(tc.args)`（L242）无防护**，截断的工具调用抛原始 `SyntaxError`（openai 已用 `safeParseJson` 解决，anthropic 未跟进）。
4. **[低-中] 三处（anthropic/google/ollama）流循环内异常路径不执行 `clearTimeout`** → 定时器残留至到期。
5. **[低] 各 provider 流式超时时长写死**（anthropic/google/ollama 120s、openai hard 15min），仅 openai 的 chat/stream idle 值可通过 config 配置。
6. **[设计确认] 无任何重试机制**（5 个文件均为单次尝试），配合部分文件「静默跳过损坏 chunk」会静默丢语义数据。
7. 非流式 `chat()` 全部不支持外部取消（仅 `chatStream` 有 signal）。
