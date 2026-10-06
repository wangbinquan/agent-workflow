// Native compatibility API; ordinary composition selects a complete effects family.
import type { VerificationProfileContent } from '../domain/verificationProfile'
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type { VerificationRunReceipt } from '../application/ports/verificationCommandEffects'
import { runVerificationProfileWithEffects } from '../application/verificationRunner'
import {
  createLocalVerificationCommandEffects,
  type VerificationProgramResolver,
} from './local/verificationCommandEffects'
export {
  createRepoScriptResolver,
  type ResolvedVerificationProgram,
  type VerificationProgramResolver,
} from './local/verificationCommandEffects'
export type {
  VerificationStepResult,
  VerificationRunReceipt,
} from '../application/ports/verificationCommandEffects'

export async function runVerificationProfile(
  deps: { readonly evidence: EvidenceArtifactPort; readonly resolver: VerificationProgramResolver },
  input: { readonly workspacePath: string; readonly profile: VerificationProfileContent },
): Promise<VerificationRunReceipt> {
  return runVerificationProfileWithEffects(createLocalVerificationCommandEffects(deps), input)
}
