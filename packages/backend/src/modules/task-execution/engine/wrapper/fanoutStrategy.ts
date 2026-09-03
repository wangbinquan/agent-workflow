import {
  deriveWrapperFanoutOutputsInScope,
  FANOUT_DONE_PORT_NAME,
  findFanoutAggregatorInScope,
  resolveKeyOf,
  splitPortItems,
  tryParseKind,
  type Agent,
  type ParsedKind,
  type WrapperFanoutPort,
} from '@agent-workflow/shared'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '../../domain/fanoutScope'
import type { FanoutAttemptPort, FanoutShardSpec } from '../../application/ports/fanoutAttempt'
import type { WrapperDataPort } from '../../application/ports/wrapperData'
import { decodeWrapperProgress } from '../../domain/wrapperProgress'
import type {
  OpenWrapperGeneration,
  WrapperExecutionRequest,
  WrapperPreparation,
  WrapperSettlement,
  WrapperStrategy,
} from '../../domain/wrapperExecution'
import { wrapperSettlement } from './strategySupport'

interface PreparedFanoutWrapper {
  readonly shardPort: WrapperFanoutPort
  readonly itemKind: ParsedKind
  readonly innerIds: readonly string[]
  readonly agentsMap: ReadonlyMap<string, Agent>
  readonly agentFailures: ReadonlyMap<
    string,
    { readonly summary: string; readonly message: string }
  >
}

/** Owns fanout hydration, scope, shard identity, attempt orchestration and projection. */
export class FanoutStrategy implements WrapperStrategy<'wrapper-fanout'> {
  readonly kind = 'wrapper-fanout' as const

  constructor(
    private readonly data: WrapperDataPort,
    private readonly attempts: FanoutAttemptPort,
  ) {}

