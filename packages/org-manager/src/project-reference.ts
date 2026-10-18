/**
 * Project reference guard — SINGLE OWNER.
 *
 * A `projectId` is a REFERENCE, not free text. Writing one that is absent from the project
 * table mints a "project orphan": the row falls out of every project view and every
 * project-scoped report while still occupying its assignee's quota, and no agent-facing
 * tool can repair it (live evidence: 130 such rows, plus one card whose requirement id and
 * project id were both wrong).
 *
 * Both services that can write a project reference (TaskService on task writes,
 * RequirementService on requirement writes) call THIS implementation. Do not inline a
 * second copy of the rule: two owners of one invariant drift, and the drift is silent.
 */

/** Minimal project lookup — satisfied by ProjectService. */
export interface ProjectLookupBridge {
  getProject(id: string): { id?: string } | null | undefined;
}

/**
 * Fail-closed project reference validation.
 *
 * Unwired lookup ⇒ throw: refusing is correct because an unverifiable reference is exactly
 * what we must not write. Callers that legitimately do not deal with projects simply never
 * reach this function.
 *
 * @param subject what is being written, for the error message ("task" / "requirement").
 */
export function assertValidProjectReference(
  lookup: ProjectLookupBridge | undefined,
  projectId: string,
  subject: 'task' | 'requirement'
): void {
  if (!lookup) {
    throw new Error(
      `Cannot set projectId on a ${subject}: project lookup is unavailable in this process, ` +
        `so the target cannot be verified. Refusing rather than writing an unvalidated ` +
        `project reference.`
    );
  }
  if (!lookup.getProject(projectId)) {
    throw new Error(
      `Project "${projectId}" does not exist — a ${subject} pointing at a non-existent project ` +
        `is a project orphan (it falls out of every project view and every project-scoped ` +
        `report). Fix the source record's projectId first, or pick a real project id.`
    );
  }
}
