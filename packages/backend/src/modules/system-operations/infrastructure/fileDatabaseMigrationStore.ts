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
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
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
}

export function createFileDatabaseMigrationStore(
  options: FileDatabaseMigrationStoreOptions,
): DatabaseMigrationStorePort {
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
      let lockHandle: number
      try {
        lockHandle = openSync(lockPath, 'wx', 0o600)
      } catch {
        throw new DatabaseMigrationStoreError(
          'migration-operation-locked',
          `database migration operation is being updated: ${expected.operationId}`,
        )
      }
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
        closeSync(lockHandle)
        try {
          unlinkSync(lockPath)
        } catch {
          // A leftover lock fails closed until operator recovery.
        }
      }
    },
  }
  return Object.freeze(store)
}
