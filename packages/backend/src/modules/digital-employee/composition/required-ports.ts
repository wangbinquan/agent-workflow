import type { ExactResourceRef } from '../domain/model'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import type { ReactionExecutionPlan } from '../domain/runtimeModel'

export interface ToolConnectionProjection {
  readonly ref: ExactResourceRef
  readonly purpose: string
  readonly available: boolean
  readonly visible: boolean
  readonly contentDigest: string
  readonly closureSummary: string
}

export interface ToolConnectionVisibilitySubject {
  readonly userId: string
  readonly authority: {
    readonly bypass: boolean
    readonly private: boolean
  }
}

/**
 * Digital employees consume the platform-wide retry limits. This port is
 * intentionally read-only: authoring an employee must never create a second
 * retry-policy namespace beside Settings -> Limits.
 */
export interface EmployeeRetryLimitsPort {
  current(): {
    readonly defaultNodeRetries: number
    readonly sessionRestartBudget: number
  }
}

/**
 * Resolves one exact, platform-owned connection revision. The consumer owns
 * this narrow contract; provider credentials and executable details never
 * cross into Digital Employee authoring or Agent input.
 */
export interface ToolConnectionCatalogPort {
  resolve(
    ref: ExactResourceRef,
    subject?: ToolConnectionVisibilitySubject | null,
  ): Promise<ToolConnectionProjection | null>

  /**
   * Chooses a stable published Adapter for a compatible legacy upgrade.
   * Historical exact refs are preferences, not a requirement: providers may
   * fall back to their deterministic catalog default when those refs are
   * absent, archived, or ambiguous. An empty preference list means "use the
   * catalog default". The selected exact ref is frozen into the new revision.
   */
  selectAutomatic?(input: {
    readonly purpose: string
    readonly candidates: readonly ExactResourceRef[]
    readonly subject?: ToolConnectionVisibilitySubject | null
  }): Promise<ToolConnectionProjection | null>
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
  read(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }): {
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  } | null
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

export type ReactionExecutionSnapshot =
  | { readonly kind: 'pending'; readonly executionRef: string }
  | {
      readonly kind: 'completed'
      readonly executionRef: string
      readonly outputJson: string
      readonly metering: ReactionExecutionMetering
    }
  | {
      readonly kind: 'failed'
      readonly executionRef: string
      /** RFC-317 T31（DE-03）—— 决定重试落在同场景还是新场景，见 WorkspaceFailureClass。 */
      readonly errorClass: WorkspaceFailureClass
      readonly errorCode: string
      readonly errorDetail: string
      readonly metering: ReactionExecutionMetering
    }

export interface ReactionExecutionMetering {
  readonly sourceRef: string
  readonly durationMs: number
  readonly totalTokens: number
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
  inspectHumanReview?(executionRef: string): 'planning' | 'waiting' | 'approved' | 'failed' | null
  cancel(executionRef: string): Promise<void>
}

/**
 * Deterministic platform-owned work items (for example source-control publish
 * or merge-readiness evaluation) execute outside Agent/Workflow/Script. The
 * participant must return the same exact output envelope as every other tool.
 */
export interface PlatformWorkItemExecutionPort {
  execute(
    plan: ReactionExecutionPlan,
    context: {
      readonly publicationSubject:
        | { readonly kind: 'user'; readonly userId: string }
        | { readonly kind: 'system' }
    },
  ): Promise<string>
}
