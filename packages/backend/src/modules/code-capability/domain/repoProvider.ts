// RFC-304 — which code host a repository belongs to.
//
// `PUT /api/code/matrix/:repoId` resolved its endpoint with a hardcoded
// `'gitlab'`, so enabling ANY capability on a GitHub repository failed with
// "no enabled gitlab webhook endpoint is configured" — a message naming a
// provider the operator never mentioned. GitHub repositories could not be
// configured at all, and no test noticed because the whole e2e suite drove
// GitLab.
//
// The route's own comment had the right reason for resolving server-side: the
// endpoint is a component of the work item's identity, so letting a caller name
// it would let two requests key one repository's cells to different endpoints.
// What it lacked was a way to derive the provider from the repository.
//
// ## Why the host, and why "exactly one" is the only safe answer
//
// A repository's provider is not stored anywhere — it is implied by where the
// repository lives. So this matches the repo's URL host against each configured
// connection, and REFUSES when the answer is ambiguous rather than picking one:
// guessing wrong keys a repository's findings to the wrong instance's ledger,
// and that mistake is invisible until somebody wonders why their merge request
// has no review.

export interface ConnectionCandidate {
  provider: 'gitlab' | 'github'
  /** The API root as configured, e.g. `https://gitlab.acme.com/api/v4`. */
  baseUrl: string
  /** GitLab-only: repository URL prefixes that map to this instance. */
  repositoryUrlPrefixes: readonly string[]
}

export type ProviderVerdict =
  | { ok: true; provider: 'gitlab' | 'github'; because: 'host-match' | 'only-connection' }
  | { ok: false; message: string }

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Which configured code host owns this repository URL.
 *
 * `only-connection` is a deliberate fallback, not laziness: the overwhelmingly
 * common deployment has exactly one code host, and there the repository must
 * belong to it however its clone URL is spelled (a mirror, an SSH alias, a
 * vanity domain in front of the API). Refusing there would block the ordinary
 * case to protect against a configuration nobody has.
 *
 * With two or more connections the host has to decide, because a wrong answer
 * is silent.
 */
export function resolveRepoProvider(
  repoUrl: string | null,
  connections: readonly ConnectionCandidate[],
): ProviderVerdict {
  if (connections.length === 0) {
    return {
      ok: false,
      message:
        'no code-host connection is configured, so this repository cannot be attached to one — configure a connection first',
    }
  }

  const repoHost = repoUrl === null ? null : hostOf(repoUrl)
  if (repoHost !== null) {
    const matches = connections.filter((connection) => {
      const apiHost = hostOf(connection.baseUrl)
      // `api.github.com` serves repositories that live on `github.com`; every
      // other deployment serves its API from the same host as its repositories.
      const expected =
        connection.provider === 'github' && apiHost === 'api.github.com' ? 'github.com' : apiHost
      if (expected !== null && (repoHost === expected || repoHost === `www.${expected}`)) {
        return true
      }
      return connection.repositoryUrlPrefixes.some((prefix) => hostOf(prefix) === repoHost)
    })

    if (matches.length === 1)
      return { ok: true, provider: matches[0]!.provider, because: 'host-match' }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `this repository's host matches ${String(matches.length)} configured code hosts (${matches
          .map((m) => m.provider)
          .join(
            ', ',
          )}) — findings would be keyed to whichever was picked, so name the instance explicitly`,
      }
    }
  }

  if (connections.length === 1) {
    return { ok: true, provider: connections[0]!.provider, because: 'only-connection' }
  }

  return {
    ok: false,
    message: `this repository's URL does not match any of the ${String(connections.length)} configured code hosts (${connections
      .map((c) => c.provider)
      .join(', ')}), so it cannot be keyed to one`,
  }
}
