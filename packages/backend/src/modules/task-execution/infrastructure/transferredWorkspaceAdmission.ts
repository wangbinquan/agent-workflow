import { preparedArtifactLane } from './workspaceLaunchLane'
import { canonicalJson } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import type { TaskWorkspaceLaunchLane } from '../application/ports/workspaceLaunch'
import { createWorkspacePreparationJournal } from './workspacePreparationJournal'

/** These physical artifacts already belong to the call-node, fusion job or
 * digital-employee workspace owner. Admission records the hand-off only: it
 * never acquires permission to remove the caller's directory. */
export type TransferredWorkspaceArtifact = {
  readonly kind: 'borrowed' | 'call' | 'fusion'
  readonly taskId: string
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly ownerRef: string
}

export async function admitTransferredWorkspace(
  transaction: ProviderNeutralDatabase,
  artifact: TransferredWorkspaceArtifact,
): Promise<TaskWorkspaceLaunchLane> {
  const journal = createWorkspacePreparationJournal(transaction)
  const artifactJson = canonicalJson({ version: 1, artifact })
  const now = Date.now()
  let plan = await journal.prepare({
    id: artifact.taskId,
    admissionKey: `task-transferred:${artifact.kind}:${artifact.taskId}`,
    requestDigest: sha256Hex(artifactJson),
    lane: 'pre-materialized',
    operationRef: null,
    ownerFence: 0,
    now,
  })
  if (plan.state === 'preparing') {
    const prepared = await journal.advance({
      id: plan.id,
      expectedVersion: plan.version,
      ownerFence: plan.ownerFence,
      from: 'preparing',
      to: 'prepared',
      artifactJson,
      now,
    })
    if (prepared === null) throw new Error('workspace-preparation-owner-changed')
    plan = prepared
  }
  if (
    plan.state !== 'prepared' ||
    plan.admittedTaskId !== null ||
    plan.artifactJson !== artifactJson
  )
    throw new Error('workspace-preparation-owner-changed')
  if (
    (await journal.advance({
      id: plan.id,
      expectedVersion: plan.version,
      ownerFence: plan.ownerFence,
      from: 'prepared',
      to: 'admitted',
      admittedTaskId: artifact.taskId,
      now,
    })) === null
  )
    throw new Error('workspace-preparation-owner-changed')
  return preparedArtifactLane(plan.id)
}
