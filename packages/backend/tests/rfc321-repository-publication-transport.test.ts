// RFC-321 — publication composition locks the end-to-end security boundary:
// personal > global selection, deterministic SSH -> HTTP(S), one fixed
// exact-target lease per publication attempt, and no fallback after selection.

import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { userRepositoryTransportCredentials } from '../src/db/schema'
import { missionPublicationSubject } from '../src/modules/development-automation/application/missionDeliveryChain'
import type { RepositoryGit } from '../src/modules/source-control/application/repositoryCommit'
import { fetchEmployeeWorkspaceRemoteHead } from '../src/modules/source-control/application/employeeCaseWorkspace'
import type { CandidatePublicationTransport } from '../src/modules/source-control/application/deliverCandidate'
import {
  createRepositoryEndpointDiscovery,
  type RepositoryEndpointConnection,
  type RepositoryEndpointFetch,
} from '../src/modules/integration/application/repositoryEndpointDiscovery'
import {
  composeRepositoryTransportCredentials,
  classifyRepositoryPushFailure,
  createRepositoryPublicationTransport,
  type RepositoryPublicationSession,
} from '../src/modules/source-control/composition'
import type { GitCredentialLeasePayloadV1 } from '../src/util/gitCredentialLease'
import { runGit as executeGit } from '../src/util/git'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DIGEST = 'a'.repeat(64)
const PERSONAL_TOKEN = 'aw-rfc321-personal-push-token-9876' // gitleaks:allow
const GLOBAL_TOKEN = 'aw-rfc321-global-push-token-1234' // gitleaks:allow
const GITHUB_GLOBAL_TOKEN = 'aw-rfc321-github-global-token-5678' // gitleaks:allow
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function appHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc321-publication-'))
  roots.push(root)
  return root
}

function subjectOf(user: Awaited<ReturnType<typeof createUser>>) {
  return { kind: 'user' as const, userId: user.id }
}

