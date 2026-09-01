// RFC-321 T16 — real smart-HTTP publication proof.
//
// The provider metadata request and git-receive-pack both cross the unified
// system-mock HTTP gateway. The mock records only a safe personal/global label;
// raw Authorization and provider tokens are redacted from its request journal.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
  SYSTEM_MOCK_GIT_PERSONAL_TOKEN,
  startSystemMockSuite,
  type RecordedMockRequest,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { createRepositoryEndpointDiscovery } from '../src/modules/integration/application/repositoryEndpointDiscovery'
import {
  composeRepositoryTransportCredentials,
  createRepositoryPublicationTransport,
} from '../src/modules/source-control/composition'
import { SQLiteRepositoryTransportCredentialRepository } from '../src/modules/source-control/infrastructure/sqliteRepositoryTransportCredentialRepository'
import { pushCandidate } from '../src/modules/source-control/application/deliverCandidate'
import { createUser } from '../src/services/users'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ENDPOINT_BINDING_DIGEST = '3'.repeat(64)
const INVALID_PERSONAL_TOKEN = 'system-mock-invalid-personal-token' // gitleaks:allow
const INVALID_GLOBAL_TOKEN = 'system-mock-invalid-global-token' // gitleaks:allow

let suite: StartedSystemMockSuite
const roots: string[] = []

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await suite?.close()
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc321-smart-http-'))
  roots.push(root)
  return root
}

function checkedGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

function subjectOf(user: Awaited<ReturnType<typeof createUser>>) {
  return { kind: 'user' as const, userId: user.id }
}

function repositoryOf(db: ReturnType<typeof createInMemoryDb>) {
  return new SQLiteRepositoryTransportCredentialRepository(db)
}

function commitProof(worktree: string, label: string): string {
  writeFileSync(join(worktree, 'RFC-321.txt'), `${label}\n`)
  checkedGit(worktree, 'add', 'RFC-321.txt')
  checkedGit(
    worktree,
    '-c',
    'user.name=RFC 321',
    '-c',
    'user.email=rfc321@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    `test: ${label}`,
  )
  return checkedGit(worktree, 'rev-parse', 'HEAD')
}

function gitRequestsFor(
  requests: readonly RecordedMockRequest[],
  projectPath: string,
): RecordedMockRequest[] {
  return requests.filter(
    (request) => request.service === 'git' && request.path.includes(`/${projectPath}.git`),
  )
}

