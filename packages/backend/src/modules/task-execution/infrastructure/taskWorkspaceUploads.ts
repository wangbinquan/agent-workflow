import type { ProviderNeutralDatabase } from '@/db/query'
import { applyUploadsToWorktree, type UploadPlan, type UploadResult } from '@/services/upload'
import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { ConflictError } from '@/util/errors'
import { createWorkspacePreparationJournal } from './workspacePreparationJournal'
import { withTaskExecutionWrite } from './ownedTaskExecution'

/** Preserve the original upload writer and record its complete packed-path receipt
 * before admission. A resumed launch must not turn the same upload into "file (1)". */
export async function applyTaskWorkspaceUploads(input: {
  db: ProviderNeutralDatabase
  taskId: string
  plan: UploadPlan
}): Promise<UploadResult> {
  const requestDigest = sha256Hex(
    canonicalJson({
      worktreePath: input.plan.worktreePath,
      inputsSubdir: input.plan.inputsSubdir ?? null,
      defs: [...input.plan.defs],
      files: input.plan.files.map((file) => ({
        inputKey: file.inputKey,
        filename: file.filename,
        bytes: sha256Hex(file.bytes),
      })),
      limits: input.plan.limits,
    }),
  )
  const journal = createWorkspacePreparationJournal(input.db)
  const prepared = await journal.read(input.taskId)
  // Only historical/custom adapters still lack a journal; production root lanes
  // record one before filesystem effects. T7 removes this compatibility arm.
  if (prepared === null) return applyUploadsToWorktree(input.plan)
  if (
    prepared.lane !== 'pre-materialized' ||
    prepared.state !== 'prepared' ||
    prepared.admittedTaskId !== null
  )
    throw new ConflictError(
      'workspace-preparation-owner-changed',
      'uploads require an unadmitted artifact',
    )
  const receipt = JSON.parse(prepared.artifactJson!) as {
    uploads?: { requestDigest: string; packedByKey: Array<[string, string[]]> }
  }
  if (receipt.uploads !== undefined) {
    if (receipt.uploads.requestDigest !== requestDigest)
      throw new ConflictError(
        'workspace-upload-request-mismatch',
        'workspace upload request changed',
      )
    return { packedByKey: new Map(receipt.uploads.packedByKey) }
  }
  const result = await applyUploadsToWorktree(input.plan)
  await withTaskExecutionWrite(input.db, async (tx) => {
    if (
      (await createWorkspacePreparationJournal(tx).completeUploads({
        id: input.taskId,
        expectedVersion: prepared.version,
        ownerFence: prepared.ownerFence,
        requestDigest,
        packedByKey: [...result.packedByKey],
        now: Date.now(),
      })) === null
    )
      throw new Error('workspace-preparation-owner-changed')
  })
  return result
}
