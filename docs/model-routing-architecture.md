# Model Routing Architecture

## 概述

Markus 的模型路由系统是一套多层次的智能模型选择框架，解决四个核心问题：

1. **成本优化**：不同难度的任务使用不同层级的模型，避免用昂贵模型处理简单任务
2. **缓存感知**：同一会话内保持同一模型，最大化 prompt caching 的经济收益
3. **多模态支持**：统一路由文本、图像、语音、视频等不同模态的请求
4. **手动控制**：允许用户按任务类型手动指定模型，与自动路由并存

---

## 系统架构

```
用户请求
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                    LLMRouter                              │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ 任务类型检测  │──▶│ 路由策略决策   │──▶│ Provider 选择 │  │
│  │             │   │              │   │              │  │
│  │ assessCompl │   │ selectForTask│   │ selectBy Tier│  │
│  │ exity()     │   │              │   │              │  │
│  └─────────────┘   └──────────────┘   └──────────────┘  │
│         │                 │                    │         │
│         ▼                 ▼                    ▼         │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ Session 锁定 │   │ 手动分配查找   │   │ 健康检查/熔断 │  │
│  │ (Cache)     │   │ (TaskRouting)│   │ (Circuit)    │  │
│  └─────────────┘   └──────────────┘   └──────────────┘  │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│                  ModalityRouter                           │
│                                                          │
│    chat ──▶ LLMRouter (文本对话)                          │
│    image_gen ──▶ ImageProvider (DALL-E/Flux)              │
│    tts ──▶ TTSProvider (OpenAI TTS/ElevenLabs)           │
│    stt ──▶ STTProvider (Whisper)                         │
│    video_gen ──▶ VideoProvider (Kling/Runway)             │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│               数据层 (Model Profile)                      │
│                                                          │
│  ModelCatalogService ←── LiteLLM (价格 + 能力)            │
│  ModelScoreService   ←── Arena AI (质量 benchmark)        │
│  ModelProfileService ──▶ 统一 ModelProfile (合并数据)      │
└──────────────────────────────────────────────────────────┘
```

---

## 一、模型分层体系（Model Tier）

### 三层模型分级

每个模型被归入 `base` / `pro` / `max` 三个层级，分级依据是综合质量分数（qualityScore，0-100）：

| Tier | qualityScore | 典型模型 | 适用场景 |
|------|-------------|---------|---------|
| **max** | ≥ 80 | Claude Opus 4.6, GPT-5.4, Gemini 3.1 Pro | 复杂推理、困难分析、关键决策 |
| **pro** | 55-79 | Claude Sonnet 4, GPT-4o, o4-mini, DeepSeek-V4-Pro | 日常任务、代码生成、一般分析 |
| **base** | < 55 | Claude Haiku, Gemini Flash, DeepSeek-V4-Flash | 简单问答、格式化、分类、翻译 |

### 分数来源

qualityScore 由两种方式确定：

**1. Arena AI ELO 分数（优先）**

`ModelScoreService` 每 24 小时从 Arena AI 排行榜拉取 ELO 分数（text / code / vision 三个类别），归一化为 0-100 分数：

```
qualityScore = (模型ELO - 最低ELO) / (最高ELO - 最低ELO) × 100
```

**2. 启发式估分（兜底）**

当 Arena 数据不可用时，根据模型名称模式估算（`estimateQualityScore()`）：

| 模型名包含 | 估分 |
|-----------|------|
| opus | 90 |
| gpt-5.4, gpt-5.5 | 88 |
| gemini-3, gemini-2.5-pro | 80 |
| sonnet | 75 |
| gpt-4o | 75 |
| deepseek-v4-pro | 72 |
| mimo, kimi | 68 |
| deepseek-v3 | 65 |
| gpt-4.1-mini | 62 |
| deepseek-v4-flash | 60 |
| gemini flash | 58 |
| haiku | 55 |
| 未知模型 | 50 |
| nano | 45 |

带 `reasoning` 能力的模型额外加 5 分。

### 成本层级（CostTier）

独立于质量层级，用于 UI 展示：

