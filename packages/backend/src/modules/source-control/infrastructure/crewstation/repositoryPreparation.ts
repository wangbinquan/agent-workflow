import type { ProviderNeutralDatabase } from '@/db/query'
import type { SecretBox } from '@/auth/secretBox'
import { unsealRepoUrl } from '@/services/repoCredentials'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { RepositoryPreparationEffectFactory } from '../../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../../application/ports/scratchWorkspaceEffects'
import type { RepositoryPreparationFacts } from '../../domain/repositoryPreparationFacts'
import type {
  MaterializedSpace,
  ResolvedRepoSource,
  WorkspaceCleanupReport,
} from '../../application/workspaceMaterialization'
import { composeRepositoryWorkspaceStore } from '../repositoryWorkspaceStore'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { assertHostedRepositoryUrl } from './repositoryUrl'

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

interface HostedSinglePreparationPlan {
  readonly version: 1
  readonly taskId: string
  readonly source: ResolvedRepoSource
}
interface HostedGroupPreparationPlan {
  readonly version: 2
  readonly taskId: string
  readonly kind: RepositoryPreparationFacts['kind']
  readonly sources: readonly ResolvedRepoSource[]
  readonly layout: RepositoryPreparationFacts['layout']
}
type HostedPreparationPlan = HostedSinglePreparationPlan | HostedGroupPreparationPlan

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
          if (facts.layout.repos.length === 0) throw new Error('hosted-repository-layout-empty')
          const sources: ResolvedRepoSource[] = []
          for (const [index, planned] of facts.layout.repos.entries()) {
            await request.assertCurrent()
            if (request.signal.aborted)
              return { kind: 'stopped', receiptJson: JSON.stringify({ version: 1 }) }
            const row = await store.findCachedRepoById(planned.cachedRepoId)
            if (row === null) throw new Error('cached-repo-not-found')
            const url = unsealRepoUrl(row, input.secretBox, store)
            if (url === null) throw new Error('cached-repo-credential-unavailable')
            assertHostedRepositoryUrl(url)
            const source = await call<ResolvedRepoSource>(
              index === 0 ? 'resolve' : `resolve:${index}`,
              'resolve-repository',
              {
                id: row.id,
                url,
                ref: planned.ref || row.defaultBranch || undefined,
                timeoutMs: request.cloneTimeoutMs,
              },
            )
            sources.push(source)
          }
          await request.assertCurrent()
          return {
            kind: 'resolved',
            planJson: JSON.stringify({
              version: 2,
              taskId: request.taskId,
              kind: facts.kind,
              sources,
              layout: facts.layout,
            } satisfies HostedPreparationPlan),
          }
        },
        async materialize(materialization) {
          await request.assertCurrent()
          const plan = JSON.parse(materialization.planJson) as HostedPreparationPlan
          if ((plan.version !== 1 && plan.version !== 2) || plan.taskId !== request.taskId)
            throw new Error('repository-preparation-replay-mismatch')
          const single =
            plan.version === 1 || (plan.kind === 'repository' && plan.sources.length === 1)
          const physical = single
            ? {
                taskId: request.taskId,
                source: plan.version === 1 ? plan.source : plan.sources[0]!,
                workingBranch: request.workingBranch,
                gitCommitIdentity: request.gitCommitIdentity,
              }
            : {
                taskId: request.taskId,
                planned: plan.layout.repos,
                nodePaths: plan.layout.nodes.map((node) => node.path),
                resolvedSources: plan.sources,
                workingBranch: request.workingBranch,
                gitUserName: request.gitCommitIdentity?.name ?? null,
                gitUserEmail: request.gitCommitIdentity?.email ?? null,
              }
          const space = hostedSpace(
            request.taskId,
            await call<MaterializedSpace>(
              'materialize',
              single ? 'materialize-single' : 'materialize-group',
              physical,
            ),
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

export function createHostedScratchWorkspaces(
  helper: WorkspaceHelper,
  workspaces: Pick<HostedTaskWorkspaces, 'abandon'>,
): ScratchWorkspaceEffects {
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
    // An unadmitted scratch space lives only in its own Task's volume, which
    // `releaseUnadmitted` gives back with the parent. Cleaning it first used
    // to wake (or wait up to five minutes for) that parent just to delete
    // files on a volume about to go (RFC-370 hosted acceptance, 2026-10-19).
    async cleanup(request) {
      await request.assertCurrent()
      return { taskId: request.taskId, complete: true, failures: [] }
    },
    async releaseUnadmitted(taskId) {
      await workspaces.abandon(taskId)
    },
  }
}
