// RFC-349 — file-backed operation state. The store is independent from both
// business databases and uses exclusive operation locks plus durable atomic
// replace for every revision.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseMigrationStorePort } from '../application/ports/databaseMigrationStore'
import {
  serializeDatabaseMigrationManifest,
  verifyDatabaseMigrationManifest,
  type DatabaseMigrationManifest,
} from '../domain/databaseMigration'

const OPERATION_ID = /^dbm_[A-Za-z0-9_-]{8,128}$/

export class DatabaseMigrationStoreError extends Error {
  constructor(
    public readonly code:
      | 'migration-operation-exists'
      | 'migration-operation-corrupt'
      | 'migration-operation-locked'
      | 'migration-operation-stale'
      | 'migration-operation-readback-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationStoreError'
  }
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) throw new Error('invalid database migration operation id')
}

function fsyncFile(path: string): void {
  const handle = openSync(path, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncFile(path)
  } catch {
    // Directory fsync is not available on every Windows/filesystem pair.
  }
}

function readManifest(path: string): DatabaseMigrationManifest {
  try {
    return verifyDatabaseMigrationManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    throw new DatabaseMigrationStoreError(
      'migration-operation-corrupt',
      `database migration operation manifest is corrupt: ${path}`,
    )
  }
}

export interface FileDatabaseMigrationStoreOptions {
  readonly root: string
  /** Test-only crash oracle immediately before a manifest replace. */
  readonly beforeReplaceForTest?: (operationId: string, revision: number) => void
  /** Test-only crash oracle immediately after a manifest replace. */
  readonly afterReplaceForTest?: (operationId: string, revision: number) => void
  /** Test seams for deterministic crash-left lock recovery. */
  readonly now?: () => number
  readonly isProcessAlive?: (pid: number) => boolean
  readonly staleLockMs?: number
}

interface ManifestLockRecord {
  readonly pid: number
  readonly createdAt: number
  readonly nonce: string
}

interface HeldManifestLock extends ManifestLockRecord {
  readonly handle: number
  readonly body: string
}

function lockBody(record: ManifestLockRecord): string {
  return `version=1\npid=${record.pid}\ncreatedAt=${record.createdAt}\nnonce=${record.nonce}\n`
}

