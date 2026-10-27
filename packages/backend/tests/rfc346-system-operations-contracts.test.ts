// RFC-346 — locks the System Operations application boundary independently of
// HTTP/catalog wiring, so Cohort A can develop while RFC-344 closes out.

import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { createSystemOperationsApplication } from '../src/modules/system-operations/application/systemOperations'
import type { AdminBackupCoordinatorPort } from '../src/modules/system-operations/application/ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from '../src/modules/system-operations/application/ports/adminRestoreCoordinator'
import type {
  LocalSystemOperationContext,
  RestoreArtifactRef,
  StageRestoreInput,
} from '../src/modules/system-operations/public/types'
import {
  backupResultViewSchema,
  recoveryStatusViewSchema,
  requestBackupInputSchema,
  stageRestoreOptionsSchema,
} from '../src/modules/system-operations/public/types'
import {
  createSystemOperationDescriptors,
  SYSTEM_OPERATION_ALIASES,
} from '../src/modules/system-operations/public/operations'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { createGateCorpus } from './architecture/rfc294Gates'

// Slowest case took 5.41 s on CI run 40433510287 including hooks (4.40 s before RFC-395 II-b); allow 20 s.
setDefaultTimeout(20_000)

const SOURCE_ROOT = join(import.meta.dirname, '../src')
const REPO_ROOT = join(import.meta.dirname, '../../..')
const localContext = Object.freeze({}) as LocalSystemOperationContext
const artifactRef = Object.freeze({}) as RestoreArtifactRef

function fakePorts(log: string[]): {
  backup: AdminBackupCoordinatorPort
  restore: AdminRestoreCoordinatorPort
} {
  return {
    backup: {
      async request(input) {
        log.push(`backup:${input.includeWorktrees}`)
        return {
          path: '/display/backup.tar.gz',
          sizeBytes: 1024,
          contents: { workflows: 2, skills: 3, db: true, config: false },
        }
      },
    },
    restore: {
      async plan(ref, input) {
        expect(ref).toBe(artifactRef)
        log.push(`plan:${input.skipIntegrityCheck}`)
        return {
          backupKind: 'manual',
          backupMigrationCreatedAt: 10,
          binaryMigrationCreatedAt: 11,
          direction: 'forward',
        }
      },
      async stage(ref, input) {
        expect(ref).toBe(artifactRef)
        log.push(`stage:${input.noSafetyBackup}:${input.noMigrate}:${input.skipIntegrityCheck}`)
        return { direction: 'same' }
      },
      status() {
        log.push('status')
        return {
          pending: {
            requestedAt: 1,
            stagedBytes: 99,
            noMigrate: true,
            skipIntegrityCheck: false,
          },
          failed: [{ dir: '/display/failed', failedAt: 2, error: 'boom' }],
        }
      },
      cancel() {
        log.push('cancel')
        return { cleared: true }
      },
      async activateLocal(ref, input) {
        expect(ref).toBe(artifactRef)
        log.push(`activate:${input.noSafetyBackup}:${input.noMigrate}:${input.skipIntegrityCheck}`)
        return {
          status: 'completed',
          direction: 'same',
          safetyBackupPath: null,
          migrated: false,
          restored: { db: true, config: false, skills: true },
        }
      },
    },
  }
}

