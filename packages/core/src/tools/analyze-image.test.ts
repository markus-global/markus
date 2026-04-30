import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalyzeImageTool } from './analyze-image.js';
import type { LLMRouter } from '../llm/router.js';
import type { LLMResponse } from '@markus/shared';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

function createMockRouter(overrides: Partial<LLMRouter> = {}): LLMRouter {
  return {
    getDefaultModel: vi.fn().mockReturnValue('gpt-4o'),
    getModelInputTypes: vi.fn().mockReturnValue(['text', 'image']),
    modelSupportsVision: vi.fn().mockReturnValue(true),
    chat: vi.fn().mockResolvedValue({
      content: 'A beautiful sunset over mountains.',
      usage: { inputTokens: 300, outputTokens: 20 },
      finishReason: 'end_turn',
    } satisfies LLMResponse),
    ...overrides,
  } as unknown as LLMRouter;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** A 1×1 red pixel as a data URL (smallest valid PNG). */
const MINI_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('createAnalyzeImageTool', () => {
  let router: LLMRouter;
  let tool: ReturnType<typeof createAnalyzeImageTool>;

  beforeEach(() => {
    router = createMockRouter();
    tool = createAnalyzeImageTool(router);
  });

  describe('metadata', () => {
    it('should have the correct name', () => {
      expect(tool.name).toBe('analyze_image');
    });

    it('should have a non-empty description', () => {
      expect(tool.description.length).toBeGreaterThan(0);
    });

    it('should have an input schema with source, question, and detail fields', () => {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('source');
      expect(props).toHaveProperty('question');
      expect(props).toHaveProperty('detail');
    });

    it('should require the source field', () => {
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain('source');
    });
  });

  describe('execute - data URL source', () => {
    it('should pass a data URL directly to the vision model', async () => {
      const result = await tool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'What color is this?',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');

      expect(router.chat).toHaveBeenCalledTimes(1);
      const callArgs = (router.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Should contain image_url in the messages
      const msg = callArgs.messages[0];
      expect(msg.role).toBe('user');
      expect(msg.content).toBeInstanceOf(Array);

      const parts = msg.content as Array<Record<string, unknown>>;
      const imagePart = parts.find(p => p.type === 'image_url');
      expect(imagePart).toBeDefined();
      const textPart = parts.find(p => p.type === 'text');
      expect(textPart).toBeDefined();
      expect((textPart as Record<string, string>).text).toBe('What color is this?');
    });

    it('should return the vision model response content', async () => {
      const result = await tool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe this image',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.analysis).toBe('A beautiful sunset over mountains.');
    });
  });

  describe('execute - URL source', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should fetch a URL and convert to data URL before calling vision model', async () => {
      const pngBinary = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(pngBinary.buffer),
      } as Response);

      const result = await tool.execute({
        source: 'https://example.com/image.png',
        question: 'What is in this image?',
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example.com/image.png',
        expect.any(Object),
      );

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });

    it('should return an error result when fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const result = await tool.execute({
        source: 'https://example.com/missing.png',
        question: 'What?',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('Network error');
    });

    it('should return an error for non-ok HTTP status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const result = await tool.execute({
        source: 'https://example.com/notfound.png',
        question: 'What?',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('404');
    });
  });

  describe('execute - file path source', () => {
    const tmpDir = '/tmp/analyze-image-test';

    beforeEach(async () => {
      const fs = await import('node:fs/promises');
      try { await fs.mkdir(tmpDir, { recursive: true }); } catch {}
    });

    afterEach(async () => {
      const fs = await import('node:fs/promises');
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('should read a local file and convert to data URL', async () => {
      const fs = await import('node:fs/promises');

      // Write a minimal 1×1 PNG to a temp file
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      const filePath = `${tmpDir}/test-image.png`;
      await fs.writeFile(filePath, pngBuffer);

      const result = await tool.execute({
        source: filePath,
        question: 'What do you see?',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.analysis).toBe('A beautiful sunset over mountains.');
    });

    it('should return an error when file is not found', async () => {
      const result = await tool.execute({
        source: '/nonexistent/path-to-nowhere.jpg',
        question: 'What?',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('ENOENT');
    });
  });

  describe('execute - input validation', () => {
    it('should return an error when source is empty', async () => {
      const result = await tool.execute({ source: '', question: 'test' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('source');
    });

    it('should return an error when source is only whitespace', async () => {
      const result = await tool.execute({ source: '   ', question: 'test' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });

    it('should use default question when question is omitted', async () => {
      const result = await tool.execute({ source: MINI_PNG_DATA_URL });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');

      const callArgs = (router.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const parts = callArgs.messages[0].content as Array<Record<string, unknown>>;
      const textPart = parts.find(p => p.type === 'text');
      expect(textPart).toBeDefined();
      expect((textPart as Record<string, string>).text.length).toBeGreaterThan(0);
    });
  });

  describe('execute - model vision support', () => {
    it('should return error when model does not support vision', async () => {
      const noVisionRouter = createMockRouter({
        modelSupportsVision: vi.fn().mockReturnValue(false),
      });
      const noVisionTool = createAnalyzeImageTool(noVisionRouter);

      const result = await noVisionTool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('vision');
      expect(parsed.modelSupportsVision).toBe(false);
      // Should NOT have called chat
      expect(noVisionRouter.chat).not.toHaveBeenCalled();
    });
  });

  describe('execute - detail parameter', () => {
    it('should accept "low" detail level', async () => {
      const result = await tool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe',
        detail: 'low',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });

    it('should accept "high" detail level', async () => {
      const result = await tool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe',
        detail: 'high',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });
  });

  describe('execute - usage metadata', () => {
    it('should include token usage in the response', async () => {
      const result = await tool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage.inputTokens).toBe(300);
      expect(parsed.usage.outputTokens).toBe(20);
      expect(parsed.usage.estimatedPreflight).toBeGreaterThan(0);
      expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
      expect(parsed.model.inputTypes).toEqual(['text', 'image']);
    });
  });

  describe('error resilience', () => {
    it('should handle chat failure gracefully', async () => {
      const failingRouter = createMockRouter({
        chat: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
      });
      const failTool = createAnalyzeImageTool(failingRouter);

      const result = await failTool.execute({
        source: MINI_PNG_DATA_URL,
        question: 'Describe',
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('API rate limit');
      expect(parsed.modelSupportsVision).toBe(true);
    });
  });
});
