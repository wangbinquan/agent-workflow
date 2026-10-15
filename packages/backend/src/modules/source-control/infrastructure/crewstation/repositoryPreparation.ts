import type { ProviderNeutralDatabase } from '@/db/query'
import type { SecretBox } from '@/auth/secretBox'
import { unsealRepoUrl } from '@/services/repoCredentials'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { RepositoryPreparationEffectFactory } from '../../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../../application/ports/scratchWorkspaceEffects'
import type {
  MaterializedSpace,
  ResolvedRepoSource,
  WorkspaceCleanupReport,
} from '../../application/workspaceMaterialization'
import { composeRepositoryWorkspaceStore } from '../repositoryWorkspaceStore'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'

function mapSpace<Value>(value: Value, path: (value: string) => string): Value {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return path(item)
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    return item
  }
  return visit(value) as Value
}

export function hostedSpace(taskId: string, space: MaterializedSpace): MaterializedSpace {
  return mapSpace(space, (path) =>
    path === '/work' || path.startsWith('/work/') ? hostedWorkspaceReference(taskId, path) : path,
  )
}

export function nativeSpace(space: MaterializedSpace): MaterializedSpace {
  return mapSpace(space, (path) =>
    path.startsWith('cs-workspace:') ? parseHostedWorkspaceReference(path).path : path,
  )
}

interface HostedPreparationPlan {
  readonly version: 1
  readonly taskId: string
  readonly source: ResolvedRepoSource
}

export function createHostedRepositoryPreparation(input: {
  readonly db: ProviderNeutralDatabase
  readonly secretBox: SecretBox
  readonly helper: WorkspaceHelper
  readonly recoverMaterialization: (
    taskId: string,
    operationId: string,
  ) => Promise<{ value: MaterializedSpace } | null>
}): RepositoryPreparationEffectFactory {
  const store = composeRepositoryWorkspaceStore(input.db)
  return {
    create(request) {
      const call = <T>(stage: string, operation: string, value: unknown) =>
        input.helper.call<T>(request.taskId, operation, value, {
          operationId: `${request.operationRef}:${stage}`,
          signal: request.signal,
          ...(request.cloneTimeoutMs === undefined ? {} : { timeoutMs: request.cloneTimeoutMs }),
        })
      return {
        assertCurrent: request.assertCurrent,
        async resolveCommits(facts) {
          await request.assertCurrent()
          if (request.signal.aborted)
            return { kind: 'stopped', receiptJson: JSON.stringify({ version: 1 }) }
          if (facts.layout.repos.length !== 1)
            throw new Error('hosted-capability-unavailable: repository groups require RFC-370 M2')
          const planned = facts.layout.repos[0]!
          const row = await store.findCachedRepoById(planned.cachedRepoId)
          if (row === null) throw new Error('cached-repo-not-found')
          const url = unsealRepoUrl(row, input.secretBox, store)
          if (url === null) throw new Error('cached-repo-credential-unavailable')
          const parsed = URL.canParse(url) ? new URL(url) : null
          if (
            parsed !== null &&
            (parsed.username !== '' ||
              parsed.password !== '' ||
              !['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol))
          ) {
            throw new Error('hosted-repository-requires-remote-url-and-platform-credentials')
          }
          if (parsed === null && !/^[^/@\s]+@[^/:\s]+:[^\s]+$/.test(url))
            throw new Error('hosted-repository-remote-url-required')
          const source = await call<ResolvedRepoSource>('resolve', 'resolve-repository', {
            id: row.id,
            url,
            ref: planned.ref || row.defaultBranch || undefined,
            timeoutMs: request.cloneTimeoutMs,
          })
          await request.assertCurrent()
          return {
            kind: 'resolved',
            planJson: JSON.stringify({
              version: 1,
              taskId: request.taskId,
              source,
            } satisfies HostedPreparationPlan),
          }
        },
        async materialize(materialization) {
          await request.assertCurrent()
          const plan = JSON.parse(materialization.planJson) as HostedPreparationPlan
          if (plan.version !== 1 || plan.taskId !== request.taskId)
            throw new Error('repository-preparation-replay-mismatch')
          const space = hostedSpace(
            request.taskId,
            await call<MaterializedSpace>('materialize', 'materialize-single', {
              taskId: request.taskId,
              source: plan.source,
              workingBranch: request.workingBranch,
              gitCommitIdentity: request.gitCommitIdentity,
            }),
          )
          await materialization.checkpoint(JSON.stringify({ version: 1, space }))
          await request.assertCurrent()
          if (space.earlyError !== null)
            return {
              kind: 'failed',
              safeCode: 'preparation-failed',
              diagnosticsJson: JSON.stringify({ version: 1, space }),
            }
          return { kind: 'prepared', receiptJson: JSON.stringify({ version: 1, space }) }
        },
        async cleanup(cleanup) {
          await request.assertCurrent()
          const evidence =
            cleanup.diagnosticsJson === null
              ? null
              : (JSON.parse(cleanup.diagnosticsJson) as { space?: MaterializedSpace })
          // A lost materialization response is not evidence of an empty
          // workspace. Replay its retained result before compensating it.
          const recovered =
            evidence?.space === undefined
              ? await input.recoverMaterialization(
                  request.taskId,
                  `${request.operationRef}:materialize`,
                )
              : null
          const space = evidence?.space ?? recovered?.value
          const report: WorkspaceCleanupReport =
            space === undefined
              ? { taskId: request.taskId, complete: true, failures: [] }
              : await input.helper.call(request.taskId, 'cleanup-space', nativeSpace(space), {
                  operationId: `${request.operationRef}:cleanup`,
                })
          return { complete: report.complete, receiptJson: JSON.stringify({ version: 1, report }) }
        },
      }
    },
  }
}

export function createHostedScratchWorkspaces(helper: WorkspaceHelper): ScratchWorkspaceEffects {
  return {
    async prepare(request) {
      await request.assertCurrent()
      const space = await helper.call<MaterializedSpace>(
        request.taskId,
        'scratch',
        {
          taskId: request.taskId,
          gitCommitIdentity: request.gitCommitIdentity,
        },
        { operationId: 'scratch-prepare', signal: request.signal },
      )
      await request.assertCurrent()
      return hostedSpace(request.taskId, space)
    },
    restore(taskId, space) {
      if (
        space.taskId !== taskId ||
        parseHostedWorkspaceReference(space.worktreePath).taskId !== taskId
      )
        throw new Error('scratch-preparation-artifact-mismatch')
      return space
    },
    async cleanup(request) {
      await request.assertCurrent()
      return helper.call(
        request.taskId,
        'cleanup-space',
        {
          taskId: request.taskId,
          cleanup: {
            taskId: request.taskId,
            ownedRoot: `/work/scratch/${request.taskId}`,
            worktrees: [],
            state: 'owned',
            report: null,
          },
        },
        { operationId: 'scratch-cleanup' },
      )
    },
  }
}
