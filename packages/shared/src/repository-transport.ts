// RFC-321 — pure repository remote description and managed HTTP(S) resolution.
//
// Git has no discovery protocol that turns an SSH clone URL into an HTTP clone
// URL. This module therefore implements only the approved deterministic chain:
// verified provider candidate -> explicit admin mapping -> exact SaaS rule.

import type { CodeHostProvider } from './schemas/webhook'
import type {
  RepositoryEndpointCandidate,
  RepositoryEndpointSource,
  RepositoryTransportMappingV1,
} from './schemas/repositoryTransport'
import { parseGitUrl } from './git-url'

export type RepositoryRemoteDescriptor =
  | {
      readonly transport: 'ssh'
      readonly host: string
      readonly port: number | null
      readonly project: string
    }
  | {
      readonly transport: 'http'
      readonly scheme: 'http' | 'https'
      readonly host: string
      readonly port: number | null
      readonly project: string
      readonly hadUserInfo: boolean
    }
  | { readonly transport: 'file'; readonly pathRef: string }

export type DescribeRepositoryRemoteResult =
  | { readonly ok: true; readonly value: RepositoryRemoteDescriptor }
  | { readonly ok: false; readonly issue: string }

export interface NormalizedRepositoryTransportMapping {
  readonly sshHost: string
  readonly sshPort: number
  readonly sshPathPrefix: string
  readonly httpBaseUrl: string
}

export type NormalizeRepositoryTransportMappingsResult =
  | { readonly ok: true; readonly value: readonly NormalizedRepositoryTransportMapping[] }
  | { readonly ok: false; readonly issue: string }

export interface ResolvedRepositoryHttpEndpoint {
  readonly provider: CodeHostProvider
  readonly project: string
  readonly url: string
  readonly source: RepositoryEndpointSource
}

export type ResolveManagedRepositoryHttpEndpointResult =
  | { readonly ok: true; readonly endpoint: ResolvedRepositoryHttpEndpoint }
  | {
      readonly ok: false
      readonly code: 'repository-http-endpoint-unresolved' | 'repository-http-endpoint-untrusted'
      readonly issue: string
    }

const HOST_RE = /^[a-z0-9.-]+$/
const ENCODED_PATH_SEPARATOR_RE = /%(?:2f|5c)/i
const HTTP_URL_RE = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i

interface ParsedHttpUrl {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number | null
  readonly path: string
  readonly hadUserInfo: boolean
}

function normalizeProjectPath(raw: string): string | null {
  let project = raw
  while (project.startsWith('/')) project = project.slice(1)
  while (project.endsWith('/')) project = project.slice(0, -1)
  if (project.endsWith('.git')) project = project.slice(0, -4)
  if (project.length === 0 || project.length > 2048) return null
  if (project.includes('\\') || project.includes('?') || project.includes('#')) return null
  if (ENCODED_PATH_SEPARATOR_RE.test(project)) return null
  const segments = project.split('/')
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return null
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('\0')) return null
  }
  return project
}

function foldedPort(scheme: 'http' | 'https', raw: number | null): number | null {
  if ((scheme === 'http' && raw === 80) || (scheme === 'https' && raw === 443)) return null
  return raw
}

/** Shared intentionally has no DOM/Node URL type; parse the admitted narrow shape here. */
function parseHttpAbsoluteUrl(raw: string): ParsedHttpUrl | null {
  const match = HTTP_URL_RE.exec(raw.trim())
  if (match === null) return null
  const scheme = match[1]!.toLowerCase() as 'http' | 'https'
  let authority = match[2]!
  const at = authority.lastIndexOf('@')
  const hadUserInfo = at >= 0
  if (hadUserInfo) {
    if (at === 0) return null
    authority = authority.slice(at + 1)
  }
  let host = authority
  let port: number | null = null
  const colon = authority.lastIndexOf(':')
  if (colon >= 0) {
    host = authority.slice(0, colon)
    const rawPort = authority.slice(colon + 1)
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null
    port = parsedPort
  }
  host = host.toLowerCase()
  if (!HOST_RE.test(host) || host.startsWith('.') || host.endsWith('.')) return null
  const path = match[3] ?? ''
  if (path.includes('\\') || ENCODED_PATH_SEPARATOR_RE.test(path)) return null
  for (const segment of path.replace(/%2e/gi, '.').split('/')) {
    if (segment === '.' || segment === '..') return null
  }
  return { scheme, host, port: foldedPort(scheme, port), path, hadUserInfo }
}

function formatHttpUrl(input: ParsedHttpUrl & { readonly path: string }): string {
  const defaultPort = input.scheme === 'https' ? 443 : 80
  const authority = `${input.host}${input.port === null || input.port === defaultPort ? '' : `:${input.port}`}`
  return `${input.scheme}://${authority}${input.path}`
}

