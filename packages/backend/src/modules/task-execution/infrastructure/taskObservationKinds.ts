import { NodeKindSchema, type ObservationAttemptFacts } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'

/** Read only frozen original node identities/kinds; never expose its prompts or configuration. */
export async function observationAttemptKinds<T extends ObservationAttemptFacts>(
  db: ProviderNeutralDatabase,
  taskId: string,
  attempts: readonly T[],
): Promise<Array<T & { computeKind: NonNullable<ObservationAttemptFacts['computeKind']> }>> {
  const selected = new Set(attempts.map((attempt) => attempt.nodeId))
  const kinds = new Map<string, NonNullable<ObservationAttemptFacts['computeKind']>>()
  const original = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  let value: unknown
  try {
    value = original ? JSON.parse(original.snapshot) : null
  } catch {
    value = null
  }
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
    computeKind: kinds.get(attempt.nodeId) ?? 'unknown',
  }))
}
