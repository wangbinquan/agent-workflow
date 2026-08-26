// RFC-328 — deterministic read-only probes for ambiguous managed code-host
// mutations. The probe never sends a second mutation; it either proves the
// requested projection, proves the exact GitLab draft still exists, or leaves
// the operation for actor-authorized replay.

import type { FetchLike, ResolvedCodeHostConnection } from '@/services/codeHost/connections'
import { codeHostTlsRequestInit } from '@/services/codeHost/connections'
import { buildCodeHostUrl } from '@/services/codeHost/url'
import {
  classifyCodeHostProbeResponse,
  codeHostRecoveryBaseUrlDigest,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '@/modules/task-execution/domain/codeHostRecovery'

const MAX_PROBE_RESPONSE_BYTES = 256 * 1024
const DEFAULT_PROBE_TIMEOUT_MS = 30_000

function probeHeaders(connection: ResolvedCodeHostConnection): Record<string, string> {
  return connection.provider === 'gitlab'
    ? { 'PRIVATE-TOKEN': connection.token, Accept: 'application/json' }
    : {
        Authorization: `Bearer ${connection.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
}

function splitPathAndQuery(value: string): {
  path: string
  query: Readonly<Record<string, string>>
} {
  const at = value.indexOf('?')
  if (at < 0) return { path: value, query: {} }
  const query: Record<string, string> = {}
  for (const [key, item] of new URLSearchParams(value.slice(at + 1))) query[key] = item
  return { path: value.slice(0, at), query }
}

function unknown(code: string): CodeHostProbeOutcome {
  return { kind: 'unknown', proofCode: code, responseStatus: null, responseBody: '' }
}

export async function probeCodeHostMutation(input: {
  descriptor: CodeHostRecoveryDescriptor
  resolveConnection: (
    provider: CodeHostRecoveryDescriptor['provider'],
  ) => ResolvedCodeHostConnection | null
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<CodeHostProbeOutcome> {
  if (input.descriptor.probe.kind === 'actor-replay') {
    return unknown('actor-replay-required')
  }
  const connection = input.resolveConnection(input.descriptor.provider)
  if (connection === null || connection.provider !== input.descriptor.provider) {
    return unknown('probe-connection-unavailable')
  }
  if (codeHostRecoveryBaseUrlDigest(connection.baseUrl) !== input.descriptor.baseUrlDigest) {
    return unknown('probe-endpoint-generation-drift')
  }
  if (
    input.descriptor.connectionGeneration !== null &&
    connection.connectionGeneration !== input.descriptor.connectionGeneration
  ) {
    return unknown('probe-connection-generation-drift')
  }
  const target = splitPathAndQuery(input.descriptor.probe.pathname)
  const built = buildCodeHostUrl(connection.baseUrl, target.path, target.query)
  if (!built.ok) return unknown('probe-path-invalid')

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
  )
  try {
    const doFetch = input.fetchImpl ?? ((url, init) => fetch(url, init))
    const response = await doFetch(built.value.url, {
      method: 'GET',
      headers: probeHeaders(connection),
      redirect: 'manual',
      ...codeHostTlsRequestInit(connection),
      signal: controller.signal,
    })
    const responseBody = (await response.text()).slice(0, MAX_PROBE_RESPONSE_BYTES)
    return classifyCodeHostProbeResponse({
      descriptor: input.descriptor,
      status: response.status,
      body: responseBody,
    })
  } catch {
    return unknown('probe-network-error')
  } finally {
    clearTimeout(timer)
  }
}
