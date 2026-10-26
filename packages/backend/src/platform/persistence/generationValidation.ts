import type { GenerationPointerV2 as ImportedGenerationPointerV2 } from './generationPointerV2'
import { parseGenerationPointerV2 } from './generationPointerV2'
// RFC-370 A-T2 — generation validation is independent of installation storage.
// This preserves RFC-349/359 pointer, manifest, schema and recovery decisions.
import { z } from 'zod'
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
  })

const DatabaseGenerationFileSchema = z
  .object({
    payload: DatabaseGenerationPayloadSchema,
    digest: DigestSchema,
  })
  .strict()

export type DatabaseGenerationPayload = z.infer<typeof DatabaseGenerationPayloadSchema>
export type DatabaseGenerationFile = z.infer<typeof DatabaseGenerationFileSchema>

export interface HostedDatabaseIdentity {
  readonly project: string
  readonly service: string
  readonly platformGenerationId: string | null
  readonly platformOperationId: string | null
}

export type ResolvedDatabaseGeneration =
  | {
      readonly source: 'epoch2-pointer'
      readonly pointer: ImportedGenerationPointerV2
      readonly payload: DatabaseGenerationPayload
    }
  | { readonly source: 'legacy-missing-pointer'; readonly payload: DatabaseGenerationPayload }
  | { readonly source: 'verified-pointer'; readonly payload: DatabaseGenerationPayload }
  /**
   * RFC-370 M0 — a CrewStation-hosted installation. Its PostgreSQL database was
   * provisioned by the platform and installed by the release migration Job, so
   * there is no local pointer and no SQLite migration manifest behind it.
   */
  | {
      readonly source: 'hosted-installation'
      readonly payload: DatabaseGenerationPayload
      readonly identity: HostedDatabaseIdentity
    }

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

function epoch2Generation(
  artifacts: DatabaseGenerationArtifactReader,
  logicalDigest: string,
): ResolvedDatabaseGeneration | null {
  let text: string | null
  let document: unknown
  try {
    text = artifacts.readPointer()
    if (text === null) return null
    document = JSON.parse(text)
  } catch {
    throw new DatabaseGenerationError(
      'generation-pointer-corrupt',
      `database generation pointer is unreadable: ${artifacts.pointerLabel}`,
    )
  }
  if (
    typeof document !== 'object' ||
    document === null ||
    (document as { payload?: { version?: number } }).payload?.version !== 2
  )
    return null
  const pointer = parseGenerationPointerV2(text)
  if (pointer.payload.schemaEpoch !== 2) throw new Error('unsupported-schema-epoch')
  const p = pointer.payload
  return {
    source: 'epoch2-pointer',
    pointer,
    payload: {
      version: 1,
      generationId: p.generationId,
      provider: p.provider,
      operationId: p.operationId,
      schemaDigest: logicalDigest,
      manifestDigest: p.manifestDigest,
      activatedAt: p.activatedAt,
    },
  }
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
  const epoch2 = epoch2Generation(artifacts, options.expectedSchemaDigest)
  if (epoch2) return { kind: 'current', generation: epoch2 }
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
  const epoch2 = epoch2Generation(artifacts, options.expectedSchemaDigest)
  if (epoch2) return epoch2
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

/**
 * RFC-370 M0 — the hosted generation identity is derived from the platform's
 * stable project/service names, so every replica and every restart of the same
 * service names the same database generation without local state.
 *
 * Like every PostgreSQL generation it names the operation that produced its
 * rows: the release migration Job's installation copy, registered once in the
 * database's epoch-2 installation identity receipt. The active generation may
 * change after a move or restore without changing the installation identity.
 */
export function hostedDatabaseGeneration(input: {
  readonly project: string
  readonly service: string
  readonly schemaDigest: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): Extract<ResolvedDatabaseGeneration, { source: 'hosted-installation' }> {
  const platformId = input.env?.CS_DATABASE_GENERATION_ID
  const platformOperation = input.env?.CS_DATABASE_GENERATION_OPERATION
  const resourceId = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  if (
    (platformId || platformOperation) &&
    (!resourceId.test(platformId ?? '') || !resourceId.test(platformOperation ?? ''))
  )
    throw new Error('hosted-database-generation-identity-invalid')
  const identity = sha256Hex(
    `crewstation\u0000${input.project}\u0000${input.service}${platformId ? `\u0000${platformId}\u0000${platformOperation}` : ''}`,
  ).slice(0, 32)
  const generationId = `dbg_cs_${identity}`
  const operationId = `dbm_cs_${identity}`
  const manifest = canonicalSchemaJson({
    kind: 'crewstation-hosted-installation',
    project: input.project,
    service: input.service,
    generationId,
    operationId,
  })
  return {
    source: 'hosted-installation',
    identity: {
      project: input.project,
      service: input.service,
      platformGenerationId: platformId ?? null,
      platformOperationId: platformOperation ?? null,
    },
    payload: {
      version: 1,
      generationId,
      provider: 'postgresql',
      operationId,
      schemaDigest: input.schemaDigest,
      manifestDigest: `sha256:${sha256Hex(manifest)}`,
      activatedAt: 0,
    },
  }
}
