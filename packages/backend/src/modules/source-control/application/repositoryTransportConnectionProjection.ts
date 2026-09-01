import {
  canonicalRepositoryTransportBinding,
  normalizeGitLabRepositoryUrlPrefix,
  normalizeRepositoryTransportMappings,
  RepositoryTransportMappingV1Schema,
  type CodeHostProvider,
  type RepositoryTransportMappingV1,
} from '@agent-workflow/shared'

import { sha256Hex } from '@/util/hash'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportConnectionProjectionSource,
} from '../ports/repositoryTransportCredentialRepository'

function parseTransportMappings(raw: string): RepositoryTransportMappingV1[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = RepositoryTransportMappingV1Schema.array().max(32).safeParse(value)
  if (!parsed.success) return []
  const normalized = normalizeRepositoryTransportMappings(parsed.data)
  if (!normalized.ok) return []
  return normalized.value.map((mapping) => ({
    sshHost: mapping.sshHost,
    sshPort: mapping.sshPort,
    ...(mapping.sshPathPrefix === '' ? {} : { sshPathPrefix: mapping.sshPathPrefix }),
    httpBaseUrl: mapping.httpBaseUrl,
  }))
}

function parseAllowedBases(raw: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return []
    const normalized = normalizeGitLabRepositoryUrlPrefix(item)
    if (!normalized.ok) return []
    if (!out.includes(normalized.value)) out.push(normalized.value)
  }
  return out
}

function providerWebBase(provider: CodeHostProvider, apiBaseUrl: string): string | null {
  if (provider === 'gitlab') {
    return apiBaseUrl.endsWith('/api/v4') ? apiBaseUrl.slice(0, -'/api/v4'.length) : null
  }
  if (apiBaseUrl === 'https://api.github.com') return 'https://github.com'
  return apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : null
}

/** Derive the source-control projection without exposing plaintext credentials. */
export function buildRepositoryTransportConnectionProjection(
  input: RepositoryTransportConnectionProjectionSource,
): RepositoryTransportConnectionProjectionInput {
  const transportMappings = parseTransportMappings(input.transportMappingsJson)
  const allowedHttpBaseUrls = parseAllowedBases(input.repositoryUrlPrefixesJson)
  const webBase = providerWebBase(input.provider, input.baseUrl)
  if (webBase !== null && !allowedHttpBaseUrls.includes(webBase)) allowedHttpBaseUrls.push(webBase)
  for (const mapping of transportMappings) {
    const normalized = normalizeGitLabRepositoryUrlPrefix(mapping.httpBaseUrl)
    if (normalized.ok && !allowedHttpBaseUrls.includes(normalized.value)) {
      allowedHttpBaseUrls.push(normalized.value)
    }
  }
  allowedHttpBaseUrls.sort()
  const canonical = canonicalRepositoryTransportBinding({
    version: 1,
    provider: input.provider,
    connectionGeneration: input.connectionGeneration,
    apiBaseUrl: input.baseUrl,
    rejectUnauthorized: input.rejectUnauthorized,
    transportMappings,
    allowedHttpBaseUrls,
  })
  if (canonical === null) {
    throw new Error(`invalid repository transport binding for ${input.provider}`)
  }
  return {
    provider: input.provider,
    connectionGeneration: input.connectionGeneration,
    endpointBindingDigest: sha256Hex(canonical),
    apiBaseUrl: input.baseUrl,
    rejectUnauthorized: input.rejectUnauthorized,
    transportMappings,
    allowedHttpBaseUrls,
    globalTokenEnc: input.tokenEnc,
    globalTokenHint: input.tokenHint,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
  }
}
