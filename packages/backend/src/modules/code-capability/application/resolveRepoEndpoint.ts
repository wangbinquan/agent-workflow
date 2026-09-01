// RFC-304 — the endpoint a repository's capability cells are keyed to.
//
// `PUT /api/code/matrix/:repoId` resolved this with a hardcoded `'gitlab'`, so
// enabling ANY capability on a GitHub repository failed with "no enabled gitlab
// webhook endpoint is configured" — naming a provider the operator had never
// configured. GitHub repositories could not be configured at all, and the
// entire e2e suite drove GitLab so nothing caught it.
//
// Lives in the module rather than the route for two reasons: `no-routes-to-db`
// forbids a route reaching the schema (RFC-294 layering), and the endpoint is a
// component of the work item's identity — deciding it is domain work, not
// request parsing.
//
// ## Why endpoints decide, and connections only disambiguate
//
// The webhook endpoint already carries a provider, and a deployment cannot
// receive a repository's events without one. So the endpoints ARE the answer
// whenever they are unanimous — which also preserves the behaviour that existed
// before this fix: a deployment that has an endpoint but has not yet configured
// a code-host connection can still switch capabilities on and see readiness
// report the missing connection, rather than being refused at the door.
//
// Only when two providers both have endpoints does the repository's URL have to
// break the tie, and only then can it fail to.

import type {
  CodeHostProvider,
  RepoEndpointReadPort,
} from '@/modules/code-capability/application/ports/repoEndpointRead'
import {
  resolveRepoProvider,
  type ConnectionCandidate,
} from '@/modules/code-capability/domain/repoProvider'

export type RepoEndpointVerdict =
  | { ok: true; provider: 'gitlab' | 'github'; endpointId: string }
  | { ok: false; message: string }

/** Stored as JSON text; a malformed value means "no prefixes", never a throw. */
function parseUrlPrefixes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export async function resolveRepoEndpoint(
  reader: RepoEndpointReadPort,
  repoId: string,
): Promise<RepoEndpointVerdict> {
  const endpoints = await reader.listEnabledEndpoints()

  if (endpoints.length === 0) {
    return {
      ok: false,
      message:
        'no enabled webhook endpoint is configured, so this repository has no identity to key its findings to',
    }
  }

  const providers = [...new Set(endpoints.map((row) => row.provider))]

  // Unanimous endpoints answer on their own — the common deployment, and the
  // one that used to work before this resolution existed.
  const provider =
    providers.length === 1 ? providers[0]! : await disambiguate(reader, repoId, providers)

  if (typeof provider !== 'string') return provider

  const forProvider = endpoints.filter((row) => row.provider === provider)
  if (forProvider.length > 1) {
    return {
      ok: false,
      message: `${String(forProvider.length)} enabled ${provider} webhook endpoints exist and this repository does not record which one delivers its events — pick one explicitly rather than keying its ledger to an arbitrary endpoint`,
    }
  }
  return { ok: true, provider, endpointId: forProvider[0]!.id }
}

/** Two providers have endpoints; the repository's URL has to decide. */
async function disambiguate(
  reader: RepoEndpointReadPort,
  repoId: string,
  providers: ReadonlyArray<CodeHostProvider>,
): Promise<'gitlab' | 'github' | { ok: false; message: string }> {
  const [repoUrl, connections] = await Promise.all([
    reader.readRepoUrl(repoId),
    reader.listConnections(),
  ])

  const candidates: ConnectionCandidate[] = connections
    .filter((row) => providers.includes(row.provider))
    .map((row) => ({
      provider: row.provider,
      baseUrl: row.baseUrl,
      repositoryUrlPrefixes: parseUrlPrefixes(row.repositoryUrlPrefixesJson),
    }))

  const verdict = resolveRepoProvider(repoUrl, candidates)
  return verdict.ok ? verdict.provider : verdict
}

/** Kept for the readiness path, which asks the same question per capability. */
export async function providerForRepo(
  reader: RepoEndpointReadPort,
  repoId: string,
): Promise<'gitlab' | 'github' | null> {
  const verdict = await resolveRepoEndpoint(reader, repoId)
  return verdict.ok ? verdict.provider : null
}

/**
 * Which webhook endpoint this round's identity is keyed to.
 *
 * The task row does not carry it (the launch path predates the work item), and
 * the schema comment records that this table is expected to hold ONE row. So
 * the single enabled endpoint for the provider is resolved here — and, when
 * that assumption stops holding, this refuses rather than picking one.
 *
 * Picking arbitrarily would be the worst outcome available: the endpoint is a
 * component of the work item's identity key, so a round keyed to the wrong one
 * gets its own parallel ledger, invisible to the one the previous rounds wrote.
 */
export async function resolveCodeHostEndpointId(
  reader: RepoEndpointReadPort,
  provider: CodeHostProvider,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const rows = (await reader.listEnabledEndpoints()).filter(
    (endpoint) => endpoint.provider === provider,
  )

  if (rows.length === 1) return { ok: true, id: rows[0]!.id }
  if (rows.length === 0) {
    return {
      ok: false,
      message: `no enabled ${provider} webhook endpoint is configured, so this round has no identity to key its findings to`,
    }
  }
  return {
    ok: false,
    message: `${rows.length} enabled ${provider} webhook endpoints exist and the task does not record which one delivered this event — pick one explicitly rather than letting the round key its ledger to an arbitrary endpoint`,
  }
}
