---
name: image-generation
description: Generate images using AI models across multiple providers
---

# Image Generation

You have access to AI image generation tools (prefixed `image-generation__`) that can create
images from text prompts using multiple providers and models.

## When to use these tools

Use image generation tools when the user wants to:
- Create, draw, or generate images from a text description
- Create illustrations, diagrams, concept art, or any visual content
- Edit or modify an existing image
- Generate variations of an image

Do NOT use these tools for:
- Taking screenshots (use Chrome DevTools instead)
- Converting documents to images (use MarkItDown or other tools)
- Text-only diagrams where Mermaid/ASCII would suffice

## Available tools

| Tool | Purpose |
|------|---------|
| `image-generation__generate_image` | Generate an image from a text prompt |
| `image-generation__list_providers` | Check which providers are configured and available |
| `image-generation__edit_image` | Edit/modify an existing image (OpenAI, Stability, Ideogram) |

## Supported providers

The skill auto-detects available providers based on environment variables.
If no provider is specified, the first available one is used.

| Provider | Env Variable | Default Model | Strengths |
|----------|-------------|---------------|-----------|
| OpenAI | `OPENAI_API_KEY` | dall-e-3 | High quality, good prompt following, style control |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | dall-e-3 | Enterprise, same quality as OpenAI |
| Stability AI | `STABILITY_API_KEY` | sd3-large | Fine control, negative prompts, inpainting |
| Google Imagen | `GOOGLE_API_KEY` | imagen-3.0-generate-002 | Photorealistic, good text rendering |
| Replicate | `REPLICATE_API_TOKEN` | black-forest-labs/flux-1.1-pro | Wide model selection, Flux models |
| Tongyi Wanxiang | `DASHSCOPE_API_KEY` | wanx2.1-t2i-turbo | Chinese text support, fast turbo mode |
| Zhipu CogView | `ZHIPU_API_KEY` | cogview-4 | Chinese text support, multiple styles |
| SiliconFlow | `SILICONFLOW_API_KEY` | FLUX.1-schnell | Affordable, hosts FLUX & SD & Qwen models, fast |
| Together AI | `TOGETHER_API_KEY` | FLUX.1.1-pro | High-quality FLUX, competitive pricing |
| FAL | `FAL_KEY` | flux-pro/v1.1 | Fast inference, Flux Pro/Dev/Schnell |
| Ideogram | `IDEOGRAM_API_KEY` | V_2 | Excellent text-in-image, supports editing |
| Baidu ERNIE ViLG | `BAIDU_API_KEY` + `BAIDU_SECRET_KEY` | sd_xl | Chinese ecosystem, Baidu Cloud |
| Tencent Hunyuan | `HUNYUAN_API_KEY` | hunyuan-image | Chinese ecosystem, Tencent Cloud |
| Volcengine (Doubao) | `VOLCENGINE_API_KEY` | general_v2.1_L | Chinese ecosystem, ByteDance Cloud |

## Key parameters

### Common parameters (all providers)

- **prompt** (required): Text description of the desired image. Be specific and detailed.
- **size**: Image dimensions (e.g. `1024x1024`, `1792x1024`). Check provider capabilities for supported sizes.
- **n**: Number of images to generate (default: 1).
- **output_dir**: Where to save generated files (default: `~/.markus/generated-images/`).
- **output_format**: `png`, `jpeg`, or `webp` (default: `png`).

### Provider/model selection

- **provider**: Force a specific provider (e.g. `openai`, `stability`, `zhipu`, `siliconflow`, `fal`). Omit to auto-select.
- **model**: Specific model name. Each provider has a default, but you can override:
  - OpenAI: `dall-e-3`, `dall-e-2`, `gpt-image-1`
  - Stability: `sd3-large`, `sd3-large-turbo`, `stable-image-ultra`, `stable-image-core`
  - Google: `imagen-3.0-generate-002`
  - Replicate: `black-forest-labs/flux-1.1-pro`, `black-forest-labs/flux-schnell`
  - Tongyi: `wanx2.1-t2i-turbo`, `wanx2.1-t2i-plus`
  - Zhipu: `cogview-4`, `cogview-4-250304`, `cogview-3-plus`
  - SiliconFlow: `black-forest-labs/FLUX.1-schnell`, `black-forest-labs/FLUX.1-dev`, `black-forest-labs/FLUX.1-pro`, `black-forest-labs/FLUX.1.1-pro`, `stabilityai/stable-diffusion-3-5-large`, `stabilityai/stable-diffusion-3-5-medium`, `Qwen/Qwen-Image`, `deepseek-ai/Janus-Pro-7B`
  - Together: `black-forest-labs/FLUX.1.1-pro`, `black-forest-labs/FLUX.1-schnell`
  - FAL: `fal-ai/flux-pro/v1.1`, `fal-ai/flux/schnell`, `fal-ai/flux/dev`
  - Ideogram: `V_2`, `V_2_TURBO`, `V_1`
  - Baidu: `sd_xl`
  - Hunyuan: `hunyuan-image`, `hunyuan-image-fast`
  - Volcengine: `general_v2.1_L`, `general_v2.0_L`

