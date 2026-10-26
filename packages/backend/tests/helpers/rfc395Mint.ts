// Transitional test inputs name the role explicitly; only fixture framing is completed here.
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { generateNodeRunEnvelopeNonce } from '@/modules/task-execution/application/buildNodeRunMintRecord'

type FixtureMintInput = Omit<NodeRunMintInput, 'slot' | 'envelopeNonce' | 'executionGeneration'> &
  Partial<Pick<NodeRunMintInput, 'slot' | 'envelopeNonce' | 'executionGeneration'>>
export function withTargetMintIdentity(input: FixtureMintInput): NodeRunMintInput {
  const frame = {
    containerRunId:
      input.containerRunId === undefined
        ? (input.inheritFrom?.containerRunId ?? null)
        : input.containerRunId,
    iteration: input.iteration ?? 0,
  }
  const shardKey =
    input.overrides?.identity?.shardKey === undefined
      ? (input.inheritFrom?.shardKey ?? null)
      : input.overrides.identity.shardKey
  const parent =
    input.overrides?.identity?.parentNodeRunId === undefined
      ? (input.inheritFrom?.parentNodeRunId ?? null)
      : input.overrides.identity.parentNodeRunId
  let slot: RunSlot
  if (input.slot) slot = input.slot
  else if (input.role === 'container') slot = { kind: 'container', nodeId: input.nodeId, frame }
  else if (input.syntheticKind === 'workgroup-host')
    slot = { kind: 'workgroup-host', nodeId: input.nodeId, shardKey }
  else if (input.syntheticKind !== null)
    slot = {
      kind: 'synthetic',
      syntheticKind: input.syntheticKind,
      owner:
        input.syntheticKind === 'commit-session'
          ? { kind: 'attempt', id: parent! }
          : { kind: 'task', id: input.taskId },
      discriminator: input.nodeId,
    }
  else if (input.cause === 'fanout-aggregator')
    slot = { kind: 'aggregator', nodeId: input.nodeId, iteration: frame.iteration }
  else if (input.cause === 'fanout-shard' || shardKey !== null)
    slot = { kind: 'shard', nodeId: input.nodeId, iteration: frame.iteration, shardKey }
  else slot = { kind: 'node', nodeId: input.nodeId, frame }
  return {
    ...input,
    slot,
    envelopeNonce:
      input.envelopeNonce ??
      input.overrides?.identity?.envelopeNonce ??
      generateNodeRunEnvelopeNonce(),
    executionGeneration: input.executionGeneration ?? { kind: 'current' },
  }
}
