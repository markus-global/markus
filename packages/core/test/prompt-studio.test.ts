import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptStudio, type PromptExecutor } from '../src/prompt-studio.js';

function createMockExecutor(): PromptExecutor {
  return {
    execute: vi.fn(async (prompt: string) => ({
      output: `Generated response for: ${prompt.slice(0, 40)}...`,
      latencyMs: Math.floor(Math.random() * 500) + 100,
      tokenCount: Math.floor(prompt.length / 4),
    })),
  };
}

describe('PromptStudio', () => {
  let studio: PromptStudio;

  beforeEach(() => {
    studio = new PromptStudio(createMockExecutor());
  });

  describe('prompt management', () => {
    it('should create a prompt template', () => {
      const prompt = studio.createPrompt({
        name: 'Code Reviewer',
        description: 'Reviews code for quality',
        category: 'development',
        content: 'You are a code reviewer. Review the following {{language}} code: {{code}}',
        author: 'test',
        tags: ['review', 'code'],
      });

      expect(prompt.name).toBe('Code Reviewer');
      expect(prompt.currentVersion).toBe(1);
      expect(prompt.versions).toHaveLength(1);
      expect(prompt.versions[0]!.variables).toEqual(['language', 'code']);
    });

    it('should update prompt and create new version', () => {
      const prompt = studio.createPrompt({
        name: 'Writer', description: 'Writes content', category: 'productivity',
        content: 'Write about {{topic}}', author: 'test',
      });

      const v2 = studio.updatePrompt(
        prompt.id,
        'Write a detailed article about {{topic}} in {{style}} style',
        'test',
        'Added style variable',
      );

      expect(v2.version).toBe(2);
      expect(v2.variables).toEqual(['topic', 'style']);
      expect(v2.changelog).toBe('Added style variable');

      const updated = studio.getPrompt(prompt.id)!;
      expect(updated.currentVersion).toBe(2);
      expect(updated.versions).toHaveLength(2);
    });

    it('should get specific version', () => {
      const prompt = studio.createPrompt({
        name: 'Test', description: '', category: 'test',
        content: 'Version 1', author: 'test',
      });
      studio.updatePrompt(prompt.id, 'Version 2', 'test');

      const v1 = studio.getVersion(prompt.id, 1);
      const v2 = studio.getVersion(prompt.id, 2);
      expect(v1!.content).toBe('Version 1');
      expect(v2!.content).toBe('Version 2');
    });

    it('should list and search prompts', () => {
      studio.createPrompt({ name: 'Code Review', description: 'Reviews code', category: 'development', content: 'Review {{code}}', author: 'test', tags: ['code'] });
      studio.createPrompt({ name: 'Doc Writer', description: 'Writes docs', category: 'productivity', content: 'Write {{topic}}', author: 'test', tags: ['docs'] });
      studio.createPrompt({ name: 'Bug Fixer', description: 'Fixes bugs', category: 'development', content: 'Fix {{bug}}', author: 'test', tags: ['code'] });

      expect(studio.listPrompts()).toHaveLength(3);
      expect(studio.listPrompts('development')).toHaveLength(2);
      expect(studio.searchPrompts('code')).toHaveLength(2);
      expect(studio.searchPrompts('docs')).toHaveLength(1);
    });

    it('should delete prompt', () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'Test', author: 'test' });
      expect(studio.deletePrompt(prompt.id)).toBe(true);
      expect(studio.getPrompt(prompt.id)).toBeUndefined();
    });

    it('should render prompt with variables', () => {
      const prompt = studio.createPrompt({
        name: 'Greeting', description: '', category: 'test',
        content: 'Hello {{name}}, welcome to {{org}}!', author: 'test',
      });

      const rendered = studio.renderPrompt(prompt.id, { name: 'Alice', org: 'Markus' });
      expect(rendered).toBe('Hello Alice, welcome to Markus!');
    });

    it('should keep unresolved variables as-is', () => {
      const prompt = studio.createPrompt({
        name: 'Partial', description: '', category: 'test',
        content: 'Hello {{name}}, your role is {{role}}', author: 'test',
      });

      const rendered = studio.renderPrompt(prompt.id, { name: 'Bob' });
      expect(rendered).toBe('Hello Bob, your role is {{role}}');
    });
  });

  describe('A/B testing', () => {
    it('should create and start an A/B test', () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'V1: {{input}}', author: 'test' });
      studio.updatePrompt(prompt.id, 'V2: Improved {{input}}', 'test');

      const test = studio.createABTest({
        name: 'V1 vs V2',
        promptId: prompt.id,
        variantA: 1,
        variantB: 2,
        splitRatio: 0.5,
      });

      expect(test.status).toBe('draft');
      expect(studio.startABTest(test.id)).toBe(true);
      expect(studio.listABTests()[0]!.status).toBe('running');
    });

    it('should pick variants based on split ratio', () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'V1', author: 'test' });
      studio.updatePrompt(prompt.id, 'V2', 'test');

      const test = studio.createABTest({ name: 'Test', promptId: prompt.id, variantA: 1, variantB: 2 });
      studio.startABTest(test.id);

      const picks = Array.from({ length: 100 }, () => studio.pickVariant(test.id));
      const aCount = picks.filter(p => p.variant === 'A').length;
      expect(aCount).toBeGreaterThan(20);
      expect(aCount).toBeLessThan(80);
    });

    it('should record results and complete test', () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'V1', author: 'test' });
      studio.updatePrompt(prompt.id, 'V2', 'test');

      const test = studio.createABTest({ name: 'Test', promptId: prompt.id, variantA: 1, variantB: 2 });
      studio.startABTest(test.id);

      for (let i = 0; i < 20; i++) {
        studio.recordABResult(test.id, 'A', 7 + Math.random() * 2);
        studio.recordABResult(test.id, 'B', 5 + Math.random() * 2);
      }

      const completed = studio.completeABTest(test.id)!;
      expect(completed.status).toBe('completed');
      expect(completed.metrics.variantATrials).toBe(20);
      expect(completed.metrics.variantBTrials).toBe(20);

      const results = studio.getABTestResults(test.id)!;
      expect(results.variantAAvg).toBeGreaterThan(results.variantBAvg);
      expect(results.winner).toBe('A');
    });

    it('should reject creating test with missing versions', () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'V1', author: 'test' });
      expect(() => studio.createABTest({ name: 'Test', promptId: prompt.id, variantA: 1, variantB: 99 }))
        .toThrow('not found');
    });
  });

  describe('evaluation', () => {
    it('should evaluate a prompt version', async () => {
      const prompt = studio.createPrompt({
        name: 'Evaluator', description: '', category: 'test',
        content: 'Analyze this: {{topic}}', author: 'test',
      });

      const result = await studio.evaluate(prompt.id, 1, 'TypeScript generics', { topic: 'generics' });
      expect(result.promptId).toBe(prompt.id);
      expect(result.version).toBe(1);
      expect(result.output).toContain('Generated response');
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    it('should score evaluations', async () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'Test {{x}}', author: 'test' });
      const result = await studio.evaluate(prompt.id, 1, 'test input');

      expect(studio.scoreEvaluation(result.id, 8.5, 'Good quality')).toBe(true);
      const evals = studio.getEvaluations(prompt.id, 1);
      expect(evals[0]!.score).toBe(8.5);
      expect(evals[0]!.notes).toBe('Good quality');
    });

    it('should clamp score between 0 and 10', async () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'Test', author: 'test' });
      const result = await studio.evaluate(prompt.id, 1, 'input');

      studio.scoreEvaluation(result.id, 15);
      expect(studio.getEvaluations(prompt.id)[0]!.score).toBe(10);
    });

    it('should compute evaluation summary', async () => {
      const prompt = studio.createPrompt({ name: 'Test', description: '', category: 'test', content: 'Test', author: 'test' });

      for (let i = 0; i < 5; i++) {
        const result = await studio.evaluate(prompt.id, 1, `input ${i}`);
        studio.scoreEvaluation(result.id, 6 + i);
      }

      const summary = studio.getEvaluationSummary(prompt.id, 1);
      expect(summary.count).toBe(5);
      expect(summary.avgScore).toBe(8); // (6+7+8+9+10)/5
      expect(summary.avgLatencyMs).toBeGreaterThan(0);
    });

    it('should throw without executor', async () => {
      const noExec = new PromptStudio();
      const prompt = noExec.createPrompt({ name: 'Test', description: '', category: 'test', content: 'Test', author: 'test' });
      await expect(noExec.evaluate(prompt.id, 1, 'input')).rejects.toThrow('No prompt executor');
    });
  });
});