function git(cwd: string, ...args: string[]): string {
  const process = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (process.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${process.stderr.toString()}`)
  }
  return process.stdout.toString().trim()
}

function createCapturingGit(): {
  readonly runGit: RepositoryGit
  readonly calls: Array<{ args: string[]; options: Parameters<RepositoryGit>[2] }>
} {
  const calls: Array<{ args: string[]; options: Parameters<RepositoryGit>[2] }> = []
  const runGit = (async (
    _repoPath: string,
    args: string[],
    options?: Parameters<RepositoryGit>[2],
  ) => {
    calls.push({ args, options })
    return { stdout: '', stderr: '', exitCode: 0 }
  }) as RepositoryGit
  return { runGit, calls }
}

function metadataDiscovery(
  connections: readonly RepositoryEndpointConnection[],
  fetchImpl: RepositoryEndpointFetch,
) {
  return createRepositoryEndpointDiscovery({
    resolveConnection: (provider) =>
      connections.find((connection) => connection.provider === provider) ?? null,
    fetchImpl,
  })
}

async function captureLease(
  session: RepositoryPublicationSession,
  capture: ReturnType<typeof createCapturingGit>,
): Promise<{
  payload: GitCredentialLeasePayloadV1
  credentialFile: string
  calls: Array<{
    args: string[]
    options: Parameters<RepositoryGit>[2]
  }>
}> {
  const start = capture.calls.length
  await session.runNetwork('/fixture/repo', ['push', 'origin', 'main'])
  await session.runNetwork('/fixture/repo', ['ls-remote', 'origin'])
  const calls = capture.calls.slice(start)
  const credentialFile = calls[0]?.options?.env?.AW_GIT_CRED_FILE
  if (typeof credentialFile !== 'string') throw new Error('credential lease path was not injected')
  return {
    payload: JSON.parse(readFileSync(credentialFile, 'utf8')) as GitCredentialLeasePayloadV1,
    credentialFile,
    calls,
  }
}

describe('RFC-321 repository publication transport', () => {
  test('managed publication failures use stable authentication and authorization codes', () => {
    expect(classifyRepositoryPushFailure('fatal: Authentication failed for repository')).toBe(
      'repository-push-authentication-failed',
    )
    expect(classifyRepositoryPushFailure('remote: HTTP 401 Unauthorized')).toBe(
      'repository-push-authentication-failed',
    )
    expect(classifyRepositoryPushFailure('remote: Write access to repository not granted')).toBe(
      'repository-push-authorization-failed',
    )
    expect(classifyRepositoryPushFailure('remote: 403 Forbidden')).toBe(
      'repository-push-authorization-failed',
    )
    expect(classifyRepositoryPushFailure('remote: pre-receive hook declined')).toBeNull()
  })

  test('mission publication subject is frozen from created_by, including system and legacy rows', () => {
    expect(missionPublicationSubject({ createdBy: 'mission-owner' })).toEqual({
      kind: 'user',
      userId: 'mission-owner',
    })
    expect(missionPublicationSubject({ createdBy: '__system__' })).toEqual({ kind: 'system' })
    expect(missionPublicationSubject({ createdBy: null })).toEqual({ kind: 'system' })
  })

  test('personal wins, SSH is mapped to HTTP(S), and one exact lease is reused then removed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 31))
    const credentials = composeRepositoryTransportCredentials(db, box)
    const alice = await createUser(db, {
      username: 'rfc321-publication-alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const bob = await createUser(db, {
      username: 'rfc321-publication-bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    credentials.adminConnections.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'gitlab-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://git.example.test/api/v4',
      rejectUnauthorized: true,
      transportMappings: [
        {
          sshHost: 'ssh.git.example.test',
          sshPort: 2222,
          sshPathPrefix: 'platform',
          httpBaseUrl: 'https://git.example.test/scm',
        },
      ],
      allowedHttpBaseUrls: ['https://git.example.test/scm'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
    })
    credentials.ownCredentials.put(subjectOf(alice), 'gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'gitlab-generation',
      endpointBindingDigest: DIGEST,
    })
    const discoveryHeaders: Array<NonNullable<BunFetchRequestInit['headers']>> = []
    const root = appHome()
    const capture = createCapturingGit()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: root,
      runGit: capture.runGit,
      endpointDiscovery: metadataDiscovery(
        [
          {
            provider: 'gitlab',
            apiBaseUrl: 'https://git.example.test/api/v4',
            connectionGeneration: 'gitlab-generation',
            token: GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
        ],
        async (_url, init) => {
          discoveryHeaders.push(init?.headers ?? {})
          return new Response('', { status: 404 })
        },
      ),
    })
    const remoteUrl = 'ssh://git@ssh.git.example.test:2222/platform/team/repository.git'

    const opened = await transport.open({
      subject: { kind: 'user', userId: alice.id },
      remoteUrl,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error(opened.code)
    expect(opened.session.endpointUrl).toBe('https://git.example.test/scm/team/repository.git')
    expect(opened.session.receipt).toEqual({
      credentialSource: 'personal',
      credentialRevision: 1,
      endpointSource: 'admin-mapping',
      endpointBindingDigest: DIGEST,
    })
    const captured = await captureLease(opened.session, capture)
    expect(captured.payload).toEqual({
      version: 1,
      protocol: 'https',
      host: 'git.example.test',
      path: 'scm/team/repository.git',
      username: 'oauth2',
      password: PERSONAL_TOKEN,
    })
    expect(new Set(captured.calls.map((call) => call.options?.env?.AW_GIT_CRED_FILE)).size).toBe(1)
    expect(JSON.stringify(captured.calls)).not.toContain(PERSONAL_TOKEN)
    expect(JSON.stringify(captured.calls)).not.toContain(GLOBAL_TOKEN)
    expect(discoveryHeaders).toHaveLength(1)
    expect(JSON.stringify(discoveryHeaders[0])).toContain(GLOBAL_TOKEN)
    expect(JSON.stringify(discoveryHeaders[0])).not.toContain(PERSONAL_TOKEN)
    opened.session.close()
    expect(existsSync(captured.credentialFile)).toBe(false)

    const bobOpened = await transport.open({
      subject: { kind: 'user', userId: bob.id },
      remoteUrl,
    })
    expect(bobOpened.ok).toBe(true)
    if (!bobOpened.ok) throw new Error(bobOpened.code)
    expect(bobOpened.session.receipt.credentialSource).toBe('global')
    const bobLease = await captureLease(bobOpened.session, capture)
    expect(bobLease.payload.password).toBe(GLOBAL_TOKEN)
    bobOpened.session.close()

    const systemOpened = await transport.open({ subject: { kind: 'system' }, remoteUrl })
    expect(systemOpened.ok).toBe(true)
    if (!systemOpened.ok) throw new Error(systemOpened.code)
    expect(systemOpened.session.receipt.credentialSource).toBe('global')
    systemOpened.session.close()
  })

  test('provider metadata wins for self-hosted SSH, while an HTTP input performs no metadata fetch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 32))
    const credentials = composeRepositoryTransportCredentials(db, box)
    credentials.adminConnections.synchronize({
      provider: 'github',
      connectionGeneration: 'github-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://github.enterprise.test/api/v3',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.enterprise.test'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
    })
    const fetches: Array<{ url: string; headers: BunFetchRequestInit['headers'] }> = []
    const capture = createCapturingGit()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: appHome(),
      runGit: capture.runGit,
      endpointDiscovery: metadataDiscovery(
        [
          {
            provider: 'github',
            apiBaseUrl: 'https://github.enterprise.test/api/v3',
            connectionGeneration: 'github-generation',
            token: GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
        ],
        async (url, init) => {
          fetches.push({ url, headers: init?.headers })
          return Response.json({
            clone_url: 'https://github.enterprise.test/acme/repository.git',
          })
        },
      ),
    })

    const sshOpened = await transport.open({
      subject: { kind: 'system' },
      remoteUrl: 'git@github.enterprise.test:acme/repository.git',
    })
    expect(sshOpened.ok).toBe(true)
    if (!sshOpened.ok) throw new Error(sshOpened.code)
    expect(sshOpened.session.endpointUrl).toBe('https://github.enterprise.test/acme/repository.git')
    expect(sshOpened.session.receipt.endpointSource).toBe('provider-api')
    expect(fetches).toHaveLength(1)
    expect(fetches[0]?.url).toBe('https://github.enterprise.test/api/v3/repos/acme/repository')
    expect(JSON.stringify(fetches[0]?.headers)).toContain(GLOBAL_TOKEN)
    sshOpened.session.close()

    const httpOpened = await transport.open({
      subject: { kind: 'system' },
      remoteUrl: 'https://github.enterprise.test/acme/repository.git',
    })
    expect(httpOpened.ok).toBe(true)
    if (!httpOpened.ok) throw new Error(httpOpened.code)
    expect(httpOpened.session.receipt.endpointSource).toBe('input-http')
    expect(fetches).toHaveLength(1)
    httpOpened.session.close()
  })

  test('provider metadata identifies the managed connection when SSH and web authorities differ', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 35))
    const credentials = composeRepositoryTransportCredentials(db, box)
    const alice = await createUser(db, {
      username: 'rfc321-cross-authority-owner',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    credentials.adminConnections.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'gitlab-cross-authority-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.code.company.test/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://code.company.test/git'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
    })
    credentials.adminConnections.synchronize({
      provider: 'github',
      connectionGeneration: 'github-cross-authority-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.github.company.test',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.company.test'],
      globalTokenEnc: box.seal(GITHUB_GLOBAL_TOKEN),
      globalTokenHint: '5678',
      updatedAt: 1,
      updatedBy: null,
    })
    credentials.ownCredentials.put(subjectOf(alice), 'gitlab', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'gitlab-cross-authority-generation',
      endpointBindingDigest: DIGEST,
    })
    const fetches: Array<{ url: string; headers: BunFetchRequestInit['headers'] }> = []
    const capture = createCapturingGit()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: appHome(),
      runGit: capture.runGit,
      endpointDiscovery: metadataDiscovery(
        [
          {
            provider: 'gitlab',
            apiBaseUrl: 'https://api.code.company.test/v4',
            connectionGeneration: 'gitlab-cross-authority-generation',
            token: GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
          {
            provider: 'github',
            apiBaseUrl: 'https://api.github.company.test',
            connectionGeneration: 'github-cross-authority-generation',
            token: GITHUB_GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
        ],
        async (url, init) => {
          fetches.push({ url, headers: init?.headers })
          if (url.startsWith('https://api.code.company.test/')) {
            return Response.json({
              http_url_to_repo: 'https://code.company.test/git/platform/app.git',
            })
          }
          return new Response('', { status: 404 })
        },
      ),
    })

    const opened = await transport.open({
      subject: { kind: 'user', userId: alice.id },
      remoteUrl: 'git@ssh.company.test:platform/app.git',
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error(opened.code)
    expect(opened.session.endpointUrl).toBe('https://code.company.test/git/platform/app.git')
    expect(opened.session.receipt).toEqual({
      credentialSource: 'personal',
      credentialRevision: 1,
      endpointSource: 'provider-api',
      endpointBindingDigest: DIGEST,
    })
    const lease = await captureLease(opened.session, capture)
    expect(lease.payload.password).toBe(PERSONAL_TOKEN)
    expect(fetches.map((item) => item.url).sort()).toEqual([
      'https://api.code.company.test/v4/projects/platform%2Fapp',
      'https://api.github.company.test/repos/platform/app',
    ])
    expect(JSON.stringify(fetches)).toContain(GLOBAL_TOKEN)
    expect(JSON.stringify(fetches)).toContain(GITHUB_GLOBAL_TOKEN)
    expect(JSON.stringify(fetches)).not.toContain(PERSONAL_TOKEN)
    opened.session.close()
  })

  test('cross-authority metadata fails closed when more than one connection claims the project', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 36))
    const credentials = composeRepositoryTransportCredentials(db, box)
    credentials.adminConnections.synchronize({
      provider: 'gitlab',
      connectionGeneration: 'gitlab-ambiguous-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.gitlab.company.test/v4',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://gitlab.company.test'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
    })
    credentials.adminConnections.synchronize({
      provider: 'github',
      connectionGeneration: 'github-ambiguous-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.github.company.test',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.company.test'],
      globalTokenEnc: box.seal(GITHUB_GLOBAL_TOKEN),
      globalTokenHint: '5678',
      updatedAt: 1,
      updatedBy: null,
    })
    const root = appHome()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: root,
      endpointDiscovery: metadataDiscovery(
        [
          {
            provider: 'gitlab',
            apiBaseUrl: 'https://api.gitlab.company.test/v4',
            connectionGeneration: 'gitlab-ambiguous-generation',
            token: GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
          {
            provider: 'github',
            apiBaseUrl: 'https://api.github.company.test',
            connectionGeneration: 'github-ambiguous-generation',
            token: GITHUB_GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
        ],
        async (url) =>
          url.includes('gitlab')
            ? Response.json({ http_url_to_repo: 'https://gitlab.company.test/team/app.git' })
            : Response.json({ clone_url: 'https://github.company.test/team/app.git' }),
      ),
    })

    expect(
      await transport.open({
        subject: { kind: 'system' },
        remoteUrl: 'git@ssh.company.test:team/app.git',
      }),
    ).toEqual({
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      detail: 'repository remote is claimed by more than one managed code-host connection',
    })

    expect(readdirSync(root).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  })

  test('known ambiguous SSH ownership never falls back when discovery is unavailable', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 37))
    const credentials = composeRepositoryTransportCredentials(db, box)
    for (const [provider, token] of [
      ['gitlab', GLOBAL_TOKEN],
      ['github', GITHUB_GLOBAL_TOKEN],
    ] as const) {
      credentials.adminConnections.synchronize({
        provider,
        connectionGeneration: `${provider}-known-ambiguous-generation`,
        endpointBindingDigest: DIGEST,
        apiBaseUrl: `https://api.${provider}.company.test`,
        rejectUnauthorized: true,
        transportMappings: [],
        allowedHttpBaseUrls: ['https://ssh.company.test'],
        globalTokenEnc: box.seal(token),
        globalTokenHint: token.slice(-4),
        updatedAt: 1,
        updatedBy: null,
      })
    }
    const root = appHome()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: root,
    })

    expect(
      await transport.open({
        subject: { kind: 'system' },
        remoteUrl: 'git@ssh.company.test:team/app.git',
      }),
    ).toEqual({
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      detail: 'repository remote matches more than one managed code-host connection',
    })
    expect(readdirSync(root).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  })

  test('a stale personal credential fails closed before discovery and never falls back to global', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 33))
    const credentials = composeRepositoryTransportCredentials(db, box)
    const alice = await createUser(db, {
      username: 'rfc321-stale-publication',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    credentials.adminConnections.synchronize({
      provider: 'github',
      connectionGeneration: 'github-generation',
      endpointBindingDigest: DIGEST,
      apiBaseUrl: 'https://api.github.com',
      rejectUnauthorized: true,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.com'],
      globalTokenEnc: box.seal(GLOBAL_TOKEN),
      globalTokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
    })
    credentials.ownCredentials.put(subjectOf(alice), 'github', {
      token: PERSONAL_TOKEN,
      connectionGeneration: 'github-generation',
      endpointBindingDigest: DIGEST,
    })
    db.update(userRepositoryTransportCredentials)
      .set({ endpointBindingDigest: 'b'.repeat(64) })
      .where(eq(userRepositoryTransportCredentials.userId, alice.id))
      .run()
    let fetches = 0
    const root = appHome()
    const transport = createRepositoryPublicationTransport({
      db,
      secretBox: box,
      appHome: root,
      endpointDiscovery: metadataDiscovery(
        [
          {
            provider: 'github',
            apiBaseUrl: 'https://api.github.com',
            connectionGeneration: 'github-generation',
            token: GLOBAL_TOKEN,
            rejectUnauthorized: true,
          },
        ],
        async () => {
          fetches += 1
          return Response.json({ clone_url: 'https://github.com/acme/repository.git' })
        },
      ),
    })

    const opened = await transport.open({
      subject: { kind: 'user', userId: alice.id },
      remoteUrl: 'git@github.com:acme/repository.git',
    })
    expect(opened).toEqual({
      ok: false,
      code: 'code-host-push-credential-stale',
      detail: 'code-host-push-credential-stale',
    })
    expect(fetches).toBe(0)
    expect(readdirSync(root).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  })

  test('employee workspace remote reads use the persisted owner and the same sanitized session endpoint', async () => {
    const root = appHome()
    const baselineRepoPath = join(root, 'baseline')
    const remotePath = join(root, 'remote.git')
    mkdirSync(baselineRepoPath, { recursive: true })
    mkdirSync(remotePath, { recursive: true })
    git(baselineRepoPath, 'init', '-q', '-b', 'main')
    writeFileSync(join(baselineRepoPath, 'README.md'), '# RFC-321\n')
    git(baselineRepoPath, 'add', 'README.md')
    git(
      baselineRepoPath,
      '-c',
      'user.name=RFC 321',
      '-c',
      'user.email=rfc321@example.test',
      'commit',
      '-q',
      '-m',
      'baseline',
    )
    const expectedHeadSha = git(baselineRepoPath, 'rev-parse', 'HEAD')
    git(remotePath, 'init', '-q', '--bare')
    git(baselineRepoPath, 'push', '-q', remotePath, 'HEAD:refs/heads/main')

    const originalRemoteUrl = 'ssh://git@ssh.example.test:2222/team/repository.git'
    const owner = { kind: 'user' as const, userId: 'employee-case-owner' }
    const networkCalls: string[][] = []
    const openedInputs: Parameters<CandidatePublicationTransport['open']>[0][] = []
    let closes = 0
    const result = await fetchEmployeeWorkspaceRemoteHead({
      baselineRepoPath,
      remoteUrl: originalRemoteUrl,
      branch: 'main',
      expectedHeadSha,
      publicationSubject: owner,
      publicationTransport: {
        async open(input) {
          openedInputs.push(input)
          return {
            ok: true as const,
            session: {
              endpointUrl: remotePath,
              receipt: {
                credentialSource: 'personal' as const,
                credentialRevision: 7,
                endpointSource: 'admin-mapping' as const,
                endpointBindingDigest: DIGEST,
              },
              runNetwork(repoPath, args, options) {
                networkCalls.push([...args])
                return executeGit(repoPath, [...args], options)
              },
              close() {
                closes += 1
              },
            },
          }
        },
      },
    })

    expect(openedInputs).toEqual([{ subject: owner, remoteUrl: originalRemoteUrl }])
    expect(networkCalls).toEqual([['fetch', '--quiet', '--no-tags', remotePath, 'refs/heads/main']])
    expect(closes).toBe(1)
    expect(result).toEqual({ ok: true, headSha: expectedHeadSha })
  })
})
