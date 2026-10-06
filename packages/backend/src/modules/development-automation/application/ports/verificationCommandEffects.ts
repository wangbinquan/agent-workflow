import type { VerificationProfileContent } from '../../domain/verificationProfile'
import type { EvidenceArtifactPort } from './evidenceArtifacts'

export type VerificationStep = VerificationProfileContent['steps'][number]
/** Only the selected program owner can interpret this reference. */
export type VerificationProgramRef = object

export interface VerificationStepResult {
  readonly stepId: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** stdout+stderr 尾部（bounded）的 evidence blob ref；空输出 ⇒ null。 */
  readonly outputTailRef: string | null
  readonly evidenceFiles: readonly {
    readonly selector: string
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }[]
}

export interface VerificationRunReceipt {
  readonly ok: boolean
  readonly stopPolicy: VerificationProfileContent['stopPolicy']
  readonly steps: readonly VerificationStepResult[]
  /** receipt 核心的 canonical digest（规则/审计引用）。 */
  readonly receiptDigest: string
}

export interface VerificationProcessFacts {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly outputTailRef: string | null
}

export interface VerificationCommandEffects {
  resolveProgram(input: {
    readonly programRef: string
    readonly argsRef: string | null
    readonly workspaceRef: string
  }): VerificationProgramRef | null | Promise<VerificationProgramRef | null>
  execute(input: {
    readonly program: VerificationProgramRef
    readonly workspaceRef: string
    readonly step: VerificationStep
  }): Promise<VerificationProcessFacts>
  collectFiles(input: {
    readonly workspaceRef: string
    readonly pattern: string
  }): Promise<VerificationStepResult['evidenceFiles']>
}

/** One complete selected receiver is created for each profile run. */
export interface VerificationCommandEffectsFactory {
  create(input: { readonly evidence: EvidenceArtifactPort }): VerificationCommandEffects
}
