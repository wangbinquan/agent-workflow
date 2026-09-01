// RFC-349 — Digital Employee and Development Automation expose only named
// async ports above composition; provider mechanisms remain in adapters.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..')
const BANNED_PROVIDER_MECHANISMS = [
  /from\s+['"]@\/db(?:\/|['"])/,
  /from\s+['"](?:bun:sqlite|drizzle-orm)/,
  /\bDbClient\b/,
  /\bDbTxSync\b/,
  /\bPostgresqlDatabaseClient\b/,
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

function businessFiles(moduleName: string): string[] {
  const root = join(BACKEND, 'src', 'modules', moduleName)
  return ['application', 'domain', 'public'].flatMap((layer) => files(join(root, layer)))
}

export function providerMechanismViolations(candidates: readonly CandidateSource[]): string[] {
  return candidates.flatMap(({ file, source }) =>
    BANNED_PROVIDER_MECHANISMS.flatMap((matcher) =>
      matcher.test(source) ? [`${file} => ${String(matcher)}`] : [],
    ),
  )
}

describe('RFC-349 Digital Employee / Development Automation provider boundary', () => {
  test('business, public, route and owned service facades contain no DB mechanism', () => {
    const candidates = [
      ...businessFiles('digital-employee'),
      ...businessFiles('development-automation'),
      ...[
        'developmentConfig.ts',
        'developmentMissions.ts',
        'digitalEmployees.ts',
        'missionInputUploads.ts',
      ].map((name) => join(BACKEND, 'src', 'routes', name)),
      ...[
        'developmentDeliveryDeps.ts',
        'digitalEmployeeAgentTemplates.ts',
        'employeeCaseMembers.ts',
      ].map((name) => join(BACKEND, 'src', 'services', name)),
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
          file: 'src/modules/digital-employee/application/authoring.ts',
          source: "import { sql } from 'drizzle-orm'",
        },
      ]),
    ).toEqual([
      'src/modules/digital-employee/application/authoring.ts => /from\\s+[\'"](?:bun:sqlite|drizzle-orm)/',
    ])
  })

  test('both live providers have authoring/runtime/mission/config/upload adapters', () => {
    const digital = new Set(
      files(join(BACKEND, 'src', 'modules', 'digital-employee', 'infrastructure')).map((path) =>
        relative(join(BACKEND, 'src', 'modules', 'digital-employee', 'infrastructure'), path),
      ),
    )
    const development = new Set(
      files(join(BACKEND, 'src', 'modules', 'development-automation', 'infrastructure')).map(
        (path) =>
          relative(
            join(BACKEND, 'src', 'modules', 'development-automation', 'infrastructure'),
            path,
          ),
      ),
    )
    expect(
      [
        'sqliteAuthoringStore.ts',
        'postgresqlAuthoringStore.ts',
        'sqliteRuntimeStore.ts',
        'postgresqlRuntimeStore.ts',
        'inputUploadStore.ts',
        'postgresqlInputUploadStore.ts',
        'sqliteReactionRoundQueries.ts',
        'postgresqlReactionRoundQueries.ts',
        'sqliteIntegrationTriggerParticipant.ts',
        'postgresqlIntegrationTriggerParticipant.ts',
        'writerCutoverPersistence.ts',
      ].filter((name) => !digital.has(name)),
    ).toEqual([])
    expect(
      [
        'sqliteConfigResourceStore.ts',
        'postgresqlConfigResourceStore.ts',
        'sqliteMissionStore.ts',
        'postgresqlMissionStore.ts',
        'sqlitePlaybookSagaStore.ts',
        'postgresqlPlaybookSagaStore.ts',
        'sqliteCutoverStore.ts',
        'postgresqlCutoverStore.ts',
        'sqliteReconcilerReaders.ts',
        'postgresqlReconcilerReaders.ts',
        'missionReadModels.ts',
        'postgresqlMissionReadModels.ts',
        'sqliteUploadPlanStore.ts',
        'postgresqlUploadPlanStore.ts',
        'missionInputUploadPersistence.ts',
        'postgresqlMigrationAssets.ts',
      ].filter((name) => !development.has(name)),
    ).toEqual([])
  })

  test('PostgreSQL adapters do not cast to SQLite, shadow, or deasync', () => {
    const source = ['digital-employee', 'development-automation']
      .flatMap((moduleName) =>
        files(join(BACKEND, 'src', 'modules', moduleName, 'infrastructure')).filter((file) =>
          /\/postgresql[^/]+\.ts$/.test(file),
        ),
      )
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/\bas\s+(?:unknown\s+as\s+)?DbClient\b/)
    expect(source).not.toContain('createInMemoryDb')
    expect(source).not.toContain('bun:sqlite')
    expect(source).not.toContain('deasync')
  })

  test('atomic trigger snapshot and maintenance owners expose closed factories', () => {
    const digital = readFileSync(
      join(BACKEND, 'src', 'modules', 'digital-employee', 'composition.ts'),
      'utf8',
    )
    const development = readFileSync(
      join(BACKEND, 'src', 'modules', 'development-automation', 'composition.ts'),
      'utf8',
    )
    expect(digital).toContain('composeDigitalEmployeeIntegrationTriggerParticipant')
    expect(digital).toContain('composeAsyncDigitalEmployeeIntegrationTriggerParticipant')
    expect(digital).toContain('createSqliteDigitalEmployeeIntegrationTriggerParticipantSync')
    expect(digital).toContain('composeSqliteDigitalEmployeeBootstrapReads')
    expect(digital).toContain('composePostgresqlDigitalEmployeeBootstrapReads')
    expect(digital).toContain('createSqliteDigitalEmployeeAuthoringReads')
    expect(digital).toContain('createPostgresqlDigitalEmployeeAuthoringReads')
    expect(digital).toContain('composePostgresqlDigitalEmployeeMaintenanceCommands')
    expect(digital).toContain('composePostgresqlDigitalEmployeeWriterCutover')
    expect(development).toContain('composeDevelopmentAutomationMaintenanceCommands')
    expect(development).toContain('composePostgresqlDevelopmentAutomationMaintenanceCommands')
  })
})
