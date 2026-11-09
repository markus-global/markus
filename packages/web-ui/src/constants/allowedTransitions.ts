/**
 * Browser-side mirror of the task/requirement transition matrices.
 *
 * The web bundle cannot import `@markus/shared` at runtime (node-flavoured code),
 * so it keeps a plain-data projection here. `packages/web-ui/test/allowedTransitions.contract.test.ts`
 * fails the build if these diverge from `TASK_TRANSITIONS` / `REQ_TRANSITIONS` in
 * `@markus/shared` — hand-editing this file only makes the test red, it cannot
 * silently change behaviour.
 */

export const TASK_ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending:     new Set(['in_progress', 'blocked', 'rejected', 'cancelled', 'completed']),
  in_progress: new Set(['review', 'blocked', 'failed', 'cancelled']),
  blocked:     new Set(['in_progress', 'cancelled', 'failed']),
  review:      new Set(['completed', 'in_progress', 'cancelled']),
  completed:   new Set(['archived', 'in_progress']),
  failed:      new Set(['in_progress', 'archived']),
  rejected:    new Set(['archived']),
  cancelled:   new Set(['archived', 'in_progress']),
  archived:    new Set([]),
};

export const REQ_ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending:     new Set(['in_progress', 'blocked', 'rejected', 'cancelled']),
  in_progress: new Set(['completed', 'blocked', 'rejected', 'cancelled']),
  blocked:     new Set(['in_progress', 'rejected', 'cancelled']),
  review:      new Set(['completed', 'in_progress', 'cancelled']),
  completed:   new Set(['archived', 'in_progress']),
  failed:      new Set(['in_progress', 'archived', 'pending']),
  rejected:    new Set(['in_progress', 'archived', 'pending']),
  cancelled:   new Set(['in_progress', 'archived', 'pending']),
  archived:    new Set([]),
};