| CostTier | input 价格 ($/1M tokens) |
|----------|------------------------|
| `$` | < $0.50 |
| `$$` | $0.50 - $2.00 |
| `$$$` | $2.00 - $5.00 |
| `$$$$` | > $5.00 |

---

## 二、复杂度评估（assessComplexity）

`LLMRouter.assessComplexity()` 从请求特征推断任务难度，返回 `simple` / `moderate` / `complex`：

```
评估流程:

1. 硬性阈值（优先判断）
   - 工具数 > 5 OR 总字符数 > 8000 OR 消息数 > 15 → complex

2. 关键词检测（最后一条用户消息）
   - 复杂关键词: architect, design, analyze, debug, refactor, optimize,
     complex, difficult, reasoning, think step, chain of thought → complex
   - 简单关键词: translate, summarize, format, convert, hello, yes, no → simple（仅在总字符 < 500 时）

3. 系统提示长度
   - 系统提示 > 4000 字符 → complex

4. 中间阈值
   - 工具数 > 0 OR 总字符数 > 2000 OR 消息数 > 5 → moderate

5. 默认 → simple
```

---

## 三、路由策略（Routing Strategy）

用户可在配置文件（`markus.json`）中选择四种策略：

### 策略与 Tier 映射

| 策略 | simple 任务 | moderate 任务 | complex 任务 | 说明 |
|------|-----------|-------------|-------------|------|
| `always_max` | max | max | max | 始终用最好的，不在乎成本 |
| `always_cheapest` | base | base | base | 始终用最便宜的 |
| `balanced`（默认） | base | pro | max | 根据任务复杂度动态选择 |
| `cache_optimized` | defaultTier | defaultTier | defaultTier | 始终用默认层级，优先保证缓存命中 |

### 配置示例

```json
{
  "llm": {
    "routing": {
      "strategy": "balanced",
      "defaultTier": "pro",
      "preferCacheHit": true
    }
  }
}
```

---

## 四、路由决策流程（selectForTask）

每次 LLM 请求的完整决策路径：

```
1. 检查手动分配 (taskRouting.assignments)
   │
   ├── 有手动分配且 provider 可用 → 使用该模型
   ├── 有手动分配但主 provider 不可用 → 使用 fallback
   └── 无手动分配或全不可用 → 继续

2. 检查 Session 锁定 (Cache 优化)
   │
   ├── 有 sessionId 且 preferCacheHit=true 且 session 已锁定模型
   │   └── 锁定的 provider 可用 → 使用该模型（缓存命中）
   └── 否则 → 继续

3. 自动路由 (Tier-based)
   │
   ├── assessComplexity(request) → 得到 simple/moderate/complex
   ├── recommendTier(complexity, strategy) → 得到目标 tier
   ├── selectProviderByTier(tier) → 在 BUILTIN_MODEL_CATALOG 中
   │   找该 tier 且 provider 健康的模型
   │   └── 优先级: 目标tier > 相邻tier > 任意可用 provider
   └── 将选中的模型锁定到 session
```

### Tier 选择的容错优先级

当目标 tier 无可用模型时，按以下顺序降级：

| 目标 tier | 降级顺序 |
|----------|---------|
| max | max → pro → base |
| pro | pro → max → base |
| base | base → pro → max |

---

## 五、缓存感知路由（Cache-Aware Routing）

### 核心经济学

各 provider 的缓存价格差异巨大：

| Provider | 缓存写入 | 缓存读取 | 节省 |
|----------|---------|---------|------|
| Anthropic | 1.25x 基础价 | 0.10x（节省 90%） | 90% |
| OpenAI | 自动，无额外成本 | 0.50x（节省 50%） | 50% |
| Google | 类似 | 0.10-0.25x | 75-90% |

### 关键设计决策

**Session 级别路由，而非 Turn 级别路由。**

原因：Session 内切换模型会破坏缓存前缀匹配。缓存命中的 Sonnet 4 ($0.30/MTok) 比未命中的 Haiku ($1.00/MTok) 更便宜。

### 实现机制

```typescript
// LLMRouter 内部
private sessionModels = new Map<string, { provider, model, tier }>();
```

