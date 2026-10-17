import type { SecretBox } from '@/auth/secretBox'
import type { BusinessEnvironmentValue } from '@/platform/crewstation/nativeMaterial'
import { materializingSpaces } from '@/services/gc'
import type { Logger } from '@/util/log'
import { createHostedRepositoryPublicationTransport } from '../infrastructure/crewstation/publicationTransport'
import type { MaterializedSpace } from '../application/workspaceMaterialization'
import type { HostedVolumeActivity } from '../public/participants'
import type { WorkspaceExcludeProfileReceipt } from '../public/types'
import { createHostedTaskWorkspaces } from '../infrastructure/crewstation/taskWorkspace'
import { createHostedWorkspaceCommands } from '../infrastructure/crewstation/workspaceCommands'
import { createHostedWorkspaceEffects } from '../infrastructure/crewstation/workspaceEffects'
import { createHostedWorkspaceMaintenance } from '../infrastructure/crewstation/workspaceMaintenance'
import { createHostedIsolationWorkspaces } from '../infrastructure/crewstation/isolationWorkspace'
import { createHostedRepositoryCandidateOperations } from '../infrastructure/crewstation/repositoryCandidate'
import { createHostedConflictMergeEffects } from '../infrastructure/crewstation/conflictMerge'
import { createHostedEmployeeCaseWorkspaceOperations } from '../infrastructure/crewstation/employeeCaseWorkspace'
import { createHostedTaskDeletionRepositories } from '../infrastructure/crewstation/taskDeletionRepositories'
import { createHostedDevelopmentRepositoryPreparation } from '../infrastructure/crewstation/developmentRepository'
import {
  createHostedWorkspaceLifecycle,
  hostedWorkspaceLifecycleOwner,
} from '../infrastructure/crewstation/workspaceLifecycle'
import {
  createHostedWorkspaceUploads,
  readHostedWorkspaceFile,
  openHostedWorkspaceFile,
  writeHostedWorkspaceStream,
} from '../infrastructure/crewstation/workspaceUploads'
import {
  createHostedRepositoryPreparation,
  createHostedScratchWorkspaces,
} from '../infrastructure/crewstation/repositoryPreparation'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
  joinHostedWorkspaceReference,
} from '../infrastructure/crewstation/workspaceReference'
import { sha256Hex } from '@/util/hash'

/** Source Control owns both parent volumes, all interpretations of their
 * references and every non-node helper command run inside them (§9.2 V2),
 * and the parents' pause / resume / close lifecycle (§9.2 V3). */