export function describeRepositoryRemote(raw: string): DescribeRepositoryRemoteResult {
  const parsed = parseGitUrl(raw)
  if (parsed === null) return { ok: false, issue: 'remote-invalid' }
  if (parsed.kind === 'file')
    return { ok: true, value: { transport: 'file', pathRef: parsed.path } }

  const project = normalizeProjectPath(parsed.path)
  if (project === null) return { ok: false, issue: 'project-invalid' }
  const host = parsed.host.toLowerCase()
  if (!HOST_RE.test(host)) return { ok: false, issue: 'host-invalid' }

  if (parsed.kind === 'ssh-scp' || parsed.kind === 'ssh-uri') {
    const port = parsed.kind === 'ssh-uri' && parsed.port !== 22 ? parsed.port : null
    return { ok: true, value: { transport: 'ssh', host, port, project } }
  }

  const url = parseHttpAbsoluteUrl(parsed.raw)
  if (url === null) return { ok: false, issue: 'remote-invalid' }
  const scheme = parsed.kind
  return {
    ok: true,
    value: {
      transport: 'http',
      scheme,
      host,
      port: foldedPort(scheme, parsed.port),
      project,
      hadUserInfo: url.hadUserInfo,
    },
  }
}

function normalizeHttpBaseUrl(raw: string): string | null {
  const url = parseHttpAbsoluteUrl(raw)
  if (url === null || url.hadUserInfo) return null
  let path = url.path
  while (path.endsWith('/')) path = path.slice(0, -1)
  return formatHttpUrl({ ...url, path })
}

function normalizeMappingPrefix(raw: string | undefined): string | null {
  if (raw === undefined) return ''
  let value = raw
  while (value.startsWith('/')) value = value.slice(1)
  while (value.endsWith('/')) value = value.slice(0, -1)
  if (value === '') return ''
  const sentinel = normalizeProjectPath(`${value}/repository`)
  return sentinel === null ? null : value
}

export function normalizeRepositoryTransportMappings(
  mappings: readonly RepositoryTransportMappingV1[],
): NormalizeRepositoryTransportMappingsResult {
  const normalized: NormalizedRepositoryTransportMapping[] = []
  const exact = new Set<string>()
  const targetBindings = new Map<string, string>()
  for (const [index, mapping] of mappings.entries()) {
    const sshHost = mapping.sshHost.trim().toLowerCase()
    if (!HOST_RE.test(sshHost) || sshHost.startsWith('.') || sshHost.endsWith('.')) {
      return { ok: false, issue: `mapping-${index}-ssh-host-invalid` }
    }
    const sshPort = mapping.sshPort ?? 22
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      return { ok: false, issue: `mapping-${index}-ssh-port-invalid` }
    }
    const sshPathPrefix = normalizeMappingPrefix(mapping.sshPathPrefix)
    if (sshPathPrefix === null) {
      return { ok: false, issue: `mapping-${index}-ssh-prefix-invalid` }
    }
    const httpBaseUrl = normalizeHttpBaseUrl(mapping.httpBaseUrl)
    if (httpBaseUrl === null) {
      return { ok: false, issue: `mapping-${index}-http-base-invalid` }
    }
    const item = { sshHost, sshPort, sshPathPrefix, httpBaseUrl }
    const key = JSON.stringify(item)
    if (exact.has(key)) continue
    const targetKey = `${sshHost}\0${sshPort}\0${sshPathPrefix}`
    const existingBase = targetBindings.get(targetKey)
    if (existingBase !== undefined && existingBase !== httpBaseUrl) {
      return { ok: false, issue: `mapping-${index}-ssh-target-conflict` }
    }
    exact.add(key)
    targetBindings.set(targetKey, httpBaseUrl)
    normalized.push(item)
  }
  normalized.sort(
    (left, right) =>
      right.sshPathPrefix.length - left.sshPathPrefix.length ||
      left.sshHost.localeCompare(right.sshHost) ||
      left.sshPort - right.sshPort ||
      left.httpBaseUrl.localeCompare(right.httpBaseUrl),
  )
  return { ok: true, value: normalized }
}

function projectMatchesPrefix(project: string, prefix: string): boolean {
  return prefix === '' || project === prefix || project.startsWith(`${prefix}/`)
}

function appendProject(base: string, suffix: string): string | null {
  if (suffix.length === 0) return null
  const normalized = normalizeHttpBaseUrl(base)
  if (normalized === null) return null
  const url = parseHttpAbsoluteUrl(normalized)
  if (url === null) return null
  const path = `${url.path.replace(/\/$/, '')}/${suffix}.git`.replace(/\/{2,}/g, '/')
  return formatHttpUrl({ ...url, path })
}

