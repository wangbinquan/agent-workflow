// Native compatibility API; ordinary composition selects a complete effects family.
// RFC-584: moved verbatim from development-automation infrastructure/verificationRunner.ts — only contract tests use it; no production entry reaches it.
import type { VerificationProfileContent } from '@/modules/development-automation/domain/verificationProfile'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { VerificationRunReceipt } from '@/modules/development-automation/application/ports/verificationCommandEffects'
import { runVerificationProfileWithEffects } from '@/modules/development-automation/application/verificationRunner'
import {
  createLocalVerificationCommandEffects,
  type VerificationProgramResolver,
} from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
export {
  createRepoScriptResolver,
  type ResolvedVerificationProgram,
  type VerificationProgramResolver,
} from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
export type {
  VerificationStepResult,
  VerificationRunReceipt,
} from '@/modules/development-automation/application/ports/verificationCommandEffects'

export async function runVerificationProfile(
  deps: { readonly evidence: EvidenceArtifactPort; readonly resolver: VerificationProgramResolver },
  input: { readonly workspacePath: string; readonly profile: VerificationProfileContent },
): Promise<VerificationRunReceipt> {
  return runVerificationProfileWithEffects(createLocalVerificationCommandEffects(deps), input)
}
