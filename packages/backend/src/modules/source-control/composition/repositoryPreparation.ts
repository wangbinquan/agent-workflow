import type { GitCommitIdentity } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import { DomainError, NotFoundError } from '@/util/errors'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'
import { createRepositoryLaunchSnapshotInTx } from '../infrastructure/repositoryLaunchSnapshot'
import { createRepositoryPreparationJournal } from '../infrastructure/repositoryPreparationJournal'
import { composeRepositoryPreparationParticipant } from '../infrastructure/repositoryPreparationParticipant'
import { createRepositoryPreparationEffects } from '../infrastructure/repositoryPreparationEffects'
import { composeRepositoryWorkspaceStore } from '../infrastructure/repositoryWorkspaceStore'
import { cleanupRepositoryWorkspace } from '../application/repositoryPreparationCleanup'
import type { FrozenRepositoryPreparationRef, RepositoryLaunchSource } from '../public/types'
import type {
  MaterializedSpace,
  WorkspaceCleanupReport,
  WorkspaceCleanupHookEvent,
} from '../infrastructure/workspaceMaterializer'

/** Root-only bridge. No Task rows, Task lease or autonomous worker are owned here. */
export function composeRepositoryPreparation(input: {
  db: ProviderNeutralDatabase
  appHome: string
  secretBox?: SecretBox | undefined
  workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
  cloneTimeoutMs?: number | undefined
}) {
  const journal = createRepositoryPreparationJournal(input.db)
  const driver = composeRepositoryPreparationParticipant({ journal })
  return {
    snapshot(request: {
      transaction: ProviderNeutralDatabase
      authority: RequestAuthority
      now: number
    }) {
      let active = true
      const scope = createRepositoryLaunchSnapshotInTx({
        ...request,
        assertLive: () => {
          if (!active) throw new Error('repository-launch-scope-ended')
        },
      })
      const inTx = createRepositoryPreparationJournal(request.transaction)
      return {
        participant: scope.participant,
        async source(selector: {
          cachedRepoId: string | null
          repoGroupId: string | null
          base: string
        }): Promise<RepositoryLaunchSource> {
          if (selector.repoGroupId !== null)
            return {
              kind: 'repository-group',
              group: await scope.currentGroup(selector.repoGroupId),
            }
          if (selector.cachedRepoId === null) throw new Error('repository-launch-source-missing')
          return {
            kind: 'repository',
            repository: await scope.currentRepository(selector.cachedRepoId),
            // Blank preserves the existing unspecified-ref behavior: resolve the
            // cache's default after fetch, then persist its concrete commit.
            base: selector.base,
          }
        },
        async plan(source: FrozenRepositoryPreparationRef) {
          if (!active) throw new Error('repository-launch-scope-ended')
          const operation = decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`)
          await inTx.plan({ id: operation, snapshotRef: source, now: request.now })
          return operation
        },
        close() {
          active = false
          scope.close()
        },
      }
    },
    async nextAttempt(request: {
      transaction: ProviderNeutralDatabase
      operationRef: string
      now: number
    }) {
      const inTx = createRepositoryPreparationJournal(request.transaction)
      const previous = await inTx.operation(request.operationRef)
      if (previous === null) throw new Error('repository-preparation-not-found')
      if (previous.state !== 'cleaned') return previous.id
      const operation = decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`)
      await inTx.plan({ id: operation, snapshotRef: previous.snapshotRef, now: request.now })
      return operation
    },
    async effect(request: {
      taskId: string
      operationRef: string
      workingBranch?: string
      gitCommitIdentity: GitCommitIdentity | null
      signal: AbortSignal
      assertCurrent(): Promise<void>
    }) {
      const operation = decodeRepositoryLaunchRef('operation', request.operationRef)
      const record = await journal.operation(operation)
      if (record === null)
        throw new NotFoundError(
          'repository-preparation-not-found',
          'preparation operation not found',
        )
      const source = decodeRepositoryLaunchRef('preparation', record.snapshotRef)
      const effects = createRepositoryPreparationEffects({
        taskId: request.taskId,
        appHome: input.appHome,
        repositoryWorkspace: composeRepositoryWorkspaceStore(input.db),
        ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
        ...(input.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: input.cloneTimeoutMs }),
        ...(request.workingBranch === undefined ? {} : { workingBranch: request.workingBranch }),
        gitCommitIdentity: request.gitCommitIdentity,
        signal: request.signal,
        ...(input.workspaceCleanupHook === undefined
          ? {}
          : { workspaceCleanupHook: input.workspaceCleanupHook }),
        assertCurrent: request.assertCurrent,
      })
      const scope = driver.bindEffect({ operation, source, effects })
      return {
        participant: driver.participant,
        capability: scope.capability,
        operation,
        source,
        async space(): Promise<MaterializedSpace> {
          await request.assertCurrent()
          const saved = await journal.operation(operation)
          if (saved === null) throw new Error('repository-preparation-result-missing')
          const raw = saved.state === 'prepared' ? saved.receiptJson : saved.diagnosticsJson
          const result = raw === null ? null : JSON.parse(raw)
          if (result?.space !== undefined) return result.space as MaterializedSpace
          if (result?.error !== undefined)
            throw new DomainError(
              result.error.code,
              result.error.message,
              result.error.status,
              result.error.details,
            )
          if (saved.state === 'stopped') throw new Error('repository preparation aborted')
          throw new Error('repository-preparation-result-unavailable')
        },
        async cleanup(): Promise<WorkspaceCleanupReport> {
          const result = await cleanupRepositoryWorkspace({
            operation,
            journal,
            effects,
            now: Date.now,
          })
          return (JSON.parse(result.receiptJson) as { report: WorkspaceCleanupReport }).report
        },
        close: scope.close,
      }
    },
  }
}
