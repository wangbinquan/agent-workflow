// RFC-304 §6 — `resolve-target`: which MR is this round about?
//
// Program-only, and the first stage of every capability. It reads the frozen
// webhook trigger context (RFC-269/292 — already the canonical namespace for
// this data) and produces the identity everything downstream keys off.
//
// Every failure mode here is "silently reviewed the wrong thing", which is why
// each missing field is refused by name rather than defaulted:
//
//   no stable project id  → the work item's identity key would collapse onto
//                           the repo PATH, which is mutable: rename or transfer
//                           the project and the same MR becomes a different
//                           work item, detaching its ledger and its supersede
//                           relation (design §2.1);
//   no MR number          → nothing to publish to;
//   no head sha           → the round has no baseline, so `awaiting` could not
//                           tell a new push from the one it is waiting on.
//
// Defaulting any of these produces a round that runs to completion and posts
// somewhere — which is worse than a round that refuses to start.

import type { WebhookTriggerFields } from '@agent-workflow/shared'

export interface RoundTarget {
  provider: 'gitlab' | 'github'
  /** Which configured code-host connection this MR lives behind. */
  codeHostEndpointId: string
  /** The STABLE numeric project id — never the path (design §2.1). */
  stableProjectId: string
  anchorKind: 'mr'
  /** The MR/PR number as the host addresses it. */
  anchorId: string
  /** Head commit this round reviews; the baseline for invalidation. */
  headSha: string
  targetBranch: string | null
  /** Mutable display data — for the UI and comments, never for identity. */
  meta: {
    title: string | null
    url: string | null
    repoPath: string | null
  }
}

export type ResolveTargetResult =
  | { ok: true; target: RoundTarget }
  | { ok: false; missing: readonly string[]; message: string }

/**
 * Resolve the round's target from the frozen trigger context.
 *
 * `codeHostEndpointId` is threaded separately: it is a platform concept (which
 * configured connection), not something the webhook payload carries.
 */
export function resolveTarget(
  webhook: WebhookTriggerFields,
  codeHostEndpointId: string,
): ResolveTargetResult {
  const missing: string[] = []

  const provider = webhook.provider
  if (provider !== 'gitlab' && provider !== 'github') missing.push('provider')

  const stableProjectId = webhook.project_id ?? ''
  if (stableProjectId === '') missing.push('project_id')

  const anchorId = webhook.mr_iid ?? ''
  if (anchorId === '') missing.push('mr_iid')

  const headSha = webhook.commit_sha ?? ''
  if (headSha === '') missing.push('commit_sha')

  if (codeHostEndpointId === '') missing.push('codeHostEndpointId')

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      // Names every missing field at once: fixing a trigger config one
      // round-trip per field is how a first-time setup takes an afternoon.
      message: `cannot resolve the review target — the trigger context is missing: ${missing.join(', ')}`,
    }
  }

  return {
    ok: true,
    target: {
      provider: provider as 'gitlab' | 'github',
      codeHostEndpointId,
      stableProjectId,
      anchorKind: 'mr',
      anchorId,
      headSha,
      targetBranch: webhook.target_branch ?? null,
      meta: {
        title: webhook.mr_title ?? null,
        url: webhook.mr_url ?? null,
        repoPath: webhook.repo_path ?? null,
      },
    },
  }
}

/**
 * The work item identity key this target belongs to.
 *
 * Built here so every caller derives it the same way — a second construction
 * site that ordered the parts differently would create a parallel work item for
 * the same MR, and neither would see the other's ledger.
 */
export function workItemKeyOf(
  target: RoundTarget,
  capability: string,
): {
  codeHostEndpointId: string
  stableProjectId: string
  capability: string
  anchorKind: string
  anchorId: string
} {
  return {
    codeHostEndpointId: target.codeHostEndpointId,
    stableProjectId: target.stableProjectId,
    capability,
    anchorKind: target.anchorKind,
    anchorId: target.anchorId,
  }
}
