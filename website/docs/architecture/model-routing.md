---
sidebar_position: 7
---

# Model Routing

The LLM Router (`llm-router` module in `@markus/core`, L2) is the central dispatcher for all model inference requests. It manages multiple provider instances, routes requests by capability, enforces circuit breakers, and handles fallback across providers.

## Multi-Provider Architecture

Markus supports **9+ provider classes** through a unified `LLMProviderInterface`. Providers with native SDKs get dedicated implementations; all OpenAI-compatible APIs share the `OpenAIProvider` base with optional subclasses for non-standard multimodal behaviour.

| Class | Providers | Backend |
|-------|-----------|---------|
| `AnthropicProvider` | Anthropic | Native Anthropic SDK |
| `OpenAIProvider` | OpenAI, DeepSeek, OpenRouter, SiliconFlow, ZAI (Zhipu) | OpenAI-compatible API |
| `GoogleProvider` | Google (Gemini, Imagen, Veo) | Native Google GenAI SDK |
| `OllamaProvider` | Ollama | Local REST API |
| `MiniMaxProvider` | MiniMax (global + China) | OpenAI-compatible + custom multimodal |
| `DashScopeProvider` | DashScope (Alibaba Qwen) | OpenAI-compatible + custom reasoning |
| `FireworksProvider` | Fireworks AI | OpenAI-compatible |
| `CodexResponsesProvider` | OpenAI Codex (ChatGPT) | OAuth-based Responses API |

**Dynamic provider registration** works via `registerProviderFromConfig(name, config)` — new providers can be added at runtime without code changes. The factory function `createOpenAICompatible()` auto-detects provider type by name or `baseUrl` pattern.

## Dynamic Provider Schema

Providers are configured through `markus.json` or the Settings API (`/api/settings/llm`). Each provider entry specifies:

```json
{
  "providers": {
    "anthropic": { "apiKey": "...", "model": "claude-sonnet-4-20250514" },
    "openai": { "apiKey": "...", "model": "gpt-4o" },
    "deepseek": { "apiKey": "...", "model": "deepseek-v4-flash", "baseUrl": "https://api.deepseek.com" },
    "siliconflow": { "apiKey": "...", "model": "Qwen/Qwen3.5-122B-A10B" },
    "ollama": { "baseUrl": "http://localhost:11434", "model": "llama3" }
  },
  "defaultProvider": "anthropic"
}
```

Custom models can be added per-provider at runtime via `addCustomModel()`, and the **ModelCatalogService** refreshes live pricing (from LiteLLM) every 24 hours.

## Capability Routing

Beyond text chat, the router dispatches requests by **capability type** — each type can be pinned to a specific provider+model with optional fallback:

| Capability | Supported Providers |
|------------|-------------------|
| `text` | All providers (default routing) |
| `image_recognition` | Anthropic, OpenAI, Google, OpenRouter |
| `image_generation` | OpenAI (DALL-E 3, GPT Image 1), MiniMax (Image-01), Google (Imagen 3) |
| `audio_tts` | OpenAI (TTS-1, TTS-1-HD), MiniMax (Speech-02) |
| `audio_stt` | OpenAI (Whisper-1), SiliconFlow (SenseVoice) |
| `video_generation` | MiniMax (Hailuo 2.3), Google (Veo 2) |

Assignment is managed via `setCapabilityRouting()` and checked at request time. When no assignment exists, the router falls through to the default model chain.

## Circuit Breaker

Every model on every provider has health tracking with three degradation tiers:

1. **Non-retryable errors** (auth/billing — 401/402/403) → immediate **30-minute provider-level cooldown**
2. **Rate-limit errors** (429) → model degraded after 2 failures, **short cooldown** (`LLM_CIRCUIT_RESET_RATE_LIMIT_MS`)
3. **Generic failures** → model degraded after 2 consecutive failures, **5-minute cooldown**

When a model is degraded, the router first tries alternate models on the same provider (`findHealthyModel`). If none are available, it falls back to the next provider in the fallback order. Circuit health auto-recovers after the cooldown period. Concurrency jitter (`LLM_MAX_CONCURRENT_PER_PROVIDER`) spreads burst traffic to reduce 429 cascades.

## Complexity-Based Tier Selection

When multiple providers are registered, the router builds **complexity tiers**:
- **Default provider** → all complexity levels (simple, moderate, complex)
- **Anthropic** (non-default) → complex only
- **OpenAI** (non-default) → complex + moderate
- **Other OpenAI-compatible** → simple + moderate

Requests are classified by message count, tool count, and total character length.

## Auto-Fallback Flow

1. Primary provider's active model
2. Alternate model on the same provider
3. Fallback providers in configured order
4. Last resort: any enabled provider (even if degraded)

Callers can disable auto-fallback via `setAutoFallback(false)` for strict provider pinning.

## Supported Providers

| Provider | Key Name | Auth Method | Notes |
|----------|----------|-------------|-------|
| Anthropic | `anthropic` | API key | Native SDK, full tool use, prompt caching |
| OpenAI | `openai` | API key | Text + multimodal (image, TTS, STT) |
| Google | `google` | API key | Gemini text/vision, Imagen, Veo |
| DeepSeek | `deepseek` | API key | OpenAI-compatible, reasoning models |
| OpenRouter | `openrouter` | API key | Pass-through to 200+ models |
| SiliconFlow | `siliconflow` | API key | Qwen, DeepSeek, Kimi hosted in China |
| MiniMax | `minimax` | API key | Text, image gen, TTS, video (Hailuo) |
| ZAI (Zhipu) | `zai` | API key | GLM series hosted in China |
| Ollama | `ollama` | None (local) | Local models via REST API |
| DashScope | `dashscope` | API key | Alibaba Qwen models |
| Fireworks AI | `fireworks` | API key | Fast inference, OpenAI-compatible |
| OpenAI Codex | `openai-codex` | OAuth | ChatGPT subscription via Responses API |

Regional aliases (`minimax-cn`, `siliconflow-intl`) share model catalogs with their parent provider.

---

For a deep dive into the circuit breaker internals, provider implementation, and model catalog schema, see [Model Routing Architecture](/docs/model-routing-architecture.md).