### Style and quality

- **quality**: `standard` or `hd` (OpenAI, Zhipu)
- **style**: `natural` or `vivid` (OpenAI), or style-specific values (Tongyi)
- **negative_prompt**: Describe what to avoid (Stability, Google, Replicate, Tongyi, SiliconFlow, Together, FAL, Ideogram, Baidu, Hunyuan)
- **seed**: Integer for reproducible results (Stability, Google, Replicate, Tongyi, SiliconFlow, FAL, Ideogram, Baidu, Volcengine)

## Best practices

1. **Check availability first**: If unsure which providers are configured, call
   `list_providers` before generating. This avoids confusing error messages.

2. **Write detailed prompts**: More specific prompts produce better results. Include subject,
   style, mood, lighting, composition, and medium (e.g. "oil painting", "photograph",
   "3D render").

3. **Confirm with user**: Before generating, confirm the prompt and parameters with the user,
   especially if they gave a vague request. Share the exact prompt you plan to use.

4. **Choose the right provider**: Match provider to use case:
   - Photorealistic images → OpenAI DALL-E 3, Google Imagen
   - Artistic/creative control → Stability AI, Ideogram (supports negative prompts, seeds)
   - Chinese text/content → Tongyi Wanxiang, Zhipu CogView, Baidu ERNIE, Hunyuan, Volcengine
   - Cutting-edge Flux models → Replicate, FAL, Together AI, SiliconFlow
   - Budget-friendly → SiliconFlow, Together AI
   - Text-in-image quality → Ideogram
   - Image editing/inpainting → OpenAI (DALL-E 2), Stability AI, Ideogram

5. **Report results clearly**: After generation, tell the user:
   - The file path where the image was saved
   - Which provider and model were used
   - The revised prompt (if the provider modified it, e.g. OpenAI)

6. **Handle errors gracefully**: If a provider fails, suggest the user:
   - Check that the API key is valid and has quota
   - Try a different provider
   - Simplify the prompt if content policy rejected it

## Common workflows

### Basic image generation
```
1. list_providers → check what's available
2. generate_image → prompt="A serene mountain landscape at sunset, oil painting style",
                    size="1792x1024"
3. Report file path and provider used to user
```

### Specific provider and model
```
1. generate_image → prompt="...", provider="stability", model="sd3-large",
                    negative_prompt="blurry, low quality", seed=42
```

### Image editing
```
1. edit_image → image_path="/path/to/original.png",
               prompt="Replace the sky with a starry night",
               provider="stability"
```

### Batch generation for comparison
```
1. generate_image → prompt="...", provider="openai"
2. generate_image → prompt="...", provider="stability"
3. Present both results to user for comparison
```

## User setup guide

If no providers are configured, guide the user to set environment variables:

```bash
# --- Global providers ---
export OPENAI_API_KEY="sk-..."
export STABILITY_API_KEY="sk-..."
export GOOGLE_API_KEY="..."
export REPLICATE_API_TOKEN="r8_..."

# --- Flux / SD hosting platforms ---
export SILICONFLOW_API_KEY="sk-..."
export TOGETHER_API_KEY="..."
export FAL_KEY="..."

# --- Specialized ---
export IDEOGRAM_API_KEY="..."

# --- Chinese providers ---
export DASHSCOPE_API_KEY="sk-..."          # Tongyi Wanxiang (Aliyun)
export ZHIPU_API_KEY="..."                 # Zhipu CogView
export HUNYUAN_API_KEY="..."               # Tencent Hunyuan
export VOLCENGINE_API_KEY="..."            # Volcengine (Doubao / ByteDance)

# --- Requires two keys ---
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"

export BAIDU_API_KEY="..."                 # Baidu ERNIE ViLG
export BAIDU_SECRET_KEY="..."
```

These can be set in the shell profile, `.env` file, or Markus settings.
