import type { ContractValidationCheck, ExactResourceRef, ToolImplementation } from '../domain/model'
import type { ReactionExecutionPlan } from '../domain/runtimeModel'

export interface ToolResourceProjection {
  readonly kind: 'agent' | 'workflow'
  readonly ref: ExactResourceRef
  readonly name: string
  readonly available: boolean
  readonly closureSummary: string
}

export interface ToolResourceCatalogPort {
  resolveAgent(ref: ExactResourceRef): Promise<ToolResourceProjection | null>
  resolveWorkflow(ref: ExactResourceRef): Promise<ToolResourceProjection | null>
}

export interface ToolConnectionProjection {
  readonly ref: ExactResourceRef
  readonly purpose: string
  readonly available: boolean
  readonly closureSummary: string
}

/**
 * Resolves one exact, platform-owned connection revision. The consumer owns
 * this narrow contract; provider credentials and executable details never
 * cross into Digital Employee authoring or Agent input.
 */
export interface ToolConnectionCatalogPort {
  resolve(ref: ExactResourceRef): Promise<ToolConnectionProjection | null>
}

export interface ProgramArtifactPort {
  put(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  }): Promise<{
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }>
}

/**
 * Content-addressed bytes are owned by the platform artifact mechanism. The
 * Digital Employee OS stores only an opaque blob ref and verified byte facts.
 */
export interface EmployeeInputArtifactPort {
  putFile(absolutePath: string): Promise<{
    readonly blobRef: string
    readonly sha256: string
    readonly bytes: number
  }>
  hasBlob(blobRef: string): boolean
  copyBlobTo(blobRef: string, absoluteTargetPath: string): void
}

/**
 * The fixture runner is an execution participant, not an alternate runtime.
 * Production adapts it to the existing Agent/Workflow/Script execution path.
 */
export interface WorkContractFixturePort {
  validate(input: {
    readonly inputSchemaId: string
    readonly outputSchemaId: string
    readonly implementation: ToolImplementation
  }): Promise<readonly ContractValidationCheck[]>
}

export type ReactionExecutionSnapshot =
  | { readonly kind: 'pending'; readonly executionRef: string }
  | { readonly kind: 'completed'; readonly executionRef: string; readonly outputJson: string }
  | {
      readonly kind: 'failed'
      readonly executionRef: string
      readonly errorCode: string
      readonly errorDetail: string
    }

export interface ReactionExecutionPort {
  launch(
    plan: ReactionExecutionPlan,
    attempt: {
      readonly ordinal: number
      readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
      readonly previousError: string | null
    },
  ): Promise<{ readonly executionRef: string }>
  inspect(executionRef: string): Promise<ReactionExecutionSnapshot>
  cancel(executionRef: string): Promise<void>
}

/**
 * Deterministic platform-owned work items (for example source-control publish
 * or merge-readiness evaluation) execute outside Agent/Workflow/Script. The
 * participant must return the same exact output envelope as every other tool.
 */
export interface PlatformWorkItemExecutionPort {
  execute(plan: ReactionExecutionPlan): Promise<string>
}
