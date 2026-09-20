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
  /** Effect substitution is used by the process interruption oracle. */
  write?: (plan: UploadPlan) => Promise<UploadResult>
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
  if (
    prepared === null ||
    prepared.lane !== 'pre-materialized' ||
    prepared.state !== 'prepared' ||
    prepared.admittedTaskId !== null
  )
    throw new ConflictError(
      'workspace-preparation-owner-changed',
      'uploads require an unadmitted artifact',
    )
  const receipt = JSON.parse(prepared.artifactJson!) as {
    uploadPlan?: { requestDigest: string; placements: string[] }
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
  if (receipt.uploadPlan !== undefined && receipt.uploadPlan.requestDigest !== requestDigest)
    throw new ConflictError('workspace-upload-request-mismatch', 'workspace upload request changed')
  let version = prepared.version
  const placements = [...(receipt.uploadPlan?.placements ?? [])]
  const result = await (input.write ?? applyUploadsToWorktree)({
    ...input.plan,
    recovery: {
      placement: (index) => placements[index] ?? null,
      async reserve(index, filename) {
        if (index !== placements.length) throw new Error('workspace-upload-sequence-changed')
        placements.push(filename)
        await withTaskExecutionWrite(input.db, async (tx) => {
          const saved = await createWorkspacePreparationJournal(tx).checkpointUploadPlan({
            id: input.taskId,
            expectedVersion: version,
            ownerFence: prepared.ownerFence,
            requestDigest,
            placements,
            now: Date.now(),
          })
          if (saved === null) throw new Error('workspace-preparation-owner-changed')
          version = saved.version
        })
      },
    },
  })
  await withTaskExecutionWrite(input.db, async (tx) => {
    if (
      (await createWorkspacePreparationJournal(tx).completeUploads({
        id: input.taskId,
        expectedVersion: version,
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