function parseLockBody(value: string): ManifestLockRecord | null {
  const lines = Object.fromEntries(
    value
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=')
        return separator < 1 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
  const pid = Number(lines.pid)
  const createdAt = Number(lines.createdAt)
  if (
    lines.version !== '1' ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    typeof lines.nonce !== 'string' ||
    !/^[A-Za-z0-9-]{8,128}$/.test(lines.nonce)
  ) {
    return null
  }
  return { pid, createdAt, nonce: lines.nonce }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createFileDatabaseMigrationStore(
  options: FileDatabaseMigrationStoreOptions,
): DatabaseMigrationStorePort {
  const now = options.now ?? Date.now
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const staleLockMs = options.staleLockMs ?? 60_000

  const acquireManifestLock = (lockPath: string, operationId: string): HeldManifestLock => {
    const record: ManifestLockRecord = {
      pid: process.pid,
      createdAt: now(),
      nonce: crypto.randomUUID(),
    }
    const body = lockBody(record)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = openSync(lockPath, 'wx', 0o600)
        try {
          writeFileSync(handle, body, { encoding: 'utf8' })
          fsyncSync(handle)
        } catch (error) {
          closeSync(handle)
          try {
            unlinkSync(lockPath)
          } catch {
            // Preserve the lock-record write failure.
          }
          throw error
        }
        return { ...record, handle, body }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      let existing: ManifestLockRecord | null = null
      let oldEnough = false
      try {
        existing = parseLockBody(readFileSync(lockPath, 'utf8'))
        const mtime = statSync(lockPath).mtimeMs
        const oldestObservedAt = existing === null ? mtime : Math.min(mtime, existing.createdAt)
        oldEnough = now() - oldestObservedAt >= staleLockMs
      } catch {
        // The lock may have been released between open and inspection.
        continue
      }
      // A lock owned by a live process is never safe to steal merely because
      // its wall-clock age crossed a threshold. The original owner may resume
      // after a slow fsync and would otherwise overwrite the recovered CAS.
      // Age is only an escape hatch for a corrupt token whose owner cannot be
      // identified; a well-formed dead-process token is safe to reclaim now.
      if (
        (existing !== null && isProcessAlive(existing.pid)) ||
        (existing === null && !oldEnough)
      ) {
        throw new DatabaseMigrationStoreError(
          'migration-operation-locked',
          `database migration operation is being updated: ${operationId}`,
        )
      }

      const quarantine = `${lockPath}.stale-${record.nonce}`
      try {
        renameSync(lockPath, quarantine)
        unlinkSync(quarantine)
        fsyncDirectory(dirname(lockPath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new DatabaseMigrationStoreError(
            'migration-operation-locked',
            `database migration operation lock could not be recovered: ${operationId}`,
          )
        }
      }
    }
    throw new DatabaseMigrationStoreError(
      'migration-operation-locked',
      `database migration operation is being updated: ${operationId}`,
    )
  }

  const releaseManifestLock = (lockPath: string, held: HeldManifestLock): void => {
    closeSync(held.handle)
    try {
      if (readFileSync(lockPath, 'utf8') === held.body) unlinkSync(lockPath)
    } catch {
      // A missing/replaced lock belongs to another recovery attempt. Never
      // delete a path whose ownership token no longer matches this process.
    }
  }

  const operationDir = (operationId: string): string => {
    assertOperationId(operationId)
    return join(options.root, operationId)
  }
  const manifestPath = (operationId: string): string =>
    join(operationDir(operationId), 'manifest.json')

  const read = (operationId: string): DatabaseMigrationManifest | null => {
    const path = manifestPath(operationId)
    if (!existsSync(path)) return null
    return readManifest(path)
  }

  const writeRevision = (
    directory: string,
    manifest: DatabaseMigrationManifest,
    isCreate: boolean,
  ): void => {
    const path = join(directory, 'manifest.json')
    const temporary = join(
      directory,
      `.manifest.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
    )
    let replaced = false
    try {
      writeFileSync(temporary, serializeDatabaseMigrationManifest(manifest), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      fsyncFile(temporary)
      options.beforeReplaceForTest?.(manifest.payload.operationId, manifest.payload.revision)
      renameSync(temporary, path)
      replaced = true
      fsyncDirectory(directory)
      options.afterReplaceForTest?.(manifest.payload.operationId, manifest.payload.revision)
      const readback = readManifest(path)
      if (readback.digest !== manifest.digest) {
        throw new DatabaseMigrationStoreError(
          'migration-operation-readback-mismatch',
          `database migration manifest read-back mismatch: ${manifest.payload.operationId}`,
        )
      }
    } finally {
      if (!replaced && existsSync(temporary)) {
        try {
          unlinkSync(temporary)
        } catch {
          // The original write error is authoritative.
        }
      }
      if (isCreate && !replaced && existsSync(directory)) {
        try {
          rmSync(directory, { recursive: true, force: true })
        } catch {
          // Preserve the original creation failure.
        }
      }
    }
  }

  const store: DatabaseMigrationStorePort = {
    create(manifest) {
      const parsed = verifyDatabaseMigrationManifest(manifest)
      mkdirSync(options.root, { recursive: true })
      const finalDirectory = operationDir(parsed.payload.operationId)
      if (existsSync(finalDirectory)) {
        throw new DatabaseMigrationStoreError(
          'migration-operation-exists',
          `database migration operation already exists: ${parsed.payload.operationId}`,
        )
      }
      const staging = join(
        options.root,
        `.operation.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
      )
      mkdirSync(staging)
      try {
        writeRevision(staging, parsed, true)
        renameSync(staging, finalDirectory)
        fsyncDirectory(options.root)
      } catch (error) {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new DatabaseMigrationStoreError(
            'migration-operation-exists',
            `database migration operation already exists: ${parsed.payload.operationId}`,
          )
        }
        throw error
      }
      return readManifest(manifestPath(parsed.payload.operationId))
    },

    read,

    list() {
      if (!existsSync(options.root)) return []
      return readdirSync(options.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && OPERATION_ID.test(entry.name))
        .map((entry) => read(entry.name))
        .filter((manifest): manifest is DatabaseMigrationManifest => manifest !== null)
        .sort((a, b) => a.payload.createdAt - b.payload.createdAt)
    },

    compareAndSwap(expected, next) {
      assertOperationId(expected.operationId)
      const directory = operationDir(expected.operationId)
      const lockPath = join(directory, '.manifest.lock')
      const lock = acquireManifestLock(lockPath, expected.operationId)
      try {
        const current = read(expected.operationId)
        if (
          current === null ||
          current.payload.revision !== expected.revision ||
          current.digest !== expected.digest ||
          next.payload.operationId !== expected.operationId ||
          next.payload.revision !== expected.revision + 1 ||
          next.payload.previousDigest !== current.digest
        ) {
          throw new DatabaseMigrationStoreError(
            'migration-operation-stale',
            `database migration compare-and-swap is stale: ${expected.operationId}`,
          )
        }
        writeRevision(directory, verifyDatabaseMigrationManifest(next), false)
        return readManifest(manifestPath(expected.operationId))
      } finally {
        releaseManifestLock(lockPath, lock)
      }
    },
  }
  return Object.freeze(store)
}