function isWithinBase(url: ParsedHttpUrl, rawBase: string): boolean {
  const base = parseHttpAbsoluteUrl(rawBase)
  if (base === null || base.hadUserInfo) return false
  if (url.scheme !== base.scheme || url.host !== base.host || url.port !== base.port) return false
  const basePath = base.path.replace(/\/$/, '')
  return basePath === '' || basePath === '/' || url.path.startsWith(`${basePath}/`)
}

function validateHttpEndpoint(input: {
  rawUrl: string
  project: string
  allowHttp: boolean
  allowedBases: readonly string[]
}): string | null {
  const url = parseHttpAbsoluteUrl(input.rawUrl)
  if (url === null || url.hadUserInfo) return null
  if (url.scheme !== 'https' && !(input.allowHttp && url.scheme === 'http')) return null
  if (
    input.allowedBases.length > 0 &&
    !input.allowedBases.some((base) => isWithinBase(url, base))
  ) {
    return null
  }
  const endpointProject = normalizeProjectPath(url.path)
  if (endpointProject === null) return null
  if (endpointProject !== input.project && !endpointProject.endsWith(`/${input.project}`))
    return null
  const path = `${url.path.replace(/\/$/, '').replace(/\.git$/, '')}.git`
  return formatHttpUrl({ ...url, path })
}