- Session 首次请求时，根据策略选模型并锁定
- 后续请求直接使用锁定模型（缓存命中）
- 仅在以下情况解锁：
  - 锁定的 provider 变为不可用
  - 用户显式要求切换（`clearSessionModel()`）

---

## 六、任务-模型手动路由（Task Routing）

### 任务类型定义

系统定义了 12 种任务类型（`ModelTaskType`），分 5 大类：

```
TEXT:    text_chat, text_reasoning, text_coding, text_translation, text_summary
IMAGE:   image_recognition, image_generation
AUDIO:   audio_tts, audio_stt
VIDEO:   video_generation
OTHER:   embedding, web_search
```

### 三种路由模式

| 模式 | 行为 |
|------|------|
| `auto` | 所有任务走自动路由（不看手动分配） |
| `manual` | 所有任务必须有手动分配（未配置的任务回退到 auto） |
| `hybrid`（推荐） | 有手动分配的走手动，没有的走自动 |

### 配置示例

```json
{
  "llm": {
    "taskRouting": {
      "mode": "hybrid",
      "autoStrategy": "balanced",
      "defaultTier": "pro",
      "assignments": {
        "text_chat": {
          "provider": "anthropic",
          "model": "claude-sonnet-4-6"
        },
        "text_reasoning": {
          "provider": "anthropic",
          "model": "claude-opus-4-6"
        },
        "text_coding": {
          "provider": "deepseek",
          "model": "deepseek-v4-pro"
        },
        "image_generation": {
          "provider": "siliconflow",
          "model": "flux-1-schnell"
        },
        "audio_tts": {
          "provider": "openai",
          "model": "tts-1-hd"
        }
      }
    }
  }
}
```

---

## 七、多模态路由（ModalityRouter）

### 设计原则

多模态能力以 **Agent Tool** 形式暴露，而非改造 LLM 聊天流：

- Agent 自然决定何时调用多模态能力
- 每种模态可独立选择最优 provider
- 不需要改造 chat 流

### 任务类型 → 模态映射

```
text_chat, text_reasoning, text_coding,
text_translation, text_summary,          ──▶ chat      ──▶ LLMRouter
image_recognition, web_search

image_generation                         ──▶ image_gen ──▶ ImageProvider
audio_tts                                ──▶ tts       ──▶ TTSProvider
audio_stt                                ──▶ stt       ──▶ STTProvider
video_generation                         ──▶ video_gen ──▶ VideoProvider
embedding                               ──▶ embedding ──▶ EmbeddingProvider
```

### Provider 能力声明

每个 Provider 通过 `ProviderCapabilities` 声明支持的模态：

```typescript
interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  imageGeneration: boolean;
  tts: boolean;
  stt: boolean;
  videoGeneration: boolean;
  embedding: boolean;
  reasoning: boolean;
  promptCaching: boolean;
}
```

`ModalityRouter` 在注册 Provider 时根据能力自动归类到对应模态。

### 多模态 Agent Tools

系统提供 4 个多模态 Agent Tool：

| Tool | 功能 | 调用方式 |
|------|------|---------|
| `generate_image` | 文字生成图片 | Agent 自主判断需要生成图片时调用 |
| `text_to_speech` | 文字转语音 | Agent 收到 TTS 请求时调用 |
| `speech_to_text` | 语音转文字 | 收到音频消息时调用 |
| `generate_video` | 文字生成视频 | Agent 收到视频生成请求时调用 |

### 多模态模型匹配

一个模型可能服务多种任务类型。`getModelTaskTypes()` 根据模型的 `mode` 和 `capabilities` 推断：

```
GPT-5       → text_chat, text_reasoning, text_coding, image_recognition, web_search
Claude Opus → text_chat, text_reasoning, text_coding, image_recognition
FLUX        → image_generation（仅此一项）
Whisper     → audio_stt（仅此一项）
```

多模态策略选择：

| 策略 | 行为 | 适合场景 |
|------|------|---------|
| `unified` | 尽量复用同一模型处理多种任务 | 减少模型数，利于缓存 |
| `specialized` | 每种任务用最擅长的专用模型 | 质量优先，允许碎片化 |

---

## 八、数据层

### 三层数据叠加

