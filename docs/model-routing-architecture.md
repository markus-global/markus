# Model Routing Architecture

## Overview

Markus uses a multi-layer model routing system built into `LLMRouter` to solve four problems:

1. **Cost optimization** — complexity-based tier selection routes simple requests to cheaper providers
2. **Multi-modal support** — unified capability routing covers text, vision, image generation, TTS, STT, and video
3. **Resilience** — circuit breaker health tracking with automatic cross-provider fallback
4. **Manual control** — users can assign specific provider/model pairs to each capability type

---

## Architecture

```
User Request
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                       LLMRouter                          │
│                                                          │
│  Text path (no assignment)  Text/Non-text with assignment│
│  ─────────────────────────  ────────────────────────────-│
│  assessComplexity()         selectForCapability()        │
│       │                   (capabilityRouting.assignments │
│       ▼                      → routingDefaultModel       │
│  selectProvider()            → selectProvider fallback)  │
│  (tier-based)                     │                      │
│       │                           │                      │
│       ▼                           ▼                      │
│  tryChat / tryStream ◄────────────┘                      │
│  (circuit breaker, health tracking, fallback chain)      │
│                                                          │
│  Multimodal tools path                                   │
│  ─────────────────────                                   │
│  resolveModalityCandidates(capabilityType)               │
│  → returns ordered list of { provider, model, name }     │
│  → tools loop candidates with try/catch fallback         │
│  → caller passes model to API (no shared state mutation) │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│              Provider Implementations                    │
│                                                          │
│  OpenAIProvider (implements MultiModalProviderInterface) │
│    - chat, chatStream                                    │
│    - generateImage (options.model ?? 'dall-e-3')         │
│    - generateSpeech (options.model ?? 'tts-1')           │
│    - transcribeSpeech (options.model ?? 'whisper-1')     │
│                                                          │
│  GoogleProvider (implements MultiModalProviderInterface) │
│    - chat, chatStream                                    │
│    - generateImage (options.model ?? gemini-2.0-flash..) │
│                                                          │
│  AnthropicProvider, OllamaProvider, etc.                 │
│    - chat only                                           │
└──────────────────────────────────────────────────────────┘
```

---

## Text Chat Routing (chat / chatStream)

```mermaid
sequenceDiagram
    participant Agent
    participant Router as LLMRouter
    participant Provider

    Agent->>Router: chat(request, providerName?, options?)

    alt Explicit providerName
        Router->>Router: selectProvider(request, providerName)
        Note right of Router: Honor if available, else fall through
    else No provider specified
        Router->>Router: inferCapability(request)
        alt capabilityType = text AND no text assignment
            Router->>Router: assessComplexity(request)
            Router->>Router: selectProvider(request)
            Note right of Router: Tier-based: default → anthropic → openai → others
        else capabilityType = text WITH assignment, or non-text
            Router->>Router: selectForCapability(capabilityType)
            Note right of Router: assignment → fallback → routingDefaultModel → selectProvider
        end
    end

    Router->>Provider: tryChat(primary, request, routedModel?)
    Note right of Router: tryChat temporarily configures altModel<br/>on the provider, always restores original<br/>model in finally block
    alt Success
        Provider-->>Router: response
        Router->>Router: recordSuccess(provider, model)
        Router-->>Agent: response
    else Failure
        Router->>Router: recordFailure(provider, model)
        alt autoFallback enabled AND retryable error
            Router->>Router: findHealthyModel(primary)
            Router->>Provider: tryChat(primary, request, altModel)
        end
        loop Each fallback provider
            Router->>Provider: tryChat(fallbackName, request)
        end
        alt All failed
            Router-->>Agent: throw lastError
        end
    end
```



**Note on text chat model switching:** Unlike the multimodal path which avoids provider mutation entirely, `tryChat()` / `tryStream()` temporarily mutate the provider's model via `configure()` when using an alternate model (routed or fallback). The original model is always restored in a `finally` block after each attempt to prevent state leakage across calls.

### Complexity Assessment


| Level        | Condition (any triggers)                                  |
| ------------ | --------------------------------------------------------- |
| **complex**  | `toolCount > 5` OR `totalChars > 8000` OR `msgCount > 15` |
| **moderate** | `toolCount > 0` OR `totalChars > 2000` OR `msgCount > 5`  |
| **simple**   | everything else                                           |