  async prepare(
    request: WrapperExecutionRequest<'wrapper-fanout'>,
  ): Promise<WrapperPreparation<'wrapper-fanout'>> {
    const { node, scope } = request
    const record = node as Record<string, unknown>
    const inputs = Array.isArray(record.inputs) ? (record.inputs as WrapperFanoutPort[]) : []
    const shardPort = inputs.find((port) => port?.isShardSource === true)
    if (shardPort === undefined) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} missing shardSource input`,
          message: 'wrapper-fanout-shard-source-missing',
        },
      }
    }
    const parsedKind = tryParseKind(shardPort.kind)
    if (parsedKind === null || parsedKind.kind !== 'list') {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} shardSource port '${shardPort.name}' kind '${shardPort.kind}' must be list<T>`,
          message: 'wrapper-fanout-shard-source-not-list',
        },
      }
    }
    if (scope.directNodeIds.length === 0) {
      return {
        kind: 'rejected',
        outcome: {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} has no inner nodes`,
          message: 'wrapper-empty',
        },
      }
    }

    const agentsMap = new Map<string, Agent>()
    const agentFailures = new Map<string, { readonly summary: string; readonly message: string }>()
    for (const innerId of scope.directNodeIds) {
      const inner = this.data.definition.nodes.find((candidate) => candidate.id === innerId)
      if (inner === undefined) continue
      const key = this.data.fanoutAgentKey(inner)
      if (key === null || agentsMap.has(key) || agentFailures.has(key)) continue
      const resolution = await this.data.resolveFanoutAgent(inner)
      if (resolution.kind === 'ok') agentsMap.set(key, resolution.agent)
      if (resolution.kind === 'failed') agentFailures.set(key, resolution)
    }

    const prepared: PreparedFanoutWrapper = {
      shardPort,
      itemKind: parsedKind.item,
      innerIds: scope.directNodeIds,
      agentsMap,
      agentFailures,
    }
    return {
      kind: 'ready',
      execute: (generation) => this.executePrepared(request, generation, prepared),
    }
  }

  private async executePrepared(
    request: WrapperExecutionRequest<'wrapper-fanout'>,
    generation: OpenWrapperGeneration<'wrapper-fanout'>,
    prepared: PreparedFanoutWrapper,
  ): Promise<WrapperSettlement> {
    const { node, iteration } = request
    const { definition } = this.data
    const { shardPort, itemKind, innerIds, agentsMap, agentFailures } = prepared
    const wrapperRunId = generation.runId
    // RFC-354: the wrapper's own inputs are read in the frame the wrapper node
    // lives in (its parameters, resolved from outside the body).
    const { inputs: upstreamInputs, consumed: wrapperConsumed } = await this.data.resolveInputs(
      node.id,
      { containerRunId: request.containerRunId, iteration },
    )
    const rawContent = upstreamInputs[shardPort.name] ?? ''

    let reuseDisabled = false
    let priorConsumedRaw: string | null
    if (generation.previous !== null) {
      priorConsumedRaw = generation.previous.consumedUpstreamRunsJson
      const persisted = decodeWrapperProgress(generation.previous.wrapperProgressJson, (message) =>
        this.data.reportDiagnostic({
          level: 'warn',
          message,
          fields: { taskId: request.task.taskId, nodeId: node.id },
        }),
      )
      if (persisted?.reuseDisabled === true) reuseDisabled = true
    } else {
      priorConsumedRaw = await this.data.priorFanoutConsumed(node.id, iteration, wrapperRunId)
    }
    if (
      priorConsumedRaw !== null &&
      !this.data.consumedProvenanceMatches(priorConsumedRaw, wrapperConsumed)
    ) {
      reuseDisabled = true
    }
    if (reuseDisabled) {
      await this.data.persistProgress(wrapperRunId, {
        kind: 'fanout',
        phase: 'inner-running',
        reuseDisabled: true,
      })
    }
    this.data.recordConsumed(wrapperRunId, wrapperConsumed)

    const derivedOutputs = deriveWrapperFanoutOutputsInScope(
      definition,
      request.scope.directNodeIds,
      agentsMap,
    )
    const items = splitPortItems(itemKind, rawContent)
    if (items.length === 0) {
      for (const port of derivedOutputs) {
        await this.data.upsertOutput({ runId: wrapperRunId, portName: port.name, content: '' })
      }
      return wrapperSettlement('done', {
        kind: 'ok',
        summary: '',
        message: 'wrapper-fanout-empty',
      })
    }

    const projectedTotal = estimateShardTotal(definition, request.scope, items.length)
    if (projectedTotal > this.data.fanoutMaxShardTotal) {
      return wrapperSettlement(
        'failed',
        {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} would mint ${projectedTotal} shards > limit ${this.data.fanoutMaxShardTotal}`,
          message: `wrapper-fanout-cartesian-exceeds-max:${projectedTotal}`,
        },
        `cartesian-exceeds-max:${projectedTotal}>${this.data.fanoutMaxShardTotal}`,
      )
    }

    let shardScope = computeShardScope({
      scope: request.scope,
      defn: definition,
      agents: agentsMap,
    })
    shardScope = applyAutoPromote(shardScope, definition)
    const keyOf = resolveKeyOf(itemKind)
    const seenShardKeys = new Set<string>()
    const shards: FanoutShardSpec[] = items.map((value, index) => {
      let shardKey = keyOf(value, index, itemKind)
      if (seenShardKeys.has(shardKey)) shardKey = `${shardKey}#${index}`
      seenShardKeys.add(shardKey)
      return { shardKey, value }
    })

    for (const innerId of innerIds) {
      const inner = definition.nodes.find((candidate) => candidate.id === innerId)
      if (inner === undefined) {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper-fanout ${node.id} inner node '${innerId}' not found in definition`,
            message: `wrapper-fanout-inner-missing:${innerId}`,
          },
          `inner-missing:${innerId}`,
        )
      }
      if (innerId === shardScope.aggregatorId) continue
      if (inner.kind !== 'agent-single') {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper-fanout ${node.id} inner '${innerId}' kind '${inner.kind}' — v1 supports agent-single only inside wrapper-fanout (PR-D2 will extend support)`,
            message: `wrapper-fanout-v1-unsupported-inner-kind:${inner.kind}`,
          },
          `v1-unsupported-inner-kind:${inner.kind}`,
        )
      }

      const innerRecord = inner as Record<string, unknown>
      const innerAgentName =
        typeof innerRecord.agentName === 'string' ? innerRecord.agentName : `node:${innerId}`
      const innerAgentId = this.data.fanoutAgentKey(inner)
      if (innerAgentId === null) {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper-fanout ${node.id} inner '${innerId}' missing canonical agentId`,
            message: 'wrapper-fanout-inner-missing-agent-id',
          },
          `inner-missing-agentId:${innerId}`,
        )
      }
      const innerAgent = agentsMap.get(innerAgentId)
      if (innerAgent === undefined) {
        const failure = agentFailures.get(innerAgentId)
        if (failure !== undefined) {
          return wrapperSettlement(
            'failed',
            { kind: 'failed', summary: failure.summary, message: failure.message },
            `inner-agent-resolution-failed:${failure.message}`,
          )
        }
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: `wrapper-fanout ${node.id} inner agent '${innerAgentName}' not found`,
            message: `agent-not-found:${innerAgentName}`,
          },
          `inner-agent-missing:${innerAgentName}`,
        )
      }

      const boundaryEdges = findBoundaryEdgesToInner(definition, node.id, innerId)
      // RFC-354: the body node's own inbound edges are read in THIS generation's frame.
      const { inputs: innerUpstream } = await this.data.resolveInputs(innerId, {
        containerRunId: wrapperRunId,
        iteration,
      })
      for (const edge of boundaryEdges) {
        if (edge.source.portName === shardPort.name) continue
        const value = upstreamInputs[edge.source.portName] ?? ''
        const prior = innerUpstream[edge.target.portName]
        innerUpstream[edge.target.portName] =
          prior === undefined ? value : `${prior}\n\n---\n\n${value}`
      }

      if (shardScope.perShard.has(innerId)) {
        const results = await Promise.all(
          shards.map((shard) =>
            this.attempts.dispatchShard({
              wrapperId: node.id,
              wrapperRunId,
              innerNode: inner,
              innerAgent,
              iteration,
              shard,
              shardSourcePortName: shardPort.name,
              boundaryEdges,
              broadcastInputs: innerUpstream,
              reuseDisabled,
            }),
          ),
        )
        if (
          results.some((result) => result.kind === 'canceled') ||
          request.execution.signal?.aborted === true
        ) {
          return wrapperSettlement('canceled', {
            kind: 'canceled',
            summary: `wrapper-fanout ${node.id} canceled`,
            message: 'canceled',
          })
        }
        const failed = results.filter((result) => result.kind === 'failed')
        if (failed.length > 0) {
          const message = failed.map((result) => `${result.shardKey}:${result.message}`).join(' | ')
          return wrapperSettlement(
            'failed',
            {
              kind: 'failed',
              summary: `wrapper-fanout ${node.id} inner '${innerId}' ${failed.length}/${shards.length} shards failed`,
              message,
            },
            `inner-shard-failed:${message}`,
          )
        }
      } else {
        const result = await this.attempts.dispatchShard({
          wrapperId: node.id,
          wrapperRunId,
          innerNode: inner,
          innerAgent,
          iteration,
          shard: null,
          shardSourcePortName: shardPort.name,
          boundaryEdges,
          broadcastInputs: innerUpstream,
          reuseDisabled,
        })
        if (result.kind === 'canceled' || request.execution.signal?.aborted === true) {
          return wrapperSettlement('canceled', {
            kind: 'canceled',
            summary: `wrapper-fanout ${node.id} canceled`,
            message: 'canceled',
          })
        }
        if (result.kind === 'failed') {
          return wrapperSettlement(
            'failed',
            {
              kind: 'failed',
              summary: `wrapper-fanout ${node.id} inner shared '${innerId}' failed`,
              message: result.message,
            },
            `inner-shared-failed:${result.message}`,
          )
        }
      }
    }

    if (shardScope.aggregatorId !== null) {
      const aggregatorNode = definition.nodes.find(
        (candidate) => candidate.id === shardScope.aggregatorId,
      )
      const aggregatorKey =
        aggregatorNode === undefined ? null : this.data.fanoutAgentKey(aggregatorNode)
      const aggregatorFailure =
        aggregatorKey === null ? undefined : agentFailures.get(aggregatorKey)
      if (aggregatorFailure !== undefined) {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: aggregatorFailure.summary,
            message: aggregatorFailure.message,
          },
          `aggregator-resolution-failed:${aggregatorFailure.message}`,
        )
      }
      const aggregator = findFanoutAggregatorInScope(
        definition,
        request.scope.directNodeIds,
        agentsMap,
      )
      if (aggregator === null) {
        return wrapperSettlement(
          'failed',
          {
            kind: 'failed',
            summary: 'aggregator agent resolution failed',
            message: 'aggregator-resolve-failed',
          },
          'aggregator-resolve-failed',
        )
      }
      const result = await this.attempts.dispatchAggregator({
        wrapperId: node.id,
        wrapperRunId,
        node: aggregator.node,
        agent: aggregator.agent,
        iteration,
        shards,
        definition,
        scope: shardScope,
        reuseDisabled,
      })
      if (result.kind === 'failed') {
        return wrapperSettlement('failed', result, `aggregator-failed:${result.message}`)
      }
      const renames = aggregator.agent.outputWrapperPortNames ?? {}
      for (const port of aggregator.agent.outputs) {
        const outletName = renames[port] ?? port
        const content = result.outputs[port] ?? ''
        const row =
          result.aggRunId === undefined ? null : await this.data.outputOf(result.aggRunId, port)
        await this.data.upsertOutput({
          runId: wrapperRunId,
          portName: outletName,
          content,
          kind: row?.kind ?? null,
          archiveJson: row !== null && row.content === content ? row.archiveJson : null,
          active: row?.active !== false,
        })
      }
    } else {
      await this.data.upsertOutput({
        runId: wrapperRunId,
        portName: FANOUT_DONE_PORT_NAME,
        content: '',
      })
    }

    this.data.reportDiagnostic({
      level: 'info',
      message: 'wrapper-fanout done',
      fields: {
        taskId: request.task.taskId,
        nodeId: node.id,
        shards: shards.length,
        hasAggregator: shardScope.aggregatorId !== null,
      },
    })
    return wrapperSettlement('done', { kind: 'ok', summary: '', message: '' })
  }
}
