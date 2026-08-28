import type { WrapperDataPort } from '../../application/ports/wrapperData'
import type { WrapperScopeDriverPort } from '../../application/ports/wrapperScopeDriver'
import type { WrapperWorkspacePort } from '../../application/ports/wrapperWorkspace'
import { decodeWrapperProgress } from '../../domain/wrapperProgress'
import type {
  OpenWrapperGeneration,
  WrapperExecutionRequest,
  WrapperPreparation,
  WrapperSettlement,
  WrapperStrategy,
} from '../../domain/wrapperExecution'
import { wrapperSettlement } from './strategySupport'

/** Owns Git-wrapper progress compatibility, diff projection and merge disposition. */
export class GitStrategy implements WrapperStrategy<'wrapper-git'> {
  readonly kind = 'wrapper-git' as const

  constructor(
    private readonly data: WrapperDataPort,
    private readonly scopeDriver: WrapperScopeDriverPort,
    private readonly workspace: WrapperWorkspacePort,
  ) {}

  async prepare(
    request: WrapperExecutionRequest<'wrapper-git'>,
  ): Promise<WrapperPreparation<'wrapper-git'>> {
    if (request.scope.directNodeIds.length === 0) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-git ${request.node.id} has no inner nodes`,
          message: 'wrapper-empty',
        },
      }
    }
    return {
      kind: 'ready',
      execute: (generation) => this.executePrepared(request, generation),
    }
  }

  private async executePrepared(
    request: WrapperExecutionRequest<'wrapper-git'>,
    generation: OpenWrapperGeneration<'wrapper-git'>,
  ): Promise<WrapperSettlement> {
    const { node, iteration, scope } = request
    const existing = generation.previous
    let baseline: string | undefined
    let preDirty: Record<string, string> = {}
    let baselines: Record<string, string> = {}
    let preDirtyByRepo: Record<string, Record<string, string>> = {}

    const freshGeneration =
      existing !== null &&
      (existing.mergeState === 'merged' ||
        (existing.mergeState === 'isolating' &&
          existing.isoBaseSnapshot === null &&
          existing.isoBaseSnapshotReposJson === null))
    if (existing !== null) {
      const progress = decodeWrapperProgress(existing.wrapperProgressJson, (message) =>
        this.data.reportDiagnostic({ level: 'warn', message }),
      )
      if (!freshGeneration && progress?.kind === 'git' && typeof progress.baseline === 'string') {
        baseline = progress.baseline
        preDirty = progress.preDirty ?? {}
        baselines = progress.baselines ?? { '': progress.baseline }
        preDirtyByRepo = progress.preDirtyByRepo ?? { '': preDirty }
      }
    }

    const scene = await this.workspace.open(generation)
    if (baseline === undefined) {
      const generationStart =
        existing === null || freshGeneration || existing.wrapperProgressJson === null
      const entry = await this.workspace.captureGitEntry(scene, generationStart)
      baselines = { ...entry.baselines }
      preDirtyByRepo = Object.fromEntries(
        Object.entries(entry.preDirtyByRepo).map(([mountPath, paths]) => [mountPath, { ...paths }]),
      )
      baseline = baselines[entry.primaryMount] ?? ''
      preDirty = preDirtyByRepo[entry.primaryMount] ?? {}
      if (generationStart) {
        await this.data.persistProgress(generation.runId, {
          kind: 'git',
          baseline,
          preDirty,
          baselines,
          preDirtyByRepo,
          phase: 'inner-running',
        })
      }
    }

    const result = await this.scopeDriver.drive({ scope, iteration, workspace: scene })
    if (result.kind === 'canceled') {
      return wrapperSettlement('canceled', {
        kind: 'canceled',
        summary: 'inner canceled',
        message: '',
      })
    }
    if (result.kind === 'failed') {
      const message = result.detail?.message ?? 'inner failed'
      return wrapperSettlement(
        'failed',
        {
          kind: 'failed',
          summary: result.detail?.summary ?? `wrapper-git ${node.id} inner failed`,
          message,
        },
        message,
      )
    }
    if (result.kind === 'awaiting_human' || result.kind === 'awaiting_review') {
      await this.data.persistProgress(generation.runId, {
        kind: 'git',
        baseline,
        preDirty,
        phase: 'awaiting',
      })
      return wrapperSettlement(result.kind, {
        kind: result.kind,
        summary: result.detail?.summary ?? '',
        message: result.detail?.message ?? '',
      })
    }

    let paths: readonly string[]
    try {
      paths = await this.workspace.changedFiles(scene, baselines, preDirtyByRepo)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return wrapperSettlement(
        'failed',
        {
          kind: 'failed',
          summary: `git diff failed: ${message}`,
          message: 'git-diff-failed',
        },
        `git-diff-failed:${message}`,
      )
    }
    await this.data.upsertOutput({
      runId: generation.runId,
      portName: 'git_diff',
      content: paths.join('\n'),
    })

    if (!scene.passthrough) {
      const merge = await this.workspace.merge({
        scene,
        runId: generation.runId,
        node,
        iteration,
      })
      if (merge.kind === 'conflict-human') {
        return wrapperSettlement('awaiting_human', {
          kind: 'awaiting_human',
          summary: `wrapper merge conflict: ${merge.detail}`,
          message: 'merge-conflict',
        })
      }
      if (merge.kind === 'merge-failed') {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper merge-back failed: ${merge.message}`,
            message: 'wrapper-merge-failed',
          },
          `wrapper-merge-failed:${merge.message}`,
        )
      }
    }
    return wrapperSettlement('done', { kind: 'ok', summary: '', message: '' })
  }
}
