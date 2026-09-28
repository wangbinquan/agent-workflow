// RFC-370 A-T2 — standalone file adapter for database generation artifacts.
// Existing callers keep their paths and atomic replace/crash semantics.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalSchemaJson } from './schemaContract'
import {
  DatabaseGenerationError,
  DatabaseGenerationPayloadSchema,
  digestGenerationPayload,
  parseDatabaseGenerationText,
  readDatabaseGenerationFromArtifacts,
  readDatabaseGenerationForBootstrapFromArtifacts,
  type DatabaseGenerationArtifactReader,
  type DatabaseGenerationBootstrapPolicy,
  type DatabaseGenerationFile,
  type DatabaseGenerationPayload,
} from './generationValidation'

export {
  DatabaseGenerationError,
  digestDatabaseArtifact,
  digestGenerationPayload,
  type DatabaseGenerationPayload,
  type DatabaseGenerationFile,
  type DatabaseGenerationBootstrapCandidate,
  type ResolvedDatabaseGeneration,
} from './generationValidation'

export interface ReadDatabaseGenerationOptions {
  readonly pointerPath: string
  readonly migrationsDir: string
  readonly expectedSchemaDigest: string
}

export function createFileDatabaseGenerationArtifacts(input: {
  readonly pointerPath: string
  readonly migrationsDir: string
}): DatabaseGenerationArtifactReader {
  return Object.freeze({
    pointerLabel: input.pointerPath,
    readPointer: () =>
      existsSync(input.pointerPath) ? readFileSync(input.pointerPath, 'utf8') : null,
    readManifest(operationId: string) {
      const path = join(input.migrationsDir, operationId, 'manifest.json')
      return existsSync(path) ? readFileSync(path) : null
    },
  })
}

function parseGenerationFile(path: string): DatabaseGenerationFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer is unreadable: ${path}`,
    )
  }
  return parseDatabaseGenerationText(text, path)
}

export function readDatabaseGeneration(options: ReadDatabaseGenerationOptions) {
  return readDatabaseGenerationFromArtifacts(
    createFileDatabaseGenerationArtifacts(options),
    options,
  )
}

export function readDatabaseGenerationForBootstrap(
  options: ReadDatabaseGenerationOptions & DatabaseGenerationBootstrapPolicy,
) {
  return readDatabaseGenerationForBootstrapFromArtifacts(
    createFileDatabaseGenerationArtifacts(options),
    options,
  )
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Some Windows/filesystem combinations cannot fsync a directory. The file
    // itself is still flushed and the atomic replace remains the authority.
  }
}

export interface WriteDatabaseGenerationOptions {
  readonly pointerPath: string
  readonly payload: DatabaseGenerationPayload
  /** Test-only crash oracle. Production callers leave these absent. */
  readonly beforeReplaceForTest?: () => void
  /** Test-only crash oracle. Production callers leave these absent. */
  readonly afterReplaceForTest?: () => void
}

export function writeDatabaseGenerationAtomic(options: WriteDatabaseGenerationOptions): void {
  const payload = DatabaseGenerationPayloadSchema.parse(options.payload)
  const file: DatabaseGenerationFile = {
    payload,
    digest: digestGenerationPayload(payload),
  }
  const directory = dirname(options.pointerPath)
  mkdirSync(directory, { recursive: true })
  const temporary = join(
    directory,
    `.database-generation.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
  )
  let replaced = false
  try {
    writeFileSync(temporary, canonicalSchemaJson(file), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    // Windows FlushFileBuffers requires a write-capable file handle.
    const handle = openSync(temporary, 'r+')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    options.beforeReplaceForTest?.()
    renameSync(temporary, options.pointerPath)
    replaced = true
    try {
      chmodSync(options.pointerPath, 0o600)
    } catch {
      // Non-POSIX filesystems still retain the atomic file contract.
    }
    fsyncDirectory(directory)
    options.afterReplaceForTest?.()

    const readback = parseGenerationFile(options.pointerPath)
    if (canonicalSchemaJson(readback) !== canonicalSchemaJson(file)) {
      throw new DatabaseGenerationError(
        'generation-pointer-readback-mismatch',
        'database generation pointer read-back mismatch after atomic replace',
      )
    }
  } finally {
    if (!replaced && existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // The original write/replace error is authoritative.
      }
    }
  }
}
