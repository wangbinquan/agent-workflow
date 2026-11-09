// RFC-321 — one stable vocabulary for managed Git publication failures.
//
// Consumers persist only these codes. The selected credential source/revision is
// already carried by RepositoryPublicationReceipt, so error strings never need
// to encode `personal`/`global` (or echo Git stderr) to explain the failure.
//
// RFC-475: the RFC-075 push-failure class and the stored-error redaction moved
// here from `services/commitPush.ts` with the workspace change publication.

import { redactGitUrl } from '@agent-workflow/shared'

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

/** How a `git push` failure should be handled. */
export type PushFailureClass = 'auth' | 'non-fast-forward' | 'repairable'

/**
 * Classify push stderr. Conservative: anything we can't positively identify as
 * auth or non-fast-forward is treated as `repairable` (worth an LLM repair
 * attempt — typically a server-side commit-message policy hook).
 */
export function classifyPushFailure(stderr: string): PushFailureClass {
  const s = stderr.toLowerCase()
  if (
    /permission denied|authentication failed|could not read username|could not read password|publickey|403 forbidden|access denied|access rights|terminal prompts disabled|invalid credentials/.test(
      s,
    )
  ) {
    return 'auth'
  }
  if (
    /non-fast-forward|fetch first|updates were rejected|tip of your current branch is behind/.test(
      s,
    )
  ) {
    return 'non-fast-forward'
  }
  return 'repairable'
}

/** Redact credentials from push stderr and cap its length for storage. */
export function redactPushError(stderr: string, maxLen = 600): string {
  // RFC-210: delegate to the shared redactor instead of keeping a second,
  // weaker regex here. This one only stripped `scheme://user:token@host`, so a
  // credential carried in the QUERY STRING (`?access_token=…`) went into
  // node_runs.commit_push_json verbatim — shared/git-url.ts已经处理了那种形态，
  // and having two implementations is how they drifted apart in the first place.
  let out = redactGitUrl(stderr).trim()
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…`
  return out
}
