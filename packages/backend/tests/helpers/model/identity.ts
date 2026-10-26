import { encodeSyntheticOwner } from '../../../src/modules/task-execution/domain/runSelection/syntheticOwner'
// Pure identity codec shared by the database and Node-loaded SQL fixture transports.
import { deriveNodeRunRole } from '../../../src/modules/task-execution/domain/nodeRunRole'
import { encodeCanonicalRunSlot } from '../../../src/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '../../../src/modules/task-execution/application/ports/runSelection'
import type { NodeRunFixtureSpec } from './nodeRun.spec'
export function nodeRunFixtureIdentity(
  spec: Pick<
    NodeRunFixtureSpec,
    | 'id'
    | 'taskId'
    | 'nodeId'
    | 'parentNodeRunId'
    | 'containerRunId'
    | 'iteration'
    | 'shardKey'
    | 'rerunCause'
    | 'wrapperProgressJson'
  >,
  container = false,
  hasShardSiblings = false,
) {
  const role = deriveNodeRunRole({
    nodeId: spec.nodeId,
    rerunCause: spec.rerunCause,
    wrapperProgressJson:
      spec.wrapperProgressJson == null
        ? null
        : typeof spec.wrapperProgressJson === 'string'
          ? spec.wrapperProgressJson
          : JSON.stringify(spec.wrapperProgressJson),
    hasContainerChildren: container,
  })
  const frame = { containerRunId: spec.containerRunId ?? null, iteration: spec.iteration ?? 0 }
  const slot: RunSlot =
    role.syntheticKind === 'workgroup-host'
      ? { kind: 'workgroup-host', nodeId: spec.nodeId, shardKey: spec.shardKey ?? null }
      : role.syntheticKind !== null
        ? {
            kind: 'synthetic',
            syntheticKind: role.syntheticKind,
            discriminator: spec.nodeId,
            owner: spec.parentNodeRunId
              ? { kind: 'attempt', id: spec.parentNodeRunId }
              : { kind: 'task', id: spec.taskId },
          }
        : role.role === 'container'
          ? { kind: 'container', nodeId: spec.nodeId, frame }
          : spec.parentNodeRunId != null
            ? spec.shardKey != null || spec.rerunCause === 'fanout-shard' || hasShardSiblings
              ? {
                  kind: 'shard',
                  nodeId: spec.nodeId,
                  iteration: frame.iteration,
                  shardKey: spec.shardKey ?? null,
                }
              : { kind: 'aggregator', nodeId: spec.nodeId, iteration: frame.iteration }
            : { kind: 'node', nodeId: spec.nodeId, frame }
  return {
    role: role.role,
    slotKey: encodeCanonicalRunSlot(slot),
    syntheticOwner:
      role.role === 'synthetic'
        ? encodeSyntheticOwner(
            slot.kind === 'synthetic' ? slot.owner : { kind: 'task', id: spec.taskId },
          )
        : null,
  }
}