### Provider Tier Mapping


| Provider kind               | Complexity levels         | Precedence   |
| --------------------------- | ------------------------- | ------------ |
| **Default provider**        | simple, moderate, complex | Always first |
| **anthropic** (non-default) | complex only              |              |
| **openai** (non-default)    | complex, moderate         |              |
| **Everything else**         | simple, moderate          |              |


### Text Capability Assignment

When `capabilityRouting.assignments.text` is configured, text chat requests use `selectForCapability()` instead of complexity-based `selectProvider()`. This lets users pin a specific provider/model for all text chat.

When no text assignment exists, the classic complexity-based tier routing applies.

---

## Multi-Modal Routing (Tools)

```mermaid
sequenceDiagram
    participant Tool as Multimodal Tool
    participant Router as LLMRouter
    participant Provider

    Tool->>Router: resolveModalityCandidates(capabilityType)

    Note over Router: Build ordered candidate list:<br/>1. assignment -> 2. assignment.fallback<br/>3. routingDefaultModel (if capable)<br/>4. defaultProvider (if capable)<br/>5. all remaining providers (if autoFallback)
    Router-->>Tool: candidates[]

    Note over Tool: Filter candidates by capability<br/>(e.g. provider.generateImage exists)

    loop Each candidate (try until success)
        alt generate_image
            Tool->>Provider: generateImage(prompt, { model, size, ... })
            Note right of Provider: Uses options.model ?? 'dall-e-3'
        else text_to_speech
            Tool->>Provider: generateSpeech(text, { model, voice, ... })
            Note right of Provider: Uses options.model ?? 'tts-1'
        else speech_to_text
            Tool->>Provider: transcribeSpeech(audio, { model, language, ... })
            Note right of Provider: Uses options.model ?? 'whisper-1'
        else generate_video
            Tool->>Provider: generateVideo(prompt, { model, duration, ... })
        end

        alt Success
            Provider-->>Tool: result
            Tool-->>Tool: Format and return JSON
        else Failure
            Tool-->>Tool: Log error, try next candidate
        end
    end
```



### Key Design: No Shared State Mutation

`resolveModalityCandidates()` returns a list of `{ provider, model, name }` tuples. The caller passes `model` into the provider method's `options` parameter. This prevents a critical bug where mutating `provider.model` (via `configure()`) for a modality call would corrupt subsequent chat requests on the same provider instance.

### Agent-Level Overrides

Each multimodal tool accepts optional `provider` and `model` parameters from the agent. When provided, `resolveEffectiveCandidates()` filters the candidate list: an explicit `provider` restricts to that single provider, and an explicit `model` overrides the routing-assigned model on all candidates. This lets agents dynamically select providers without changing the global routing configuration.

### Multi-Modal Tools

Registered via `createMultiModalTools()` in `AgentManager`:


| Tool             | CapabilityType     | Provider Method      | Default Model |
| ---------------- | ------------------ | -------------------- | ------------- |
| `generate_image` | `image_generation` | `generateImage()`    | `dall-e-3`    |
| `text_to_speech` | `audio_tts`        | `generateSpeech()`   | `tts-1`       |
| `speech_to_text` | `audio_stt`        | `transcribeSpeech()` | `whisper-1`   |
| `generate_video` | `video_generation` | `generateVideo()`    | (none yet)    |


The assigned model from `capabilityRouting.assignments[capabilityType].model` is passed as `options.model` to each provider method. Provider methods use the assigned model if provided, otherwise fall back to their hardcoded defaults.

**Output behavior:**

- `generate_image` → returns `{ url, revisedPrompt }` or `{ base64 }`
- `text_to_speech` → saves audio to temp file, returns `{ filePath, format, sizeBytes }`
- `speech_to_text` → accepts URL or local file path, returns `{ text }`
- `generate_video` → returns `{ taskId, status, url }` (async polling)

---

## Fallback & Health Tracking

