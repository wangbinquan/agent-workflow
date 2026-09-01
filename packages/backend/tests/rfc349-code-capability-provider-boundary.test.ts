// RFC-349 — code-capability application/public/transport never regain a
// provider mechanism, and both live providers keep an explicit adapter roster.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..')
const MODULE = join(BACKEND, 'src', 'modules', 'code-capability')
const BANNED_PROVIDER_MECHANISMS = [
  /from\s+['"]@\/db(?:\/|['"])/,
  /from\s+['"](?:bun:sqlite|drizzle-orm)/,
  /\bDbClient\b/,
  /\bdbTxSync\b/,
  /\bPostgresqlDatabaseClient\b/,
  /\/infrastructure\//,
] as const

interface CandidateSource {
  readonly file: string
  readonly source: string
}

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

export function providerMechanismViolations(candidates: readonly CandidateSource[]): string[] {
  return candidates.flatMap(({ file, source }) =>
    BANNED_PROVIDER_MECHANISMS.flatMap((matcher) =>
      matcher.test(source) ? [`${file} => ${String(matcher)}`] : [],
    ),
  )
}

describe('RFC-349 code-capability provider boundary', () => {
  test('application/domain/public and code transport contain no database mechanism', () => {
    const candidates = [
      ...files(join(MODULE, 'application')),
      ...files(join(MODULE, 'domain')),
      ...files(join(MODULE, 'public')),
      join(BACKEND, 'src', 'routes', 'code.ts'),
      join(BACKEND, 'src', 'routes', 'capabilityTemplates.ts'),
      join(BACKEND, 'src', 'services', 'capabilityTemplates.ts'),
      join(BACKEND, 'src', 'services', 'codeCapabilityParams.ts'),
      join(BACKEND, 'src', 'services', 'codeIntel', 'codeIntel.ts'),
      join(BACKEND, 'src', 'services', 'codeIntel', 'fileSymbols.ts'),
      join(BACKEND, 'src', 'services', 'changeNarrative.ts'),
      join(BACKEND, 'src', 'services', 'structuralDiff', 'service.ts'),
    ]
    expect(candidates.length).toBeGreaterThanOrEqual(10)
    const violations = providerMechanismViolations(
      candidates.map((file) => ({
        file: relative(BACKEND, file),
        source: readFileSync(file, 'utf8'),
      })),
    )
    expect(violations).toEqual([])
  })

  test('negative fixture: a business import of a provider mechanism is rejected', () => {
    expect(
      providerMechanismViolations([
        {
          file: 'src/modules/code-capability/application/orders.ts',
          source: "import { openDb } from '@/db/client'",
        },
      ]),
    ).toEqual([
      'src/modules/code-capability/application/orders.ts => /from\\s+[\'"]@\\/db(?:\\/|[\'"])/',
    ])
  })

  test('SQLite and PostgreSQL own the same closed live adapter families', () => {
    const infrastructure = new Set(
      files(join(MODULE, 'infrastructure')).map((file) =>
        relative(join(MODULE, 'infrastructure'), file),
      ),
    )
    const families = [
      ['sqliteCapabilityMatrix.ts', 'postgresqlCapabilityMatrixRead.ts'],
      ['sqliteCodeMetricsRead.ts', 'postgresqlCodeMetricsQuery.ts'],
      ['sqliteDeliveryChain.ts', 'postgresqlDeliveryChain.ts'],
      ['sqliteRoundAttemptsRead.ts', 'postgresqlRoundAttemptsRead.ts'],
      ['sqliteWorkItemProjectionRead.ts', 'postgresqlWorkItemProjectionRead.ts'],
      ['sqliteRepoEndpointRead.ts', 'postgresqlRepoEndpointRead.ts'],
      ['sqliteReadinessFactsRead.ts', 'postgresqlReadinessFactsRead.ts'],
      ['sqliteTemplateUpstreamPersistence.ts', 'postgresqlTemplateUpstreamPersistence.ts'],
      ['sqliteCapabilityTemplatePersistence.ts', 'postgresqlCapabilityTemplatePersistence.ts'],
      ['sqliteCapabilityParamRead.ts', 'postgresqlCapabilityParamRead.ts'],
      ['sqliteCodeWorkspaceRead.ts', 'postgresqlCodeWorkspaceRead.ts'],
      ['sqliteDemoSeedPersistence.ts', 'postgresqlDemoSeedPersistence.ts'],
    ]
    const missing = families.flatMap((family) => family.filter((file) => !infrastructure.has(file)))
    expect(missing).toEqual([])
  })

  test('PostgreSQL adapters do not cast to SQLite, shadow data, or deasync', () => {
    const source = files(join(MODULE, 'infrastructure'))
      .filter((file) => /\/postgresql[^/]+\.ts$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/\bas\s+(?:unknown\s+as\s+)?DbClient\b/)
    expect(source).not.toContain('createInMemoryDb')
    expect(source).not.toContain('bun:sqlite')
    expect(source).not.toContain('deasync')
  })

  test('package mutation exposes provider-bound atomic participants', () => {
    const source = readFileSync(
      join(MODULE, 'infrastructure', 'capabilityTemplatePackageCommit.ts'),
      'utf8',
    )
    expect(source).toContain('createSqliteCapabilityTemplatePackageCommitSync')
    expect(source).toContain('createPostgresqlCapabilityTemplatePackageCommit')
    expect(source).toContain('tx.insert(capabilityTemplates)')
    expect(source).toContain('await tx')
  })

  test('capability-template transport consumes the injected upstream operation', () => {
    const source = readFileSync(join(BACKEND, 'src', 'routes', 'capabilityTemplates.ts'), 'utf8')
    expect(source).toContain('deps.codeHistoryQueries.templateUpstream')
    expect(source).toContain('templateUpstream.read(id)')
    expect(source).toContain('templateUpstream.merge(id, actor)')
    expect(source).not.toContain('readUpstreamReport(deps.db')
    expect(source).not.toContain('mergeFromUpstream(deps.db')
  })

  test('demo seed exposes one provider-neutral aggregate participant', () => {
    const source = readFileSync(join(MODULE, 'composition', 'demoSeed.ts'), 'utf8')
    expect(source).toContain('composeSqliteCodeCapabilityDemoSeedParticipant')
    expect(source).toContain('composePostgresqlCodeCapabilityDemoSeedParticipant')
    expect(source).toContain('createCodeCapabilityDemoSeedParticipant')
    expect(source).not.toContain('as unknown as')
  })
})
