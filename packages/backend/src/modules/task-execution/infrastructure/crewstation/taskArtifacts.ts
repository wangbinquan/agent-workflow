// RFC-370 v3 V6 — `hosted_task_artifacts` is Task Execution's owner reference
// for `task-artifact` publications (key = artifact reference, scope = task id).
// A row is written only in the ready transaction of its publication.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectReceipt } from '@/modules/system-operations/public/participants'

export const HOSTED_TASK_ARTIFACT_OWNER = 'task-artifact'

export async function retainHostedTaskArtifactInTx(
  tx: PersistenceDb,
  input: {
    readonly reference: string
    readonly taskId: string
    readonly object: HostedObjectReceipt
  },
): Promise<void> {
  const { hostedTaskArtifacts } = tablesOf(tx)
  await tx
    .insert(hostedTaskArtifacts)
    .values({
      reference: input.reference,
      taskId: input.taskId,
      objectId: input.object.id,
      digest: input.object.sha256,
      size: input.object.size,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
  const [saved] = await tx
    .select()
    .from(hostedTaskArtifacts)
    .where(eq(hostedTaskArtifacts.reference, input.reference))
    .limit(1)
  if (
    saved?.taskId !== input.taskId ||
    saved.objectId !== input.object.id ||
    saved.digest !== input.object.sha256 ||
    saved.size !== input.object.size
  )
    throw new Error('hosted-task-artifact-content-changed')
}
