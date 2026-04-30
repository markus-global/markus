import { createLogger, type LLMRequest, type LLMResponse } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const log = createLogger('analyze-image');

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB per image
const DEFAULT_QUESTION = 'Describe this image in detail. What do you see?';

/**
 * Infer MIME type from file extension or buffer magic bytes.
 */
function inferMimeType(filePath: string, buffer: Buffer): string {
  // Check magic bytes first
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';

  // Fall back to extension
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'image/png';
  }
}

/**
 * Read a local file and convert to base64 data URL.
 */
async function fileToDataUrl(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const buffer = await fs.readFile(resolved);
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image file too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max: 20MB)`);
  }
  const mimeType = inferMimeType(filePath, buffer);
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Fetch a URL and convert its content to a base64 data URL.
 */
async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch image from URL: HTTP ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') ?? 'image/png';
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB (max: 20MB)`);
  }
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

/**
 * Resolve a raw image argument to a data URL.
 * Supports: URL, absolute/relative file path, or already-encoded data URL.
 */
async function resolveToDataUrl(source: string): Promise<string> {
  // Already a data URL
  if (source.startsWith('data:')) {
    return source;
  }

  // URL (http/https)
  if (source.startsWith('http://') || source.startsWith('https://')) {
    log.debug('Fetching image from URL', { url: source.slice(0, 80) });
    return urlToDataUrl(source);
  }

  // File path — relative paths are resolved from the workspace root
  log.debug('Reading image from file', { path: source });
  return fileToDataUrl(source);
}

/**
 * Estimate token cost for an image.
 * Uses a rough heuristic: ~4.5 tokens per 100x100 px (at standard detail).
 * For low-detail images: ~85 tokens fixed.
 * Without dimensions, assume 1024x1024 → ~470 tokens.
 */
function estimateImageTokens(dataUrl: string, detail?: string): number {
  if (detail === 'low') return 85;

  // Try to estimate from data URL size
  const base64Data = dataUrl.split(',')[1] ?? '';
  const byteLength = (base64Data.length * 3) / 4;

  // Rough heuristic: ~4.5 tokens per 100x100 equivalent
  // For a 1024x1024 image (common case) → ~470 tokens
  const estimatedPixels = byteLength / 3; // 3 bytes per pixel for RGB
  const estimatedWidth = Math.round(Math.sqrt(estimatedPixels));
  const tilesX = Math.ceil(estimatedWidth / 512);
  const tokensPerTile = 170; // Standard detail: 170 tokens per 512px tile
  const tileCount = tilesX * tilesX;

  return Math.max(85, tileCount * tokensPerTile);
}

/**
 * Estimate total token usage for analysis: image tokens + text tokens + overhead.
 */
function estimateTotalTokens(
  dataUrl: string,
  questionText: string,
  detail?: string,
): { imageTokens: number; textTokens: number; total: number } {
  const imageTokens = estimateImageTokens(dataUrl, detail);
  const textTokens = Math.ceil(questionText.length / 4);
  const overhead = 40; // system overhead per message
  return {
    imageTokens,
    textTokens,
    total: imageTokens + textTokens + overhead,
  };
}

/**
 * Create an analyze_image tool that uses the configured vision model to analyze images.
 */
export function createAnalyzeImageTool(llmRouter: LLMRouter): AgentToolHandler {
  return {
    name: 'analyze_image',
    description:
      'Analyze an image using a vision-capable AI model. ' +
      'Accepts an image from a URL, a local file path, or a data URL. ' +
      'Returns a detailed description of the image contents. ' +
      'Use this tool when you need to understand the content of an image, ' +
      'read text from an image, or identify objects/people/scenes in a photo. ' +
      'The vision model will analyze the image and return a text description.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Image source. Can be: (1) a URL starting with http:// or https://, ' +
            '(2) a local file path (absolute or relative to workspace), ' +
            '(3) a data URL starting with data:image/.',
        },
        question: {
          type: 'string',
          description:
            'Optional question or instruction about the image. ' +
            'E.g. "What does this diagram show?" or "Read the text in this image." ' +
            'If omitted, defaults to a general description request.',
        },
        detail: {
          type: 'string',
          enum: ['auto', 'low', 'high'],
          description:
            'Optional image detail level for OpenAI-compatible providers. ' +
            '"auto" (default) lets the model decide. "low" uses fewer tokens (faster, cheaper). ' +
            '"high" provides more detail (more tokens, better for small text/detailed images).',
        },
      },
      required: ['source'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const source = args['source'] as string;
      const question = (args['question'] as string) ?? DEFAULT_QUESTION;
      const detail = (args['detail'] as string) ?? 'auto';

      if (!source || typeof source !== 'string') {
        return JSON.stringify({
          status: 'error',
          error: 'Missing or invalid required parameter: source. Must be a URL, file path, or data URL.',
        });
      }

      // Check vision support
      if (!llmRouter.modelSupportsVision()) {
        return JSON.stringify({
          status: 'error',
          error:
            'The currently active model does not support vision/image input. ' +
            'Please switch to a vision-capable model (e.g. Claude Sonnet 4, GPT-4o) ' +
            'using the settings tool or check your LLM provider configuration.',
          modelSupportsVision: false,
        });
      }

      try {
        // Resolve image source to data URL
        const dataUrl = await resolveToDataUrl(source);

        // Estimate token cost before calling
        const tokenEstimate = estimateTotalTokens(dataUrl, question, detail);

        // Build LLM request with image
        const request: LLMRequest = {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          maxTokens: 4096,
          metadata: {
            purpose: 'analyze_image',
          },
        };

        log.debug('Calling vision model for image analysis', {
          sourceType: source.startsWith('data:') ? 'data_url' : source.startsWith('http') ? 'url' : 'file',
          questionLength: question.length,
          estimatedTokens: tokenEstimate,
        });

        const startTime = Date.now();
        const response: LLMResponse = await llmRouter.chat(request);
        const durationMs = Date.now() - startTime;

        return JSON.stringify({
          status: 'success',
          analysis: response.content,
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            estimatedPreflight: tokenEstimate.total,
          },
          model: {
            inputTypes: ['text', 'image'],
          },
          durationMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Image analysis failed', { error: message });
        return JSON.stringify({
          status: 'error',
          error: `Image analysis failed: ${message}`,
          modelSupportsVision: true,
        });
      }
    },
  };
}
