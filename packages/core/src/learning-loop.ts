/**
 * Learning Loop primitives — docs/LEARNING-LOOP.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillStats {
  usage_count: number;
  success_count: number;
  last_used: string | null;
  avg_token_cost: number | null;
  feedback: string[];
}

export function emptySkillStats(): SkillStats {
  return {
    usage_count: 0,
    success_count: 0,
    last_used: null,
    avg_token_cost: null,
    feedback: [],
  };
}

export function shouldDistillTask(opts: {
  toolCallCount: number;
  hadRejection: boolean;
  similarTaskCount: number;
  status: string;
}): boolean {
  // Only completed tasks — failed has no accepted outcome / feedback yet.
  if (opts.status !== 'completed') return false;
  if (opts.hadRejection) return true;
  if (opts.toolCallCount >= 5) return true;
  if (opts.similarTaskCount >= 2) return true;
  return false;
}

function statsPath(skillDir: string): string {
  return join(skillDir, 'stats.json');
}

export function loadSkillStats(skillDir: string): SkillStats {
  const p = statsPath(skillDir);
  if (!existsSync(p)) return emptySkillStats();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<SkillStats>;
    return {
      usage_count: Number(raw.usage_count) || 0,
      success_count: Number(raw.success_count) || 0,
      last_used: raw.last_used ?? null,
      avg_token_cost: raw.avg_token_cost ?? null,
      feedback: Array.isArray(raw.feedback) ? raw.feedback.map(String) : [],
    };
  } catch {
    return emptySkillStats();
  }
}

export function saveSkillStats(skillDir: string, stats: SkillStats): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(statsPath(skillDir), JSON.stringify(stats, null, 2), 'utf8');
}

export function recordSkillActivation(skillDir: string): SkillStats {
  const stats = loadSkillStats(skillDir);
  stats.usage_count += 1;
  stats.last_used = new Date().toISOString().slice(0, 10);
  saveSkillStats(skillDir, stats);
  return stats;
}

export function recordSkillTaskSuccess(skillDir: string): SkillStats {
  const stats = loadSkillStats(skillDir);
  stats.success_count += 1;
  saveSkillStats(skillDir, stats);
  return stats;
}

export function recordSkillTaskRejection(skillDir: string, note: string): SkillStats {
  const stats = loadSkillStats(skillDir);
  const line = `- ${note}`.slice(0, 500);
  stats.feedback = [...stats.feedback, line].slice(-50);
  saveSkillStats(skillDir, stats);
  return stats;
}

/** Suppress near-identical drafts after a reject that mentioned the fingerprint. */
export function shouldSuppressSkillDraft(
  feedback: string[],
  draftFingerprint: string,
): boolean {
  if (!draftFingerprint) return false;
  const fp = draftFingerprint.toLowerCase();
  return feedback.some((f) => f.toLowerCase().includes(fp));
}

export function skillPendingDir(artifactsRoot: string, name: string): string {
  return join(artifactsRoot, 'skills', '.pending', name);
}

export function skillLiveDir(artifactsRoot: string, name: string): string {
  return join(artifactsRoot, 'skills', name);
}
