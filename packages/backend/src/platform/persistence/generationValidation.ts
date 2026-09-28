// RFC-370 A-T2 — generation validation is independent of installation storage.
// This preserves RFC-349/359 pointer, manifest, schema and recovery decisions.
import { z } from 'zod'
import { databaseProviderTraits } from './providerTraits'
import { sha256Hex } from '@/util/hash'
import { canonicalSchemaJson } from './schemaContract'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const GenerationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
const OperationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)

export const DatabaseGenerationPayloadSchema = z
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
    // A generation that was migrated INTO a target must name the manifest that
    // produced it; the source generation legitimately has none.
    if (
      databaseProviderTraits(value.provider).migrationRole === 'target' &&
      value.operationId === null
    ) {
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

export function parseDatabaseGenerationText(text: string, label: string): DatabaseGenerationFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer is unreadable: ${label}`,
    )
  }
  const parsed = DatabaseGenerationFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer failed validation: ${label}`,
    )
  }
  if (digestGenerationPayload(parsed.data.payload) !== parsed.data.digest) {
    throw new DatabaseGenerationError(
      'generation-pointer-digest-mismatch',
      `database generation pointer digest mismatch: ${label}`,
    )
  }
  return parsed.data
}

export type DatabaseGenerationBootstrapCandidate =
  | { readonly kind: 'current'; readonly generation: ResolvedDatabaseGeneration }
  | {
      readonly kind: 'schema-upgrade'
      readonly payload: DatabaseGenerationPayload
      readonly pointerDigest: string
    }
  | {
      readonly kind: 'operation-recovery'
      readonly payload: DatabaseGenerationPayload
      readonly pointerDigest: string
      readonly recoveryManifestDigest: string
    }

export interface GenerationOperationRecoveryInput {
  readonly payload: DatabaseGenerationPayload
  readonly manifestText: string
}

/** A synchronous view of already available generation artifacts. Local files
 * implement it directly; an async host adapter must finish loading a coherent
 * snapshot before validation. Validation itself never performs host IO. */
export interface DatabaseGenerationArtifactReader {
  readonly pointerLabel: string
  readPointer(): string | null
  readManifest(operationId: string): Uint8Array | null
}

export interface DatabaseGenerationReadPolicy {
  readonly expectedSchemaDigest: string
}

export interface DatabaseGenerationBootstrapPolicy extends DatabaseGenerationReadPolicy {
  readonly supportedSchemaDigests: readonly string[]
  readonly verifyInterruptedOperation?: (input: GenerationOperationRecoveryInput) => void
}

function readGenerationDocument(
  artifacts: DatabaseGenerationArtifactReader,
): DatabaseGenerationFile | null {
  let text: string | null
  try {
    text = artifacts.readPointer()
  } catch {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer is unreadable: ${artifacts.pointerLabel}`,
    )
  }
  return text === null ? null : parseDatabaseGenerationText(text, artifacts.pointerLabel)
}

function legacyResolvedGeneration(schemaDigest: string): ResolvedDatabaseGeneration {
  return { source: 'legacy-missing-pointer', payload: legacyGeneration(schemaDigest) }
}

function verifyGenerationManifest(
  file: DatabaseGenerationFile,
  artifacts: DatabaseGenerationArtifactReader,
  verifyInterruptedOperation?: (input: GenerationOperationRecoveryInput) => void,
): string | null {
  if (file.payload.operationId !== null && file.payload.manifestDigest !== null) {
    const manifestBytes = artifacts.readManifest(file.payload.operationId)
    if (manifestBytes === null) {
      throw new DatabaseGenerationError(
        'generation-manifest-missing',
        `database generation manifest is missing for ${file.payload.operationId}`,
      )
    }
    const actualManifestDigest = digestDatabaseArtifact(manifestBytes)
    if (actualManifestDigest !== file.payload.manifestDigest) {
      if (verifyInterruptedOperation !== undefined) {
        verifyInterruptedOperation({
          payload: file.payload,
          manifestText: Buffer.from(manifestBytes).toString('utf8'),
        })
        return actualManifestDigest
      }
      throw new DatabaseGenerationError(
        'generation-manifest-digest-mismatch',
        `database generation manifest digest mismatch for ${file.payload.operationId}`,
      )
    }
  }
  return null
}

/**
 * Bootstrap discovery only. An older pointer is a candidate for a verified
 * schema upgrade, never an admitted provider generation. Callers obtain the
 * supported digests from the complete immutable migration history and still
 * verify the actual database before publishing its new pointer.
 */
export function readDatabaseGenerationForBootstrapFromArtifacts(
  artifacts: DatabaseGenerationArtifactReader,
  options: DatabaseGenerationBootstrapPolicy,
): DatabaseGenerationBootstrapCandidate {
  const file = readGenerationDocument(artifacts)
  if (file === null) {
    return { kind: 'current', generation: legacyResolvedGeneration(options.expectedSchemaDigest) }
  }
  if (
    file.payload.schemaDigest !== options.expectedSchemaDigest &&
    !options.supportedSchemaDigests.includes(file.payload.schemaDigest)
  ) {
    throw new DatabaseGenerationError(
      'generation-schema-mismatch',
      'database generation schema digest does not match this binary',
    )
  }
  const recoveryManifestDigest = verifyGenerationManifest(
    file,
    artifacts,
    options.verifyInterruptedOperation,
  )
  if (recoveryManifestDigest !== null) {
    return {
      kind: 'operation-recovery',
      payload: file.payload,
      pointerDigest: file.digest,
      recoveryManifestDigest,
    }
  }
  if (file.payload.schemaDigest === options.expectedSchemaDigest) {
    return {
      kind: 'current',
      generation: { source: 'verified-pointer', payload: file.payload },
    }
  }
  return { kind: 'schema-upgrade', payload: file.payload, pointerDigest: file.digest }
}

export function readDatabaseGenerationFromArtifacts(
  artifacts: DatabaseGenerationArtifactReader,
  options: DatabaseGenerationReadPolicy,
): ResolvedDatabaseGeneration {
  const file = readGenerationDocument(artifacts)
  if (file === null) return legacyResolvedGeneration(options.expectedSchemaDigest)
  if (file.payload.schemaDigest !== options.expectedSchemaDigest) {
    throw new DatabaseGenerationError(
      'generation-schema-mismatch',
      `database generation schema digest does not match this binary`,
    )
  }
  verifyGenerationManifest(file, artifacts)
  return { source: 'verified-pointer', payload: file.payload }
}
