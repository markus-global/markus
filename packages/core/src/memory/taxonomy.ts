/**
 * knowledge.md / state.md dual store helpers — MEMORY-SYSTEM Spec §1.1
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_TTL_DAYS } from '@markus/shared';

const STATE_MARKER_RE = /\b(silent|silence|current|progress|day\s*\d+|静默|当前|进度)\b/i;
const DATED_LINE_RE = /^\s*[-*]?\s*\d{4}-\d{2}-\d{2}/m;

export function knowledgePath(dataDir: string): string {
  return join(dataDir, 'knowledge.md');
}

export function statePath(dataDir: string): string {
  return join(dataDir, 'state.md');
}

export function legacyMemoryPath(dataDir: string): string {
  return join(dataDir, 'MEMORY.md');
}

/** Heuristic split of legacy MEMORY.md into knowledge + state. */
export function splitLegacyMemory(content: string): { knowledge: string; state: string } {
  const sections = content.split(/(?=^## )/m).filter(Boolean);
  const knowledgeParts: string[] = [];
  const stateParts: string[] = [];
  for (const sec of sections) {
    if (sec.includes('## _observations')) {
      knowledgeParts.push(sec); // keep observations under knowledge file bottom
      continue;
    }
    if (STATE_MARKER_RE.test(sec) || DATED_LINE_RE.test(sec)) {
      stateParts.push(sec);
    } else {
      knowledgeParts.push(sec);
    }
  }
  return {
    knowledge: knowledgeParts.join('\n').trim() + '\n',
    state: stateParts.join('\n').trim() + '\n',
  };
}

export function ensureKnowledgeStateFiles(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const k = knowledgePath(dataDir);
  const s = statePath(dataDir);
  const legacy = legacyMemoryPath(dataDir);
  if (!existsSync(k) && existsSync(legacy)) {
    const raw = readFileSync(legacy, 'utf8');
    const { knowledge, state } = splitLegacyMemory(raw);
    writeFileSync(k, knowledge || '# Knowledge\n', 'utf8');
    writeFileSync(s, state || '# State\n', 'utf8');
    return;
  }
  if (!existsSync(k)) writeFileSync(k, '# Knowledge\n', 'utf8');
  if (!existsSync(s)) writeFileSync(s, '# State\n', 'utf8');
}

export function readKnowledge(dataDir: string): string {
  ensureKnowledgeStateFiles(dataDir);
  return readFileSync(knowledgePath(dataDir), 'utf8');
}

export function readState(dataDir: string): string {
  ensureKnowledgeStateFiles(dataDir);
  return readFileSync(statePath(dataDir), 'utf8');
}

export function writeKnowledge(dataDir: string, content: string): void {
  mkdirSync(dirname(knowledgePath(dataDir)), { recursive: true });
  writeFileSync(knowledgePath(dataDir), content, 'utf8');
}

export function writeState(dataDir: string, content: string): void {
  mkdirSync(dirname(statePath(dataDir)), { recursive: true });
  writeFileSync(statePath(dataDir), content, 'utf8');
}

/** Drop state sections older than TTL (by ## heading date or HTML comment updatedAt). */
export function pruneExpiredState(content: string, now = Date.now(), ttlDays = STATE_TTL_DAYS): string {
  const cutoff = now - ttlDays * 24 * 3600_000;
  const sections = content.split(/(?=^## )/m);
  const kept: string[] = [];
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const m =
      sec.match(/updatedAt[:\s]+(\d{4}-\d{2}-\d{2})/i)
      || sec.match(/(\d{4}-\d{2}-\d{2})/);
    if (m?.[1]) {
      const t = Date.parse(m[1]);
      if (Number.isFinite(t) && t < cutoff) continue;
    }
    kept.push(sec);
  }
  return kept.join('').trim() + (kept.length ? '\n' : '');
}

export function dreamArchiveSkillSuggestion(opts: {
  usageCount: number;
  ageDays: number;
}): boolean {
  return opts.usageCount === 0 && opts.ageDays > 30;
}