function mappingEndpoint(input: {
  descriptor: Extract<RepositoryRemoteDescriptor, { transport: 'ssh' }>
  mappings: readonly NormalizedRepositoryTransportMapping[]
}):
  | { readonly kind: 'none' }
  | { readonly kind: 'tie' }
  | {
      readonly kind: 'resolved'
      readonly url: string
      readonly base: string
      readonly mappedProject: string
    } {
  const port = input.descriptor.port ?? 22
  const candidates = input.mappings.filter(
    (mapping) =>
      mapping.sshHost === input.descriptor.host &&
      mapping.sshPort === port &&
      projectMatchesPrefix(input.descriptor.project, mapping.sshPathPrefix),
  )
  if (candidates.length === 0) return { kind: 'none' }
  const longest = candidates[0]!.sshPathPrefix.length
  const winners = candidates.filter((candidate) => candidate.sshPathPrefix.length === longest)
  if (winners.length !== 1) return { kind: 'tie' }
  const winner = winners[0]!
  const suffix =
    winner.sshPathPrefix === ''
      ? input.descriptor.project
      : input.descriptor.project.slice(winner.sshPathPrefix.length).replace(/^\//, '')
  const url = appendProject(winner.httpBaseUrl, suffix)
  return url === null
    ? { kind: 'none' }
    : {
        kind: 'resolved',
        url,
        base: winner.httpBaseUrl,
        mappedProject: suffix,
      }
}

function saasBase(provider: CodeHostProvider, host: string): string | null {
  if (provider === 'github' && host === 'github.com') return 'https://github.com'
  if (provider === 'gitlab' && host === 'gitlab.com') return 'https://gitlab.com'
  return null
}

export function resolveManagedRepositoryHttpEndpoint(input: {
  remoteUrl: string
  provider: CodeHostProvider
  connectionGeneration: string
  mappings: readonly RepositoryTransportMappingV1[]
  allowedHttpBaseUrls?: readonly string[]
  apiCandidate?: RepositoryEndpointCandidate | null
}): ResolveManagedRepositoryHttpEndpointResult {
  const described = describeRepositoryRemote(input.remoteUrl)
  if (!described.ok || described.value.transport === 'file') {
    return {
      ok: false,
      code: 'repository-http-endpoint-unresolved',
      issue: !described.ok ? described.issue : 'local-fixture-has-no-http-endpoint',
    }
  }
  const normalizedMappings = normalizeRepositoryTransportMappings(input.mappings)
  if (!normalizedMappings.ok) {
    return {
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      issue: normalizedMappings.issue,
    }
  }
  const descriptor = described.value
  const mappingBases = normalizedMappings.value.map((mapping) => mapping.httpBaseUrl)
  const saas = saasBase(input.provider, descriptor.host)
  const allowedBases = [
    ...(input.allowedHttpBaseUrls ?? []),
    ...mappingBases,
    ...(saas === null ? [] : [saas]),
  ]

  if (descriptor.transport === 'http') {
    const path = `/${descriptor.project}.git`
    const raw = formatHttpUrl({
      scheme: descriptor.scheme,
      host: descriptor.host,
      port: descriptor.port,
      path,
      hadUserInfo: false,
    })
    const inputUrl = parseHttpAbsoluteUrl(raw)
    const allowHttp =
      inputUrl !== null &&
      normalizedMappings.value.some(
        (mapping) =>
          mapping.httpBaseUrl.startsWith('http://') && isWithinBase(inputUrl, mapping.httpBaseUrl),
      )
    const endpoint = validateHttpEndpoint({
      rawUrl: raw,
      project: descriptor.project,
      // A direct cleartext remote needs an explicit mapping for that exact
      // HTTP base. An unrelated cleartext mapping cannot act as a global
      // downgrade switch for every allowed repository authority.
      allowHttp,
      allowedBases,
    })
    return endpoint === null
      ? {
          ok: false,
          code: 'repository-http-endpoint-untrusted',
          issue: 'input-http-endpoint-outside-connection',
        }
      : {
          ok: true,
          endpoint: {
            provider: input.provider,
            project: descriptor.project,
            url: endpoint,
            source: 'input-http',
          },
        }
  }

  if (input.apiCandidate !== undefined && input.apiCandidate !== null) {
    const candidate = input.apiCandidate
    if (
      candidate.provider !== input.provider ||
      candidate.connectionGeneration !== input.connectionGeneration ||
      normalizeProjectPath(candidate.project) !== descriptor.project
    ) {
      return {
        ok: false,
        code: 'repository-http-endpoint-untrusted',
        issue: 'provider-candidate-binding-mismatch',
      }
    }
    const candidateUrl = parseHttpAbsoluteUrl(candidate.url)
    const allowHttp =
      candidateUrl !== null &&
      normalizedMappings.value.some(
        (mapping) =>
          mapping.httpBaseUrl.startsWith('http://') &&
          isWithinBase(candidateUrl, mapping.httpBaseUrl),
      )
    const endpoint = validateHttpEndpoint({
      rawUrl: candidate.url,
      project: descriptor.project,
      // Provider metadata does not grant a cleartext downgrade by itself. An
      // administrator must have admitted this exact HTTP base via a transport
      // mapping; an unrelated HTTP mapping cannot authorize the candidate.
      allowHttp,
      allowedBases,
    })
    return endpoint === null
      ? {
          ok: false,
          code: 'repository-http-endpoint-untrusted',
          issue: 'provider-candidate-endpoint-untrusted',
        }
      : {
          ok: true,
          endpoint: {
            provider: input.provider,
            project: descriptor.project,
            url: endpoint,
            source: 'provider-api',
          },
        }
  }

  const mapped = mappingEndpoint({ descriptor, mappings: normalizedMappings.value })
  if (mapped.kind === 'tie') {
    return {
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      issue: 'admin-mapping-tie',
    }
  }
  if (mapped.kind === 'resolved') {
    const endpoint = validateHttpEndpoint({
      rawUrl: mapped.url,
      // An explicit path-prefix mapping is allowed to rebase
      // `sshHost/old-prefix/project` onto `httpBase/new-prefix/project`.
      // Validate the constructed mapped suffix inside the trusted HTTP base;
      // the public endpoint identity below remains the original project.
      project: mapped.mappedProject,
      allowHttp: mapped.base.startsWith('http://'),
      allowedBases: [mapped.base],
    })
    if (endpoint === null) {
      return {
        ok: false,
        code: 'repository-http-endpoint-untrusted',
        issue: 'admin-mapping-endpoint-untrusted',
      }
    }
    return {
      ok: true,
      endpoint: {
        provider: input.provider,
        project: descriptor.project,
        url: endpoint,
        source: 'admin-mapping',
      },
    }
  }

  if (saas !== null) {
    const endpoint = appendProject(saas, descriptor.project)
    if (endpoint !== null) {
      return {
        ok: true,
        endpoint: {
          provider: input.provider,
          project: descriptor.project,
          url: endpoint,
          source: 'saas-convention',
        },
      }
    }
  }

  return {
    ok: false,
    code: 'repository-http-endpoint-unresolved',
    issue: 'no-trusted-http-endpoint',
  }
}

export function canonicalRepositoryTransportBinding(input: {
  version: 1
  provider: CodeHostProvider
  connectionGeneration: string
  apiBaseUrl: string
  rejectUnauthorized: boolean
  transportMappings: readonly RepositoryTransportMappingV1[]
  allowedHttpBaseUrls?: readonly string[]
}): string | null {
  const apiBaseUrl = normalizeHttpBaseUrl(input.apiBaseUrl)
  const mappings = normalizeRepositoryTransportMappings(input.transportMappings)
  const allowedHttpBaseUrls: string[] = []
  for (const raw of input.allowedHttpBaseUrls ?? []) {
    const base = normalizeHttpBaseUrl(raw)
    if (base === null) return null
    if (!allowedHttpBaseUrls.includes(base)) allowedHttpBaseUrls.push(base)
  }
  allowedHttpBaseUrls.sort()
  if (apiBaseUrl === null || !mappings.ok) return null
  return JSON.stringify({
    version: 1,
    provider: input.provider,
    connectionGeneration: input.connectionGeneration,
    apiBaseUrl,
    rejectUnauthorized: input.rejectUnauthorized,
    transportMappings: mappings.value,
    allowedHttpBaseUrls,
  })
}
