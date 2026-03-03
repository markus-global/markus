import { createLogger, generateId } from '@markus/shared';

const log = createLogger('prompt-studio');

export interface PromptVersion {
  id: string;
  promptId: string;
  version: number;
  content: string;
  variables: string[];
  author: string;
  createdAt: Date;
  changelog?: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  currentVersion: number;
  versions: PromptVersion[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ABTestConfig {
  id: string;
  name: string;
  promptId: string;
  variantA: number;
  variantB: number;
  /** Split ratio (0-1), where value = traffic fraction for variant A */
  splitRatio: number;
  status: 'draft' | 'running' | 'completed';
  metrics: ABTestMetrics;
  createdAt: Date;
  completedAt?: Date;
}

export interface ABTestMetrics {
  variantATrials: number;
  variantBTrials: number;
  variantAScores: number[];
  variantBScores: number[];
}

export interface EvaluationResult {
  id: string;
  promptId: string;
  version: number;
  testInput: string;
  output: string;
  score: number;
  latencyMs: number;
  tokenCount: number;
  evaluatedAt: Date;
  evaluator?: string;
  notes?: string;
}

export interface PromptExecutor {
  execute(prompt: string, variables: Record<string, string>): Promise<{
    output: string;
    latencyMs: number;
    tokenCount: number;
  }>;
}

export class PromptStudio {
  private prompts = new Map<string, PromptTemplate>();
  private abTests = new Map<string, ABTestConfig>();
  private evaluations: EvaluationResult[] = [];

  constructor(private executor?: PromptExecutor) {}

  setExecutor(executor: PromptExecutor): void {
    this.executor = executor;
  }

  // ── Prompt Management ──────────────────────────────────────────────────

  createPrompt(opts: { name: string; description: string; category: string; content: string; author: string; tags?: string[] }): PromptTemplate {
    const id = generateId('prompt');
    const version: PromptVersion = {
      id: generateId('pv'),
      promptId: id,
      version: 1,
      content: opts.content,
      variables: this.extractVariables(opts.content),
      author: opts.author,
      createdAt: new Date(),
    };

    const prompt: PromptTemplate = {
      id,
      name: opts.name,
      description: opts.description,
      category: opts.category,
      currentVersion: 1,
      versions: [version],
      tags: opts.tags ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.prompts.set(id, prompt);
    log.info('Prompt created', { promptId: id, name: opts.name });
    return prompt;
  }

  updatePrompt(promptId: string, content: string, author: string, changelog?: string): PromptVersion {
    const prompt = this.prompts.get(promptId);
    if (!prompt) throw new Error(`Prompt ${promptId} not found`);

    const newVersionNum = prompt.currentVersion + 1;
    const version: PromptVersion = {
      id: generateId('pv'),
      promptId,
      version: newVersionNum,
      content,
      variables: this.extractVariables(content),
      author,
      createdAt: new Date(),
      changelog,
    };

    prompt.versions.push(version);
    prompt.currentVersion = newVersionNum;
    prompt.updatedAt = new Date();

    log.info('Prompt updated', { promptId, version: newVersionNum });
    return version;
  }

  getPrompt(promptId: string): PromptTemplate | undefined {
    return this.prompts.get(promptId);
  }

  getVersion(promptId: string, version: number): PromptVersion | undefined {
    const prompt = this.prompts.get(promptId);
    return prompt?.versions.find(v => v.version === version);
  }

  listPrompts(category?: string): PromptTemplate[] {
    const all = [...this.prompts.values()];
    if (!category) return all;
    return all.filter(p => p.category === category);
  }

  searchPrompts(query: string): PromptTemplate[] {
    const lower = query.toLowerCase();
    return [...this.prompts.values()].filter(p =>
      p.name.toLowerCase().includes(lower) ||
      p.description.toLowerCase().includes(lower) ||
      p.tags.some(t => t.toLowerCase().includes(lower))
    );
  }

  deletePrompt(promptId: string): boolean {
    return this.prompts.delete(promptId);
  }

  renderPrompt(promptId: string, variables: Record<string, string>, version?: number): string {
    const prompt = this.prompts.get(promptId);
    if (!prompt) throw new Error(`Prompt ${promptId} not found`);

    const v = version
      ? prompt.versions.find(pv => pv.version === version)
      : prompt.versions.find(pv => pv.version === prompt.currentVersion);

    if (!v) throw new Error(`Version ${version ?? prompt.currentVersion} not found`);

    return this.interpolatePrompt(v.content, variables);
  }

  // ── A/B Testing ────────────────────────────────────────────────────────

  createABTest(opts: {
    name: string;
    promptId: string;
    variantA: number;
    variantB: number;
    splitRatio?: number;
  }): ABTestConfig {
    const prompt = this.prompts.get(opts.promptId);
    if (!prompt) throw new Error(`Prompt ${opts.promptId} not found`);

    const findVersion = (v: number) => prompt.versions.find(pv => pv.version === v);
    if (!findVersion(opts.variantA)) throw new Error(`Variant A (v${opts.variantA}) not found`);
    if (!findVersion(opts.variantB)) throw new Error(`Variant B (v${opts.variantB}) not found`);

    const test: ABTestConfig = {
      id: generateId('ab-test'),
      name: opts.name,
      promptId: opts.promptId,
      variantA: opts.variantA,
      variantB: opts.variantB,
      splitRatio: opts.splitRatio ?? 0.5,
      status: 'draft',
      metrics: {
        variantATrials: 0,
        variantBTrials: 0,
        variantAScores: [],
        variantBScores: [],
      },
      createdAt: new Date(),
    };

    this.abTests.set(test.id, test);
    log.info('A/B test created', { testId: test.id, promptId: opts.promptId });
    return test;
  }

  startABTest(testId: string): boolean {
    const test = this.abTests.get(testId);
    if (!test || test.status !== 'draft') return false;
    test.status = 'running';
    return true;
  }

  /** Pick which variant to use based on the split ratio */
  pickVariant(testId: string): { version: number; variant: 'A' | 'B' } {
    const test = this.abTests.get(testId);
    if (!test || test.status !== 'running') {
      throw new Error(`A/B test ${testId} is not running`);
    }

    const isA = Math.random() < test.splitRatio;
    return isA
      ? { version: test.variantA, variant: 'A' }
      : { version: test.variantB, variant: 'B' };
  }

  recordABResult(testId: string, variant: 'A' | 'B', score: number): void {
    const test = this.abTests.get(testId);
    if (!test || test.status !== 'running') return;

    if (variant === 'A') {
      test.metrics.variantATrials++;
      test.metrics.variantAScores.push(score);
    } else {
      test.metrics.variantBTrials++;
      test.metrics.variantBScores.push(score);
    }
  }

  completeABTest(testId: string): ABTestConfig | undefined {
    const test = this.abTests.get(testId);
    if (!test || test.status !== 'running') return undefined;

    test.status = 'completed';
    test.completedAt = new Date();

    log.info('A/B test completed', {
      testId,
      variantAAvg: this.average(test.metrics.variantAScores),
      variantBAvg: this.average(test.metrics.variantBScores),
    });

    return test;
  }

  getABTestResults(testId: string): {
    test: ABTestConfig;
    variantAAvg: number;
    variantBAvg: number;
    winner: 'A' | 'B' | 'tie';
    confidence: number;
  } | undefined {
    const test = this.abTests.get(testId);
    if (!test) return undefined;

    const avgA = this.average(test.metrics.variantAScores);
    const avgB = this.average(test.metrics.variantBScores);
    const diff = Math.abs(avgA - avgB);
    const totalTrials = test.metrics.variantATrials + test.metrics.variantBTrials;
    const confidence = totalTrials > 0 ? Math.min(1, (totalTrials / 100) * (diff / Math.max(avgA, avgB, 0.01))) : 0;

    let winner: 'A' | 'B' | 'tie' = 'tie';
    if (diff > 0.05) winner = avgA > avgB ? 'A' : 'B';

    return { test, variantAAvg: avgA, variantBAvg: avgB, winner, confidence };
  }

  listABTests(promptId?: string): ABTestConfig[] {
    const all = [...this.abTests.values()];
    if (!promptId) return all;
    return all.filter(t => t.promptId === promptId);
  }

  // ── Evaluation ─────────────────────────────────────────────────────────

  async evaluate(
    promptId: string,
    version: number,
    testInput: string,
    variables: Record<string, string> = {},
    evaluator?: string,
  ): Promise<EvaluationResult> {
    if (!this.executor) throw new Error('No prompt executor configured');

    const rendered = this.renderPrompt(promptId, variables, version);
    const fullPrompt = `${rendered}\n\nInput: ${testInput}`;
    const { output, latencyMs, tokenCount } = await this.executor.execute(fullPrompt, variables);

    const result: EvaluationResult = {
      id: generateId('eval'),
      promptId,
      version,
      testInput,
      output,
      score: 0,
      latencyMs,
      tokenCount,
      evaluatedAt: new Date(),
      evaluator,
    };

    this.evaluations.push(result);
    return result;
  }

  scoreEvaluation(evaluationId: string, score: number, notes?: string): boolean {
    const ev = this.evaluations.find(e => e.id === evaluationId);
    if (!ev) return false;
    ev.score = Math.max(0, Math.min(10, score));
    if (notes) ev.notes = notes;
    return true;
  }

  getEvaluations(promptId: string, version?: number): EvaluationResult[] {
    return this.evaluations.filter(e =>
      e.promptId === promptId &&
      (version === undefined || e.version === version)
    );
  }

  getEvaluationSummary(promptId: string, version: number): {
    avgScore: number;
    avgLatencyMs: number;
    avgTokenCount: number;
    count: number;
  } {
    const evals = this.getEvaluations(promptId, version);
    if (evals.length === 0) return { avgScore: 0, avgLatencyMs: 0, avgTokenCount: 0, count: 0 };

    return {
      avgScore: this.average(evals.map(e => e.score)),
      avgLatencyMs: this.average(evals.map(e => e.latencyMs)),
      avgTokenCount: this.average(evals.map(e => e.tokenCount)),
      count: evals.length,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private extractVariables(content: string): string[] {
    const matches = content.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => m.slice(2, -2)))];
  }

  private interpolatePrompt(content: string, variables: Record<string, string>): string {
    return content.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      return variables[name] ?? `{{${name}}}`;
    });
  }

  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
  }
}
