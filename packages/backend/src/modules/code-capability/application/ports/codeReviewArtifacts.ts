// RFC-370 §10 V16 — persisted code-review artifacts of one task: the
// structural diffs computed for its terminal generations and its change
// narrative. A terminal task is served from here first, so viewing its Changes
// tab needs neither its worktree nor (hosted) a wake of its volume.
import type { ChangeNarrative, StructuralDiff, StructuralScope } from '@agent-workflow/shared'

export interface StructuralDiffArtifactKey {
  readonly taskId: string
  readonly scope: StructuralScope
  readonly nodeRunId?: string
  /**
   * The terminal generation the diff was computed in (the task's `finishedAt`).
   * `null` on a read asks for whatever the store still holds for the scope; a
   * store that keys by generation answers null for it.
   */
  readonly generation: string | null
}

export interface CodeReviewArtifactStore {
  readStructuralDiff(key: StructuralDiffArtifactKey): Promise<StructuralDiff | null>
  /** Best effort: a failed write never fails the response that computed it. */
  writeStructuralDiff(key: StructuralDiffArtifactKey, diff: StructuralDiff): Promise<void>
  /** The latest narrative generated for the task, or null. */
  readNarrative(taskId: string): Promise<ChangeNarrative | null>
  writeNarrative(taskId: string, narrative: ChangeNarrative): Promise<void>
  /** Every artifact of the task. */
  removeTask(taskId: string): Promise<void>
}