export function composeCrewStationWorkspaceOwner(
  input: Parameters<typeof createHostedTaskWorkspaces>[0] & {
    readonly secretBox: SecretBox
    readonly commandEnvironment?: (
      operation: string,
    ) => Readonly<Record<string, BusinessEnvironmentValue>> | undefined
  },
) {
  const workspaces = createHostedTaskWorkspaces(input)
  const commands = createHostedWorkspaceCommands({
    db: input.db,
    fence: input.fence,
    api: input.api,
    workspaces,
    ...(input.commandEnvironment === undefined
      ? {}
      : { commandEnvironment: input.commandEnvironment }),
  })
  const helper = commands
  // In-process writer holds (references of trees a command still writes).
  const retained = new Set<string>()
  const held = (owner: string) =>
    [...retained].some((reference) => {
      try {
        return parseHostedWorkspaceReference(reference).taskId === owner
      } catch {
        return false
      }
    })
  return {
    commands,
    retainWorkspace(reference: string, keep: boolean) {
      if (keep) retained.add(reference)
      else retained.delete(reference)
    },
    workspaces,
    /** The background owner pausing idle parents and completing lost closes;
     * runs only while this instance holds execution authority. */
    lifecycleOwner(
      activity: HostedVolumeActivity,
      options: {
        readonly intervalMs?: number
        readonly taskGraceMs?: number
        readonly sharedIdleMs?: number
        readonly log?: Pick<Logger, 'warn'>
      } = {},
    ) {
      return hostedWorkspaceLifecycleOwner(
        createHostedWorkspaceLifecycle({
          db: input.db,
          api: input.api,
          fence: input.fence,
          workspaces,
          commands,
          activity,
          held,
          ...(options.taskGraceMs === undefined ? {} : { taskGraceMs: options.taskGraceMs }),
          ...(options.sharedIdleMs === undefined ? {} : { sharedIdleMs: options.sharedIdleMs }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }),
        {
          ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
          ...(options.log === undefined ? {} : { log: options.log }),
        },
      )
    },
    deletionRepositories: () => createHostedTaskDeletionRepositories({ helper, workspaces }),
    writeStream: (
      reference: string,
      stream: ReadableStream<Uint8Array>,
      facts: { readonly size: number; readonly sha256: string },
    ) => {
      const file = parseHostedWorkspaceReference(reference)
      return writeHostedWorkspaceStream(helper, {
        workspaceRef: hostedWorkspaceReference(file.taskId, '/work'),
        fileRef: reference,
        stream,
        ...facts,
        replace: true,
      })
    },
    /** Whole-file write (chunked within the command budget), replacing any file. */
    writeFile: (reference: string, bytes: Uint8Array) => {
      const file = parseHostedWorkspaceReference(reference)
      return writeHostedWorkspaceStream(helper, {
        workspaceRef: hostedWorkspaceReference(file.taskId, '/work'),
        fileRef: reference,
        stream: new Blob([Uint8Array.from(bytes)]).stream(),
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        replace: true,
      })
    },
    readFile: (reference: string) =>
      readHostedWorkspaceFile({ api: input.api, workspaces }, reference),
    openFile: (reference: string) =>
      openHostedWorkspaceFile({ api: input.api, workspaces }, reference),
    reference: hostedWorkspaceReference,
    locate(reference: string, relative?: string) {
      return parseHostedWorkspaceReference(
        relative === undefined ? reference : joinHostedWorkspaceReference(reference, relative),
      )
    },
    bind() {
      const workspaceMaintenanceFilesystem = createHostedWorkspaceMaintenance({
        helper,
        workspaces,
        isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
      })
      return {
        // §9.2 V3: a task publication's network Git runs in its task volume.
        repositoryPublicationTransport: createHostedRepositoryPublicationTransport({ helper }),
        // RFC-308 workspace profiles are written where the worktree lives.
        workspaceExcludeProfiles: {
          bind: ({ workspaceRef }: { workspaceRef: string }) => {
            const workspace = parseHostedWorkspaceReference(workspaceRef)
            return {
              ensure: (request: { directChildMounts?: readonly string[] } = {}) =>
                helper.call<WorkspaceExcludeProfileReceipt>(
                  workspace.taskId,
                  'workspace-exclude-profile',
                  { path: workspace.path, directChildMounts: request.directChildMounts ?? [] },
                ),
            }
          },
        },
        reviewRollbackSnapshots: {
          snapshotExists: ({
            worktreePath,
            snapshot,
          }: {
            worktreePath: string
            snapshot: string
          }) => {
            const workspace = parseHostedWorkspaceReference(worktreePath)
            return helper.call<boolean>(workspace.taskId, 'review-snapshot-exists', {
              path: workspace.path,
              snapshot,
            })
          },
        },
        developmentWorkspaceRepositoryPreparation: createHostedDevelopmentRepositoryPreparation({
          ...input,
          helper,
          taskId: 'development:shared',
        }),
        ...createHostedWorkspaceEffects({ helper, workspaces, api: input.api }),
        workspacePresence: { exists: workspaceMaintenanceFilesystem.exists },
        workspaceMaintenanceFilesystem,
        isolationWorkspaces: createHostedIsolationWorkspaces(helper),
        repositoryCandidateEffects: createHostedRepositoryCandidateOperations({
          helper,
          writerHeld: (reference) => retained.has(reference),
        }),
        conflictMergeWorkspaceEffects: createHostedConflictMergeEffects(helper),
        workspaceUploads: createHostedWorkspaceUploads({
          helper,
          workspaces,
          api: input.api,
        }),
        employeeCaseWorkspaceEffects: createHostedEmployeeCaseWorkspaceOperations({ helper }),
        repositoryPreparationEffects: createHostedRepositoryPreparation({
          db: input.db,
          secretBox: input.secretBox,
          helper,
          recoverMaterialization: (taskId, operationId) =>
            helper.recover<MaterializedSpace>(taskId, operationId),
        }),
        scratchWorkspaceEffects: createHostedScratchWorkspaces(helper),
      }
    },
  }
}
