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

export type ProjectAddress =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string }

/**
 * How to ADDRESS this project in an API path — which is not how to identify it.
 *
 * The two differ per provider, and the difference is the reason this function
 * sits next to `workItemKeyOf` instead of in its own file: a reader who sees
 * only one of them reaches for the wrong projection.
 *
 *   GitLab  `/projects/{id}` accepts the numeric project id directly, so the
 *           stable identity doubles as the address. Nothing to reconcile.
 *   GitHub  `/repos/{owner}/{repo}` takes the PATH. The numeric repository id
 *           is not accepted on this route, so the address has to come from the
 *           mutable display snapshot even though identity never may.
 *
 * When GitHub has no path, this refuses. The tempting alternative — send the
 * numeric id and let the host 404 — is merely loud, but the other tempting
 * alternative is not: `services/codeHost/project.ts` already records why a
 * path-shaped value must never be sent on a hunch, because a repository that
 * belongs to a different host will happily resolve to a same-named project on
 * this one, and the round then comments on a stranger's code.
 */
export function apiProjectAddress(target: RoundTarget): ProjectAddress {
  if (target.provider === 'gitlab') return { ok: true, value: target.stableProjectId }

  const path = target.meta.repoPath ?? ''
  if (path === '') {
    return {
      ok: false,
      message:
        'GitHub addresses a repository by owner/repo and the trigger context carries no repository path — the numeric id cannot be used on this route',
    }
  }
  return { ok: true, value: path }
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
