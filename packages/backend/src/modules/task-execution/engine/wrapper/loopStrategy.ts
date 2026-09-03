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
  wrapperOutputBindings,
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
    // RFC-354 (schema v6): returns are the loop's `wrapper-output` edges. A
    // return can only hand out what the body produced: a source outside the
    // direct members is the validator's `wrapper-loop-output-binding-out-of-scope`
    // shape, which an old snapshot may still carry — fail closed instead of
    // reading a value the loop never computed (a false exit on round 1).
    const bindings = wrapperOutputBindings(this.data.definition, node.id)
    const foreign = bindings.find((binding) => !scope.directNodeIds.includes(binding.bind.nodeId))
    if (foreign !== undefined) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-loop ${node.id} return port '${foreign.name}' reads '${foreign.bind.nodeId}.${foreign.bind.portName}', which is not a direct member of the loop body`,
          message: 'wrapper-loop-return-source-out-of-scope',
        },
      }
    }
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

  /**
   * RFC-354 (design D3): at the end of EVERY round the loop first promotes its
   * return values — each `wrapper-output` edge's body port, read in this
   * generation's frame at this round — onto the generation row, and only then
   * evaluates the exit predicate against its OWN return port. The promoted
   * values of the round the loop leaves on are what downstream reads.
   */
  private async promoteReturns(
    generation: OpenWrapperGeneration<'wrapper-loop'>,
    bindings: readonly WrapperOutputBinding[],
    iteration: number,
  ): Promise<ReadonlyMap<string, { content: string; active: boolean }>> {
    const promoted = new Map<string, { content: string; active: boolean }>()
    for (const binding of bindings) {
      const value = await this.data.readPort(binding.bind.nodeId, binding.bind.portName, {
        containerRunId: generation.runId,
        iteration,
      })
      await this.data.upsertOutput({
        runId: generation.runId,
        portName: binding.name,
        content: value.content,
        kind: value.kind,
        archiveJson: value.archiveJson,
        active: value.active,
      })
      promoted.set(binding.name, { content: value.content, active: value.active })
    }
    return promoted
  }

  private async complete(input: {
    readonly request: WrapperExecutionRequest<'wrapper-loop'>
    readonly generation: OpenWrapperGeneration<'wrapper-loop'>
    readonly workspace: WrapperWorkspaceScene
    readonly iteration: number
    readonly maxIterations: number
    readonly reason: LoopCompletionReason
  }): Promise<WrapperSettlement> {
    const { request, generation, workspace, iteration, maxIterations, reason } = input

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
      // RFC-354: the body runs in the frame of THIS generation row; a nested
      // loop re-entered on our next round opens a fresh generation of its own.
      const result = await this.scopeDriver.drive({
        scope,
        containerRunId: generation.runId,
        iteration,
        workspace: scene,
      })
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
      // RFC-354: promote this round's return values, then decide on the loop's
      // OWN return port (the v5 body-port read through the wall is gone).
      const promoted = await this.promoteReturns(generation, prepared.bindings, iteration)
      const port = promoted.get(prepared.exitCondition.portName)
      if (port === undefined) {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper-loop ${node.id} exitCondition reads return port '${prepared.exitCondition.portName}', which no wrapper-output edge declares`,
            message: 'wrapper-loop-exit-port-missing',
          },
          'wrapper-loop-exit-port-missing',
        )
      }
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
