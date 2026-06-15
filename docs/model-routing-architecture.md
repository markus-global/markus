# Model Routing Architecture

## Overview

Markus uses a multi-layer model routing system built into `LLMRouter` to solve four problems:

1. **Cost optimization** — complexity-based tier selection routes simple requests to cheaper models
2. **Cache affinity** — session-level model pinning maximizes prompt-cache hit rates
3. **Multi-modal support** — unified task routing covers text, image generation, TTS, STT, and video
4. **Manual control** — users can assign specific provider/model pairs to each task type

---

## Architecture

```
User Request
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                       LLMRouter                          │
│                                                          │
│  Text path                  Non-text path                │
│  ─────────                  ─────────────                │
│  assessComplexity()         inferTaskType()               │
│       │                          │                       │
│       ▼                          ▼                       │
│  selectProvider()           selectForTask()               │
│  (tier-based +              (taskRouting.assignments      │
│   fallback chain)            → provider/model)            │
│       │                          │                       │
│       ▼                          ▼                       │
│  tryChat / tryStream        resolveModalityProvider()     │
│  (circuit breaker,          → MultiModalProviderInterface │
│   health tracking)            generateImage / TTS / STT   │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│              Provider Implementations                     │
│                                                          │
│  OpenAIProvider (implements MultiModalProviderInterface)  │
│    - chat, chatStream                                    │
│    - generateImage (DALL-E)                               │
│    - generateSpeech (TTS-1)                               │
│    - transcribeSpeech (Whisper)                           │
│                                                          │
│  GoogleProvider (implements MultiModalProviderInterface)  │
│    - chat, chatStream                                    │
│    - generateImage (Imagen via Gemini)                   │
│                                                          │
│  AnthropicProvider, OllamaProvider, etc.                 │
│    - chat only                                           │
└──────────────────────────────────────────────────────────┘
```

## Text Routing Flow

For text/chat requests (`taskType === 'text'`), the router uses complexity-based selection:

1. **`assessComplexity(request)`** — hard thresholds on tool count (>5), character count (>8000), message count (>15) determine `simple | moderate | complex`
2. **`selectProvider(request)`** — considers complexity, tier ordering, session affinity, and circuit breaker health
3. **Fallback chain** — if the primary provider fails, the router tries alternates in order
4. **`tryChat()` / `tryStream()`** — executes the request with health tracking. On failure, the model is restored in the `catch` block (not `finally`) to avoid corrupting state on success

## Multi-Modal Routing Flow

For non-text tasks (`image_generation`, `audio_tts`, `audio_stt`, `video_generation`):

1. **`inferTaskType(request)`** — detects images in messages → `image_recognition`, otherwise `text`
2. **`selectForTask(taskType)`** — looks up `taskRouting.assignments[taskType]`, falls back to `routingDefaultModel`, then `defaultProvider`
3. **`resolveModalityProvider(taskType)`** — returns a `MultiModalProviderInterface` instance configured with the assigned model

### Multi-Modal Tools

Registered via `createMultiModalTools()` in `AgentManager`:

| Tool | TaskType | Provider Method |
|------|----------|-----------------|
| `generate_image` | `image_generation` | `generateImage()` |
| `text_to_speech` | `audio_tts` | `generateSpeech()` |
| `speech_to_text` | `audio_stt` | `transcribeSpeech()` |
| `generate_video` | `video_generation` | `generateVideo()` |

The tools resolve their provider via `llmRouter.resolveModalityProvider(taskType)`.

**Output behavior:**
- `generate_image` → returns `{ url, revisedPrompt }` or `{ base64 }`
- `text_to_speech` → saves audio to temp file, returns `{ filePath, format, sizeBytes }`
- `speech_to_text` → accepts URL or local file path, returns `{ text }`
- `generate_video` → returns `{ taskId, status, url }` (async polling)

## Model Catalog

### Sources (priority order)

1. **Live catalog** — fetched from LiteLLM's public model list, refreshed every 24h, cached in `~/.markus/model_prices_and_context_window.json`
2. **Baseline catalog** — bundled in `packages/core/data/model-catalog-baseline.json`
3. **Supplements** — additional entries in `model-catalog-supplements.json`
4. **BUILTIN_MODEL_CATALOG** — hardcoded entries in `router.ts` for common models

### Regional Provider Aliases

Regional variants share the parent provider's model catalog:

```typescript
REGIONAL_PROVIDER_ALIASES = {
  'minimax-cn': 'minimax',
  'siliconflow-intl': 'siliconflow',
};
```

`getProviderModels()` synthesizes entries for aliased providers at runtime.

## Tier Classification

Models are classified into three tiers: `base`, `pro`, `max`.

**Classification sources (in priority order):**
1. Explicit `tier` field on `ModelDefinition` (BUILTIN_MODEL_CATALOG entries)
2. `estimateQualityScore()` using input cost per 1M tokens:
   - `>= $3` → `max` (score ≥ 75)
   - `>= $0.50` → `pro` (score ≥ 50)
   - `< $0.50` → `base`
3. Parameter count from model name (`\d+B`) as secondary signal

## Configuration

All routing configuration lives in `MarkusConfig.llm`:

```typescript
interface MarkusConfig {
  llm: {
    taskRouting?: TaskRoutingConfig;        // per-task model assignments
    routingDefaultModel?: { provider: string; model: string };
    catalogMirrorUrl?: string;              // optional mirror for catalog fetch
    // ... existing fields
  };
}
```

### Task Routing Config

```typescript
interface TaskRoutingConfig {
  assignments: Partial<Record<ModelTaskType, TaskModelAssignment>>;
}

interface TaskModelAssignment {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
}

type ModelTaskType = 'text' | 'image_recognition' | 'image_generation' | 'audio_tts' | 'audio_stt' | 'video_generation';
```

## API Endpoints

| Endpoint | Method | Description | Caching |
|----------|--------|-------------|---------|
| `/api/settings/llm/routing` | GET | Current routing config | None |
| `/api/settings/llm/routing` | POST | Update routing config | Invalidates routing-candidates cache |
| `/api/models/routing-candidates` | GET | All available models per provider | 5-min server-side TTL |
| `/api/models/suggested-assignments` | GET | Auto-suggested best model per task | None |

## UI Components

- **`ModelRoutingSection`** — task assignment table with per-task model selection
- **`ModelSelect`** — searchable model dropdown grouped by provider
- **`ModelPicker`** — model selection with tier/cost badges for the main settings panel

### Stale Assignment Handling

When a provider is removed from configuration, its task assignments become stale. The UI shows a yellow warning badge (⚠) on stale assignments instead of auto-cleaning them, letting users decide whether to clear or reconfigure.