```mermaid
sequenceDiagram
    participant Router as LLMRouter
    participant Health as ModelHealth Map
    participant PD as ProviderDegraded Map

    Note over Router: On failure...
    Router->>Router: isNonRetryableError?(error)

    alt Non-retryable (401/402/403, billing, auth)
        Router->>PD: set provider degraded = true
        Note right of PD: Cooldown: 30 min
    else Rate limit (429)
        Router->>Health: consecutiveFailures++
        alt failures >= 2
            Router->>Health: degraded = true
            Note right of Health: Cooldown: 30 sec
        end
    else Other error
        Router->>Health: consecutiveFailures++
        alt failures >= 2
            Router->>Health: degraded = true
            Note right of Health: Cooldown: 5 min
        end
    end

    Note over Router: On success...
    Router->>Health: consecutiveFailures = 0, degraded = false

    Note over Router: On availability check...
    Router->>Health: time since lastFailure > resetMs?
    alt Expired
        Router->>Health: Reset (lazy recovery)
    end
```



### Circuit Breaker Thresholds


| Scope                  | Trigger                                                     | Cooldown   | Effect                             |
| ---------------------- | ----------------------------------------------------------- | ---------- | ---------------------------------- |
| **Provider**           | Any non-retryable error (401/402/403, billing, invalid key) | **30 min** | Entire provider skipped            |
| **Model**              | 2 consecutive retryable failures                            | **5 min**  | That `provider:model` pair skipped |
| **Model (rate limit)** | 2 consecutive 429 errors                                    | **30 sec** | That `provider:model` pair skipped |


Recovery is lazy: checked on next `isAvailable()` / `isModelAvailable()` call after the cooldown period.

---

## Model Catalog

### Sources (merge order)

1. **Remote catalog** — fetched from LiteLLM's public model list, refreshed every 24h, cached in `~/.markus/model-catalog-cache.json`
2. **Baseline catalog** — bundled in `packages/core/data/model-catalog-baseline.json`
3. **Supplements** — additional/override entries in `model-catalog-supplements.json` (always merged last)
4. **BUILTIN_MODEL_CATALOG** — curated entries in `router.ts` with explicit tiers and costs

### Regional Provider Aliases

Regional variants share the parent provider's model catalog:

```typescript
REGIONAL_PROVIDER_ALIASES = {
  'minimax-cn': 'minimax',
  'siliconflow-intl': 'siliconflow',
};
```

`getProviderModels()` synthesizes entries for aliased providers at runtime.

---

## Tier Classification

Models are classified into three tiers: `base`, `pro`, `max`.

**Classification sources (in priority order):**

1. Explicit `tier` field on `ModelDefinition` (BUILTIN_MODEL_CATALOG entries)
2. `estimateQualityScore()` using input cost per 1M tokens:
  - `>= $3` → `max` (score >= 75)
  - `>= $0.50` → `pro` (score >= 50)
  - `< $0.50` → `base`
3. Parameter count from model name (`\d+B`) as secondary signal

---

## Configuration

All routing configuration lives in `MarkusConfig.llm`:

```typescript
interface MarkusConfig {
  llm: {
    capabilityRouting?: CapabilityRoutingConfig;  // per-capability model assignments
    routingDefaultModel?: { provider: string; model: string };
    catalogMirrorUrl?: string;              // optional mirror for catalog fetch
    // ... existing fields
  };
}
```

### Capability Routing Config

```typescript
interface CapabilityRoutingConfig {
  assignments: Partial<Record<ModelCapabilityType, CapabilityModelAssignment>>;
}

interface CapabilityModelAssignment {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
}

type ModelCapabilityType = 'text' | 'image_recognition' | 'image_generation' | 'audio_tts' | 'audio_stt' | 'video_generation';
```

---

## API Endpoints


| Endpoint                            | Method | Description                                                          | Caching               |
| ----------------------------------- | ------ | -------------------------------------------------------------------- | --------------------- |
| `/api/settings/llm/routing`         | GET    | Current routing config                                               | None                  |
| `/api/settings/llm`                 | POST   | Update routing config (capabilityRouting, routingDefaultModel, etc.) | None                  |
| `/api/models/routing-candidates`    | GET    | All available models per provider                                    | 5-min server-side TTL |
| `/api/models/suggested-assignments` | GET    | Auto-suggested best model per capability                             | None                  |


---

## UI Components

- `**ModelRoutingSection**` — capability assignment table with per-capability model selection
- `**ModelSelect**` — searchable model dropdown grouped by provider
- `**ModelPicker**` — model selection with tier/cost badges for the main settings panel

### Stale Assignment Handling

When a provider is removed from configuration, its capability assignments become stale. The UI shows a yellow warning badge on stale assignments instead of auto-cleaning them, letting users decide whether to clear or reconfigure.