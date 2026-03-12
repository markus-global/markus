/**
 * File-based persistence for the Knowledge Base.
 *
 * Directory layout:
 *   {baseDir}/
 *   ├── {scope}/
 *   │   └── {scopeId}/
 *   │       ├── _index.json          (lightweight index of all entries)
 *   │       ├── {id}.json            (full entry content)
 *   │       └── ...
 *
 * On startup the store loads every _index.json into an in-memory Map so
 * search/browse are fast. Individual entry files are written on contribute
 * and can be read directly by agents via file_read.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type KnowledgeEntry } from '@markus/shared';

const log = createLogger('file-knowledge-store');

export class FileKnowledgeStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
  }

  private scopeDir(scope: string, scopeId: string): string {
    return join(this.baseDir, scope, scopeId);
  }

  private indexPath(scope: string, scopeId: string): string {
    return join(this.scopeDir(scope, scopeId), '_index.json');
  }

  entryPath(entry: KnowledgeEntry): string {
    return join(this.scopeDir(entry.scope, entry.scopeId), `${entry.id}.json`);
  }

  // ─── Load ────────────────────────────────────────────────────────────────

  loadAll(): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    if (!existsSync(this.baseDir)) return entries;

    for (const scope of readdirSafe(this.baseDir)) {
      const scopePath = join(this.baseDir, scope);
      for (const scopeId of readdirSafe(scopePath)) {
        const idxPath = join(scopePath, scopeId, '_index.json');
        if (!existsSync(idxPath)) continue;
        try {
          const data = JSON.parse(readFileSync(idxPath, 'utf-8')) as KnowledgeEntry[];
          entries.push(...data);
        } catch (err) {
          log.warn('Failed to load index', { path: idxPath, error: String(err) });
        }
      }
    }
    log.info('Knowledge loaded from disk', { count: entries.length });
    return entries;
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  saveEntry(entry: KnowledgeEntry): void {
    const dir = this.scopeDir(entry.scope, entry.scopeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
  }

  saveIndex(scope: string, scopeId: string, entries: KnowledgeEntry[]): void {
    const dir = this.scopeDir(scope, scopeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_index.json'), JSON.stringify(entries, null, 2));
  }

  removeEntryFile(entry: KnowledgeEntry): void {
    const p = join(this.scopeDir(entry.scope, entry.scopeId), `${entry.id}.json`);
    try { unlinkSync(p); } catch { /* ignore if already gone */ }
  }

  /** Persist a single entry and rebuild the scope index. */
  persist(entry: KnowledgeEntry, allInScope: KnowledgeEntry[]): void {
    this.saveEntry(entry);
    this.saveIndex(entry.scope, entry.scopeId, allInScope);
  }

  /** Rebuild the scope index (e.g. after status changes). */
  rebuildIndex(scope: string, scopeId: string, entries: KnowledgeEntry[]): void {
    this.saveIndex(scope, scopeId, entries);
    for (const e of entries) {
      this.saveEntry(e);
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}
