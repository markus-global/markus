import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createLogger, type ModelTier } from '@markus/shared';
import { estimateQualityScore, tierFromQualityScore } from './router.js';

const log = createLogger('model-scores');

const ARENA_API_BASE = 'https://api.wulong.dev/arena-ai-leaderboards/v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = join(__dirname, '../../data');

export interface ArenaModelEntry {
  rank: number;
  model: string;
  vendor: string | null;
  license: string | null;
  score: number | null;
  ci: number | null;
  votes: number | null;
}

export interface ArenaLeaderboard {
  meta: { leaderboard: string; model_count: number; fetched_at?: string };
  models: ArenaModelEntry[];
}

export interface ModelScoreEntry {
  modelId: string;
  overallElo?: number;
  codingElo?: number;
  visionElo?: number;
  qualityScore: number;
  tier: ModelTier;
  source: 'arena' | 'heuristic';
}

interface ScoresCache {
  fetchedAt: string;
  entries: Record<string, ModelScoreEntry>;
}

/**
 * ModelScoreService fetches and caches benchmark scores from Arena AI leaderboards.
 * Falls back to heuristic scoring when Arena data is unavailable.
 */
export class ModelScoreService {
  private scores = new Map<string, ModelScoreEntry>();
  private stateDir: string;
  private cachePath: string;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(homedir(), '.markus');
    this.cachePath = join(this.stateDir, 'model-scores-cache.json');
  }

  async init(): Promise<void> {
    this.loadBundledData();
    this.loadFromCache();
    await this.refreshInBackground();
    this.refreshTimer = setInterval(() => this.refreshInBackground(), CACHE_TTL_MS);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  getScore(modelId: string): ModelScoreEntry | undefined {
    return this.scores.get(this.normalizeId(modelId));
  }

  /**
   * Get or estimate the quality score for a model.
   * If Arena data is available, uses it. Otherwise falls back to heuristic.
   */
  getOrEstimate(modelId: string, reasoning?: boolean, inputCostPer1M?: number): ModelScoreEntry {
    const existing = this.getScore(modelId);
    if (existing) return existing;

    const score = estimateQualityScore(modelId, reasoning, inputCostPer1M);
    return {
      modelId,
      qualityScore: score,
      tier: tierFromQualityScore(score),
      source: 'heuristic',
    };
  }

  getAllScores(): ModelScoreEntry[] {
    return [...this.scores.values()];
  }

  private normalizeId(id: string): string {
    return id.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  }

  /**
   * Load pre-bundled Arena AI leaderboard data shipped with the repository.
   * This provides a baseline without any network access.
   */
  private loadBundledData(): void {
    try {
      const files = [
        { path: join(BUNDLED_DATA_DIR, 'arena-text.json'), category: 'overall' as const },
        { path: join(BUNDLED_DATA_DIR, 'arena-code.json'), category: 'coding' as const },
        { path: join(BUNDLED_DATA_DIR, 'arena-vision.json'), category: 'vision' as const },
      ];

      let loaded = 0;
      for (const { path, category } of files) {
        if (!existsSync(path)) continue;
        try {
          const raw = readFileSync(path, 'utf-8');
          const lb: ArenaLeaderboard = JSON.parse(raw);
          loaded += this.mergeLeaderboard(lb, category);
        } catch { /* skip malformed file */ }
      }

      if (loaded > 0) {
        this.recalculateScores();
        log.info(`Loaded ${loaded} model scores from bundled data`);
      }
    } catch (err) {
      log.warn(`Failed to load bundled arena data: ${err}`);
    }
  }

  private loadFromCache(): void {
    try {
      if (!existsSync(this.cachePath)) return;
      const raw = readFileSync(this.cachePath, 'utf-8');
      const cache: ScoresCache = JSON.parse(raw);

      const age = Date.now() - new Date(cache.fetchedAt).getTime();
      if (age > CACHE_TTL_MS * 2) {
        log.info('Score cache too old, will refresh');
        return;
      }

      for (const [key, entry] of Object.entries(cache.entries)) {
        this.scores.set(key, entry);
      }
      log.info(`Loaded ${this.scores.size} model scores from cache`);
    } catch (err) {
      log.warn(`Failed to load score cache: ${err}`);
    }
  }

  private saveToCache(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const cache: ScoresCache = {
        fetchedAt: new Date().toISOString(),
        entries: Object.fromEntries(this.scores),
      };
      writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (err) {
      log.warn(`Failed to save score cache: ${err}`);
    }
  }

  private async refreshInBackground(): Promise<void> {
    try {
      const [text, code, vision] = await Promise.allSettled([
        this.fetchLeaderboard('text'),
        this.fetchLeaderboard('code'),
        this.fetchLeaderboard('vision'),
      ]);

      let updated = 0;

      if (text.status === 'fulfilled' && text.value) {
        updated += this.mergeLeaderboard(text.value, 'overall');
      }
      if (code.status === 'fulfilled' && code.value) {
        updated += this.mergeLeaderboard(code.value, 'coding');
      }
      if (vision.status === 'fulfilled' && vision.value) {
        updated += this.mergeLeaderboard(vision.value, 'vision');
      }

      if (updated > 0) {
        this.recalculateScores();
        this.saveToCache();
        log.info(`Updated ${updated} model scores from Arena AI`);
      }
    } catch (err) {
      log.warn(`Failed to refresh model scores: ${err}`);
    }
  }

  private async fetchLeaderboard(name: string): Promise<ArenaLeaderboard | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(`${ARENA_API_BASE}/leaderboard?name=${name}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'markus-model-scores/1.0' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        log.warn(`Arena API returned ${resp.status} for ${name}`);
        return null;
      }

      return await resp.json() as ArenaLeaderboard;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.warn(`Arena API timeout for ${name}`);
      } else {
        log.debug(`Arena API fetch failed for ${name}: ${err}`);
      }
      return null;
    }
  }

  private mergeLeaderboard(lb: ArenaLeaderboard, category: 'overall' | 'coding' | 'vision'): number {
    let count = 0;
    for (const entry of lb.models) {
      if (entry.score == null) continue;
      const id = this.normalizeId(entry.model);
      const existing = this.scores.get(id) ?? {
        modelId: entry.model,
        qualityScore: 0,
        tier: 'pro' as ModelTier,
        source: 'arena' as const,
      };

      if (category === 'overall') existing.overallElo = entry.score;
      else if (category === 'coding') existing.codingElo = entry.score;
      else if (category === 'vision') existing.visionElo = entry.score;

      existing.source = 'arena';
      this.scores.set(id, existing);
      count++;
    }
    return count;
  }

  /**
   * Normalize ELO scores to 0-100 quality scores and assign tiers.
   */
  private recalculateScores(): void {
    const elos = [...this.scores.values()]
      .map(s => s.overallElo)
      .filter((e): e is number => e != null);

    if (elos.length === 0) return;

    const minElo = Math.min(...elos);
    const maxElo = Math.max(...elos);
    const range = maxElo - minElo || 1;

    for (const entry of this.scores.values()) {
      if (entry.overallElo != null) {
        entry.qualityScore = Math.round(((entry.overallElo - minElo) / range) * 100);
      }
      entry.tier = tierFromQualityScore(entry.qualityScore);
    }
  }
}
