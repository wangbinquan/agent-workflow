import { NODE_KIND } from '@agent-workflow/shared'
import type { NodeRunSyntheticKind } from '../nodeRunRole'
import { nodeRunSlotKeyForMint, type NodeRunMintSlotFacts } from './mintIdentity'
import type { RunFamily } from './families'
import type {
  FrozenRunNode,
  LegacyNodeRunFacts,
  LegacyNodeRunIdentity,
  LegacyNodeRunRow,
  LegacyRunRelatedFacts,
  LegacyRunWriterFact,
} from './legacyFacts'
import type { Frame, RunSlot } from './slots'

const wrapperKinds = new Set(['wrapper-git', 'wrapper-loop', 'wrapper-fanout'])

/** design/RFC-395-database-target-schema-rebuild/plan.md:435. Dormant V2 identity rules. */
export function deriveLegacyNodeRunIdentity(
  row: LegacyNodeRunRow,
  facts: LegacyNodeRunFacts,
): LegacyNodeRunIdentity {
  const usedFacts = new Set<string>()
  const missingFacts = new Set<string>()
  const conflicts = new Set<string>()
  const references = new Set<string>()
  const task = facts.task
  if (task === undefined) missingFacts.add('task')
  else {
    usedFacts.add('task.id')
    if (task.id !== row.taskId) conflicts.add('task.id')
    if (task.definition === undefined) missingFacts.add('task.definition')
    for (const field of ['subject', 'engine'] as const)
      if (task[field] === undefined) missingFacts.add(`task.${field}`)
      else usedFacts.add(`task.${field}`)
  }
  const nodes = task?.definition?.nodes ?? []
  const nodeAt = (nodeId: string): FrozenRunNode | undefined => {
    const found = nodes.filter((node) => node.id === nodeId)
    if (found.length > 1) conflicts.add(`task.definition.nodes:${nodeId}`)
    return found[0]
  }
  const node = nodeAt(row.nodeId)
  if (node !== undefined && !NODE_KIND.includes(node.kind)) conflicts.add('node.kind')
  usedFacts.add('row.nodeId')
  if (task?.definition !== undefined) usedFacts.add('task.definition.nodes')

  const related = (
    field: 'parentNodeRunId' | 'containerRunId',
    supplied: LegacyRunRelatedFacts | undefined,
  ): LegacyRunRelatedFacts | undefined => {
    const id = row[field]
    if (id === undefined) {
      missingFacts.add(`row.${field}`)
      return undefined
    }
    usedFacts.add(`row.${field}`)
    if (id === null) return undefined
    const name = field === 'parentNodeRunId' ? 'parent' : 'container'
    if (supplied === undefined) missingFacts.add(`${name}.row:${id}`)
    else if (supplied.row.id !== id || supplied.row.taskId !== row.taskId || id === row.id)
      conflicts.add(`${name}.identity`)
    else {
      usedFacts.add(`${name}.row`)
      return supplied
    }
    return undefined
  }
  const parent = related('parentNodeRunId', facts.parent)
  const container = related('containerRunId', facts.container)
  if (container !== undefined) {
    const containerNode = nodeAt(container.row.nodeId)
    if (containerNode === undefined) missingFacts.add('container.definition')
    else if (!wrapperKinds.has(containerNode.kind)) conflicts.add('container.wrapper-kind')
  }

  const writerFor = (
    target: LegacyNodeRunRow,
    writer: LegacyRunWriterFact | undefined,
    path: string,
  ): LegacyRunWriterFact | undefined => {
    if (writer === undefined) return undefined
    usedFacts.add(path)
    if (writer.runId !== target.id || writer.taskId !== target.taskId) {
      conflicts.add(`${path}.identity`)
      return undefined
    }
    if (writer.evidence.length === 0 || writer.evidence.some((entry) => entry.length === 0)) {
      missingFacts.add(`${path}.evidence`)
      return undefined
    }
    writer.evidence.forEach((entry) => references.add(entry))
    return writer
  }
  const writer = writerFor(row, facts.writer, 'writer')
  const parentWriter =
    parent === undefined ? undefined : writerFor(parent.row, parent.writer, 'parent.writer')

  const finish = (
    rule: string | null,
    identity?: NodeRunMintSlotFacts,
    family?: RunFamily,
  ): LegacyNodeRunIdentity => {
    const proved = identity !== undefined && missingFacts.size === 0 && conflicts.size === 0
    if (proved) nodeRunSlotKeyForMint(identity)
    return {
      role: proved ? identity.role : null,
      syntheticKind: proved ? identity.syntheticKind : null,
      slot: proved ? identity.slot : null,
      family: proved ? (family ?? { kind: 'node', nodeId: row.nodeId }) : null,
      recordMode: proved ? 'executable' : 'history-only',
      provenanceQuality: proved ? 'legacy-derived' : 'unknown',
      evidence: {
        rule,
        usedFacts: [...usedFacts],
        missingFacts: [...missingFacts],
        conflicts: [...conflicts],
        references: [...references],
        source: { ...row },
      },
    }
  }
  const iteration = (): number | undefined => {
    if (row.iteration === undefined) missingFacts.add('row.iteration')
    else if (
      !Number.isSafeInteger(row.iteration) ||
      row.iteration < 0 ||
      Object.is(row.iteration, -0)
    )
      conflicts.add('row.iteration')
    else {
      usedFacts.add('row.iteration')
      return row.iteration
    }
    return undefined
  }
  const shard = (): string | null | undefined => {
    if (row.shardKey === undefined) missingFacts.add('row.shardKey')
    else usedFacts.add('row.shardKey')
    return row.shardKey
  }
  const frame = (): Frame | undefined => {
    const value = iteration()
    if (row.containerRunId === null && nodes.some((entry) => entry.nodeIds?.includes(row.nodeId)))
      missingFacts.add('node.wrapper-frame')
    if (container !== undefined) {
      const wrapper = nodeAt(container.row.nodeId)
      if (wrapper === undefined) missingFacts.add('container.definition')
      else if (!wrapperKinds.has(wrapper.kind)) conflicts.add('container.wrapper-kind')
      else if (wrapper.nodeIds === undefined) missingFacts.add('container.definition.nodeIds')
      else if (!wrapper.nodeIds.includes(row.nodeId)) conflicts.add('container.membership')
    }
    return value === undefined || row.containerRunId === undefined
      ? undefined
      : { containerRunId: row.containerRunId, iteration: value }
  }
  const synthetic = (
    kind: Exclude<NodeRunSyntheticKind, 'workgroup-host'>,
    owner: Extract<RunSlot, { kind: 'synthetic' }>['owner'],
    rule: string,
    family?: RunFamily,
  ) => {
    const slot = {
      kind: 'synthetic' as const,
      owner,
      syntheticKind: kind,
      discriminator: row.nodeId,
    }
    return finish(rule, { role: 'synthetic', syntheticKind: kind, slot }, family ?? slot)
  }
  const requireEngine = (engine: 'workgroup-turns' | 'dw-generate') => {
    for (const field of ['subject', 'engine'] as const)
      if (task?.[field] === undefined) missingFacts.add(`task.${field}`)
      else usedFacts.add(`task.${field}`)
    if (task?.subject !== undefined && task.subject !== 'workgroup') conflicts.add('task.subject')
    if (task?.engine !== undefined && task.engine !== engine) conflicts.add('task.engine')
  }

  // The parent's actual writer proves sessions, even before rerun_cause was recorded.
  if (parent !== undefined && parentWriter?.writer === 'commit-push') {
    if (nodeAt(parent.row.nodeId) !== undefined) conflicts.add('parent.writer.user-node')
    if (writer !== undefined) conflicts.add('writer.commit-session-parent')
    return synthetic('commit-session', { kind: 'attempt', id: parent.row.id }, 'commit-session')
  }

  if (node !== undefined && wrapperKinds.has(node.kind)) {
    if (writer !== undefined) conflicts.add('writer.wrapper-definition')
    const slotFrame = frame()
    return finish(
      'wrapper',
      slotFrame === undefined
        ? undefined
        : {
            role: 'container',
            syntheticKind: null,
            slot: { kind: 'container', nodeId: row.nodeId, frame: slotFrame },
          },
    )
  }

  if (writer?.writer === 'workgroup-turn') {
    requireEngine('workgroup-turns')
    if (node !== undefined && node.kind !== 'agent-single') conflicts.add('writer.host-node-kind')
    if (row.parentNodeRunId !== null || row.containerRunId !== null)
      conflicts.add('writer.host-scope')
    const shardKey = shard()
    const family: RunFamily | undefined =
      shardKey === undefined
        ? undefined
        : {
            kind: 'workgroup',
            taskId: row.taskId,
            nodeId: row.nodeId,
            shardKey,
          }
    usedFacts.add('row.rerunCause')
    if (row.rerunCause === undefined) missingFacts.add('row.rerunCause')
    if (row.rerunCause === 'wg-gate') {
      if (shardKey !== undefined && shardKey !== null) conflicts.add('writer.gate-shard')
      return synthetic('wg-gate', { kind: 'task', id: row.taskId }, 'workgroup-gate', family)
    }
    if (
      ![
        'wg-leader-round',
        'wg-assignment',
        'wg-message-turn',
        'wg-protocol-retry',
        'clarify-answer',
        'cross-clarify-questioner-rerun',
      ].includes(row.rerunCause ?? '')
    )
      missingFacts.add('writer.workgroup-operation')
    return finish(
      'workgroup-host',
      shardKey === undefined
        ? undefined
        : {
            role: 'synthetic',
            syntheticKind: 'workgroup-host',
            slot: { kind: 'workgroup-host', nodeId: row.nodeId, shardKey },
          },
      family,
    )
  }

  if (writer !== undefined) {
    if (node !== undefined) conflicts.add('writer.user-node')
    const owner =
      row.parentNodeRunId == null
        ? { kind: 'task' as const, id: row.taskId }
        : { kind: 'attempt' as const, id: row.parentNodeRunId }
    switch (writer.writer) {
      case 'repository-preparation':
        return synthetic('repo-prep', owner, 'repository-preparation')
      case 'commit-push':
        return synthetic('commit-push', owner, 'commit-push')
      case 'merge-resolution':
        return synthetic('merge-resolve', owner, 'merge-resolution')
      case 'dynamic-workflow':
        requireEngine('dw-generate')
        usedFacts.add('row.rerunCause')
        if (row.rerunCause !== 'dw-gate' && row.rerunCause !== 'dw-generate') {
          missingFacts.add('writer.dynamic-workflow-operation')
          return finish('dynamic-workflow')
        }
        return synthetic(
          row.rerunCause === 'dw-gate' ? 'dw-gate' : 'dw-orchestrator',
          owner,
          'dynamic-workflow',
        )
    }
  }

  if (node === undefined) {
    missingFacts.add('node.definition-or-system-writer')
    return finish(null)
  }
  if (
    task?.subject === 'workgroup' &&
    task.engine === 'workgroup-turns' &&
    node.kind === 'agent-single'
  ) {
    missingFacts.add('writer.workgroup-turn')
    return finish('workgroup-host')
  }
  // A clarify node (including __wg_clarify__) follows the ordinary frozen kind.
  const scope =
    parent !== undefined && nodeAt(parent.row.nodeId)?.kind === 'wrapper-fanout'
      ? parent
      : container !== undefined && nodeAt(container.row.nodeId)?.kind === 'wrapper-fanout'
        ? container
        : undefined
  if (scope !== undefined) {
    const wrapper = nodeAt(scope.row.nodeId)!
    const topologies = task?.fanouts?.filter((entry) => entry.wrapperNodeId === wrapper.id) ?? []
    const topology = topologies[0]
    if (topologies.length > 1) conflicts.add('fanout.topology.duplicate')
    if (topology === undefined) {
      missingFacts.add(`fanout.topology:${wrapper.id}`)
      return finish('fanout')
    }
    usedFacts.add(`task.fanouts:${wrapper.id}`)
    if (topology.evidence.length === 0 || topology.evidence.some((entry) => entry.length === 0))
      missingFacts.add('fanout.topology.evidence')
    topology.evidence.forEach((entry) => references.add(entry))
    const members = [
      ...topology.perShardNodeIds,
      ...topology.sharedNodeIds,
      ...(topology.aggregatorNodeId === null ? [] : [topology.aggregatorNodeId]),
    ]
    if (wrapper.nodeIds === undefined) missingFacts.add('fanout.definition.nodeIds')
    else if (
      members.length !== wrapper.nodeIds.length ||
      new Set(members).size !== members.length ||
      members.some((id) => !wrapper.nodeIds!.includes(id)) ||
      !members.includes(row.nodeId)
    )
      conflicts.add('fanout.topology.membership')
    if (parent !== undefined && container !== undefined && parent.row.id !== container.row.id)
      conflicts.add('fanout.parent-container')
    const value = iteration()
    const shardKey = shard()
    const aggregator = topology.aggregatorNodeId === row.nodeId
    if (
      (aggregator || topology.sharedNodeIds.includes(row.nodeId)) &&
      shardKey !== undefined &&
      shardKey !== null
    )
      conflicts.add('fanout.shard-key')
    // Per-shard NULL is unproven; shared/broadcast NULL is explicitly a shard slot.
    if (topology.perShardNodeIds.includes(row.nodeId) && shardKey === null)
      missingFacts.add('fanout.per-shard-key')
    return finish(
      aggregator ? 'fanout-aggregator' : 'fanout-shard',
      value === undefined || shardKey === undefined
        ? undefined
        : {
            role: 'node-attempt',
            syntheticKind: null,
            slot: aggregator
              ? { kind: 'aggregator', nodeId: row.nodeId, iteration: value }
              : { kind: 'shard', nodeId: row.nodeId, iteration: value, shardKey },
          },
    )
  }

  if (row.parentNodeRunId !== null) missingFacts.add('parent.commit-push-or-fanout-scope')
  if (row.shardKey !== undefined && row.shardKey !== null) missingFacts.add('shard.fanout-scope')
  const slotFrame = frame()
  return finish(
    'ordinary-node',
    slotFrame === undefined
      ? undefined
      : {
          role: 'node-attempt',
          syntheticKind: null,
          slot: { kind: 'node', nodeId: row.nodeId, frame: slotFrame },
        },
  )
}
