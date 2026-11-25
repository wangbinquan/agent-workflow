// RFC-589 — the agent dependency, import, reference-label and resource-integrity queries the agent HTTP binding reads, with
// their inputs and results. They left `public/` when the agent binding moved into this module's inbound layer: no other
// module consumes them.
import type {
  ResolveAgentImportRefsRequest,
  ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import type { AgentOperationContext } from '../../public/participants'
import type { AgentCatalogResource, GetAgentResourceClosureStatusInput } from '../../public/types'
// RFC-477: the exact wire code shared by every disabled-plugin integrity emitter is declared with the disabled-resource
// policy (`domain/disabledResourcePolicy.ts`); the issue union below names it by type.
import type { PluginDisabledErrorCode } from '../../domain/disabledResourcePolicy'

// RFC-589: the label / display / issue shapes below were `public/types`' local helpers of the moved contracts.
interface AgentReferenceLabel {
  readonly id: string
  readonly name: string
}

type AgentResourceRefKind = 'skill' | 'mcp' | 'plugin' | 'agent'
type AgentResourceIssueCode =
  | 'agent-dependency-not-found'
  | 'agent-dependency-cycle'
  | 'skill-not-found'
  | 'skill-unavailable'
  | 'mcp-not-found'
  | 'plugin-not-found'
  | PluginDisabledErrorCode
type AgentResourceDisplayState = 'available' | 'hidden' | 'missing' | 'unavailable'

interface AgentResourceDisplayRef {
  readonly kind: AgentResourceRefKind
  readonly refId: string
  readonly name: string | null
  readonly state: AgentResourceDisplayState
}

interface AgentResourceDisplayIssue {
  readonly code: AgentResourceIssueCode
  readonly refKind: AgentResourceRefKind
  readonly state: AgentResourceDisplayState
  readonly refId: string | null
  readonly refName: string | null
  readonly ownerAgentId: string | null
  readonly ownerAgentName: string | null
  readonly direct: boolean
}

interface AgentResourceClosureIssue {
  readonly code: AgentResourceIssueCode
  readonly rootAgentId: string
  readonly refKind: AgentResourceRefKind
  readonly direct: boolean
}

/** Provider-neutral Agent dependency traversal and reference admission. */
export interface AgentDependencyQueries {
  closure(
    authority: AgentOperationContext,
    input: ResolveAgentDependencyClosureInput,
  ): Promise<AgentDependencyClosureResult>
  resolveUsableIds(
    authority: AgentOperationContext,
    input: ResolveAgentDependencyIdsInput,
  ): Promise<ResolvedAgentDependencyIds>
  validate(authority: AgentOperationContext, input: ValidateAgentDependenciesInput): Promise<void>
}

/** Portable Agent import selector resolution bound to the active provider. */
export interface AgentImportQueries {
  resolve(
    authority: AgentOperationContext,
    input: ResolveAgentImportRefsRequest,
  ): Promise<ResolveAgentImportRefsResult>
}

export interface AgentReferenceQueries {
  labels(
    authority: AgentOperationContext,
    input: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels>
}

/** Provider-neutral projection used by the Agent authoring surface. */
export interface AgentResourceIntegrityQueries {
  status(
    authority: AgentOperationContext,
    input: GetAgentResourceStatusInput,
  ): Promise<AgentResourceStatus>
  closureStatus(
    authority: AgentOperationContext,
    input: GetAgentResourceClosureStatusInput,
  ): Promise<AgentResourceClosureStatus>
}

export type AgentDependencyClosureResult =
  | { readonly ok: true; readonly agents: readonly AgentCatalogResource[] }
  | { readonly ok: false; readonly cyclePath: readonly string[] }

export interface ResolveAgentDependencyClosureInput {
  readonly root: AgentCatalogResource
  readonly onMissing: 'fail' | 'skip'
}

export interface ResolveAgentDependencyIdsInput {
  readonly ids: readonly string[]
}

export interface ResolvedAgentDependencyIds {
  readonly ids: readonly string[]
  readonly missing: readonly {
    readonly type: 'agent'
    readonly name: string
  }[]
}

export interface ValidateAgentDependenciesInput {
  readonly selfId: string
  readonly dependsOn: readonly string[]
}

export interface AgentReferenceLabels {
  readonly skills: readonly AgentReferenceLabel[]
  readonly mcps: readonly AgentReferenceLabel[]
  readonly plugins: readonly AgentReferenceLabel[]
}

export interface AgentReferenceLabelsInput {
  readonly agents: readonly AgentCatalogResource[]
  readonly visibleAgentIds: readonly string[]
}

export interface AgentResourceClosureStatus {
  readonly ok: boolean
  readonly issues: readonly AgentResourceClosureIssue[]
}

export interface AgentResourceStatus {
  readonly ok: boolean
  readonly references: readonly AgentResourceDisplayRef[]
  readonly issues: readonly AgentResourceDisplayIssue[]
}

export interface GetAgentResourceStatusInput {
  readonly root: AgentCatalogResource
}