describe('RFC-346 System Operations contracts', () => {
  test('strict DTO schemas reject unknown fields', () => {
    expect(() => requestBackupInputSchema.parse({ includeWorktrees: false, extra: true })).toThrow()
    expect(() =>
      stageRestoreOptionsSchema.parse({
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
        extra: true,
      }),
    ).toThrow()
    expect(() =>
      backupResultViewSchema.parse({
        path: '/x',
        sizeBytes: 1,
        contents: { workflows: 0, skills: 0, db: true, config: true, extra: true },
      }),
    ).toThrow()
    expect(() =>
      recoveryStatusViewSchema.parse({ pending: null, failed: [], extra: true }),
    ).toThrow()
  })

  test('authority contexts stay on executable contracts instead of DTO aliases', () => {
    const publicRoot = join(SOURCE_ROOT, 'modules/system-operations/public')
    const types = readFileSync(join(publicRoot, 'types.ts'), 'utf8')
    const commands = readFileSync(join(publicRoot, 'commands.ts'), 'utf8')
    const queries = readFileSync(join(publicRoot, 'queries.ts'), 'utf8')

    expect(types).not.toContain('@/modules/identity-access/public/participants')
    expect(types).not.toMatch(/\bSystemOperation(?:Command|Query)Context\b/)
    expect(commands).toContain(
      "import type { CommandContext } from '@/modules/identity-access/public/participants'",
    )
    expect(commands).toContain('context: CommandContext | LocalSystemOperationContext')
    expect(commands).not.toContain('type SystemOperationCommandContext')
    expect(queries).toMatch(
      /import type \{[\s\S]*?\bQueryContext\b[\s\S]*?\} from '@\/modules\/identity-access\/public\/participants'/,
    )
    expect(queries).toContain('execute(context: QueryContext): RecoveryStatusView')
    expect(queries).not.toContain('type SystemOperationQueryContext')
  })

  test('exports exactly four primary operation ids and four one-to-one legacy aliases', () => {
    expect(SYSTEM_OPERATION_ALIASES.map((entry) => String(entry.target))).toEqual([
      'system-operations.request-backup.v1',
      'system-operations.get-recovery-status.v1',
      'system-operations.cancel-staged-restore.v1',
      'system-operations.stage-restore.v1',
    ])
    expect(
      SYSTEM_OPERATION_ALIASES.map((entry) => ({
        alias: String(entry.alias),
        target: String(entry.target),
        removeAfter: entry.removeAfter,
      })),
    ).toEqual([
      {
        alias: 'legacy-http.post-backup.v1',
        target: 'system-operations.request-backup.v1',
        removeAfter: 'explicit-consumer-zero-decision',
      },
      {
        alias: 'legacy-http.read-restore-pending.v1',
        target: 'system-operations.get-recovery-status.v1',
        removeAfter: 'explicit-consumer-zero-decision',
      },
      {
        alias: 'legacy-http.delete-restore-pending.v1',
        target: 'system-operations.cancel-staged-restore.v1',
        removeAfter: 'explicit-consumer-zero-decision',
      },
      {
        alias: 'legacy-http.post-restore.v1',
        target: 'system-operations.stage-restore.v1',
        removeAfter: 'explicit-consumer-zero-decision',
      },
    ])
    expect(new Set(SYSTEM_OPERATION_ALIASES.map((entry) => entry.alias)).size).toBe(4)
    expect(new Set(SYSTEM_OPERATION_ALIASES.map((entry) => entry.target)).size).toBe(4)
  })

  test('effect descriptors preserve established conflict errors without widening reads', () => {
    const application = createSystemOperationsApplication(fakePorts([]))
    const operations = createSystemOperationDescriptors({
      commands: application.commands,
      queries: application.queries,
      stageRestoreInput: {
        name: 'rfc346.live-stage-input',
        version: 1,
        parse: (value) => value as StageRestoreInput,
      },
    })
    expect(operations.requestBackup.publicErrors).toEqual([
      'validation-failed',
      'conflict',
      'internal-error',
    ])
    expect(operations.stageRestore.publicErrors).toEqual([
      'validation-failed',
      'conflict',
      'internal-error',
    ])
    expect(operations.getRecoveryStatus.publicErrors).toEqual([
      'validation-failed',
      'internal-error',
    ])
    expect(operations.cancelStagedRestore.publicErrors).toEqual([
      'validation-failed',
      'internal-error',
    ])
  })

  test('all six use cases call only the two narrow coordinator ports', async () => {
    const log: string[] = []
    const application = createSystemOperationsApplication(fakePorts(log))

    expect(
      await application.commands.requestBackup.execute(localContext, {
        includeWorktrees: true,
      }),
    ).toEqual({
      path: '/display/backup.tar.gz',
      sizeBytes: 1024,
      contents: { workflows: 2, skills: 3, db: true, config: false },
    })
    expect(
      await application.queries.planLocalRestore.execute(localContext, {
        artifactRef,
        skipIntegrityCheck: true,
      }),
    ).toMatchObject({ direction: 'forward', backupKind: 'manual' })
    expect(
      await application.commands.stageRestore.execute(localContext, {
        artifactRef,
        noSafetyBackup: true,
        noMigrate: false,
        skipIntegrityCheck: true,
      }),
    ).toEqual({ direction: 'same' })
    expect(
      await application.commands.activateLocalRestore.execute(localContext, {
        artifactRef,
        noSafetyBackup: false,
        noMigrate: true,
        skipIntegrityCheck: true,
      }),
    ).toMatchObject({ status: 'completed', direction: 'same' })

    const queries = application.queries as unknown as {
      getRecoveryStatus: { execute(context: unknown): unknown }
    }
    const commands = application.commands as unknown as {
      cancelStagedRestore: { execute(context: unknown): unknown }
    }
    expect(queries.getRecoveryStatus.execute({})).toEqual({
      pending: {
        requestedAt: 1,
        stagedBytes: 99,
        noMigrate: true,
        skipIntegrityCheck: false,
      },
      failed: [{ dir: '/display/failed', failedAt: 2, error: 'boom' }],
    })
    expect(commands.cancelStagedRestore.execute({})).toEqual({ cleared: true })

    expect(log).toEqual([
      'backup:true',
      'plan:true',
      'stage:true:false:true',
      'activate:false:true:true',
      'status',
      'cancel',
    ])
  })

  test('domain/public/application layers have no legacy mechanism or transport imports', () => {
    const root = join(import.meta.dirname, '../src/modules/system-operations')
    const files = ['domain', 'public', 'application'].flatMap((layer) => walk(join(root, layer)))
    const offenders = files
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) =>
        /from ['"](?:node:(?:fs|path)|hono|@\/(?:db|services|routes|server|util\/paths))/.test(
          source,
        ),
      )
      .map(({ path }) => path.slice(root.length + 1))
      .sort()
    expect(offenders).toEqual([])
    expect(readdirSync(join(root, 'public')).sort()).toEqual([
      'commands.ts',
      'operations.ts',
      'participants.ts',
      'queries.ts',
      'types.ts',
    ])
  })

  test('HTTP routes are thin descriptor adapters and bootstrap composes one module root', () => {
    const backup = readFileSync(join(SOURCE_ROOT, 'routes/backup.ts'), 'utf8')
    const restore = readFileSync(join(SOURCE_ROOT, 'routes/restore.ts'), 'utf8')
    const server = readFileSync(join(SOURCE_ROOT, 'server.ts'), 'utf8')
    for (const source of [backup, restore]) {
      expect(source).toContain('registerOperationRoute')
      expect(source).not.toMatch(
        /from ['"](?:node:(?:fs|path)|@\/(?:db|services|server|util\/(?:paths|migrationsFolder)))/,
      )
      expect(source).not.toMatch(
        /from ['"]@\/modules\/[^/'"]+\/(?:application|composition|domain|infrastructure)(?:\/|['"])/,
      )
      expect(source).toContain('@/modules/identity-access/public/participants')
      expect(source).toContain('@/modules/system-operations/public/operations')
      expect(source).not.toContain('AppDeps')
      expect(source).not.toContain('registerRoute(')
    }
    expect(backup).toContain('systemOperations.operations.requestBackup')
    expect(restore).toContain('systemOperations.operations.getRecoveryStatus')
    expect(restore).toContain('systemOperations.operations.cancelStagedRestore')
    expect(restore).toContain('systemOperations.operations.stageRestore')
    const adapters = readFileSync(join(SOURCE_ROOT, 'bootstrap/daemonModules/adapters.ts'), 'utf8')
    expect(adapters.match(/composeSystemOperations\s*\(/g)).toHaveLength(1)
    expect(adapters.match(/composePostgresqlSystemOperations\s*\(/g)).toHaveLength(1)
    expect(server).toContain(
      'mountBackupRoutes(app, input.system.backup.operations, input.system.backup.identityAccess)',
    )
    expect(server).toContain(
      'mountRestoreRoutes(app, input.system.restore.operations, input.system.restore.identityAccess)',
    )
    expect(server).toContain('for (const alias of SYSTEM_OPERATION_ALIASES)')
  })

  test('both coordinator ports have production consumers, composition and provider adapters', () => {
    const units = backendUnits(REPO_ROOT)
    expect(units.length).toBeGreaterThan(800)
    const root = 'packages/backend/src/modules/system-operations/'
    for (const [port, adapters] of [
      [
        'adminBackupCoordinator',
        [
          'infrastructure/crewstation/databaseBackups.ts',
          'infrastructure/legacyPlatformRecoveryAdapter.ts',
          'infrastructure/postgresqlAdminBackupCoordinator.ts',
        ],
      ],
      [
        'adminRestoreCoordinator',
        [
          'infrastructure/legacyPlatformRecoveryAdapter.ts',
          'infrastructure/postgresqlAdminRestoreCoordinator.ts',
        ],
      ],
    ] as const) {
      const consumers = requiredPortImporters(
        units,
        `${root}application/ports/${port}.ts`,
        port === 'adminBackupCoordinator'
          ? 'AdminBackupCoordinatorPort'
          : 'AdminRestoreCoordinatorPort',
      )
      expect(consumers).toContain(root + 'application/systemOperations.ts')
      expect(consumers.filter((file) => file === root + 'composition.ts')).toEqual([
        root + 'composition.ts',
      ])
      expect(consumers.filter((file) => file.startsWith(root + 'infrastructure/'))).toEqual(
        adapters.map((file) => root + file),
      )
    }
    expect(
      createGateCorpus(units).edges.some(
        (edge) =>
          edge.from.path.startsWith(root) &&
          edge.kind === 'type' &&
          /\/identity-access\/public\/(?:types|participants)\.ts$/.test(edge.target),
      ),
    ).toBe(true)
  })

  test('required-port import scanning detects a missing consumer and resolves type-only relative edges', () => {
    const target = 'packages/backend/src/modules/probe/application/ports/port.ts'
    const consumer = 'packages/backend/src/modules/probe/composition.ts'
    const units = [
      sourceUnit(target, 'export interface Port {}'),
      sourceUnit(consumer, "import type { Port } from './application/ports/port'"),
    ]
    expect(requiredPortImporters(units, target, 'Port')).toEqual([consumer])
    expect(requiredPortImporters(units.slice(0, 1), target, 'Port')).toEqual([])
    expect(
      requiredPortImporters(
        [
          sourceUnit(target, 'export interface Port {}; export interface Dto {}'),
          sourceUnit(consumer, "import type { Dto } from './application/ports/port'"),
        ],
        target,
        'Port',
      ),
    ).toEqual([])
    expect(
      requiredPortImporters(
        [
          sourceUnit(target, 'export interface Port {}'),
          sourceUnit(consumer, "import type { Port as Alias } from './application/ports/port'"),
        ],
        target,
        'Port',
      ),
    ).toEqual([consumer])

    expect(
      requiredPortImporters(
        [sourceUnit(consumer, "// import type { Port } from './application/ports/port'")],
        target,
        'Port',
      ),
    ).toEqual([])
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

function requiredPortImporters(
  units: readonly SourceUnit[],
  target: string,
  symbol: string,
): string[] {
  const corpus = createGateCorpus(units)
  return [
    ...new Set(
      corpus.edges
        .filter(
          (edge) =>
            edge.target === target &&
            edge.from.source.statements.some((node) => {
              if (
                !ts.isImportDeclaration(node) ||
                !ts.isStringLiteralLike(node.moduleSpecifier) ||
                node.moduleSpecifier.text !== edge.specifier
              )
                return false
              const bindings = node.importClause?.namedBindings
              return (
                bindings !== undefined &&
                ts.isNamedImports(bindings) &&
                bindings.elements.some(
                  (binding) => (binding.propertyName ?? binding.name).text === symbol,
                )
              )
            }),
        )
        .map((edge) => edge.from.path),
    ),
  ].sort()
}
