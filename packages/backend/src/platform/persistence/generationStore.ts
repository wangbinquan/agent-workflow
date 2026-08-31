// RFC-349 — durable live database generation pointer.
//
// The pointer is deliberately outside SQLite and PostgreSQL. Boot either sees
// a verified complete generation or fails closed; it never guesses a provider
// from config, a half-written target, or the newest-looking database.

import { sha256Hex } from '@/util/hash'
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
import { z } from 'zod'
import { canonicalSchemaJson } from './schemaContract'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const GenerationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
const OperationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)

const DatabaseGenerationPayloadSchema = z
  .object({
    version: z.literal(1),
    generationId: GenerationIdSchema,
    provider: z.enum(['sqlite', 'postgresql']),
    operationId: OperationIdSchema.nullable(),
    schemaDigest: DigestSchema,
    manifestDigest: DigestSchema.nullable(),
    activatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operationId === null) !== (value.manifestDigest === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifestDigest'],
        message: 'operationId and manifestDigest must either both be present or both be null',
      })
    }
    if (value.provider === 'postgresql' && value.operationId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationId'],
        message: 'a PostgreSQL generation must reference its verified migration manifest',
      })
    }
  })

const DatabaseGenerationFileSchema = z
  .object({
    payload: DatabaseGenerationPayloadSchema,
    digest: DigestSchema,
  })
  .strict()

export type DatabaseGenerationPayload = z.infer<typeof DatabaseGenerationPayloadSchema>
export type DatabaseGenerationFile = z.infer<typeof DatabaseGenerationFileSchema>

export type ResolvedDatabaseGeneration =
  | { readonly source: 'legacy-missing-pointer'; readonly payload: DatabaseGenerationPayload }
  | { readonly source: 'verified-pointer'; readonly payload: DatabaseGenerationPayload }

export class DatabaseGenerationError extends Error {
  constructor(
    public readonly code:
      | 'generation-pointer-corrupt'
      | 'generation-pointer-digest-mismatch'
      | 'generation-schema-mismatch'
      | 'generation-manifest-missing'
      | 'generation-manifest-digest-mismatch'
      | 'generation-pointer-readback-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseGenerationError'
  }
}

export function digestDatabaseArtifact(value: string | Uint8Array): string {
  return `sha256:${sha256Hex(value)}`
}

export function digestGenerationPayload(payload: DatabaseGenerationPayload): string {
  return digestDatabaseArtifact(canonicalSchemaJson(payload))
}

function legacyGeneration(schemaDigest: string): DatabaseGenerationPayload {
  return {
    version: 1,
    generationId: 'dbg_legacy_sqlite',
    provider: 'sqlite',
    operationId: null,
    schemaDigest,
    manifestDigest: null,
    activatedAt: 0,
  }
}

function parseGenerationFile(path: string): DatabaseGenerationFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer is unreadable: ${path}`,
    )
  }
  const parsed = DatabaseGenerationFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer failed validation: ${path}`,
    )
  }
  if (digestGenerationPayload(parsed.data.payload) !== parsed.data.digest) {
    throw new DatabaseGenerationError(
      'generation-pointer-digest-mismatch',
      `database generation pointer digest mismatch: ${path}`,
    )
  }
  return parsed.data
}

export interface ReadDatabaseGenerationOptions {
  readonly pointerPath: string
  readonly migrationsDir: string
  readonly expectedSchemaDigest: string
}

export function readDatabaseGeneration(
  options: ReadDatabaseGenerationOptions,
): ResolvedDatabaseGeneration {
  if (!existsSync(options.pointerPath)) {
    return {
      source: 'legacy-missing-pointer',
      payload: legacyGeneration(options.expectedSchemaDigest),
    }
  }

  const file = parseGenerationFile(options.pointerPath)
  if (file.payload.schemaDigest !== options.expectedSchemaDigest) {
    throw new DatabaseGenerationError(
      'generation-schema-mismatch',
      `database generation schema digest does not match this binary`,
    )
  }
  if (file.payload.operationId !== null && file.payload.manifestDigest !== null) {
    const manifestPath = join(options.migrationsDir, file.payload.operationId, 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw new DatabaseGenerationError(
        'generation-manifest-missing',
        `database generation manifest is missing for ${file.payload.operationId}`,
      )
    }
    const actualManifestDigest = digestDatabaseArtifact(readFileSync(manifestPath))
    if (actualManifestDigest !== file.payload.manifestDigest) {
      throw new DatabaseGenerationError(
        'generation-manifest-digest-mismatch',
        `database generation manifest digest mismatch for ${file.payload.operationId}`,
      )
    }
  }
  return { source: 'verified-pointer', payload: file.payload }
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
    const handle = openSync(temporary, 'r')
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
