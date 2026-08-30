// RFC-346 — verifies the compatibility adapter preserves the established
// backup/stage/status/cold-restore effect order without moving RFC-213 mechanics.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '../src/db/client'
import { createLegacyPlatformRecoveryAdapter } from '../src/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter'
import { createRestoreArtifactIngress } from '../src/modules/system-operations/infrastructure/restoreArtifactIngress'
import { removeTempDirSync } from './fixtures/tempDir'

const tmps: string[] = []
function tmp(): string {
  const path = mkdtempSync(join(tmpdir(), 'rfc346-'))
  tmps.push(path)
  return path
}

afterEach(() => {
  for (const path of tmps.splice(0)) removeTempDirSync(path)
})

describe('RFC-346 legacy platform adapter', () => {
  test('backup prepares credentials exactly once before exactly one snapshot', async () => {
    const home = tmp()
    const log: string[] = []
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        ensureCredentialsSealed(_db, _secretBox, options) {
          log.push(`seal:${options?.blockOnCredentialedPath === true}`)
          return { sealed: 0, linked: 0, scrubbed: 0 }
        },
        async createBackup(options) {
          log.push(`backup:${options.includeWorktrees === true}:${options.appHome === home}`)
          return {
            path: join(home, 'backup.tar.gz'),
            sizeBytes: 1,
            contents: { workflows: 0, skills: 0, db: true, config: false },
          }
        },
      },
    })

    await expect(adapter.backup.request({ includeWorktrees: true })).resolves.toMatchObject({
      sizeBytes: 1,
    })
    expect(log).toEqual(['seal:true', 'backup:true:true'])
  })

  test('backup preparation failure prevents the snapshot effect', async () => {
    const home = tmp()
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    let backupCalls = 0
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        ensureCredentialsSealed() {
          throw new Error('credential preparation failed')
        },
        async createBackup() {
          backupCalls += 1
          throw new Error('must not run')
        },
      },
    })

    await expect(adapter.backup.request({ includeWorktrees: false })).rejects.toThrow(
      'credential preparation failed',
    )
    expect(backupCalls).toBe(0)
  })

  test('stage validates first and forwards every established restore option', async () => {
    const home = tmp()
    const log: string[] = []
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/backup.tar.gz')
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      now: () => 42,
      mechanisms: {
        async validateBackupForStage(path, options) {
          log.push(`validate:${path}:${options?.skipIntegrityCheck === true}`)
          return {
            manifest: null,
            backupLastCreatedAt: null,
            currentMaxWhen: 1,
            direction: 'forward',
          }
        },
        stagePendingRestore(path, options) {
          log.push(
            `stage:${path}:${options.noSafetyBackup === true}:${options.noMigrate === true}:${options.skipIntegrityCheck === true}:${options.now}`,
          )
        },
      },
    })

    await expect(
      adapter.restore.stage(ref, {
        noSafetyBackup: true,
        noMigrate: true,
        skipIntegrityCheck: true,
      }),
    ).resolves.toEqual({ direction: 'forward' })
    expect(log).toEqual([
      'validate:/input/backup.tar.gz:true',
      'stage:/input/backup.tar.gz:true:true:true:42',
    ])
  })

  test('stage never writes pending state when validation fails', async () => {
    const home = tmp()
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/invalid.tar.gz')
    let stageCalls = 0
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        async validateBackupForStage() {
          throw new Error('invalid restore package')
        },
        stagePendingRestore() {
          stageCalls += 1
        },
      },
    })

    await expect(
      adapter.restore.stage(ref, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).rejects.toThrow('invalid restore package')
    expect(stageCalls).toBe(0)
  })

  test('stage preserves an existing pending-restore conflict', async () => {
    const home = tmp()
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/backup.tar.gz')
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        async validateBackupForStage() {
          return {
            manifest: null,
            backupLastCreatedAt: null,
            currentMaxWhen: 1,
            direction: 'same',
          }
        },
        stagePendingRestore() {
          throw new Error('a pending restore already exists')
        },
      },
    })

    await expect(
      adapter.restore.stage(ref, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).rejects.toThrow('a pending restore already exists')
  })

  test('cold activation holds and releases the daemon lock around restore', async () => {
    const home = tmp()
    const log: string[] = []
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/backup.tar.gz')
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        readPidFromLock() {
          log.push('read-pid')
          return null
        },
        acquireLock() {
          log.push('lock')
          return { pid: 1, path: '/lock', release: () => log.push('release') }
        },
        async restoreBackup(path, options) {
          log.push(
            `restore:${path}:${options?.noSafetyBackup === true}:${options?.noMigrate === true}:${options?.skipIntegrityCheck === true}`,
          )
          return {
            direction: 'same',
            safetyBackupPath: null,
            migrated: false,
            restored: { db: true, config: true, skills: true },
          }
        },
      },
    })

    await expect(
      adapter.restore.activateLocal(ref, {
        noSafetyBackup: true,
        noMigrate: false,
        skipIntegrityCheck: true,
      }),
    ).resolves.toMatchObject({ status: 'completed', direction: 'same' })
    expect(log).toEqual([
      'read-pid',
      'lock',
      'restore:/input/backup.tar.gz:true:false:true',
      'release',
    ])
  })

  test('cold activation releases the daemon lock when restore throws', async () => {
    const home = tmp()
    const log: string[] = []
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/backup.tar.gz')
    const adapter = createLegacyPlatformRecoveryAdapter({
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
      mechanisms: {
        readPidFromLock: () => null,
        acquireLock() {
          log.push('lock')
          return { pid: 1, path: '/lock', release: () => log.push('release') }
        },
        async restoreBackup() {
          log.push('restore')
          throw new Error('post-swap failure')
        },
      },
    })

    await expect(
      adapter.restore.activateLocal(ref, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).rejects.toThrow('post-swap failure')
    expect(log).toEqual(['lock', 'restore', 'release'])
  })

  test('live-daemon and lock-race outcomes do not invoke restore', async () => {
    const home = tmp()
    const artifacts = createRestoreArtifactIngress({ uploadRoot: join(home, 'uploads') })
    const ref = artifacts.ingestLocalPath('/input/backup.tar.gz')
    let restoreCalls = 0
    const base = {
      artifacts,
      backupResources: () => ({ db: {} as DbClient, secretBox: undefined }),
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      lockPath: join(home, '.daemon.lock'),
      resolveRestoreMigrations: async () => '/migrations',
    }
    const live = createLegacyPlatformRecoveryAdapter({
      ...base,
      mechanisms: {
        readPidFromLock: () => 321,
        isProcessAlive: () => true,
        restoreBackup: async () => {
          restoreCalls += 1
          throw new Error('must not run')
        },
      },
    })
    await expect(
      live.restore.activateLocal(ref, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).resolves.toEqual({ status: 'daemon-running', pid: 321 })

    const lockRace = createLegacyPlatformRecoveryAdapter({
      ...base,
      mechanisms: {
        readPidFromLock: () => null,
        acquireLock: () => {
          throw new Error('race')
        },
        restoreBackup: async () => {
          restoreCalls += 1
          throw new Error('must not run')
        },
      },
    })
    await expect(
      lockRace.restore.activateLocal(ref, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).resolves.toEqual({ status: 'lock-unavailable' })
    expect(restoreCalls).toBe(0)
  })

  test('HTTP ingress owns and removes its temporary upload; local path is untouched', async () => {
    const home = tmp()
    const ingress = createRestoreArtifactIngress({
      uploadRoot: join(home, 'uploads'),
      id: () => 'fixed',
    })
    const uploaded = await ingress.ingestHttpUpload({
      async arrayBuffer() {
        return Uint8Array.from([1, 2, 3]).buffer
      },
    })
    const uploadPath = ingress.pathOf(uploaded)
    expect(readFileSync(uploadPath)).toEqual(Buffer.from([1, 2, 3]))
    ingress.release(uploaded)
    expect(existsSync(uploadPath)).toBe(false)

    const localPath = join(home, 'local.tar.gz')
    const local = ingress.ingestLocalPath(localPath)
    expect(ingress.pathOf(local)).toBe(localPath)
    ingress.release(local)
    expect(() => ingress.pathOf(local)).toThrow('no longer available')
  })

  test('HTTP ingress removes the reserved path when upload decoding fails', async () => {
    const home = tmp()
    const uploadRoot = join(home, 'uploads')
    const ingress = createRestoreArtifactIngress({ uploadRoot, id: () => 'failed' })

    await expect(
      ingress.ingestHttpUpload({
        async arrayBuffer() {
          throw new Error('decode failed')
        },
      }),
    ).rejects.toThrow('decode failed')
    expect(existsSync(join(uploadRoot, 'upload-failed.tar.gz'))).toBe(false)
  })
})
