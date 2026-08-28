import { readContinueOnMaxIterations } from '@agent-workflow/shared'
import { evaluateExitCondition, parseExitCondition } from '../../domain/loopExitCondition'
import type { WrapperDataPort } from '../../application/ports/wrapperData'
import type { WrapperScopeDriverPort } from '../../application/ports/wrapperScopeDriver'
import type {
  WrapperWorkspacePort,
  WrapperWorkspaceScene,
} from '../../application/ports/wrapperWorkspace'
import { decodeWrapperProgress } from '../../domain/wrapperProgress'
import type {
  OpenWrapperGeneration,
  WrapperExecutionRequest,
  WrapperPreparation,
  WrapperSettlement,
  WrapperStrategy,
} from '../../domain/wrapperExecution'
import {
  readWrapperOutputBindings,
  wrapperSettlement,
  type WrapperOutputBinding,
} from './strategySupport'

type LoopCompletionReason = 'exit-condition' | 'max-iterations-continued'

function pickNumber(node: Record<string, unknown>, key: string): number | undefined {
  const value = node[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Owns loop iteration, resume, exit, output promotion and exhaustion policy. */
export class LoopStrategy implements WrapperStrategy<'wrapper-loop'> {
  readonly kind = 'wrapper-loop' as const

  constructor(
    private readonly data: WrapperDataPort,
    private readonly scopeDriver: WrapperScopeDriverPort,
    private readonly workspace: WrapperWorkspacePort,
  ) {}

  async prepare(
    request: WrapperExecutionRequest<'wrapper-loop'>,
  ): Promise<WrapperPreparation<'wrapper-loop'>> {
    const { node, scope } = request
    if (scope.directNodeIds.length === 0) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-loop ${node.id} has no inner nodes`,
          message: 'wrapper-empty',
        },
      }
    }
    const record = node as Record<string, unknown>
    const maxIterations = pickNumber(record, 'maxIterations')
    if (maxIterations === undefined || maxIterations < 1) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-loop ${node.id} missing maxIterations`,
          message: 'wrapper-loop-max-iterations',
        },
      }
    }
    const continueOnMaxIterations = readContinueOnMaxIterations(node)
    if (continueOnMaxIterations === null) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-loop ${node.id} continueOnMaxIterations must be a boolean`,
          message: 'wrapper-loop-continue-on-max-iterations',
        },
      }
    }
    const exitCondition = parseExitCondition(record.exitCondition)
    if (exitCondition === null) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-loop ${node.id} invalid exitCondition`,
          message: 'wrapper-loop-exit-condition',
        },
      }
    }
    const bindings = readWrapperOutputBindings(node, 'outputBindings')
    return {
      kind: 'ready',
      execute: (generation) =>
        this.executePrepared(request, generation, {
          maxIterations,
          continueOnMaxIterations,
          exitCondition,
          bindings,
        }),
    }
  }

  private async complete(input: {
    readonly request: WrapperExecutionRequest<'wrapper-loop'>
    readonly generation: OpenWrapperGeneration<'wrapper-loop'>
    readonly workspace: WrapperWorkspaceScene
    readonly bindings: readonly WrapperOutputBinding[]
    readonly iteration: number
    readonly maxIterations: number
    readonly reason: LoopCompletionReason
  }): Promise<WrapperSettlement> {
    const { request, generation, workspace, bindings, iteration, maxIterations, reason } = input
    for (const binding of bindings) {
      const value = await this.data.readPort(binding.bind.nodeId, binding.bind.portName, iteration)
      await this.data.upsertOutput({
        runId: generation.runId,
        portName: binding.name,
        content: value.content,
        kind: value.kind,
        archiveJson: value.archiveJson,
        active: value.active,
      })
    }

    if (!workspace.passthrough) {
      const merge = await this.workspace.merge({
        scene: workspace,
        runId: generation.runId,
        node: request.node,
        iteration,
      })
      if (merge.kind === 'conflict-human') {
        return wrapperSettlement('awaiting_human', {
          kind: 'awaiting_human',
          summary: `loop merge conflict: ${merge.detail}`,
          message: 'merge-conflict',
        })
      }
      if (merge.kind === 'merge-failed') {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `loop merge-back failed: ${merge.message}`,
            message: 'wrapper-merge-failed',
          },
          `wrapper-merge-failed:${merge.message}`,
        )
      }
    }

    if (reason === 'max-iterations-continued') {
      this.data.reportDiagnostic({
        level: 'warn',
        message: 'wrapper-loop reached max iterations and continued by policy',
        fields: {
          code: 'wrapper-loop-max-iterations-continued',
          taskId: request.task.taskId,
          nodeId: request.node.id,
          wrapperRunId: generation.runId,
          iteration,
          maxIterations,
        },
      })
    }
    return wrapperSettlement('done', { kind: 'ok', summary: '', message: '' })
  }

  private async executePrepared(
    request: WrapperExecutionRequest<'wrapper-loop'>,
    generation: OpenWrapperGeneration<'wrapper-loop'>,
    prepared: {
      readonly maxIterations: number
      readonly continueOnMaxIterations: boolean
      readonly exitCondition: NonNullable<ReturnType<typeof parseExitCondition>>
      readonly bindings: readonly WrapperOutputBinding[]
    },
  ): Promise<WrapperSettlement> {
    const { node, scope } = request
    let startIteration = 0
    if (generation.previous !== null) {
      const progress = decodeWrapperProgress(generation.previous.wrapperProgressJson, (message) =>
        this.data.reportDiagnostic({ level: 'warn', message }),
      )
      if (progress?.kind === 'loop' && typeof progress.iteration === 'number') {
        startIteration = progress.iteration
      }
    }

    const scene = await this.workspace.open(generation)
    for (let iteration = startIteration; iteration < prepared.maxIterations; iteration++) {
      await this.data.persistProgress(generation.runId, {
        kind: 'loop',
        iteration,
        phase: 'inner-running',
      })
      const result = await this.scopeDriver.drive({ scope, iteration, workspace: scene })
      if (result.kind === 'canceled') {
        return wrapperSettlement('canceled', {
          kind: 'canceled',
          summary: result.detail?.summary ?? 'canceled',
          message: '',
        })
      }
      if (result.kind === 'failed') {
        const message = result.detail?.message ?? 'inner failed'
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: result.detail?.summary ?? `wrapper-loop ${node.id} inner failed`,
            message,
          },
          message,
        )
      }
      if (result.kind === 'awaiting_human' || result.kind === 'awaiting_review') {
        await this.data.persistProgress(generation.runId, {
          kind: 'loop',
          iteration,
          phase: 'awaiting',
        })
        return wrapperSettlement(result.kind, {
          kind: result.kind,
          summary: result.detail?.summary ?? '',
          message: result.detail?.message ?? '',
        })
      }

      await this.data.persistProgress(generation.runId, {
        kind: 'loop',
        iteration,
        phase: 'iter-done',
      })
      const port = await this.data.readPort(
        prepared.exitCondition.nodeId,
        prepared.exitCondition.portName,
        iteration,
      )
      if (
        evaluateExitCondition(prepared.exitCondition, {
          content: port.content,
          active: port.active,
        })
      ) {
        return this.complete({
          request,
          generation,
          workspace: scene,
          bindings: prepared.bindings,
          iteration,
          maxIterations: prepared.maxIterations,
          reason: 'exit-condition',
        })
      }
    }

    if (prepared.continueOnMaxIterations) {
      return this.complete({
        request,
        generation,
        workspace: scene,
        bindings: prepared.bindings,
        iteration: prepared.maxIterations - 1,
        maxIterations: prepared.maxIterations,
        reason: 'max-iterations-continued',
      })
    }

    return wrapperSettlement(
      'exhausted',
      {
        kind: 'failed',
        summary: `wrapper-loop ${node.id} exhausted after ${prepared.maxIterations} iterations`,
        message: 'wrapper-loop-exhausted',
      },
      'max iterations reached',
    )
  }
}
