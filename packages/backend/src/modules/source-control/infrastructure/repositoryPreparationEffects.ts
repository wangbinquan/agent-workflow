import {
  GitCommitIdentitySchema,
  PlannedDirectoryNodeSchema,
  PlannedRepoSchema,
} from '@agent-workflow/shared'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import { z } from 'zod'
import type { SecretBox } from '@/auth/secretBox'
import { DomainError, ConflictError } from '@/util/errors'
import { runGit, type WorktreeLifecycleHookEvent } from '@/util/git'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import type { RepositoryPreparationEffects } from '../application/ports/repositoryPreparationEffects'
import {
  cleanupMaterializedSpace,
  materializeSpaceWithProvider,
  resolveRepoSourceSingleWithProvider,
} from './workspaceMaterializer'
import { createJournaledWorktreeMaterializer } from './journaledWorktreeMaterializer'

const resolvedSourceSchema = z
  .object({
    repoPath: z.string(),
    baseBranch: z.string().optional(),
    resolvedCommit: z.string(),
    repoUrl: z.string().nullable(),
    cachedRepoId: z.string().nullable(),
    pathFetchError: z.string().nullable(),
    ffWarnings: z.array(z.object({ branch: z.string(), warning: z.string() }).strict()),
  })
  .strict()
export const RepositoryMaterializationPlanSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string(),
    appHome: z.string(),
    workingBranch: z.string().optional(),
    gitCommitIdentity: GitCommitIdentitySchema.nullable(),
    sources: z.array(resolvedSourceSchema).min(1),
    layout: z
      .object({ repos: z.array(PlannedRepoSchema), nodes: z.array(PlannedDirectoryNodeSchema) })
      .strict()
      .nullable(),
  })
  .strict()

/** Same Git mechanism as existing launches, with durable plan/checkpoint operands. */
export function createRepositoryPreparationEffects(input: {
  readonly taskId: string
  readonly appHome: string
  readonly repositoryWorkspace: RepositoryWorkspaceStore
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly workingBranch?: string
  readonly gitCommitIdentity: GitCommitIdentity | null
  readonly signal?: AbortSignal
  readonly worktreeLifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
  readonly assertCurrent: () => Promise<void>
}): RepositoryPreparationEffects {
  const dependencies = {
    appHome: input.appHome,
    repositoryWorkspace: input.repositoryWorkspace,
    ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
    ...(input.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: input.cloneTimeoutMs }),
    ...(input.signal === undefined ? {} : { sourceTerminationLaunchSignal: input.signal }),
    ...(input.worktreeLifecycleHook === undefined
      ? {}
      : { worktreeLifecycleHook: input.worktreeLifecycleHook }),
    loadFrozenSpaceLayout: async (): Promise<never> => {
      throw new Error('repository-preparation-unfrozen-layout')
    },
  }
  const stopped = (detail: unknown) => ({
    kind: 'stopped' as const,
    receiptJson: JSON.stringify({ version: 1, detail }),
  })
  const failure = (error: DomainError) => ({
    kind: 'failed' as const,
    safeCode: error.code.startsWith('cached-repo-')
      ? ('repository-unavailable' as const)
      : ('preparation-failed' as const),
    diagnosticsJson: JSON.stringify({
      version: 1,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        details: error.details,
      },
    }),
  })
  return {
    assertCurrent: input.assertCurrent,
    async resolveCommits(facts) {
      await input.assertCurrent()
      if (input.signal?.aborted) return stopped({ stage: 'before-resolution' })
      try {
        const sources = []
        for (const planned of facts.layout.repos) {
          const configuration = facts.repositories.find((row) => row.id === planned.cachedRepoId)
          if (configuration === undefined) throw new Error('repository-preparation-config-missing')
          const ref = planned.ref || configuration.defaultBranch || undefined
          const source = await resolveRepoSourceSingleWithProvider(
            { cachedRepoId: planned.cachedRepoId, ...(ref === undefined ? {} : { ref }) },
            {},
            dependencies,
          )
          const base = source.baseBranch ?? 'HEAD'
          const resolved = await runGit(
            source.repoPath,
            ['rev-parse', '--verify', `${base}^{commit}`, '--'],
            { signal: input.signal },
          )
          if (resolved.exitCode !== 0)
            throw new DomainError(
              'worktree-base-invalid',
              `cannot resolve base ref '${base}'`,
              422,
              { stderr: resolved.stderr.trim() },
            )
          sources.push({ ...source, resolvedCommit: resolved.stdout.trim() })
          await input.assertCurrent()
        }
        if (input.signal?.aborted) return stopped({ stage: 'after-resolution' })
        const plan = RepositoryMaterializationPlanSchema.parse({
          version: 1,
          taskId: input.taskId,
          appHome: input.appHome,
          ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
          gitCommitIdentity: input.gitCommitIdentity,
          sources,
          layout: facts.kind === 'repository-group' ? facts.layout : null,
        })
        return { kind: 'resolved', planJson: JSON.stringify(plan) }
      } catch (error) {
        if (input.signal?.aborted)
          return stopped({
            stage: 'resolution',
            message: error instanceof Error ? error.message : String(error),
          })
        if (error instanceof DomainError) return failure(error)
        throw error
      }
    },
    async materialize(request) {
      const plan = RepositoryMaterializationPlanSchema.parse(JSON.parse(request.planJson))
      if (plan.taskId !== input.taskId)
        throw new ConflictError(
          'repository-preparation-replay-mismatch',
          'preparation belongs to another task',
        )
      await input.assertCurrent()
      // Cancellation compensation consumes the same durable evidence in the
      // Task-owned stop adapter; a stopped attempt cannot create new worktrees.
      if (input.signal?.aborted)
        return stopped({ stage: 'before-materialization', evidenceJson: request.evidenceJson })
      let latestEvidenceJson = request.evidenceJson
      let checkpointError: unknown
      const worktreeMaterializer = createJournaledWorktreeMaterializer({
        evidenceJson: request.evidenceJson,
        assertCurrent: input.assertCurrent,
        async checkpoint(json) {
          try {
            await request.checkpoint(json)
            latestEvidenceJson = json
          } catch (error) {
            checkpointError = error
            throw error
          }
        },
      })
      try {
        const space = await materializeSpaceWithProvider(
          {
            cachedRepoId: plan.sources[0]!.cachedRepoId ?? '',
            ...(plan.workingBranch === undefined ? {} : { workingBranch: plan.workingBranch }),
          },
          {
            ...dependencies,
            appHome: plan.appHome,
            gitCommitIdentity: plan.gitCommitIdentity,
            preResolvedSources: plan.sources,
            frozenLayout: plan.layout,
            worktreeMaterializer,
          },
          plan.taskId,
        )
        await input.assertCurrent()
        if (input.signal?.aborted)
          return stopped({
            stage: 'after-materialization',
            evidenceJson: latestEvidenceJson,
            cleanup: await cleanupMaterializedSpace(space),
          })
        if (space.earlyError !== null)
          return {
            kind: 'failed',
            safeCode: 'preparation-failed',
            diagnosticsJson: JSON.stringify({ version: 1, space }),
          }
        return { kind: 'prepared', receiptJson: JSON.stringify({ version: 1, space }) }
      } catch (error) {
        if (error === checkpointError) throw error
        if (input.signal?.aborted)
          return stopped({
            stage: 'materialization',
            evidenceJson: latestEvidenceJson,
            message: error instanceof Error ? error.message : String(error),
          })
        if (error instanceof DomainError) return failure(error)
        throw error
      }
    },
  }
}
