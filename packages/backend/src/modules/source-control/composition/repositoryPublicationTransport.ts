// RFC-321 — bootstrap-owned repository publication transport composition.
// Selection, provider metadata resolution, endpoint validation, unsealing and
// the exact-target helper are completed once per publication attempt. Consumers
// receive only a sanitized endpoint and a network runner closure.

import {
  describeRepositoryRemote,
  normalizeRepositoryTransportMappings,
  resolveManagedRepositoryHttpEndpoint,
  type CodeHostProvider,
  type RepositoryEndpointCandidate,
  type RepositoryPublicationReceipt,
  type ResolvedRepositoryHttpEndpoint,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createRepositoryEndpointDiscovery } from '@/modules/integration/application/repositoryEndpointDiscovery'
import type { RepositoryGit } from '../application/repositoryCommit'
import { RepositoryTransportCredentials } from '../application/repositoryTransportCredentials'
import {
  credentialFreeHttpUrl,
  leaseGitCredential,
  leaseTargetBoundGitCredential,
  type GitCredentialLease,
} from '../infrastructure/gitCredentialLease'
import { SQLiteRepositoryTransportCredentialRepository } from '../infrastructure/sqliteRepositoryTransportCredentialRepository'
import type { StoredRepositoryTransportConnection } from '../ports/repositoryTransportCredentialRepository'

export type RepositoryPublicationSubject =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'system' }

export type OpenRepositoryPublicationSessionResult =
  | { readonly ok: true; readonly session: RepositoryPublicationSession }
  | {
      readonly ok: false
      readonly code:
        | 'code-host-push-credential-stale'
        | 'code-host-push-credential-unavailable'
        | 'repository-http-endpoint-unresolved'
        | 'repository-http-endpoint-untrusted'
      readonly detail: string
    }

export interface RepositoryPublicationSession {
  readonly endpointUrl: string
  readonly receipt: RepositoryPublicationReceipt
  runNetwork(
    runGit: RepositoryGit,
    repoPath: string,
    args: readonly string[],
    options?: Parameters<RepositoryGit>[2],
  ): ReturnType<RepositoryGit>
  close(): void
}

export interface RepositoryPublicationTransport {
  open(input: {
    readonly subject: RepositoryPublicationSubject
    readonly remoteUrl: string
  }): Promise<OpenRepositoryPublicationSessionResult>
}

function baseMatchesHost(raw: string, host: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase() === host
  } catch {
    return false
  }
}

