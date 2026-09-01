// RFC-346 — locks the System Operations application boundary independently of
// HTTP/catalog wiring, so Cohort A can develop while RFC-344 closes out.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
import {
  buildCanonicalArtifacts,
  targetContextFor,
  targetRemoveAfterWaveFor,
} from './architecture/rfc294Canonical'

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
    expect(server.match(/composeSystemOperations\s*\(/g)).toHaveLength(2)
    expect(server.match(/composePostgresqlSystemOperations\s*\(/g)).toHaveLength(1)
    expect(server).toContain('mountBackupRoutes(app, systemOperations, identityAccess)')
    expect(server).toContain('mountRestoreRoutes(app, systemOperations, identityAccess)')
    expect(server).toContain('for (const alias of SYSTEM_OPERATION_ALIASES)')
  })

  test('canonical ownership is exact and does not swallow maintenance, doctor or migrate', () => {
    for (const path of [
      'packages/backend/src/cli/backup.ts',
      'packages/backend/src/cli/restore.ts',
      'packages/backend/src/routes/backup.ts',
      'packages/backend/src/routes/restore.ts',
    ]) {
      expect(targetContextFor(path)).toBe('system-operations')
      expect(targetRemoveAfterWaveFor(path, '$file')).toBe('W4-E7')
    }

    for (const path of [
      'packages/backend/src/routes/maintenance.ts',
      'packages/backend/src/services/backupScheduler.ts',
      'packages/backend/src/services/maintenanceTicker.ts',
      'packages/backend/src/services/pendingRestore.ts',
      'packages/backend/src/services/restore.ts',
    ]) {
      expect(targetContextFor(path)).toBe('platform')
    }
    for (const path of [
      'packages/backend/src/cli/dbCompact.ts',
      'packages/backend/src/cli/doctor.ts',
      'packages/backend/src/cli/migrate.ts',
      'packages/backend/src/cli/rfc295-downgrade-audit.ts',
    ]) {
      expect(targetContextFor(path)).toBe('bootstrap')
    }

    expect(
      targetRemoveAfterWaveFor(
        'packages/backend/src/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts',
        '$file',
      ),
    ).toBe('W9-E')
    expect(targetRemoveAfterWaveFor('packages/backend/src/services/restore.ts', '$file')).toBe(
      'W9-E',
    )
    expect(
      targetRemoveAfterWaveFor('packages/backend/src/services/backupScheduler.ts', '$file'),
    ).toBe('W9')

    expect(
      targetContextFor(
        'packages/backend/src/services/taskArchive.ts',
        'restoreLegacyMovedDirectories',
      ),
    ).toBe('task-execution')
    expect(
      targetContextFor('packages/backend/src/services/skillVersion.ts', 'restoreSkillVersion'),
    ).toBe('knowledge-evolution')
    expect(targetContextFor('packages/backend/src/util/git.ts', 'restoreBranchRefCas')).toBe(
      'source-control',
    )
  })

  test('canonical registers both coordinator ports and the authority edge as live', () => {
    const canonical = buildCanonicalArtifacts(REPO_ROOT)
    const requiredPorts = canonical.crossContextImports.requiredPorts as Array<{
      id: string
      status: string
      consumerOwnerEntryIds: string[]
      compositionFiles: string[]
      providerAdapters: Array<{ file: string }>
    }>
    for (const id of [
      'required:system-operations:AdminBackupCoordinatorPort',
      'required:system-operations:AdminRestoreCoordinatorPort',
    ]) {
      const port = requiredPorts.find((entry) => entry.id === id)
      expect(port?.status).toBe('active')
      expect(port?.consumerOwnerEntryIds).toContain(
        'owner:packages/backend/src/modules/system-operations/application/systemOperations.ts#$file',
      )
      expect(port?.compositionFiles).toEqual([
        'packages/backend/src/modules/system-operations/composition.ts',
      ])
      expect(port?.providerAdapters.map((entry) => entry.file)).toEqual(
        id === 'required:system-operations:AdminBackupCoordinatorPort'
          ? [
              'packages/backend/src/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts',
              'packages/backend/src/modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator.ts',
            ]
          : [
              'packages/backend/src/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts',
              'packages/backend/src/modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator.ts',
            ],
      )
    }

    const observedEdges = canonical.crossContextImports.observedEdges as Array<{
      fromContext: string
      toContext: string
      role: string
    }>
    expect(
      observedEdges.some(
        (edge) =>
          edge.fromContext === 'system-operations' &&
          edge.toContext === 'identity-access' &&
          edge.role === 'authority-type-only',
      ),
    ).toBe(true)
  }, 60_000)
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
