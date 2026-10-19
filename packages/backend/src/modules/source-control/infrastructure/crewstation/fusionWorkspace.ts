import { randomUUID } from 'node:crypto'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import type {
  FusionWorkspaceEffects,
  FusionWorkspacePreparation,
  FusionWorkspaceResult,
} from '../../application/ports/fusionWorkspaceEffects'
import {
  FUSION_WORKSPACE_INLINE_BYTES,
  FUSION_WORKSPACE_OPERATION,
  FUSION_WORKSPACE_PATH,
  FUSION_WORKSPACE_PAYLOAD_DIRECTORY,
  fromWireFiles,
  toWireFiles,
  type FusionWorkspaceVolumeOutcome,
  type FusionWorkspaceVolumeRequest,
  type FusionWorkspaceWireResult,
  type FusionWorkspaceWireSeed,
} from './fusionWorkspaceVolume'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'
import { readHostedWorkspaceFile, writeHostedWorkspaceStream } from './workspaceUploads'

/**
 * RFC-370 §10 V20 — a hosted fusion engine task's working copy lives in its own
 * task volume (`cs-workspace:<taskId>/fusion`). Seeding and collecting are each
 * ONE `fusion-workspace` command; whole trees above the inline budget travel as
 * volume files. Fusion engine tasks are internal: Task deletion and workspace
 * GC never reach them, so the parent is given back here once the proposal has
 * been captured (or the task was never admitted).
 */
export function createHostedFusionWorkspaces(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: HostedTaskWorkspaces
  readonly api: CrewStationBusinessExecution
}): FusionWorkspaceEffects {
  const call = <T>(taskId: string, request: FusionWorkspaceVolumeRequest) =>
    input.helper.call<FusionWorkspaceVolumeOutcome<T>>(taskId, FUSION_WORKSPACE_OPERATION, request)
  // Best effort: a leftover payload file in the volume's tmp is harmless and
  // must not mask the operation's own outcome.
  const releaseFile = (taskId: string, file: string) =>
    input.helper
      .call(taskId, FUSION_WORKSPACE_OPERATION, { operation: 'release-file', file })
      .catch(() => undefined)
  const valueOf = async <T>(taskId: string, outcome: FusionWorkspaceVolumeOutcome<T>) => {
    if (outcome.resultFile === undefined) return outcome.value
    try {
      const bytes = await readHostedWorkspaceFile(
        { api: input.api, workspaces: input.workspaces },
        hostedWorkspaceReference(taskId, outcome.resultFile),
      )
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as T
    } finally {
      await releaseFile(taskId, outcome.resultFile)
    }
  }
  return Object.freeze({
    async prepare(request: Parameters<FusionWorkspaceEffects['prepare']>[0]) {
      const taskId = request.taskId
      const seed: FusionWorkspaceWireSeed = {
        base: toWireFiles(request.base),
        overlay: request.overlay === null ? null : toWireFiles(request.overlay),
      }
      try {
        const json = JSON.stringify(seed)
        let seedFile: string | undefined
        if (Buffer.byteLength(json) > FUSION_WORKSPACE_INLINE_BYTES) {
          seedFile = `${FUSION_WORKSPACE_PAYLOAD_DIRECTORY}/${randomUUID()}.json`
          const bytes = new TextEncoder().encode(json)
          await writeHostedWorkspaceStream(input.helper, {
            workspaceRef: hostedWorkspaceReference(taskId, '/work'),
            fileRef: hostedWorkspaceReference(taskId, seedFile),
            stream: new Blob([bytes]).stream(),
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            replace: true,
          })
        }
        try {
          const prepared = await valueOf(
            taskId,
            await call<{ readonly baseCommit: string }>(
              taskId,
              seedFile === undefined
                ? { operation: 'prepare', path: FUSION_WORKSPACE_PATH, seed }
                : { operation: 'prepare', path: FUSION_WORKSPACE_PATH, seedFile },
            ),
          )
          return {
            worktreePath: hostedWorkspaceReference(taskId, FUSION_WORKSPACE_PATH),
            baseCommit: prepared.baseCommit,
          } satisfies FusionWorkspacePreparation
        } finally {
          if (seedFile !== undefined) await releaseFile(taskId, seedFile)
        }
      } catch (error) {
        // The parent this preparation created belongs to a task never admitted.
        await input.workspaces.abandon(taskId).catch(() => undefined)
        throw error
      }
    },
    async collect(request: Parameters<FusionWorkspaceEffects['collect']>[0]) {
      const location = parseHostedWorkspaceReference(request.worktreePath)
      if (location.taskId !== request.taskId)
        throw new Error('hosted-fusion-workspace-owner-mismatch')
      const wire = await valueOf(
        request.taskId,
        await call<FusionWorkspaceWireResult>(request.taskId, {
          operation: 'collect',
          path: location.path,
          baseCommit: request.baseCommit,
        }),
      )
      return {
        diff: wire.diff,
        manifest: wire.manifest,
        files: fromWireFiles(wire.files),
      } satisfies FusionWorkspaceResult
    },
    // Closing is recorded first, so the lifecycle owner completes a close the
    // platform refuses for the moment; both modes end the engine task's parent.
    async release(request: Parameters<FusionWorkspaceEffects['release']>[0]) {
      await input.workspaces.abandon(request.taskId)
    },
  } satisfies FusionWorkspaceEffects)
}
