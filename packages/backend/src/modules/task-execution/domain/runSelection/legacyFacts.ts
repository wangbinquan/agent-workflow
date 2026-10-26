import type { NodeKind } from '@agent-workflow/shared'
import type { NodeRunRole, NodeRunSyntheticKind } from '../nodeRunRole'
import type { TaskSubject } from '../taskSubject'
import type { TaskEngineKind } from '../taskEngine'
import type { RunFamily } from './families'
import type { RunSlot } from './slots'

/** Missing columns are not equivalent to recorded NULLs. V2 supplies persisted values. */
export interface LegacyNodeRunRow {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly seq?: number | null
  readonly parentNodeRunId?: string | null
  readonly containerRunId?: string | null
  readonly iteration?: number
  readonly shardKey?: string | null
  readonly rerunCause?: string | null
  readonly reviewIteration?: number
  readonly wgRound?: number | null
  readonly wrapperProgressJson?: string | null
}

export interface FrozenRunNode {
  readonly id: string
  readonly kind: NodeKind
  readonly nodeIds?: readonly string[]
}

/** Projection of the frozen scope graph, including frozen aggregator-agent facts.
 * Missing frozen agent roles must not be filled from today's resource catalog. */
export interface FrozenFanoutTopology {
  readonly wrapperNodeId: string
  readonly perShardNodeIds: readonly string[]
  readonly sharedNodeIds: readonly string[]
  readonly aggregatorNodeId: string | null
  readonly evidence: readonly string[]
}

/** Persisted writer/operation evidence, not a classification based on a reserved node id. */
export interface LegacyRunWriterFact {
  readonly runId: string
  readonly taskId: string
  readonly writer:
    | 'repository-preparation'
    | 'commit-push'
    | 'merge-resolution'
    | 'dynamic-workflow'
    | 'workgroup-turn'
  readonly evidence: readonly string[]
}

export interface LegacyRunRelatedFacts {
  readonly row: LegacyNodeRunRow
  readonly writer?: LegacyRunWriterFact
}

export interface LegacyNodeRunFacts {
  readonly task?: {
    readonly id: string
    readonly subject?: TaskSubject['kind']
    readonly engine?: TaskEngineKind
    readonly definition?: { readonly nodes: readonly FrozenRunNode[] }
    readonly fanouts?: readonly FrozenFanoutTopology[]
  }
  readonly parent?: LegacyRunRelatedFacts
  readonly container?: LegacyRunRelatedFacts
  readonly writer?: LegacyRunWriterFact
}

export interface LegacyRunIdentityEvidence {
  readonly rule: string | null
  readonly usedFacts: readonly string[]
  readonly missingFacts: readonly string[]
  readonly conflicts: readonly string[]
  readonly references: readonly string[]
  readonly source: LegacyNodeRunRow
}

/** executable here proves identity only; V2 must also validate config and other target facts. */
export interface LegacyNodeRunIdentity {
  readonly role: NodeRunRole | null
  readonly syntheticKind: NodeRunSyntheticKind | null
  readonly slot: RunSlot | null
  readonly family: RunFamily | null
  readonly recordMode: 'executable' | 'history-only'
  readonly provenanceQuality: 'legacy-derived' | 'unknown'
  readonly evidence: LegacyRunIdentityEvidence
}
