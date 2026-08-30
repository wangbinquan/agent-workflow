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
} from '../src/modules/system-operations/public/types'
import {
  backupResultViewSchema,
  recoveryStatusViewSchema,
  requestBackupInputSchema,
  stageRestoreOptionsSchema,
} from '../src/modules/system-operations/public/types'

const SOURCE_ROOT = join(import.meta.dirname, '../src')
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
    expect(queries).toContain(
      "import type { QueryContext } from '@/modules/identity-access/public/participants'",
    )
    expect(queries).toContain('execute(context: QueryContext): RecoveryStatusView')
    expect(queries).not.toContain('type SystemOperationQueryContext')
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
      'queries.ts',
      'types.ts',
    ])
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
