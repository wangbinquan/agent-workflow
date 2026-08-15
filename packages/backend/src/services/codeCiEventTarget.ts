// RFC-304 T24b — which merge request a fork's CI event belongs to.
//
// A pipeline event from a FORK does not say. GitHub's `pull_requests[]` arrives
// empty for fork PRs because the pipeline ran in the fork's own repository, and
// GitLab's pipeline hook on a fork MR carries the fork's project rather than the
// target's. The only thing the event reliably carries is the commit, so the
// mapping has to run the other way: head sha → open merge request.
//
// Reading the target repository's own list is the same trust decision as
// fetching the head from the target remote (design §6.1): the platform already
// holds credentials there, the fork may be private or deleted, and nothing here
// follows a URL supplied by a third-party webhook payload.
//
// The lookup is bounded on purpose. A repository with hundreds of open MRs
// would otherwise cost a paged crawl on every pipeline event, most of which
// belong to branches nobody is reviewing.

import {
  resolveCiEventMr,
  type CiEventTarget,
  type OpenMrCandidate,
} from '@/modules/code-capability/domain/capabilityWake'
import {
  apiProjectAddress,
  type ProjectAddressable,
} from '@/modules/code-capability/domain/resolveTarget'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'

/** How many open MRs are considered before giving up on the mapping. */
export const CI_EVENT_MR_SCAN_LIMIT = 100

export type CiEventLookup =
  | { ok: true; target: CiEventTarget }
  /** The host could not be read; the caller must not guess from that. */
  | { ok: false; message: string }

/**
 * Read a project's open merge requests into the shape the decision needs.
 *
 * Both hosts report the head commit, in different places: GitLab puts it at
 * `sha` on the MR, GitHub nests it under `head.sha`. Reading the wrong one
 * yields no matches at all, which would look exactly like "this commit belongs
 * to no open MR" — a silent no-op rather than a visible error.
 */
export function parseOpenMrs(provider: 'gitlab' | 'github', body: string): OpenMrCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: OpenMrCandidate[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    if (provider === 'github') {
      const number = row.number
      const head = row.head
      const sha =
        typeof head === 'object' && head !== null ? (head as { sha?: unknown }).sha : undefined
      if ((typeof number === 'number' || typeof number === 'string') && typeof sha === 'string') {
        out.push({ mrIid: String(number), headSha: sha })
      }
      continue
    }

    const iid = row.iid
    const sha = row.sha
    if ((typeof iid === 'number' || typeof iid === 'string') && typeof sha === 'string') {
      out.push({ mrIid: String(iid), headSha: sha })
    }
  }
  return out
}

/**
 * Find the open merge request a CI event's commit heads.
 *
 * Returns the domain's verdict rather than an MR id, because `ambiguous` and
 * `none` are different answers the caller must handle differently — and neither
 * is an error worth failing a delivery over.
 */
export async function lookupCiEventMr(input: {
  codeHost: CodeHostPort
  target: ProjectAddressable
  headSha: string
  limit?: number
}): Promise<CiEventLookup> {
  const project = apiProjectAddress(input.target)
  if (!project.ok) return { ok: false, message: project.message }

  const listed = await input.codeHost.call({
    action: 'mr.list',
    params: {
      project: project.value,
      mr_state: 'open',
      per_page: String(input.limit ?? CI_EVENT_MR_SCAN_LIMIT),
    },
  })
  if (!listed.ok) {
    return {
      ok: false,
      message: `could not list open merge requests to place this CI event (${listed.code}: ${listed.message})`,
    }
  }

  return {
    ok: true,
    target: resolveCiEventMr(parseOpenMrs(input.target.provider, listed.body), input.headSha),
  }
}
