#!/usr/bin/env node

// MCP server for multi-provider AI image generation.
// Detects available providers from environment variables and routes
// requests to the appropriate API. Saves generated images to disk.
// Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05).

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const DEFAULT_OUTPUT_DIR = join(homedir(), '.markus', 'generated-images');

// ─── Provider registry ──────────────────────────────────────────────────────

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'dall-e-3',
    models: ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
    supportedSizes: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'],
    supportsEdit: true,
    supportsNegativePrompt: false,
  },
  azure_openai: {
    name: 'Azure OpenAI',
    envKey: 'AZURE_OPENAI_API_KEY',
    extraEnv: ['AZURE_OPENAI_ENDPOINT'],
    defaultModel: 'dall-e-3',
    models: ['dall-e-3', 'dall-e-2'],
    supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
    supportsEdit: false,
    supportsNegativePrompt: false,
  },
  stability: {
    name: 'Stability AI',
    envKey: 'STABILITY_API_KEY',
    defaultModel: 'sd3-large',
    models: ['sd3-large', 'sd3-large-turbo', 'sd3-medium', 'stable-image-ultra', 'stable-image-core'],
    supportedSizes: ['1024x1024', '1536x1024', '1024x1536', '1344x768', '768x1344'],
    supportsEdit: true,
    supportsNegativePrompt: true,
  },
  google: {
    name: 'Google Imagen',
    envKey: 'GOOGLE_API_KEY',
    defaultModel: 'imagen-3.0-generate-002',
    models: ['imagen-3.0-generate-002', 'imagen-3.0-generate-001'],
    supportedSizes: ['1024x1024', '1536x1024', '1024x1536'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  replicate: {
    name: 'Replicate',
    envKey: 'REPLICATE_API_TOKEN',
    defaultModel: 'black-forest-labs/flux-1.1-pro',
    models: ['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell', 'stability-ai/sdxl'],
    supportedSizes: ['1024x1024', '1024x768', '768x1024'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  tongyi: {
    name: 'Tongyi Wanxiang (Aliyun)',
    envKey: 'DASHSCOPE_API_KEY',
    defaultModel: 'wanx2.1-t2i-turbo',
    models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1'],
    supportedSizes: ['1024x1024', '720x1280', '1280x720'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  zhipu: {
    name: 'Zhipu AI',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'cogview-4',
    models: ['cogview-4', 'cogview-4-250304', 'cogview-3-plus', 'cogview-3'],
    supportedSizes: ['1024x1024', '768x1344', '1344x768', '864x1152', '1152x864'],
    supportsEdit: false,
    supportsNegativePrompt: false,
  },
  siliconflow: {
    name: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    defaultModel: 'black-forest-labs/FLUX.1-schnell',
    models: [
      'black-forest-labs/FLUX.1-schnell',
      'black-forest-labs/FLUX.1-dev',
      'black-forest-labs/FLUX.1-pro',
      'black-forest-labs/FLUX.1.1-pro',
      'stabilityai/stable-diffusion-3-5-large',
      'stabilityai/stable-diffusion-3-5-large-turbo',
      'stabilityai/stable-diffusion-3-5-medium',
      'stabilityai/stable-diffusion-xl-base-1.0',
      'Qwen/Qwen-Image',
      'deepseek-ai/Janus-Pro-7B',
    ],
    supportedSizes: ['1024x1024', '1024x768', '768x1024', '1024x576', '576x1024'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  together: {
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    defaultModel: 'black-forest-labs/FLUX.1.1-pro',
    models: ['black-forest-labs/FLUX.1.1-pro', 'black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0'],
    supportedSizes: ['1024x1024', '1024x768', '768x1024'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  fal: {
    name: 'FAL',
    envKey: 'FAL_KEY',
    defaultModel: 'fal-ai/flux-pro/v1.1',
    models: ['fal-ai/flux-pro/v1.1', 'fal-ai/flux/schnell', 'fal-ai/flux/dev', 'fal-ai/flux-pro', 'fal-ai/stable-diffusion-v35-large'],
    supportedSizes: ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  ideogram: {
    name: 'Ideogram',
    envKey: 'IDEOGRAM_API_KEY',
    defaultModel: 'V_2',
    models: ['V_2', 'V_2_TURBO', 'V_1', 'V_1_TURBO'],
    supportedSizes: ['1024x1024', '1024x768', '768x1024', '1344x768', '768x1344'],
    supportsEdit: true,
    supportsNegativePrompt: true,
  },
  baidu: {
    name: 'Baidu ERNIE ViLG',
    envKey: 'BAIDU_API_KEY',
    extraEnv: ['BAIDU_SECRET_KEY'],
    defaultModel: 'sd_xl',
    models: ['sd_xl', 'ernievilg-v1'],
    supportedSizes: ['1024x1024', '768x1024', '1024x768', '576x1024', '1024x576'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  hunyuan: {
    name: 'Tencent Hunyuan',
    envKey: 'HUNYUAN_API_KEY',
    defaultModel: 'hunyuan-image',
    models: ['hunyuan-image', 'hunyuan-image-fast'],
    supportedSizes: ['1024x1024', '768x1024', '1024x768'],
    supportsEdit: false,
    supportsNegativePrompt: true,
  },
  volcengine: {
    name: 'Volcengine (Doubao)',
    envKey: 'VOLCENGINE_API_KEY',
    defaultModel: 'general_v2.1_L',
    models: ['general_v2.1_L', 'general_v2.0_L', 'general_v1.4'],
    supportedSizes: ['1024x1024', '768x1024', '1024x768', '512x512'],
    supportsEdit: false,
    supportsNegativePrompt: false,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEnv(key) {
  return process.env[key] || null;
}

function getAvailableProviders() {
  const available = [];
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const apiKey = getEnv(cfg.envKey);
    if (!apiKey) continue;
    if (cfg.extraEnv) {
      const missing = cfg.extraEnv.filter(k => !getEnv(k));
      if (missing.length > 0) continue;
    }
    available.push({
      id,
      name: cfg.name,
      defaultModel: cfg.defaultModel,
      models: cfg.models,
      supportedSizes: cfg.supportedSizes,
      supportsEdit: cfg.supportsEdit,
      supportsNegativePrompt: cfg.supportsNegativePrompt,
    });
  }
  return available;
}

function pickProvider(requestedProvider) {
  if (requestedProvider) {
    const cfg = PROVIDERS[requestedProvider];
    if (!cfg) throw new Error(`Unknown provider: ${requestedProvider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
    if (!getEnv(cfg.envKey)) throw new Error(`Provider ${requestedProvider} requires ${cfg.envKey} to be set`);
    return requestedProvider;
  }
  for (const id of Object.keys(PROVIDERS)) {
    const cfg = PROVIDERS[id];
    if (!getEnv(cfg.envKey)) continue;
    if (cfg.extraEnv && cfg.extraEnv.some(k => !getEnv(k))) continue;
    return id;
  }
  throw new Error(
    'No image generation provider configured. Set one of these environment variables: ' +
    Object.values(PROVIDERS).map(p => p.envKey).join(', ')
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveBase64Image(base64, outputDir, format) {
  ensureDir(outputDir);
  const ext = format || 'png';
  const filename = `image-${timestamp()}.${ext}`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, Buffer.from(base64, 'base64'));
  return filepath;
}

async function downloadImage(url, outputDir, format) {
  ensureDir(outputDir);
  const ext = format || 'png';
  const filename = `image-${timestamp()}.${ext}`;
  const filepath = join(outputDir, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(filepath, buf);
  return filepath;
}

// ─── Provider implementations ────────────────────────────────────────────────

async function generateOpenAI(args) {
  const apiKey = getEnv('OPENAI_API_KEY');
  const model = args.model || 'dall-e-3';
  const body = {
    model,
    prompt: args.prompt,
    n: args.n || 1,
    size: args.size || '1024x1024',
  };
  if (model === 'dall-e-3') {
    if (args.quality) body.quality = args.quality;
    if (args.style) body.style = args.style;
    body.response_format = 'b64_json';
  } else if (model === 'gpt-image-1') {
    if (args.quality) body.quality = args.quality;
    body.response_format = 'b64_json';
  } else {
    body.response_format = 'b64_json';
  }

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of data.data) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath, revised_prompt: item.revised_prompt });
    } else if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath, revised_prompt: item.revised_prompt });
    }
  }
  return results;
}

async function generateAzureOpenAI(args) {
  const apiKey = getEnv('AZURE_OPENAI_API_KEY');
  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT');
  const model = args.model || 'dall-e-3';
  const body = {
    prompt: args.prompt,
    n: args.n || 1,
    size: args.size || '1024x1024',
    response_format: 'b64_json',
  };
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;

  const url = `${endpoint}/openai/deployments/${model}/images/generations?api-version=2024-02-01`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of data.data) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath, revised_prompt: item.revised_prompt });
    }
  }
  return results;
}

async function generateStability(args) {
  const apiKey = getEnv('STABILITY_API_KEY');
  const model = args.model || 'sd3-large';

  const formData = new FormData();
  formData.append('prompt', args.prompt);
  if (args.negative_prompt) formData.append('negative_prompt', args.negative_prompt);
  formData.append('output_format', args.output_format || 'png');

  if (model.startsWith('sd3')) {
    formData.append('model', model);
    if (args.seed !== undefined) formData.append('seed', String(args.seed));
    const aspectMap = {
      '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3',
      '1344x768': '16:9', '768x1344': '9:16',
    };
    if (args.size && aspectMap[args.size]) formData.append('aspect_ratio', aspectMap[args.size]);
  }

  const endpoint = model.startsWith('stable-image')
    ? `https://api.stability.ai/v2beta/stable-image/generate/${model.replace('stable-image-', '')}`
    : 'https://api.stability.ai/v2beta/stable-image/generate/sd3';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'image/*',
    },
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Stability API error ${res.status}: ${errText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(args.output_dir);
  const ext = args.output_format || 'png';
  const filename = `image-${timestamp()}.${ext}`;
  const filepath = join(args.output_dir, filename);
  writeFileSync(filepath, buf);
  return [{ file_path: filepath }];
}

async function generateGoogle(args) {
  const apiKey = getEnv('GOOGLE_API_KEY');
  const model = args.model || 'imagen-3.0-generate-002';

  const body = {
    instances: [{ prompt: args.prompt }],
    parameters: {
      sampleCount: args.n || 1,
    },
  };
  if (args.negative_prompt) body.parameters.negativePrompt = args.negative_prompt;
  if (args.seed !== undefined) body.parameters.seed = args.seed;
  if (args.size) {
    const [w, h] = args.size.split('x').map(Number);
    if (w && h) {
      body.parameters.aspectRatio = w === h ? '1:1' : w > h ? '3:2' : '2:3';
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google Imagen API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const pred of (data.predictions || [])) {
    if (pred.bytesBase64Encoded) {
      const filepath = saveBase64Image(pred.bytesBase64Encoded, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateReplicate(args) {
  const apiToken = getEnv('REPLICATE_API_TOKEN');
  const model = args.model || 'black-forest-labs/flux-1.1-pro';

  const input = { prompt: args.prompt };
  if (args.negative_prompt) input.negative_prompt = args.negative_prompt;
  if (args.size) {
    const [w, h] = args.size.split('x').map(Number);
    if (w && h) { input.width = w; input.height = h; }
  }
  if (args.seed !== undefined) input.seed = args.seed;
  if (args.n && args.n > 1) input.num_outputs = args.n;

  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({ version: undefined, model, input }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    throw new Error(`Replicate API error ${createRes.status}: ${errText}`);
  }

  let prediction = await createRes.json();

  // Poll if not yet completed (Prefer: wait may not always work)
  let attempts = 0;
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && attempts < 60) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    prediction = await pollRes.json();
    attempts++;
  }

  if (prediction.status === 'failed') {
    throw new Error(`Replicate prediction failed: ${prediction.error || 'unknown error'}`);
  }

  const outputs = Array.isArray(prediction.output) ? prediction.output : [prediction.output];
  const results = [];
  for (const outputUrl of outputs) {
    if (typeof outputUrl === 'string') {
      const filepath = await downloadImage(outputUrl, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateTongyi(args) {
  const apiKey = getEnv('DASHSCOPE_API_KEY');
  const model = args.model || 'wanx2.1-t2i-turbo';

  const body = {
    model,
    input: { prompt: args.prompt },
    parameters: { n: args.n || 1 },
  };
  if (args.negative_prompt) body.input.negative_prompt = args.negative_prompt;
  if (args.size) body.parameters.size = args.size;
  if (args.seed !== undefined) body.parameters.seed = args.seed;
  if (args.style) body.parameters.style = args.style;

  // Async task submission
  const submitRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => '');
    throw new Error(`Tongyi API error ${submitRes.status}: ${errText}`);
  }
  const submitData = await submitRes.json();
  const taskId = submitData.output?.task_id;
  if (!taskId) throw new Error('Tongyi API did not return a task_id');

  // Poll for completion
  let taskResult;
  let attempts = 0;
  while (attempts < 60) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    taskResult = await pollRes.json();
    const status = taskResult.output?.task_status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED') throw new Error(`Tongyi task failed: ${taskResult.output?.message || 'unknown'}`);
    attempts++;
  }

  const results = [];
  for (const item of (taskResult.output?.results || [])) {
    if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    } else if (item.b64_image) {
      const filepath = saveBase64Image(item.b64_image, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateZhipu(args) {
  const apiKey = getEnv('ZHIPU_API_KEY');
  const model = args.model || 'cogview-4';

  const body = {
    model,
    prompt: args.prompt,
  };
  if (args.size) body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.style) body.style = args.style;

  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Zhipu API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of (data.data || [])) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    } else if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateSiliconFlow(args) {
  const apiKey = getEnv('SILICONFLOW_API_KEY');
  const SILICONFLOW_DEFAULT = 'black-forest-labs/FLUX.1-schnell';
  const model = args.model || SILICONFLOW_DEFAULT;
  const isFallbackAttempt = args._siliconflowRetry === true;

  const body = {
    model,
    prompt: args.prompt,
    image_size: args.size || '1024x1024',
    batch_size: args.n || 1,
  };
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) body.seed = args.seed;

  const res = await fetch('https://api.siliconflow.cn/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const isModelIssue = (res.status === 400 || res.status === 404) &&
      (errText.toLowerCase().includes('not found') ||
       errText.toLowerCase().includes('disabled') ||
       errText.toLowerCase().includes('not support') ||
       errText.toLowerCase().includes('available') ||
       errText.toLowerCase().includes('permission'));

    if (isModelIssue && !isFallbackAttempt && model !== SILICONFLOW_DEFAULT) {
      // Auto-fallback: retry with the default model
      const fallbackArgs = { ...args, model: SILICONFLOW_DEFAULT, _siliconflowRetry: true };
      const fallbackResult = await generateSiliconFlow(fallbackArgs);
      // Tag the result so the caller knows fallback occurred
      fallbackResult._fallback = true;
      fallbackResult._originalModel = model;
      fallbackResult._fallbackModel = SILICONFLOW_DEFAULT;
      // Update args.model so the response handler uses the actual model
      args.model = SILICONFLOW_DEFAULT;
      return fallbackResult;
    }

    // Enhanced error message with available models hint
    const modelHint = isModelIssue
      ? `The requested model "${model}" is not available on your account. Available models: ${PROVIDERS.siliconflow.models.join(', ')}`
      : `Available models: ${PROVIDERS.siliconflow.models.join(', ')}`;

    throw new Error(`SiliconFlow API error ${res.status}: ${errText}. ${modelHint}`);
  }

  const data = await res.json();
  const results = [];
  for (const item of (data.images || data.data || [])) {
    const url = item.url || item;
    if (typeof url === 'string') {
      const filepath = await downloadImage(url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateTogether(args) {
  const apiKey = getEnv('TOGETHER_API_KEY');
  const model = args.model || 'black-forest-labs/FLUX.1.1-pro';

  const body = {
    model,
    prompt: args.prompt,
    n: args.n || 1,
    width: 1024,
    height: 1024,
    response_format: 'b64_json',
  };
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) body.seed = args.seed;
  if (args.size) {
    const [w, h] = args.size.split('x').map(Number);
    if (w && h) { body.width = w; body.height = h; }
  }

  const res = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Together AI API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of (data.data || [])) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    } else if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateFal(args) {
  const apiKey = getEnv('FAL_KEY');
  const model = args.model || 'fal-ai/flux-pro/v1.1';

  const input = { prompt: args.prompt };
  if (args.negative_prompt) input.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) input.seed = args.seed;
  if (args.size) {
    const [w, h] = args.size.split('x').map(Number);
    if (w && h) { input.image_size = { width: w, height: h }; }
  }
  if (args.n && args.n > 1) input.num_images = args.n;

  // Submit request
  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => '');
    throw new Error(`FAL API error ${submitRes.status}: ${errText}`);
  }
  const submitData = await submitRes.json();
  const requestId = submitData.request_id;

  // Poll for result
  let result;
  let attempts = 0;
  while (attempts < 120) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
      headers: { 'Authorization': `Key ${apiKey}` },
    });
    const statusData = await statusRes.json();
    if (statusData.status === 'COMPLETED') {
      const resultRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
        headers: { 'Authorization': `Key ${apiKey}` },
      });
      result = await resultRes.json();
      break;
    }
    if (statusData.status === 'FAILED') {
      throw new Error(`FAL task failed: ${statusData.error || 'unknown error'}`);
    }
    attempts++;
  }
  if (!result) throw new Error('FAL task timed out');

  const results = [];
  for (const img of (result.images || [])) {
    if (img.url) {
      const filepath = await downloadImage(img.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateIdeogram(args) {
  const apiKey = getEnv('IDEOGRAM_API_KEY');
  const model = args.model || 'V_2';

  const imageRequest = {
    prompt: args.prompt,
    model,
  };
  if (args.negative_prompt) imageRequest.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) imageRequest.seed = args.seed;
  if (args.style) imageRequest.style_type = args.style;
  if (args.size) {
    const aspectMap = {
      '1024x1024': 'ASPECT_1_1', '1024x768': 'ASPECT_4_3', '768x1024': 'ASPECT_3_4',
      '1344x768': 'ASPECT_16_9', '768x1344': 'ASPECT_9_16',
    };
    if (aspectMap[args.size]) imageRequest.aspect_ratio = aspectMap[args.size];
  }

  const res = await fetch('https://api.ideogram.ai/generate', {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image_request: imageRequest }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ideogram API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of (data.data || [])) {
    if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath, prompt: item.prompt });
    }
  }
  return results;
}

async function generateBaidu(args) {
  const apiKey = getEnv('BAIDU_API_KEY');
  const secretKey = getEnv('BAIDU_SECRET_KEY');

  // Get access token
  const tokenRes = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
    { method: 'POST' }
  );
  if (!tokenRes.ok) throw new Error(`Baidu token error: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error('Failed to get Baidu access token');

  const model = args.model || 'sd_xl';
  const body = {
    prompt: args.prompt,
    n: args.n || 1,
    size: args.size || '1024x1024',
  };
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) body.seed = args.seed;

  const res = await fetch(
    `https://aip.baidubce.com/rpc/2.0/ernievilg/v1/txt2imgv2?access_token=${accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Baidu API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (data.error_code) throw new Error(`Baidu API error: ${data.error_msg || data.error_code}`);

  // Async task — poll for result
  const taskId = data.data?.task_id;
  if (!taskId) throw new Error('Baidu API did not return a task_id');

  let taskResult;
  let attempts = 0;
  while (attempts < 60) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://aip.baidubce.com/rpc/2.0/ernievilg/v1/getImgv2?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      }
    );
    taskResult = await pollRes.json();
    const status = taskResult.data?.task_status;
    if (status === 'SUCCESS') break;
    if (status === 'FAILED') throw new Error(`Baidu task failed: ${taskResult.data?.error_msg || 'unknown'}`);
    attempts++;
  }

  const results = [];
  for (const item of (taskResult.data?.sub_task_result_list || [])) {
    if (item.final_image_list?.[0]?.img_url) {
      const filepath = await downloadImage(item.final_image_list[0].img_url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateHunyuan(args) {
  const apiKey = getEnv('HUNYUAN_API_KEY');
  const model = args.model || 'hunyuan-image';

  const body = {
    model,
    prompt: args.prompt,
    n: args.n || 1,
    size: args.size || '1024x1024',
    response_format: 'b64_json',
  };
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt;
  if (args.style) body.style = args.style;

  const res = await fetch('https://api.hunyuan.cloud.tencent.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Hunyuan API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of (data.data || [])) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    } else if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function generateVolcengine(args) {
  const apiKey = getEnv('VOLCENGINE_API_KEY');
  const model = args.model || 'general_v2.1_L';

  const body = {
    req_key: 'text_to_image',
    model_version: model,
    prompt: args.prompt,
    return_url: true,
    image_num: args.n || 1,
  };
  if (args.size) {
    const [w, h] = args.size.split('x').map(Number);
    if (w && h) { body.width = w; body.height = h; }
  }
  if (args.seed !== undefined) body.seed = args.seed;

  const res = await fetch('https://visual.volcengineapi.com/v1/text_to_image', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Volcengine API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (data.code !== 0 && data.code !== 10000) {
    throw new Error(`Volcengine error: ${data.message || data.code}`);
  }
  const results = [];
  for (const item of (data.data?.image_urls || [])) {
    if (typeof item === 'string') {
      const filepath = await downloadImage(item, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  // Fallback: binary_data_base64 array
  if (results.length === 0) {
    for (const b64 of (data.data?.binary_data_base64 || [])) {
      if (b64) {
        const filepath = saveBase64Image(b64, args.output_dir, args.output_format);
        results.push({ file_path: filepath });
      }
    }
  }
  return results;
}

const GENERATE_FN = {
  openai: generateOpenAI,
  azure_openai: generateAzureOpenAI,
  stability: generateStability,
  google: generateGoogle,
  replicate: generateReplicate,
  tongyi: generateTongyi,
  zhipu: generateZhipu,
  siliconflow: generateSiliconFlow,
  together: generateTogether,
  fal: generateFal,
  ideogram: generateIdeogram,
  baidu: generateBaidu,
  hunyuan: generateHunyuan,
  volcengine: generateVolcengine,
};

// ─── Edit image (providers that support it) ──────────────────────────────────

async function editOpenAI(args) {
  const apiKey = getEnv('OPENAI_API_KEY');
  const model = args.model || 'dall-e-2';

  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', args.prompt);
  const imgBuf = readFileSync(resolve(args.image_path));
  formData.append('image', new Blob([imgBuf]), 'image.png');
  if (args.mask_path) {
    const maskBuf = readFileSync(resolve(args.mask_path));
    formData.append('mask', new Blob([maskBuf]), 'mask.png');
  }
  if (args.size) formData.append('size', args.size);
  formData.append('n', String(args.n || 1));
  formData.append('response_format', 'b64_json');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI edit API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of data.data) {
    if (item.b64_json) {
      const filepath = saveBase64Image(item.b64_json, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

async function editStability(args) {
  const apiKey = getEnv('STABILITY_API_KEY');

  const formData = new FormData();
  formData.append('prompt', args.prompt);
  const imgBuf = readFileSync(resolve(args.image_path));
  formData.append('image', new Blob([imgBuf]), 'image.png');
  if (args.negative_prompt) formData.append('negative_prompt', args.negative_prompt);
  formData.append('output_format', args.output_format || 'png');
  if (args.seed !== undefined) formData.append('seed', String(args.seed));

  const endpoint = args.mask_path
    ? 'https://api.stability.ai/v2beta/stable-image/edit/inpaint'
    : 'https://api.stability.ai/v2beta/stable-image/edit/search-and-replace';

  if (args.mask_path) {
    const maskBuf = readFileSync(resolve(args.mask_path));
    formData.append('mask', new Blob([maskBuf]), 'mask.png');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'image/*',
    },
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Stability edit API error ${res.status}: ${errText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(args.output_dir);
  const ext = args.output_format || 'png';
  const filename = `image-${timestamp()}.${ext}`;
  const filepath = join(args.output_dir, filename);
  writeFileSync(filepath, buf);
  return [{ file_path: filepath }];
}

async function editIdeogram(args) {
  const apiKey = getEnv('IDEOGRAM_API_KEY');

  const formData = new FormData();
  const imgBuf = readFileSync(resolve(args.image_path));
  formData.append('image_file', new Blob([imgBuf]), 'image.png');
  if (args.mask_path) {
    const maskBuf = readFileSync(resolve(args.mask_path));
    formData.append('mask', new Blob([maskBuf]), 'mask.png');
  }

  const imageRequest = {
    prompt: args.prompt,
    model: args.model || 'V_2',
  };
  if (args.negative_prompt) imageRequest.negative_prompt = args.negative_prompt;
  if (args.seed !== undefined) imageRequest.seed = args.seed;
  formData.append('image_request', JSON.stringify(imageRequest));

  const res = await fetch('https://api.ideogram.ai/edit', {
    method: 'POST',
    headers: { 'Api-Key': apiKey },
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ideogram edit API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = [];
  for (const item of (data.data || [])) {
    if (item.url) {
      const filepath = await downloadImage(item.url, args.output_dir, args.output_format);
      results.push({ file_path: filepath });
    }
  }
  return results;
}

const EDIT_FN = {
  openai: editOpenAI,
  stability: editStability,
  ideogram: editIdeogram,
};

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleGenerateImage(toolArgs) {
  const providerId = pickProvider(toolArgs.provider);
  const providerCfg = PROVIDERS[providerId];
  const model = toolArgs.model || providerCfg.defaultModel;
  const outputDir = toolArgs.output_dir || DEFAULT_OUTPUT_DIR;

  const genArgs = { ...toolArgs, model, output_dir: outputDir };
  const fn = GENERATE_FN[providerId];
  if (!fn) throw new Error(`No generate implementation for provider: ${providerId}`);

  const images = await fn(genArgs);

  return JSON.stringify({
    status: 'success',
    provider: providerCfg.name,
    provider_id: providerId,
    model: genArgs.model,  // Use genArgs.model to reflect auto-fallback model changes
    prompt: toolArgs.prompt,
    images,
    count: images.length,
  }, null, 2);
}

async function handleListProviders() {
  const available = getAvailableProviders();
  const allProviders = Object.entries(PROVIDERS).map(([id, cfg]) => ({
    id,
    name: cfg.name,
    env_var: cfg.envKey,
    extra_env: cfg.extraEnv || [],
    configured: available.some(a => a.id === id),
    default_model: cfg.defaultModel,
    models: cfg.models,
    supported_sizes: cfg.supportedSizes,
    supports_edit: cfg.supportsEdit,
    supports_negative_prompt: cfg.supportsNegativePrompt,
  }));
  return JSON.stringify({
    configured_count: available.length,
    providers: allProviders,
  }, null, 2);
}

async function handleEditImage(toolArgs) {
  const providerId = pickProvider(toolArgs.provider);
  const providerCfg = PROVIDERS[providerId];

  if (!providerCfg.supportsEdit) {
    throw new Error(`Provider ${providerCfg.name} does not support image editing. Use OpenAI or Stability AI.`);
  }

  const fn = EDIT_FN[providerId];
  if (!fn) throw new Error(`No edit implementation for provider: ${providerId}`);

  const outputDir = toolArgs.output_dir || DEFAULT_OUTPUT_DIR;
  const editArgs = { ...toolArgs, output_dir: outputDir };
  const images = await fn(editArgs);

  return JSON.stringify({
    status: 'success',
    provider: providerCfg.name,
    provider_id: providerId,
    model: toolArgs.model || providerCfg.defaultModel,
    images,
    count: images.length,
  }, null, 2);
}

// ─── MCP tool definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate images from a text prompt using AI models. ' +
      'Supports 14 providers: OpenAI DALL-E, Azure OpenAI, Stability AI, Google Imagen, Replicate, Tongyi Wanxiang, Zhipu CogView, ' +
      'SiliconFlow, Together AI, FAL (Flux), Ideogram, Baidu ERNIE ViLG, Tencent Hunyuan, Volcengine Doubao. ' +
      'Auto-selects provider based on available API keys, or specify one explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:           { type: 'string', description: 'Text description of the image to generate' },
        negative_prompt:  { type: 'string', description: 'What to avoid in the image (supported by Stability, Google, Replicate, Tongyi)' },
        provider:         { type: 'string', enum: Object.keys(PROVIDERS), description: 'Force a specific provider (auto-detected if omitted)' },
        model:            { type: 'string', description: 'Model name (uses provider default if omitted). e.g. dall-e-3, sd3-large, cogview-4' },
        size:             { type: 'string', description: 'Image dimensions, e.g. 1024x1024, 1792x1024, 768x1344' },
        quality:          { type: 'string', enum: ['standard', 'hd'], description: 'Image quality (OpenAI, Zhipu)' },
        style:            { type: 'string', description: 'Style preset, e.g. natural, vivid (OpenAI), or style name (Tongyi)' },
        n:                { type: 'number', description: 'Number of images to generate (default: 1)' },
        seed:             { type: 'number', description: 'Seed for reproducibility (Stability, Google, Replicate, Tongyi)' },
        output_dir:       { type: 'string', description: 'Directory to save images (default: ~/.markus/generated-images/)' },
        output_format:    { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output image format (default: png)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_providers',
    description:
      'List all supported image generation providers and their configuration status. ' +
      'Shows which providers are configured (have API keys set), available models, supported sizes, and capabilities.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'edit_image',
    description:
      'Edit or modify an existing image using AI. Supports inpainting (with mask) and image-to-image transformation. ' +
      'Currently supported by OpenAI (DALL-E 2), Stability AI, and Ideogram.',
    inputSchema: {
      type: 'object',
      properties: {
        image_path:       { type: 'string', description: 'Path to the source image file' },
        prompt:           { type: 'string', description: 'Description of the desired edit or the target image' },
        mask_path:        { type: 'string', description: 'Path to mask image for inpainting (transparent areas will be regenerated)' },
        negative_prompt:  { type: 'string', description: 'What to avoid (Stability only)' },
        provider:         { type: 'string', enum: ['openai', 'stability', 'ideogram'], description: 'Provider for editing (must support edit)' },
        model:            { type: 'string', description: 'Model name (e.g. dall-e-2 for OpenAI edits)' },
        size:             { type: 'string', description: 'Output image size' },
        n:                { type: 'number', description: 'Number of variations (default: 1)' },
        seed:             { type: 'number', description: 'Seed for reproducibility (Stability only)' },
        output_dir:       { type: 'string', description: 'Directory to save result' },
        output_format:    { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format (default: png)' },
      },
      required: ['image_path', 'prompt'],
    },
  },
];

const TOOL_MAP = {
  generate_image: handleGenerateImage,
  list_providers: handleListProviders,
  edit_image: handleEditImage,
};

// ─── MCP JSON-RPC protocol ──────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  const { id, method, params } = msg;

  if (!method) return;
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'image-generation', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const handler = TOOL_MAP[toolName];
      if (!handler) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        break;
      }
      try {
        const text = await handler(toolArgs);
        respond(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        respond(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
});

process.stdin.resume();