```
层级1: 价格数据 (ModelCatalogService ← LiteLLM)
  - inputCostPer1MTokens / outputCostPer1MTokens
  - cacheReadCostPer1MTokens / cacheWriteCostPer1MTokens
  - 24h 自动刷新 + model-catalog-supplements.json 手动补充

层级2: 能力数据 (ModelCatalogService ← LiteLLM)
  - vision, functionCalling, reasoning, promptCaching
  - webSearch, audioInput, audioOutput
  - 覆盖 300+ 模型

层级3: 质量分数 (ModelScoreService ← Arena AI)
  - text/code/vision 三类 ELO 分数
  - 24h 自动刷新
  - 缓存: ~/.markus/model-scores-cache.json
```

### ModelProfile — 统一数据结构

`ModelProfileService` 将三层数据合并为 `ModelProfile`：

```typescript
interface ModelProfile {
  // 基础信息
  id: string;              // "claude-opus-4-6"
  provider: string;        // "anthropic"
  displayName: string;     // "claude-opus-4-6"
  family: string;          // "claude"
  mode: string;            // "chat"

  // 规格
  maxInputTokens: number;  // 1000000
  maxOutputTokens: number; // 128000

  // 价格（归一化）
  cost: NormalizedCost;

  // 能力
  capabilities: CatalogModelCapabilities;

  // 质量
  quality: {
    overallElo?: number;   // 1503 (Arena text)
    codingElo?: number;    // 1480 (Arena code)
    visionElo?: number;    // 1450 (Arena vision)
    qualityScore: number;  // 92 (归一化 0-100)
    tier: ModelTier;       // "max"
    lastUpdated: string;
  };

  // 该模型支持的任务类型
  taskTypes: ModelTaskType[];  // ["text_chat", "text_reasoning", ...]

  // 派生指标（自动计算）
  derived: {
    costEfficiency: number;      // qualityScore / inputCost
    costTier: CostTier;          // "$$$"
    latencyClass: 'fast' | 'medium' | 'slow';
  };
}
```

### 价格归一化（NormalizedCost）

不同模态的模型计费单位不同，`NormalizedCost` 统一表示：

```typescript
interface NormalizedCost {
  // Token 计费（chat/embedding）
  inputPer1MTokens?: number;
  outputPer1MTokens?: number;
  cachedReadPer1MTokens?: number;
  cachedWritePer1MTokens?: number;

  // 按请求计费（Perplexity search）
  perRequest?: number;

  // 按图片计费（DALL-E）
  perImage?: number;

  // 按音频计费（TTS/STT）
  perMinute?: number;       // STT: $/分钟
  per1MChars?: number;      // TTS: $/百万字符

  // 按视频计费
  perSecond?: number;       // 视频生成: $/秒

  // 元信息
  pricingType: 'token' | 'request' | 'image' | 'audio' | 'video'
             | 'free' | 'local' | 'variable' | 'unknown';
  isFree: boolean;
  isLocal: boolean;
  priceConfidence: 'exact' | 'estimated' | 'unknown';
}
```

### 无价格模型的处理

| 类型 | 处理方式 |
|------|---------|
| 免费模型 | `pricingType: 'free'`, 正常参与路由 |
| 本地模型 | `pricingType: 'local'`, 标注 "Free (runs locally)" |
| 聚合入口 (openrouter/auto) | `pricingType: 'variable'`, 不参与成本比较 |
| 预览模型 | `priceConfidence: 'unknown'`, 仅手动选择可用 |
| 可估算 | `priceConfidence: 'estimated'`, 使用同家族价格 × 1.2 |

---

## 九、Provider 聚合

### 已注册的聚合服务商

| Provider | 特点 | 模态覆盖 |
|----------|------|---------|
| OpenRouter | 400+ 模型 | 仅文本 |
| SiliconFlow | 国内友好 | 文本 + 图像 |
| Atlas Cloud | OpenAI 兼容, 300+ 模型 | 全模态 |
| Strongly.AI | 302 模型 | 全模态 |

用户只需填写一个聚合服务商的 API key，即可使用 text + image + audio + video 能力。

---

