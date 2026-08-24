// RFC-321 T19 — repository publication boundary ratchet.
//
// The machine ledger is only useful when it is closed over the real call sites.
// These assertions lock the persisted owner at each boundary, the single-session
// transport wiring, session-only credential administration, and the extinction
// of the legacy push-credential resolver. The fabricated violation proves the
// absence matcher still detects a bypass if one is reintroduced.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

interface PublicationCallSite {
  readonly id: string
  readonly file: string
  readonly operations: readonly string[]
  readonly subject: string
  readonly target: string
}

interface PublicationLedger {
  readonly schemaVersion: 1
  readonly recordedAtSha: string
  readonly owner: 'source-control'
  readonly callSites: readonly PublicationCallSite[]
  readonly gitCommandFiles: Readonly<Record<'push' | 'fetch' | 'ls-remote', readonly string[]>>
  readonly excludedReadPaths: readonly {
    readonly id: string
    readonly file: string
    readonly reason: string
  }[]
}

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
}

const GIT_NETWORK_COMMANDS = ['push', 'fetch', 'ls-remote'] as const
type GitNetworkCommand = (typeof GIT_NETWORK_COMMANDS)[number]

function backendTypeScriptFiles(): string[] {
  const sourceRoot = resolve(REPO_ROOT, 'packages/backend/src')
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
      } else if (name.endsWith('.ts')) {
        files.push(relative(REPO_ROOT, absolute).replaceAll('\\', '/'))
      }
    }
  }
  walk(sourceRoot)
  return files.sort()
}

export function gitNetworkCommandsInSource(file: string, source: string): GitNetworkCommand[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const commands = new Set<GitNetworkCommand>()
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isStringLiteralLike(element)) continue
        if (GIT_NETWORK_COMMANDS.includes(element.text as GitNetworkCommand)) {
          commands.add(element.text as GitNetworkCommand)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return GIT_NETWORK_COMMANDS.filter((command) => commands.has(command))
}

function scannedGitCommandFiles(files: readonly string[]): PublicationLedger['gitCommandFiles'] {
  const found: Record<GitNetworkCommand, string[]> = {
    push: [],
    fetch: [],
    'ls-remote': [],
  }
  for (const file of files) {
    for (const command of gitNetworkCommandsInSource(file, read(file))) {
      found[command].push(file)
    }
  }
  return found
}

const LEDGER = JSON.parse(
  read('architecture/repository-publication-call-sites.json'),
) as PublicationLedger

const CALL_SITE_SUBJECTS = {
  'task-auto-push': 'tasks.owner_user_id',
  'task-non-fast-forward-repair': 'tasks.owner_user_id',
  'task-submodule-publication': 'tasks.owner_user_id',
  'repository-commit-publication': 'bound-by-caller',
  'development-candidate-delivery': 'development_missions.created_by',
  'employee-case-conflict-refresh': 'employee_cases.owner_user_id',
} as const

interface SourceFixture {
  readonly file: string
  readonly source: string
}

