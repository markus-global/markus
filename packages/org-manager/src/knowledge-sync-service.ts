import { createLogger } from '@markus/shared';
import type { DeliverableService } from './deliverable-service.js';
import type { Dirent } from 'node:fs';

const log = createLogger('knowledge-sync');

export interface KnowledgeSyncResult {
  projectId: string;
  roots: string[];
  scanned: number;
  registered: number;
  updated: number;
  outdated: number;
  errors: string[];
}

/**
 * Knowledge-base sync service (V2 规划).
 *
 * Scans a project's bound knowledge-base root directory(ies), registers each
 * recognized file as a `source='knowledge'` deliverable bound to the project,
 * extracts its text content for full-text search, and marks deliverables whose
 * files disappeared as `outdated`.
 */
export class KnowledgeSyncService {
  constructor(private deliverableService: DeliverableService) {}

  /**
   * Sync one project's knowledge base.
   * @param projectId        Target project (deliverables get projectId bound).
   * @param knowledgeRoots   Root directories to scan (resolved paths).
   * @param opts.ownerId     Optional agentId to record on registered deliverables.
   */
  async sync(
    projectId: string,
    knowledgeRoots: string[],
    opts: { ownerId?: string; includeHidden?: boolean; maxDepth?: number } = {},
  ): Promise<KnowledgeSyncResult> {
    const roots = (knowledgeRoots ?? []).filter(Boolean);
    const result: KnowledgeSyncResult = {
      projectId,
      roots,
      scanned: 0,
      registered: 0,
      updated: 0,
      outdated: 0,
      errors: [],
    };

    const { existsSync, statSync, readdirSync } = await import('node:fs');
    const { join, relative, sep, extname } = await import('node:path');

    const includeHidden = opts.includeHidden ?? false;
    const maxDepth = opts.maxDepth ?? 8;

    // ── Recursively walk a root collecting file paths ─────────────────────
    const walk = (dir: string, depth: number, out: string[]): void => {
      if (depth > maxDepth) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
      } catch (err) {
        result.errors.push(`Cannot read dir ${dir}: ${String(err)}`);
        return;
      }
      for (const entry of entries) {
        // Skip hidden files/dirs unless explicitly enabled.
        if (!includeHidden && entry.name.startsWith('.')) continue;
        // Skip common large/vendored directories.
        if (entry.isDirectory() && ['node_modules', '.git', 'dist', 'build', '.next', '.cache'].includes(entry.name)) {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1, out);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    };

    // ── Gather files from all roots (dedupe by resolved path) ─────────────
    const files = new Set<string>();
    for (const root of roots) {
      if (!existsSync(root)) {
        result.errors.push(`Knowledge root does not exist: ${root}`);
        continue;
      }
      const st = statSync(root);
      if (st.isDirectory()) {
        const collected: string[] = [];
        walk(root, 0, collected);
        for (const f of collected) files.add(f);
      } else if (st.isFile()) {
        files.add(root);
      }
    }

    // ── Existing KB deliverables for this project (to mark missing ones) ──
    const existing = this.deliverableService
      .search({ projectId, source: 'knowledge', limit: 5000 })
      .results.filter(d => d.status !== 'outdated');

    const existingByRef = new Map<string, (typeof existing)[number]>();
    for (const d of existing) {
      if (d.reference) existingByRef.set(d.reference, d);
    }

    // ── Upsert each scanned file ───────────────────────────────────────────
    for (const filePath of [...files].sort()) {
      result.scanned++;
      let size = 0;
      try { size = statSync(filePath).size; } catch { /* ignore */ }
      const ext = extname(filePath).toLowerCase();
      const known = existingByRef.get(filePath);

      // Text extraction for full-text search.
      const { extractTextFromFile } = await import('@markus/core');
      let content = '';
      try {
        content = await extractTextFromFile(filePath);
      } catch (err) {
        result.errors.push(`Text extraction failed for ${filePath}: ${String(err)}`);
      }

      const root = roots.find(r => {
        try { return filePath === r || filePath.startsWith(r + sep); } catch { return false; }
      });
      const relativePath = root ? relative(root, filePath) : undefined;

      const title = known?.title ?? (relativePath ?? filePath.split(sep).pop() ?? 'file');
      const summary = known?.summary ?? `Knowledge base file: ${relativePath ?? filePath}`;

      try {
        const d = await this.deliverableService.create({
          type: 'file',
          title,
          summary,
          reference: filePath,
          format: ext.replace('.', ''),
          tags: ['knowledge', 'kb'],
          projectId,
          agentId: opts.ownerId,
          source: 'knowledge',
          knowledgeRoot: root,
          content,
        });
        if (known) result.updated++;
        else result.registered++;
        void d;
      } catch (err) {
        result.errors.push(`Failed to register ${filePath}: ${String(err)}`);
      }
    }

    // ── Mark missing files as outdated ─────────────────────────────────────
    for (const d of existing) {
      if (!files.has(d.reference)) {
        await this.deliverableService.flagOutdated(d.id);
        result.outdated++;
      }
    }

    log.info('Knowledge sync finished', {
      projectId,
      roots: roots.length,
      scanned: result.scanned,
      registered: result.registered,
      updated: result.updated,
      outdated: result.outdated,
      errors: result.errors.length,
    });
    return result;
  }
}