## 十、文件清单与职责

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types/model-catalog.ts` | 所有类型定义：ModelTier, ModelTaskType, RoutingStrategy, ModelProfile, NormalizedCost 等 |
| `packages/shared/src/types/llm.ts` | ModelDefinition 扩展 tier 字段 |
| `packages/shared/src/utils/config.ts` | MarkusConfig 新增 routing / taskRouting 配置项 |
| `packages/shared/src/models.ts` | PROVIDERS 注册表，新增 Atlas Cloud / Strongly.AI |
| `packages/core/src/llm/router.ts` | **核心路由逻辑**：assessComplexity, recommendTier, selectForTask, selectProviderByTier, sessionModels, BUILTIN_MODEL_CATALOG |
| `packages/core/src/llm/provider.ts` | Provider 接口扩展：MultiModalProviderInterface, ImageGenOptions, TTSOptions 等 |
| `packages/core/src/llm/modality-router.ts` | ModalityRouter：非 chat 模态的 provider 路由 |
| `packages/core/src/llm/model-scores.ts` | ModelScoreService：Arena AI ELO 分数拉取与缓存 |
| `packages/core/src/llm/model-profile.ts` | ModelProfileService：合并 catalog + scores 生成统一 ModelProfile |
| `packages/core/src/tools/multimodal.ts` | 多模态 Agent Tools：generate_image, text_to_speech, speech_to_text, generate_video |
| `packages/cli/src/commands/start.ts` | 启动时从配置加载 routing/taskRouting 应用到 LLMRouter |
| `packages/web-ui/src/constants/providers.ts` | UI 端 provider 选项列表 |

---

## 十一、配置完整参考

```json
{
  "llm": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-6",
    "autoFallback": true,

    "routing": {
      "strategy": "balanced",
      "defaultTier": "pro",
      "preferCacheHit": true,
      "tierOverrides": {
        "customer-support-agent": "base"
      },
      "budgetLimit": 100
    },

    "taskRouting": {
      "mode": "hybrid",
      "autoStrategy": "balanced",
      "defaultTier": "pro",
      "multiModalStrategy": "specialized",
      "assignments": {
        "text_chat": {
          "provider": "anthropic",
          "model": "claude-sonnet-4-6"
        },
        "text_reasoning": {
          "provider": "anthropic",
          "model": "claude-opus-4-6"
        },
        "text_coding": {
          "provider": "deepseek",
          "model": "deepseek-v4-pro",
          "fallback": {
            "provider": "anthropic",
            "model": "claude-sonnet-4-6"
          }
        },
        "image_generation": {
          "provider": "siliconflow",
          "model": "flux-1-schnell"
        },
        "audio_tts": {
          "provider": "openai",
          "model": "tts-1-hd"
        },
        "audio_stt": {
          "provider": "openai",
          "model": "whisper-1"
        }
      }
    },

    "providers": {
      "anthropic": { "apiKey": "sk-ant-..." },
      "openai": { "apiKey": "sk-..." },
      "deepseek": { "apiKey": "sk-..." },
      "siliconflow": {
        "apiKey": "sf-...",
        "baseUrl": "https://api.siliconflow.cn/v1"
      }
    }
  }
}
```

---

## 十二、数据文件

| 路径 | 内容 | TTL |
|------|------|-----|
| `~/.markus/model-catalog-cache.json` | LiteLLM 模型 catalog（已有） | 24h |
| `~/.markus/model-scores-cache.json` | Arena AI ELO 排行数据 | 24h |
| `~/.markus/model-profiles-cache.json` | 合并后的 ModelProfile[] | 随刷新重建 |

### 启动时初始化流程

```
1. ModelCatalogService.init()     ── 加载价格 + 能力（已有）
2. ModelScoreService.init()       ── 加载 Arena ELO（从缓存 + 后台刷新）
3. ModelProfileService.build()    ── 合并 → ModelProfile[]
4. LLMRouter.setRoutingConfig()   ── 从 markus.json 加载路由策略
5. LLMRouter.setTaskRouting()     ── 从 markus.json 加载任务路由
6. ModalityRouter.loadAssignments() ── 加载多模态任务分配
```

### 24h 定时刷新

```
catalog refresh → score refresh → profile rebuild → 通知 Router 更新 tier 映射
```
