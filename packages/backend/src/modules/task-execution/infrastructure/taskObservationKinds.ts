import { NodeKindSchema, type ObservationAttemptFacts } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'

/** Read only frozen original node identities/kinds; never expose its prompts or configuration. */
export async function observationAttemptKinds<
  T extends ObservationAttemptFacts & { readonly rerunCause?: string | null },
>(
  db: ProviderNeutralDatabase,
  taskId: string,
  attempts: readonly T[],
): Promise<Array<T & { computeKind: NonNullable<ObservationAttemptFacts['computeKind']> }>> {
  const selected = new Set(attempts.map((attempt) => attempt.nodeId))
  const kinds = new Map<string, NonNullable<ObservationAttemptFacts['computeKind']>>()
  const original = await db
    .select({
      snapshot: tasks.workflowSnapshot,
      workgroupId: tasks.workgroupId,
      workgroupConfig: tasks.workgroupConfigJson,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  let value: unknown
  let group: unknown
  try {
    value = original ? JSON.parse(original.snapshot) : null
  } catch {
    value = null
  }
  try {
    group = original?.workgroupConfig ? JSON.parse(original.workgroupConfig) : null
  } catch {
    group = null
  }
  const dynamicWorkgroup =
    original?.workgroupId != null &&
    group !== null &&
    typeof group === 'object' &&
    'mode' in group &&
    group.mode === 'dynamic_workflow'
  if (value && typeof value === 'object' && 'nodes' in value && Array.isArray(value.nodes)) {
    for (const node of value.nodes as unknown[]) {
      if (
        !node ||
        typeof node !== 'object' ||
        !('id' in node) ||
        typeof node.id !== 'string' ||
        !selected.has(node.id) ||
        !('kind' in node)
      )
        continue
      const kind = NodeKindSchema.safeParse(node.kind)
      const classification = !kind.success
        ? 'unknown'
        : kind.data === 'agent-single' || kind.data === 'code-round'
          ? 'agent'
          : 'non-agent'
      if (kinds.has(node.id)) kinds.set(node.id, 'unknown')
      else kinds.set(node.id, classification)
    }
  }
  return attempts.map((attempt) => ({
    ...attempt,
    // The generated DAG replaces the original orchestrator graph. Its human gate and
    // model execution share a node ID; only the original owner cause distinguishes them.
    computeKind:
      dynamicWorkgroup && attempt.nodeId === '__dw_orchestrator__'
        ? attempt.rerunCause === 'dw-gate'
          ? 'non-agent'
          : attempt.rerunCause === 'dw-generate'
            ? 'agent'
            : (kinds.get(attempt.nodeId) ?? 'unknown')
        : (kinds.get(attempt.nodeId) ?? 'unknown'),
  }))
}
