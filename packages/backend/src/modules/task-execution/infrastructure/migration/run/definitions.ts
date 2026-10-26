import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  ORCHESTRATOR_AGENT_ID,
  ORCHESTRATOR_AGENT_NAME,
} from '../../../domain/orchestratorAgentIdentity'
import { createExecutionScopeIndex } from '../../../domain/executionScope'
import { computeShardScope, applyAutoPromote } from '../../../domain/fanoutScope'
import type { FrozenRunNode, FrozenFanoutTopology } from '../../../domain/runSelection/legacyFacts'

export interface FrozenRunDefinition {
  readonly nodes: readonly FrozenRunNode[]
  readonly parentOf: readonly (readonly [string, string])[]
  readonly fanouts: readonly FrozenFanoutTopology[]
  readonly missingFacts: readonly string[]
  readonly readable: boolean
  readonly platformHost?: 'workgroup-turns' | 'dw-generate'
}

/** Same schema + upgrade + scope analysis as the deleted O2 startup job. */
export function parseFrozenDefinition(snapshot: string | null): WorkflowDefinition | null {
  if (!snapshot) return null
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(snapshot))
    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
  } catch {
    return null
  }
}

export function frozenRunDefinition(
  snapshot: string | null,
  rows: readonly SourceRow[] = [],
  task?: TaskFacts,
): FrozenRunDefinition {
  const definition = parseFrozenDefinition(snapshot)
  const unreadable: FrozenRunDefinition = {
    nodes: [],
    parentOf: [],
    fanouts: [],
    missingFacts: ['tasks.workflow_snapshot'],
    readable: false,
  }
  if (!definition) return unreadable
  try {
    const scope = createExecutionScopeIndex(definition)
    const missingFacts: string[] = []
    const fanouts: FrozenFanoutTopology[] = []
    const byId = new Map(rows.map((row) => [row.values.id, row]))
    for (const wrapper of definition.nodes.filter((node) => node.kind === 'wrapper-fanout')) {
      const descriptor = scope.wrapper(wrapper.id, 'wrapper-fanout')
      const agents = definition.nodes.filter(
        (node) => descriptor.directNodeIds.includes(node.id) && node.kind === 'agent-single',
      )
      const candidates = new Set<string>()
      const refs: string[] = []
      let conflicting = false
      for (const row of rows) {
        if (row.values.rerun_cause !== 'fanout-aggregator') continue
        const parent = byId.get(row.values.parent_node_run_id)
        const container = byId.get(row.values.container_run_id)
        const member = agents.find((node) => node.id === row.values.node_id)
        const belongs =
          parent?.values.node_id === wrapper.id ||
          container?.values.node_id === wrapper.id ||
          member !== undefined
        if (!belongs) continue
        const owner = parent ?? container
        if (
          !member ||
          row.values.shard_key !== null ||
          owner?.values.node_id !== wrapper.id ||
          (parent !== undefined &&
            container !== undefined &&
            parent.values.id !== container.values.id) ||
          (row.values.parent_node_run_id !== null && parent === undefined) ||
          (row.values.container_run_id !== null && container === undefined)
        ) {
          conflicting = true
          refs.push(`node_runs:${String(row.values.id)}:conflicting-aggregator-writer`)
          continue
        }
        candidates.add(member.id)
        refs.push(
          `node_runs:${String(row.values.id)}:fanout-aggregator:wrapper=${String(owner.values.id)}`,
        )
      }
      if (conflicting || candidates.size > 1) {
        missingFacts.push(`fanout.writer-conflict:${wrapper.id}`, ...refs)
        continue
      }
      const aggregatorId = [...candidates][0] ?? null
      // The persisted writer identifies the convergence terminal; all other agents
      // follow the frozen graph's normal shard propagation.
      const graph = {
        ...definition,
        edges: definition.edges.filter((edge) => edge.target.nodeId !== aggregatorId),
      }
      const split = computeShardScope({ scope: descriptor, defn: graph, agents: new Map() })
      split.aggregatorId = aggregatorId
      if (aggregatorId !== null) {
        split.perShard.delete(aggregatorId)
        split.shared.delete(aggregatorId)
      }
      applyAutoPromote(split, definition)
      fanouts.push({
        wrapperNodeId: wrapper.id,
        perShardNodeIds: [...split.perShard],
        sharedNodeIds: [...split.shared],
        aggregatorNodeId: split.aggregatorId,
        evidence: [
          `tasks.workflow_snapshot:fanout:${wrapper.id}`,
          ...refs,
          ...(aggregatorId === null ? ['node_runs:no-aggregator-writer'] : []),
        ],
      })
    }
    const host =
      task?.subjectKind === 'workgroup' &&
      (task.engineKind === 'workgroup-turns' &&
      definition.nodes.length === 3 &&
      definition.nodes.some(
        (node) => node.id === '__wg_leader__' && node.kind === 'agent-single',
      ) &&
      definition.nodes.some(
        (node) => node.id === '__wg_member__' && node.kind === 'agent-single',
      ) &&
      definition.nodes.some((node) => node.id === '__wg_clarify__' && node.kind === 'clarify')
        ? 'workgroup-turns'
        : task.engineKind === 'dw-generate' &&
            definition.nodes.length === 1 &&
            definition.nodes.some(
              (node) =>
                node.id === '__dw_orchestrator__' &&
                node.kind === 'agent-single' &&
                node.agentId === ORCHESTRATOR_AGENT_ID &&
                node.agentName === ORCHESTRATOR_AGENT_NAME,
            )
          ? 'dw-generate'
          : undefined)
    return {
      ...(host ? { platformHost: host } : {}),
      nodes: definition.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(Array.isArray(node.nodeIds) ? { nodeIds: node.nodeIds as string[] } : {}),
      })),
      parentOf: [...scope.parentOf],
      fanouts,
      missingFacts,
      readable: true,
    }
  } catch {
    return unreadable
  }
}