function isLocalRepositoryRemote(raw: string): boolean {
  const value = raw.trim()
  return (
    isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
}

function connectionMayOwnRemote(
  connection: StoredRepositoryTransportConnection,
  remoteUrl: string,
): boolean {
  const described = describeRepositoryRemote(remoteUrl)
  if (!described.ok || described.value.transport === 'file') return false
  const remote = described.value
  const resolved = resolveManagedRepositoryHttpEndpoint({
    remoteUrl,
    provider: connection.provider,
    connectionGeneration: connection.connectionGeneration,
    mappings: connection.transportMappings,
    allowedHttpBaseUrls: connection.allowedHttpBaseUrls,
  })
  if (resolved.ok) return true
  if (remote.transport !== 'ssh') return false
  const normalized = normalizeRepositoryTransportMappings(connection.transportMappings)
  if (!normalized.ok) return true
  // A valid explicit mapping already resolved above. The remaining SSH case
  // is provider-metadata discovery for a connection whose trusted web base
  // shares the SSH authority.
  return connection.allowedHttpBaseUrls.some((base) => baseMatchesHost(base, remote.host))
}

function legacySession(remoteUrl: string, appHome: string): RepositoryPublicationSession {
  const described = describeRepositoryRemote(remoteUrl)
  const endpointUrl = credentialFreeHttpUrl(remoteUrl) ?? remoteUrl
  const lease = leaseGitCredential(remoteUrl, appHome)
  return sessionOf({
    endpointUrl,
    lease,
    receipt: {
      credentialSource: 'legacy',
      credentialRevision: null,
      endpointSource:
        (described.ok && described.value.transport === 'file') || isLocalRepositoryRemote(remoteUrl)
          ? 'local-fixture'
          : 'legacy-remote',
      endpointBindingDigest: null,
    },
  })
}

function sessionOf(input: {
  readonly endpointUrl: string
  readonly lease: GitCredentialLease | null
  readonly receipt: RepositoryPublicationReceipt
}): RepositoryPublicationSession {
  let closed = false
  return {
    endpointUrl: input.endpointUrl,
    receipt: input.receipt,
    runNetwork(runGit, repoPath, args, options) {
      if (closed) throw new Error('repository publication session is closed')
      return runGit(
        repoPath,
        [...(input.lease?.leadingArgs ?? []), ...args],
        input.lease === null
          ? options
          : {
              ...options,
              env: { ...(options?.env ?? {}), ...input.lease.env },
            },
      )
    },
    close() {
      if (closed) return
      closed = true
      input.lease?.cleanup()
    },
  }
}

function usernameFor(provider: CodeHostProvider): string {
  return provider === 'github' ? 'x-access-token' : 'oauth2'
}

async function discoverEndpointCandidate(input: {
  readonly connection: StoredRepositoryTransportConnection
  readonly project: string
  readonly secretBox: SecretBox
  readonly fetchImpl?: (url: string, init?: BunFetchRequestInit) => Promise<Response>
}): Promise<RepositoryEndpointCandidate | null> {
  let globalLookupToken: string
  try {
    globalLookupToken = input.secretBox.unseal(input.connection.globalTokenEnc)
  } catch {
    // Metadata discovery is best-effort. A missing/corrupt global API credential
    // still permits an administrator mapping or trusted SaaS fallback.
    return null
  }
  return createRepositoryEndpointDiscovery({
    provider: input.connection.provider,
    apiBaseUrl: input.connection.apiBaseUrl,
    connectionGeneration: input.connection.connectionGeneration,
    token: globalLookupToken,
    rejectUnauthorized: input.connection.rejectUnauthorized,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }).discover({
    provider: input.connection.provider,
    project: input.project,
    connectionGeneration: input.connection.connectionGeneration,
  })
}

export function createRepositoryPublicationTransport(input: {
  readonly db: DbClient
  readonly secretBox?: SecretBox
  readonly appHome: string
  readonly fetchImpl?: (url: string, init?: BunFetchRequestInit) => Promise<Response>
}): RepositoryPublicationTransport {
  const repository = new SQLiteRepositoryTransportCredentialRepository(input.db)
  const secretBox = input.secretBox
  const credentialSupply =
    secretBox === undefined ? null : new RepositoryTransportCredentials(repository, secretBox)
  return {
    async open(request) {
      const described = describeRepositoryRemote(request.remoteUrl)
      if (!described.ok) {
        if (isLocalRepositoryRemote(request.remoteUrl)) {
          return { ok: true, session: legacySession(request.remoteUrl, input.appHome) }
        }
        return {
          ok: false,
          code: 'repository-http-endpoint-unresolved',
          detail: described.issue,
        }
      }
      if (described.value.transport === 'file') {
        return { ok: true, session: legacySession(request.remoteUrl, input.appHome) }
      }
      const connections = repository.listConnections()
      const candidates = connections.filter((connection) =>
        connectionMayOwnRemote(connection, request.remoteUrl),
      )
      if (candidates.length > 1) {
        return {
          ok: false,
          code: 'repository-http-endpoint-untrusted',
          detail: 'repository remote matches more than one managed code-host connection',
        }
      }

      let connection: StoredRepositoryTransportConnection
      let endpoint: ResolvedRepositoryHttpEndpoint | null = null
      if (candidates.length === 1) {
        connection = candidates[0]!
      } else {
        if (described.value.transport !== 'ssh' || secretBox === undefined) {
          return { ok: true, session: legacySession(request.remoteUrl, input.appHome) }
        }

        // A self-hosted provider may expose a dedicated SSH authority which is
        // intentionally absent from its trusted HTTP allowlist. In that case,
        // query every administrator-configured provider using only its global
        // API credential, then accept one independently validated claim. The
        // user's personal token is selected later and is used only by Git.
        const discovered: Array<{
          connection: StoredRepositoryTransportConnection
          endpoint: ResolvedRepositoryHttpEndpoint
        }> = []
        let untrustedIssue: string | null = null
        for (const possibleConnection of connections) {
          const apiCandidate = await discoverEndpointCandidate({
            connection: possibleConnection,
            project: described.value.project,
            secretBox,
            ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
          })
          if (apiCandidate === null) continue
          const resolved = resolveManagedRepositoryHttpEndpoint({
            remoteUrl: request.remoteUrl,
            provider: possibleConnection.provider,
            connectionGeneration: possibleConnection.connectionGeneration,
            mappings: possibleConnection.transportMappings,
            allowedHttpBaseUrls: possibleConnection.allowedHttpBaseUrls,
            apiCandidate,
          })
          if (!resolved.ok) {
            if (resolved.code === 'repository-http-endpoint-untrusted') {
              untrustedIssue ??= resolved.issue
            }
            continue
          }
          if (resolved.endpoint.source !== 'provider-api') {
            untrustedIssue ??= 'provider-candidate-did-not-bind-endpoint'
            continue
          }
          discovered.push({ connection: possibleConnection, endpoint: resolved.endpoint })
        }
        if (untrustedIssue !== null) {
          return {
            ok: false,
            code: 'repository-http-endpoint-untrusted',
            detail: untrustedIssue,
          }
        }
        if (discovered.length > 1) {
          return {
            ok: false,
            code: 'repository-http-endpoint-untrusted',
            detail: 'repository remote is claimed by more than one managed code-host connection',
          }
        }
        if (discovered.length === 0) {
          return { ok: true, session: legacySession(request.remoteUrl, input.appHome) }
        }
        connection = discovered[0]!.connection
        endpoint = discovered[0]!.endpoint
      }

      if (credentialSupply === null || secretBox === undefined) {
        return {
          ok: false,
          code: 'code-host-push-credential-unavailable',
          detail: 'the repository credential seal key is unavailable',
        }
      }
      const selected = credentialSupply.resolveExecution(request.subject, connection.provider)
      if (!selected.ok) {
        return {
          ok: false,
          code:
            selected.code === 'code-host-push-credential-connection-missing'
              ? 'code-host-push-credential-unavailable'
              : selected.code,
          detail: selected.code,
        }
      }
      const credential = selected.credential
      if (
        credential.connectionGeneration !== connection.connectionGeneration ||
        credential.endpointBindingDigest !== connection.endpointBindingDigest
      ) {
        return {
          ok: false,
          code: 'code-host-push-credential-stale',
          detail: 'code-host endpoint binding changed during credential selection',
        }
      }
      let apiCandidate: RepositoryEndpointCandidate | null = null
      if (endpoint === null && described.value.transport === 'ssh') {
        apiCandidate = await discoverEndpointCandidate({
          connection,
          project: described.value.project,
          secretBox,
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        })
      }

      const current = repository.findConnection(connection.provider)
      if (
        current === null ||
        current.connectionGeneration !== connection.connectionGeneration ||
        current.endpointBindingDigest !== connection.endpointBindingDigest
      ) {
        return {
          ok: false,
          code: 'code-host-push-credential-stale',
          detail: 'code-host endpoint binding changed during publication setup',
        }
      }
      if (endpoint === null) {
        const resolved = resolveManagedRepositoryHttpEndpoint({
          remoteUrl: request.remoteUrl,
          provider: connection.provider,
          connectionGeneration: connection.connectionGeneration,
          mappings: connection.transportMappings,
          allowedHttpBaseUrls: connection.allowedHttpBaseUrls,
          apiCandidate,
        })
        if (!resolved.ok) return { ok: false, code: resolved.code, detail: resolved.issue }
        endpoint = resolved.endpoint
      }
      const lease = leaseTargetBoundGitCredential({
        endpointUrl: endpoint.url,
        username: usernameFor(connection.provider),
        password: credential.token,
        appHome: input.appHome,
        rejectUnauthorized: connection.rejectUnauthorized,
      })
      if (lease === null) {
        return {
          ok: false,
          code: 'repository-http-endpoint-untrusted',
          detail: 'resolved endpoint cannot be bound to a credential helper lease',
        }
      }
      return {
        ok: true,
        session: sessionOf({
          endpointUrl: endpoint.url,
          lease,
          receipt: {
            credentialSource: credential.credentialSource,
            credentialRevision: credential.credentialRevision,
            endpointSource: endpoint.source,
            endpointBindingDigest: connection.endpointBindingDigest,
          },
        }),
      }
    },
  }
}

/**
 * Scheduler-safe production resolver. It only reads an existing daemon key;
 * missing/corrupt keys yield a fail-closed managed transport and never create
 * credential material from a background task.
 */
export function resolveRepositoryPublicationTransportFromKeyFile(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly fetchImpl?: (url: string, init?: BunFetchRequestInit) => Promise<Response>
}): RepositoryPublicationTransport {
  let secretBox: SecretBox | undefined
  try {
    secretBox = createSecretBoxFromKey(readFileSync(join(input.appHome, 'secret.key')))
  } catch {
    secretBox = undefined
  }
  return createRepositoryPublicationTransport({
    db: input.db,
    appHome: input.appHome,
    ...(secretBox === undefined ? {} : { secretBox }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
}