test('SSH metadata resolves to real smart HTTP; personal wins, absence uses global, and auth failure never retries global', async () => {
  const projectPath = 'rfc321/managed-publication'
  const project = await suite.client.seedCodeHost({
    provider: 'gitlab',
    projectPath,
    gitPushCredentialMode: 'personal-and-global',
    baseFiles: { 'README.md': '# RFC-321 managed publication\n' },
    headFiles: { 'README.md': '# RFC-321 managed publication\n\ncandidate\n' },
  })

  const root = temporaryRoot()
  const appHome = join(root, 'app-home')
  const worktree = join(root, 'worktree')
  mkdirSync(appHome)
  const cloned = await runGit(root, ['clone', '-q', project.repoHttpUrl, worktree])
  expect(cloned.exitCode, cloned.stderr).toBe(0)
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 41))
  const credentials = composeRepositoryTransportCredentials(repositoryOf(db), secretBox)
  const [alice, bob] = await Promise.all([
    createUser(db, {
      username: 'rfc321-smart-http-alice',
      displayName: 'Alice',
      role: 'user',
      password: 'longEnoughPassword',
    }),
    createUser(db, {
      username: 'rfc321-smart-http-bob',
      displayName: 'Bob',
      role: 'user',
      password: 'longEnoughPassword',
    }),
  ])
  await credentials.adminConnections.synchronize({
    provider: 'gitlab',
    connectionGeneration: 'rfc321-system-mock-generation',
    endpointBindingDigest: ENDPOINT_BINDING_DIGEST,
    apiBaseUrl: suite.endpoints.gitlabApiBaseUrl,
    rejectUnauthorized: true,
    // Trust the mock's cleartext HTTP base without directly mapping the
    // port-22 SSH remote: the endpoint must still come from provider metadata.
    transportMappings: [
      {
        sshHost: 'ssh.system-mock.test',
        sshPort: 2200,
        httpBaseUrl: suite.endpoints.baseUrl,
      },
    ],
    allowedHttpBaseUrls: [suite.endpoints.baseUrl],
    globalTokenEnc: secretBox.seal(SYSTEM_MOCK_GIT_GLOBAL_TOKEN),
    globalTokenHint: SYSTEM_MOCK_GIT_GLOBAL_TOKEN.slice(-4),
    updatedAt: 1,
    updatedBy: null,
  })
  await credentials.ownCredentials.put(subjectOf(alice), 'gitlab', {
    token: SYSTEM_MOCK_GIT_PERSONAL_TOKEN,
    connectionGeneration: 'rfc321-system-mock-generation',
    endpointBindingDigest: ENDPOINT_BINDING_DIGEST,
  })
  const endpointDiscovery = createRepositoryEndpointDiscovery({
    resolveConnection(provider) {
      if (provider !== 'gitlab') return null
      return {
        provider,
        apiBaseUrl: suite.endpoints.gitlabApiBaseUrl,
        connectionGeneration: 'rfc321-system-mock-generation',
        token: SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
        rejectUnauthorized: true,
      }
    },
  })
  const transport = createRepositoryPublicationTransport({
    repository: repositoryOf(db),
    secretBox,
    appHome,
    endpointDiscovery,
  })
  const sshRemote = `git@ssh.system-mock.test:${projectPath}.git`

  const personalSha = commitProof(worktree, 'personal identity publication')
  const personalTree = checkedGit(worktree, 'rev-parse', `${personalSha}^{tree}`)
  const personalParent = checkedGit(worktree, 'rev-parse', `${personalSha}^1`)
  const beforePersonal = (await suite.client.requests()).length
  const personal = await pushCandidate({
    baselineRepoPath: worktree,
    commitSha: personalSha,
    remoteUrl: sshRemote,
    branch: 'rfc321-personal',
    expectedRemoteSha: null,
    expectedTreeOid: personalTree,
    baselineSha: personalParent,
    publicationSubject: { kind: 'user', userId: alice.id },
    publicationTransport: transport,
  })
  if (!personal.ok) throw new Error(`${personal.code}: ${personal.detail}`)
  expect(personal.ok).toBe(true)
  expect(personal.receipt.publication).toMatchObject({
    credentialSource: 'personal',
    credentialRevision: 1,
    endpointSource: 'provider-api',
  })
  const afterPersonal = await suite.client.requests()
  const personalRequests = gitRequestsFor(afterPersonal.slice(beforePersonal), projectPath)
  expect(personalRequests.map((request) => request.credentialIdentity)).toContain('personal')
  expect(personalRequests.map((request) => request.credentialIdentity)).not.toContain('global')
  const personalRemote = await runGit(root, [
    'ls-remote',
    project.repoHttpUrl,
    'refs/heads/rfc321-personal',
  ])
  expect(personalRemote.exitCode, personalRemote.stderr).toBe(0)
  expect(personalRemote.stdout).toContain(personalSha)

  const globalSha = commitProof(worktree, 'global fallback publication')
  const globalTree = checkedGit(worktree, 'rev-parse', `${globalSha}^{tree}`)
  const globalParent = checkedGit(worktree, 'rev-parse', `${globalSha}^1`)
  const beforeGlobal = afterPersonal.length
  const global = await pushCandidate({
    baselineRepoPath: worktree,
    commitSha: globalSha,
    remoteUrl: sshRemote,
    branch: 'rfc321-global',
    expectedRemoteSha: null,
    expectedTreeOid: globalTree,
    baselineSha: globalParent,
    publicationSubject: { kind: 'user', userId: bob.id },
    publicationTransport: transport,
  })
  if (!global.ok) throw new Error(global.code)
  expect(global.ok).toBe(true)
  expect(global.receipt.publication.credentialSource).toBe('global')
  const afterGlobal = await suite.client.requests()
  const globalRequests = gitRequestsFor(afterGlobal.slice(beforeGlobal), projectPath)
  expect(globalRequests.map((request) => request.credentialIdentity)).toContain('global')
  expect(globalRequests.map((request) => request.credentialIdentity)).not.toContain('personal')
  const globalRemote = await runGit(root, [
    'ls-remote',
    project.repoHttpUrl,
    'refs/heads/rfc321-global',
  ])
  expect(globalRemote.exitCode, globalRemote.stderr).toBe(0)
  expect(globalRemote.stdout).toContain(globalSha)

  await credentials.ownCredentials.put(subjectOf(alice), 'gitlab', {
    token: INVALID_PERSONAL_TOKEN,
    connectionGeneration: 'rfc321-system-mock-generation',
    endpointBindingDigest: ENDPOINT_BINDING_DIGEST,
  })
  const invalidSha = commitProof(worktree, 'invalid personal must fail closed')
  const invalidTree = checkedGit(worktree, 'rev-parse', `${invalidSha}^{tree}`)
  const invalidParent = checkedGit(worktree, 'rev-parse', `${invalidSha}^1`)
  const beforeInvalid = afterGlobal.length
  const invalid = await pushCandidate({
    baselineRepoPath: worktree,
    commitSha: invalidSha,
    remoteUrl: sshRemote,
    branch: 'rfc321-invalid',
    expectedRemoteSha: null,
    expectedTreeOid: invalidTree,
    baselineSha: invalidParent,
    publicationSubject: { kind: 'user', userId: alice.id },
    publicationTransport: transport,
  })
  expect(invalid).toMatchObject({
    ok: false,
    code: 'repository-push-authentication-failed',
  })
  const afterInvalidPersonal = await suite.client.requests()
  const invalidRequests = gitRequestsFor(afterInvalidPersonal.slice(beforeInvalid), projectPath)
  expect(invalidRequests.map((request) => request.credentialIdentity)).toContain('invalid')
  expect(invalidRequests.map((request) => request.credentialIdentity)).not.toContain('global')

  await credentials.adminConnections.synchronize({
    provider: 'gitlab',
    connectionGeneration: 'rfc321-system-mock-generation',
    endpointBindingDigest: ENDPOINT_BINDING_DIGEST,
    apiBaseUrl: suite.endpoints.gitlabApiBaseUrl,
    rejectUnauthorized: true,
    transportMappings: [
      {
        sshHost: 'ssh.system-mock.test',
        sshPort: 22,
        httpBaseUrl: suite.endpoints.baseUrl,
      },
    ],
    allowedHttpBaseUrls: [suite.endpoints.baseUrl],
    globalTokenEnc: secretBox.seal(INVALID_GLOBAL_TOKEN),
    globalTokenHint: INVALID_GLOBAL_TOKEN.slice(-4),
    updatedAt: 2,
    updatedBy: null,
  })
  const invalidGlobalSha = commitProof(worktree, 'invalid global must fail closed')
  const invalidGlobalTree = checkedGit(worktree, 'rev-parse', `${invalidGlobalSha}^{tree}`)
  const invalidGlobalParent = checkedGit(worktree, 'rev-parse', `${invalidGlobalSha}^1`)
  const beforeInvalidGlobal = afterInvalidPersonal.length
  const invalidGlobal = await pushCandidate({
    baselineRepoPath: worktree,
    commitSha: invalidGlobalSha,
    remoteUrl: sshRemote,
    branch: 'rfc321-invalid-global',
    expectedRemoteSha: null,
    expectedTreeOid: invalidGlobalTree,
    baselineSha: invalidGlobalParent,
    publicationSubject: { kind: 'user', userId: bob.id },
    publicationTransport: transport,
  })
  expect(invalidGlobal).toMatchObject({
    ok: false,
    code: 'repository-push-authentication-failed',
  })
  const allRequests = await suite.client.requests()
  const invalidGlobalRequests = gitRequestsFor(allRequests.slice(beforeInvalidGlobal), projectPath)
  expect(invalidGlobalRequests.map((request) => request.credentialIdentity)).toContain('invalid')
  expect(invalidGlobalRequests.map((request) => request.credentialIdentity)).not.toContain(
    'personal',
  )

  const gitConfig = readFileSync(join(worktree, '.git', 'config'), 'utf8')
  const serializedResults = JSON.stringify({ personal, global, invalid, invalidGlobal, gitConfig })
  const serializedJournal = JSON.stringify(allRequests)
  for (const canary of [
    SYSTEM_MOCK_GIT_PERSONAL_TOKEN,
    SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
    INVALID_PERSONAL_TOKEN,
    INVALID_GLOBAL_TOKEN,
  ]) {
    expect(serializedResults).not.toContain(canary)
    expect(serializedJournal).not.toContain(canary)
    expect(gitConfig).not.toContain(canary)
  }
  expect(readdirSync(appHome).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  expect(serializedJournal).not.toContain(SYSTEM_MOCK_GIT_PERSONAL_TOKEN)
  expect(serializedJournal).not.toContain(SYSTEM_MOCK_GIT_GLOBAL_TOKEN)
  expect(serializedJournal).not.toContain(INVALID_PERSONAL_TOKEN)
  expect(serializedJournal).not.toContain(INVALID_GLOBAL_TOKEN)
  expect(
    allRequests
      .flatMap((request) => Object.entries(request.headers))
      .filter(([name]) => name === 'authorization' || name === 'private-token')
      .every(([, value]) => value === '[redacted]'),
  ).toBe(true)
}, 30_000)
