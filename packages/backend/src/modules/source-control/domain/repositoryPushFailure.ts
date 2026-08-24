// RFC-321 — one stable vocabulary for managed Git publication failures.
//
// Consumers persist only these codes. The selected credential source/revision is
// already carried by RepositoryPublicationReceipt, so error strings never need
// to encode `personal`/`global` (or echo Git stderr) to explain the failure.

export type RepositoryPushFailureCode =
  | 'repository-push-authentication-failed'
  | 'repository-push-authorization-failed'

/**
 * Classify provider/Git authentication failures before any repair decision.
 * Authorization wins when a response contains both a generic authentication
 * phrase and an explicit write/permission denial.
 */
export function classifyRepositoryPushFailure(detail: string): RepositoryPushFailureCode | null {
  const normalized = detail.toLowerCase()
  if (
    /(?:\b403\b|permission denied to|write access(?: to (?:the )?repository)? not granted|not allowed to push|access denied|insufficient (?:permission|scope)s?|does not have permission to push|you are not allowed to push)/.test(
      normalized,
    )
  ) {
    return 'repository-push-authorization-failed'
  }
  if (
    /(?:\b401\b|authentication failed|invalid credentials?|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey\))/.test(
      normalized,
    )
  ) {
    return 'repository-push-authentication-failed'
  }
  return null
}
