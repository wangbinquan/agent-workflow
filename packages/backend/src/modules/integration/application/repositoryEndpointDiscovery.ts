// RFC-321 T7 — provider-owned GitHub/GitLab repository metadata query.
// Integration resolves the daemon's global code-host connection at call time;
// source-control receives only a secret-free endpoint candidate.

import { RepositoryEndpointCandidateSchema, type CodeHostProvider } from '@agent-workflow/shared'

import { timeoutSignal } from '@/util/timeoutSignal'

export interface RepositoryEndpointConnection {
  readonly provider: CodeHostProvider
  readonly apiBaseUrl: string
  readonly connectionGeneration: string
  readonly token: string
  readonly rejectUnauthorized: boolean
}

export type RepositoryEndpointFetch = (url: string, init?: BunFetchRequestInit) => Promise<Response>

function metadataPath(provider: CodeHostProvider, project: string): string | null {
  const segments = project.split('/').filter((segment) => segment !== '')
  if (segments.length < 2) return null
  if (provider === 'gitlab') return `/projects/${encodeURIComponent(segments.join('/'))}`
  if (segments.length !== 2) return null
  return `/repos/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(segments[1]!)}`
}

function headersFor(provider: CodeHostProvider, token: string): Record<string, string> {
  return provider === 'gitlab'
    ? { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
    : {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
}

export function createRepositoryEndpointDiscovery(input: {
  readonly resolveConnection: (
    provider: CodeHostProvider,
  ) => RepositoryEndpointConnection | null
  readonly fetchImpl?: RepositoryEndpointFetch
}) {
  return {
    async discover(request: {
      readonly provider: CodeHostProvider
      readonly project: string
      readonly connectionGeneration: string
    }) {
      const connection = input.resolveConnection(request.provider)
      if (
        connection === null ||
        connection.provider !== request.provider ||
        connection.connectionGeneration !== request.connectionGeneration
      ) {
        return null
      }
      const path = metadataPath(request.provider, request.project)
      if (path === null) return null
      const doFetch = input.fetchImpl ?? ((url, init) => fetch(url, init))
      const deadline = timeoutSignal(15_000)
      try {
        const response = await doFetch(`${connection.apiBaseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'GET',
          headers: headersFor(connection.provider, connection.token),
          redirect: 'manual',
          signal: deadline.signal,
          ...(connection.rejectUnauthorized ? {} : { tls: { rejectUnauthorized: false } }),
        })
        if (!response.ok) return null
        const text = await response.text()
        if (text.length > 64 * 1024) return null
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return null
        }
        if (body === null || typeof body !== 'object') return null
        const url = (body as Record<string, unknown>)[
          connection.provider === 'gitlab' ? 'http_url_to_repo' : 'clone_url'
        ]
        const parsed = RepositoryEndpointCandidateSchema.safeParse({
          provider: connection.provider,
          project: request.project,
          connectionGeneration: connection.connectionGeneration,
          url,
          source: 'provider-api',
        })
        return parsed.success ? parsed.data : null
      } catch {
        return null
      } finally {
        deadline.cancel()
      }
    },
  }
}