export function repositoryPublicationBoundaryViolations(
  fixtures: readonly SourceFixture[],
): string[] {
  const forbidden = [
    { id: 'legacy-resolver', pattern: /\bsetPushCredentialResolver\s*\(/g },
    { id: 'legacy-lease', pattern: /\bleasePushCredential\s*\(/g },
    {
      id: 'token-bearing-url',
      pattern: /https?:\/\/[^\n'"`]{0,160}(?:access[_-]?token|password|token)=/gi,
    },
  ] as const
  const violations: string[] = []
  for (const fixture of fixtures) {
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(fixture.source)) violations.push(`${fixture.file}:${rule.id}`)
    }
  }
  return violations.sort()
}

function secretBearingPublicationFields(fixtures: readonly SourceFixture[]): string[] {
  const declaration = /\b(?:password|secret|ciphertext|tokenEnc|plainToken)\??\s*:/g
  const violations: string[] = []
  for (const fixture of fixtures) {
    declaration.lastIndex = 0
    if (declaration.test(fixture.source)) violations.push(fixture.file)
  }
  return violations.sort()
}

interface PublicationSecuritySources {
  readonly helper: string
  readonly selector: string
  readonly accountRoutes: string
}

export function repositoryPublicationSecurityInvariantViolations(
  sources: PublicationSecuritySources,
): string[] {
  const violations: string[] = []
  if (!sources.helper.includes("if (protocol !== lease.protocol) return ''")) {
    violations.push('helper-target-protocol')
  }
  if (!sources.helper.includes("if (host === null || host !== lease.host) return ''")) {
    violations.push('helper-target-authority')
  }
  if (
    !sources.helper.includes(
      "if (normalizedCredentialPath(requestFields.path ?? '') !== lease.path) return ''",
    )
  ) {
    violations.push('helper-target-path')
  }
  const personalStart = sources.selector.indexOf(
    "if (input.subjectKind === 'user' && input.personal !== null)",
  )
  const globalStart = sources.selector.indexOf('if (input.global !== null)', personalStart)
  const personalBranch =
    personalStart >= 0 && globalStart > personalStart
      ? sources.selector.slice(personalStart, globalStart)
      : ''
  if (
    !personalBranch.includes("return { ok: false, code: 'code-host-push-credential-stale' }") ||
    !personalBranch.includes("source: 'personal'")
  ) {
    violations.push('personal-failure-must-not-fallback')
  }
  if ((sources.accountRoutes.match(/tokenAccess: 'never'/g) ?? []).length !== 4) {
    violations.push('account-route-token-access')
  }
  return violations.sort()
}

function tableIds(source: string, prefix: 'AC-' | 'T'): string[] {
  const pattern = prefix === 'AC-' ? /^\|\s+(AC-\d+)\s+\|/gm : /^\|\s+(T\d+)\s+\|/gm
  return [...source.matchAll(pattern)]
    .map((match) => match[1]!)
    .sort((left, right) => {
      const leftNumber = Number(left.replace(/\D/g, ''))
      const rightNumber = Number(right.replace(/\D/g, ''))
      return leftNumber - rightNumber
    })
}

describe('RFC-321 repository publication architecture ratchet', () => {
  test('the publication ledger is complete, source-owned, and reproducible from reachable history', () => {
    expect(LEDGER.schemaVersion).toBe(1)
    expect(LEDGER.owner).toBe('source-control')
    expect(Object.fromEntries(LEDGER.callSites.map((site) => [site.id, site.subject]))).toEqual(
      CALL_SITE_SUBJECTS,
    )
    expect(LEDGER.callSites.every((site) => site.operations.length > 0)).toBe(true)
    expect(
      LEDGER.callSites
        .map((site) => site.file)
        .filter((file) => !existsSync(resolve(REPO_ROOT, file))),
    ).toEqual([])
    expect(LEDGER.excludedReadPaths.map((entry) => entry.id).sort()).toEqual([
      'cached-repository-clone-refresh',
      'submodule-object-pool-copy',
      'working-branch-preparation',
    ])
    expect(LEDGER.excludedReadPaths.every((entry) => entry.reason.trim().length > 20)).toBe(true)
    expect(LEDGER.recordedAtSha).toMatch(/^[0-9a-f]{40}$/)
    const reachable = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', LEDGER.recordedAtSha, 'HEAD'],
      { cwd: REPO_ROOT },
    )
    expect(reachable.status).toBe(0)

    const baselines = JSON.parse(read('architecture/ledger-baselines.json')) as {
      ledgers: Array<{ id: string; baseline: number; file: string; symbol: string }>
    }
    expect(
      baselines.ledgers.find((entry) => entry.id === 'rfc321-repository-publication-call-sites'),
    ).toMatchObject({
      id: 'rfc321-repository-publication-call-sites',
      file: 'architecture/repository-publication-call-sites.json',
      symbol: 'callSites',
      baseline: LEDGER.callSites.length,
    })
  })

  test('the backend corpus scanner accounts for every literal Git network command', () => {
    const corpus = backendTypeScriptFiles()
    expect(corpus.length).toBeGreaterThanOrEqual(750)
    expect(scannedGitCommandFiles(corpus)).toEqual(LEDGER.gitCommandFiles)

    expect(
      gitNetworkCommandsInSource(
        'fixture.ts',
        "await runGit(repo, ['push', 'origin', 'main'])\nawait runGit(repo, ['fetch', 'origin'])",
      ),
    ).toEqual(['push', 'fetch'])

    const legacyAdapterReferences = corpus.filter((file) =>
      read(file).includes('bindTaskWorkspaceCommitParticipant'),
    )
    expect(legacyAdapterReferences).toEqual([
      'packages/backend/src/modules/task-execution/composition/taskWorkspaceCommit.ts',
    ])
  })

  test('task, candidate, and employee-case publication reuse one fixed transport session', () => {
    const commitPush = read('packages/backend/src/services/commitPushRunner.ts')
    const candidate = read(
      'packages/backend/src/modules/source-control/application/deliverCandidate.ts',
    )
    const employeeWorkspace = read(
      'packages/backend/src/modules/source-control/application/employeeCaseWorkspace.ts',
    )
    const platformWorkItems = read(
      'packages/backend/src/modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts',
    )
    const composition = read('packages/backend/src/modules/source-control/composition.ts')
    const cli = read('packages/backend/src/cli/start.ts')
    const server = read('packages/backend/src/server.ts')

    expect(commitPush).toContain('subject: publicationSubject')
    expect(commitPush).toContain('session.runNetwork')
    expect(commitPush).toContain('session.close()')
    expect(candidate).toContain('const networkRunGit: RepositoryGit')
    expect(candidate).toContain('session.runNetwork')
    expect(candidate).toContain('session.close()')
    expect(employeeWorkspace).toContain('opened.session.runNetwork')
    expect(employeeWorkspace).toContain('opened.session.close()')
    expect(employeeWorkspace).toContain(
      "throw new Error('employee workspace publication transport and owner are required')",
    )
    expect(platformWorkItems).toContain('.select({ ownerUserId: employeeCases.ownerUserId })')
    expect(
      platformWorkItems.match(
        /publicationSubject: employeeCasePublicationSubject\(input\.db, plan\.caseRef\.id\)/g,
      )?.length,
    ).toBe(4)
    expect(composition).toContain('fetchEmployeeWorkspaceRemoteHead({')
    expect(composition).toContain('{ publicationTransport: input.publicationTransport }')
    expect(
      cli.match(/publicationTransport: repositoryPublicationTransport/g)?.length,
    ).toBeGreaterThanOrEqual(4)
    expect(
      server.match(/publicationTransport: repositoryPublicationTransport/g)?.length,
    ).toBeGreaterThanOrEqual(3)
  })

  test('personal credential routes are interactive-session-only and never accept PAT access', () => {
    const route = read('packages/backend/src/routes/accountRepositoryTransportCredentials.ts')
    expect(route.match(/tokenAccess: 'never'/g)?.length).toBe(4)
    expect(route).toContain("actor.source !== 'session'")
    expect(route).toContain('credentials.resolvePersonalForTest(subject, provider, parsed.data)')
    expect(route).not.toContain("tokenAccess: 'pat'")
    expect(route).not.toContain('parsed.error')
  })

  test('personal credentials stay inside Git publication and their explicit identity probe', () => {
    const publication = read(
      'packages/backend/src/modules/source-control/composition/repositoryPublicationTransport.ts',
    )
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    const developmentRest = read('packages/backend/src/services/developmentDeliveryDeps.ts')
    const integrationRest = read(
      'packages/backend/src/modules/integration/composition/codeHostEffects.ts',
    )
    const reconcilerPorts = read(
      'packages/backend/src/modules/development-automation/application/ports/reconcilerPorts.ts',
    )

    expect(publication).toContain('credentialSupply.resolveExecution(')
    expect(publication).toContain('secretBox.unseal(connection.globalTokenEnc)')
    expect(publication).toContain('token: globalLookupToken')
    expect(publication).toContain('password: credential.token')
    expect(publication).not.toContain('token: credential.token')
    expect(scheduler).toContain('resolveCodeHostConnectionsFromKeyFile(db, Paths.secretKeyFile)')
    expect(developmentRest).toContain('resolveCodeHostConnectionsFromKeyFile(')
    expect(integrationRest).not.toContain('RepositoryCredentialSubject')
    expect(reconcilerPorts).not.toContain('RepositoryCredentialSubject')
    expect(scheduler).not.toContain('resolveRepositoryTransportCredentialsFromKeyFile')
    expect(developmentRest).not.toContain('resolveRepositoryTransportCredentialsFromKeyFile')
  })

  test('publication public contracts stay secret-free', () => {
    const publicContracts = [
      'packages/backend/src/modules/source-control/public/participants.ts',
      'packages/backend/src/modules/source-control/public/repositoryTransportParticipants.ts',
      'packages/backend/src/modules/source-control/public/types.ts',
    ].map((file) => ({ file, source: read(file) }))
    expect(secretBearingPublicationFields(publicContracts)).toEqual([])

    const fabricated = [{ file: 'fixture.ts', source: 'interface Leak { password: string }' }]
    expect(secretBearingPublicationFields(fabricated)).toEqual(['fixture.ts'])
  })

  test('legacy resolver and token-bearing URL bypasses remain extinct', () => {
    const publicationSources = [
      'packages/backend/src/services/commitPushRunner.ts',
      'packages/backend/src/modules/source-control/application/deliverCandidate.ts',
      'packages/backend/src/modules/source-control/application/employeeCaseWorkspace.ts',
      'packages/backend/src/modules/source-control/composition/repositoryPublicationTransport.ts',
      'packages/backend/src/modules/source-control/infrastructure/gitCredentialLease.ts',
    ].map((file) => ({ file, source: read(file) }))
    expect(repositoryPublicationBoundaryViolations(publicationSources)).toEqual([])

    const fabricated = [
      {
        file: 'fixture.ts',
        source:
          "setPushCredentialResolver(resolve)\nconst remote = 'https://git.test/repo?access_token=secret'",
      },
    ]
    expect(repositoryPublicationBoundaryViolations(fabricated)).toEqual([
      'fixture.ts:legacy-resolver',
      'fixture.ts:token-bearing-url',
    ])
  })

  test('security mutation fixtures prove target binding, no-fallback, route, and URL guards carry weight', () => {
    const production: PublicationSecuritySources = {
      helper: read(
        'packages/backend/src/modules/source-control/infrastructure/gitCredentialLease.ts',
      ),
      selector: read(
        'packages/backend/src/modules/source-control/domain/repositoryTransportCredential.ts',
      ),
      accountRoutes: read('packages/backend/src/routes/accountRepositoryTransportCredentials.ts'),
    }
    expect(repositoryPublicationSecurityInvariantViolations(production)).toEqual([])

    const withoutPathBinding = {
      ...production,
      helper: production.helper.replace(
        "if (normalizedCredentialPath(requestFields.path ?? '') !== lease.path) return ''",
        '// mutation: helper now answers sibling repository paths',
      ),
    }
    expect(repositoryPublicationSecurityInvariantViolations(withoutPathBinding)).toContain(
      'helper-target-path',
    )

    const withPersonalFallback = {
      ...production,
      selector: production.selector.replace(
        "return { ok: false, code: 'code-host-push-credential-stale' }",
        "return input.global === null ? { ok: true, source: 'legacy', credentialRevision: null } : { ok: true, source: 'global', credentialRef: input.global.credentialRef, credentialRevision: input.global.credentialRevision }",
      ),
    }
    expect(repositoryPublicationSecurityInvariantViolations(withPersonalFallback)).toContain(
      'personal-failure-must-not-fallback',
    )

    const patEnabled = {
      ...production,
      accountRoutes: production.accountRoutes.replace("tokenAccess: 'never'", "tokenAccess: 'pat'"),
    }
    expect(repositoryPublicationSecurityInvariantViolations(patEnabled)).toContain(
      'account-route-token-access',
    )

    const tokenUrl = [
      {
        file: 'mutated-publication.ts',
        source: `${read(
          'packages/backend/src/modules/source-control/composition/repositoryPublicationTransport.ts',
        )}\nconst endpoint = 'https://git.example/repo?token=plaintext'`,
      },
    ]
    expect(repositoryPublicationBoundaryViolations(tokenUrl)).toContain(
      'mutated-publication.ts:token-bearing-url',
    )
  })

  test('the evidence index maps every AC and implementation task exactly once', () => {
    const evidence = read('design/RFC-321-user-code-host-push-credentials/evidence.md')
    expect(tableIds(evidence, 'AC-')).toEqual(
      Array.from({ length: 14 }, (_, index) => `AC-${index + 1}`),
    )
    expect(tableIds(evidence, 'T')).toEqual(
      Array.from({ length: 20 }, (_, index) => `T${index + 1}`),
    )
    const acRows = evidence.match(/^\|\s+AC-\d+\s+\|[^\n]+\|[^\n]+\|[^\n]+\|$/gm) ?? []
    const taskRows = evidence.match(/^\|\s+T\d+\s+\|[^\n]+\|\s+AC-[^\n]+\|$/gm) ?? []
    expect(acRows).toHaveLength(14)
    expect(taskRows).toHaveLength(20)
    expect(evidence).not.toContain('UNMAPPED')
  })
})
