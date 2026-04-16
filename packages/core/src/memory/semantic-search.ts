import { createLogger } from '@markus/shared';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry } from './types.js';

const log = createLogger('semantic-search');

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface VectorStore {
  upsert(
    id: string,
    embedding: number[],
    metadata: { agentId: string; content: string; type: string }
  ): Promise<void>;
  search(
    queryEmbedding: number[],
    opts: { topK: number; agentId?: string; minSimilarity?: number }
  ): Promise<Array<{ id: string; similarity: number; content: string; type: string }>>;
  delete(id: string): Promise<void>;
}

export interface SemanticSearchResult {
  entry: MemoryEntry;
  similarity: number;
}

/**
 * OpenAI-compatible embedding provider.
 * Works with OpenAI, Azure OpenAI, and any compatible API.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model?: string; dimensions?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Embedding API error ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

/**
 * Portable vector store backed by local files — no database required.
 * Uses in-memory cosine similarity for search. Suitable for single-user
 * scenarios (personal dev tools, local agents).
 *
 * At 1536-dim embeddings, brute-force cosine over 10k entries takes <10ms.
 */
export class LocalVectorStore implements VectorStore {
  private vectors: Map<
    string,
    { embedding: number[]; metadata: { agentId: string; content: string; type: string } }
  > = new Map();
  private storePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    const dir = join(dataDir, 'vector-store');
    mkdirSync(dir, { recursive: true });
    this.storePath = join(dir, 'embeddings.json');
    this.load();
  }

  async upsert(
    id: string,
    embedding: number[],
    metadata: { agentId: string; content: string; type: string }
  ): Promise<void> {
    this.vectors.set(id, { embedding, metadata });
    this.scheduleSave();
  }

  async search(
    queryEmbedding: number[],
    opts: { topK: number; agentId?: string; minSimilarity?: number }
  ): Promise<Array<{ id: string; similarity: number; content: string; type: string }>> {
    const minSim = opts.minSimilarity ?? 0.3;
    const results: Array<{ id: string; similarity: number; content: string; type: string }> = [];

    for (const [id, entry] of this.vectors) {
      if (opts.agentId && entry.metadata.agentId !== opts.agentId) continue;
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (sim >= minSim) {
        results.push({
          id,
          similarity: sim,
          content: entry.metadata.content,
          type: entry.metadata.type,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, opts.topK);
  }

  async delete(id: string): Promise<void> {
    this.vectors.delete(id);
    this.scheduleSave();
  }

  private load(): void {
    try {
      if (existsSync(this.storePath)) {
        const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Array<
          [
            string,
            { embedding: number[]; metadata: { agentId: string; content: string; type: string } },
          ]
        >;
        this.vectors = new Map(data);
        log.info('Local vector store loaded', { entries: this.vectors.size });
      }
    } catch (err) {
      log.warn('Failed to load local vector store', { error: String(err) });
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      try {
        writeFileSync(this.storePath, JSON.stringify(Array.from(this.vectors.entries())));
        this.dirty = false;
      } catch (err) {
        log.warn('Failed to save local vector store', { error: String(err) });
      }
    }, 2000);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic search service that wraps embedding + vector store.
 * Provides a simple interface for agent memory.
 */
export class SemanticMemorySearch {
  private embedding: EmbeddingProvider;
  private vectorStore: VectorStore;
  private enabled = false;

  constructor(embedding: EmbeddingProvider, vectorStore: VectorStore) {
    this.embedding = embedding;
    this.vectorStore = vectorStore;
  }

  async initialize(): Promise<boolean> {
    this.enabled = true;
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async indexMemory(entry: MemoryEntry, agentId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const embedding = await this.embedding.embed(entry.content);
      await this.vectorStore.upsert(entry.id, embedding, {
        agentId,
        content: entry.content,
        type: entry.type,
      });
    } catch (err) {
      log.warn('Failed to index memory entry', { id: entry.id, error: String(err) });
    }
  }

  async search(
    query: string,
    opts?: {
      topK?: number;
      agentId?: string;
      minSimilarity?: number;
    }
  ): Promise<SemanticSearchResult[]> {
    if (!this.enabled) return [];

    try {
      const queryEmbedding = await this.embedding.embed(query);
      const results = await this.vectorStore.search(queryEmbedding, {
        topK: opts?.topK ?? 5,
        agentId: opts?.agentId,
        minSimilarity: opts?.minSimilarity ?? 0.3,
      });

      return results.map(r => ({
        entry: {
          id: r.id,
          content: r.content,
          type: r.type as MemoryEntry['type'],
          timestamp: '',
        },
        similarity: r.similarity,
      }));
    } catch (err) {
      log.warn('Semantic search failed, returning empty results', { error: String(err) });
      return [];
    }
  }

  async deleteMemory(id: string): Promise<void> {
    if (!this.enabled) return;
    await this.vectorStore.delete(id);
  }
}

