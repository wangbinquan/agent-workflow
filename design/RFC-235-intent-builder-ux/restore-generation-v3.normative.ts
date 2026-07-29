/**
 * RFC-235 Draft v21 normative appendix.
 *
 * This file is design-source, not production code. It is intentionally
 * executable: Zod 3.25 and strict TypeScript must be able to prove the exact
 * wire/decoded boundary that cold and pending restore will implement.
 *
 * Normative owners:
 * - R19-P0-01: SQLite DB/WAL/SHM generation and record-before-act publication.
 * - R19-P1-01: all seven wire schemas, seven decoded schemas, seven encoders,
 *   and both complete refiners.
 * - R19-P1-02: root-specific storage keys, publication locators, and operation
 *   digest verification.
 * - R19-P1-03: durable execution options and honest migration dispositions.
 * - R19-P1-04: absent/present live DB and Skills publication algebra.
 * - R20-P1-01: immutable revision-addressed roots and descendant lookup.
 * - R20-P1-02: purpose-specific publication semantic projections.
 * - R20-P1-03: lossless repair unions and checked root transitions.
 * - R20-P1-04: the prose contract owns legacy options; this appendix proves
 *   the native restore roots to which that handoff is bound.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
// The appendix is outside a workspace package, so bind the repository-pinned
// Zod 3.25 installation explicitly instead of relying on a global resolver.
import { z } from '../../packages/shared/node_modules/zod'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Expect<Value extends true> = Value

const DigestV3Schema = z.string().regex(/^[0-9a-f]{64}$/)
const IdV3Schema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/)
const NonNegativeSafeIntegerV3Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const PositiveSafeIntegerV3Schema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const SignedSafeIntegerV3Schema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)

function canonicalJsonV3(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite-json-number')
    return JSON.stringify(value)
  }
  if (
    typeof value === 'bigint' ||
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new Error('non-json-value')
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonV3(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonV3(record[key])}`)
    .join(',')}}`
}

function sha256DomainV3(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\0${canonicalJsonV3(value)}`, 'utf8')
    .digest('hex')
}

function constantTimeDigestEqualV3(left: string, right: string): boolean {
  if (!DigestV3Schema.safeParse(left).success || !DigestV3Schema.safeParse(right).success) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export interface ArtifactEntryIdentityV3 {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: number
  readonly nlink: number
  readonly fsid: readonly [number, number]
}

export interface ArtifactEntryIdentityV3Wire {
  readonly dev: string
  readonly ino: string
  readonly mode: number
  readonly nlink: number
  readonly fsid: readonly [number, number]
}

const UINT64_MAX_V3 = 18_446_744_073_709_551_615n
const CanonicalUint64V3Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(20)
  .superRefine((value, context) => {
    if (BigInt(value) > UINT64_MAX_V3) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'uint64-overflow' })
    }
  })

export const ArtifactEntryIdentityV3WireSchema: z.ZodType<
  ArtifactEntryIdentityV3Wire,
  z.ZodTypeDef,
  ArtifactEntryIdentityV3Wire
> = z
  .object({
    dev: CanonicalUint64V3Schema,
    ino: CanonicalUint64V3Schema,
    mode: NonNegativeSafeIntegerV3Schema,
    nlink: NonNegativeSafeIntegerV3Schema,
    fsid: z.tuple([SignedSafeIntegerV3Schema, SignedSafeIntegerV3Schema]),
  })
  .strict()

export const ArtifactEntryIdentityV3Schema: z.ZodType<
  ArtifactEntryIdentityV3,
  z.ZodTypeDef,
  ArtifactEntryIdentityV3Wire
> = ArtifactEntryIdentityV3WireSchema.transform(
  (wire): ArtifactEntryIdentityV3 => ({
    dev: BigInt(wire.dev),
    ino: BigInt(wire.ino),
    mode: wire.mode,
    nlink: wire.nlink,
    fsid: [wire.fsid[0], wire.fsid[1]],
  }),
)

export function encodeArtifactEntryIdentityV3(
  decoded: ArtifactEntryIdentityV3,
): ArtifactEntryIdentityV3Wire {
  return ArtifactEntryIdentityV3WireSchema.parse({
    dev: decoded.dev.toString(10),
    ino: decoded.ino.toString(10),
    mode: decoded.mode,
    nlink: decoded.nlink,
    fsid: [decoded.fsid[0], decoded.fsid[1]],
  })
}

function identityEqualV3(left: ArtifactEntryIdentityV3, right: ArtifactEntryIdentityV3): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.fsid[0] === right.fsid[0] &&
    left.fsid[1] === right.fsid[1]
  )
}

function identityWireEqualV3(
  left: ArtifactEntryIdentityV3Wire,
  right: ArtifactEntryIdentityV3Wire,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.fsid[0] === right.fsid[0] &&
    left.fsid[1] === right.fsid[1]
  )
}

export interface RestoreExecutionOptionsV3 {
  readonly noMigrate: boolean
  readonly noSafetyBackup: boolean
  readonly skipIntegrityCheck: boolean
}

export const RestoreExecutionOptionsV3Schema: z.ZodType<
  RestoreExecutionOptionsV3,
  z.ZodTypeDef,
  RestoreExecutionOptionsV3
> = z
  .object({
    noMigrate: z.boolean(),
    noSafetyBackup: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
  .strict()

export function encodeRestoreExecutionOptionsV3(
  options: RestoreExecutionOptionsV3,
): RestoreExecutionOptionsV3 {
  return RestoreExecutionOptionsV3Schema.parse({
    noMigrate: options.noMigrate,
    noSafetyBackup: options.noSafetyBackup,
    skipIntegrityCheck: options.skipIntegrityCheck,
  })
}

export function digestRestoreExecutionOptionsV3(options: RestoreExecutionOptionsV3): string {
  return sha256DomainV3(
    'agent-workflow/restore-execution-options/v3',
    encodeRestoreExecutionOptionsV3(options),
  )
}

export interface RestoreOperationIdentityV3 {
  readonly kind: 'app-generation-restore'
  readonly restoreOperationId: string
  readonly archiveDigest: string
  readonly incomingDatabaseDigest: string
  readonly incomingConfigDigest: string | null
  readonly incomingSkillsTreeDigest: string
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
}

export const RestoreOperationIdentityV3Schema: z.ZodType<
  RestoreOperationIdentityV3,
  z.ZodTypeDef,
  RestoreOperationIdentityV3
> = z
  .object({
    kind: z.literal('app-generation-restore'),
    restoreOperationId: IdV3Schema,
    archiveDigest: DigestV3Schema,
    incomingDatabaseDigest: DigestV3Schema,
    incomingConfigDigest: DigestV3Schema.nullable(),
    incomingSkillsTreeDigest: DigestV3Schema,
    options: RestoreExecutionOptionsV3Schema,
    optionsDigest: DigestV3Schema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      !constantTimeDigestEqualV3(
        operation.optionsDigest,
        digestRestoreExecutionOptionsV3(operation.options),
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'restore-options-digest-mismatch' })
    }
  })

export function encodeRestoreOperationIdentityV3(
  operation: RestoreOperationIdentityV3,
): RestoreOperationIdentityV3 {
  return RestoreOperationIdentityV3Schema.parse({
    kind: 'app-generation-restore',
    restoreOperationId: operation.restoreOperationId,
    archiveDigest: operation.archiveDigest,
    incomingDatabaseDigest: operation.incomingDatabaseDigest,
    incomingConfigDigest: operation.incomingConfigDigest,
    incomingSkillsTreeDigest: operation.incomingSkillsTreeDigest,
    options: encodeRestoreExecutionOptionsV3(operation.options),
    optionsDigest: operation.optionsDigest,
  })
}

export function digestArtifactFsOperationIdentityV3(operation: RestoreOperationIdentityV3): string {
  return sha256DomainV3(
    'agent-workflow/artifact-fs-operation/v3',
    encodeRestoreOperationIdentityV3(operation),
  )
}

export const RestoreArtifactFsSlotRoleV3Schema = z.enum([
  'restore-database-file',
  'restore-live-database-wal-removal',
  'restore-live-database-shm-removal',
  'restore-safety-database-file',
  'restore-safety-database-wal',
  'restore-safety-database-shm',
  'restore-safety-config-file',
  'restore-safety-skills-root',
  'restore-config-file',
  'restore-skills-root',
])
export type RestoreArtifactFsSlotRoleV3 = z.output<typeof RestoreArtifactFsSlotRoleV3Schema>

export interface ArtifactPublicationReceiptRefV3 {
  readonly receiptId: string
  readonly revision: number
  readonly frameDigest: string
  readonly operationDigest: string
  readonly slotRole: RestoreArtifactFsSlotRoleV3
}

export const ArtifactPublicationReceiptRefV3Schema: z.ZodType<
  ArtifactPublicationReceiptRefV3,
  z.ZodTypeDef,
  ArtifactPublicationReceiptRefV3
> = z
  .object({
    receiptId: IdV3Schema,
    revision: PositiveSafeIntegerV3Schema,
    frameDigest: DigestV3Schema,
    operationDigest: DigestV3Schema,
    slotRole: RestoreArtifactFsSlotRoleV3Schema,
  })
  .strict()

interface ArtifactPublicationReceiptBaseV3<Value> {
  readonly schemaVersion: 3
  readonly receiptId: string
  readonly revision: number
  readonly previousRevision: number | null
  readonly previousFrameDigest: string | null
  readonly operation: RestoreOperationIdentityV3
  readonly operationDigest: string
  readonly slotRole: RestoreArtifactFsSlotRoleV3
  readonly stagedIdentity: Value
  readonly stagedDigest: string
}

type ArtifactPublicationReceiptV3For<Value> =
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'prepared'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: null
      readonly displacedIdentity: null
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'prepared'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: null
      readonly displacedIdentity: null
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'exchanged'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: null
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'exchanged'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
      readonly cleanupVerifiedAt: null
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'cleanup-verified'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'cleanup-verified'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
      readonly cleanupVerifiedAt: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'prepared'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: null
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: null
      readonly repairId: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'prepared'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: null
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: null
      readonly repairId: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'exchanged'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: null
      readonly repairId: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'exchanged'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
      readonly cleanupVerifiedAt: null
      readonly repairId: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'cleanup-verified'
      readonly publicationMode: 'no-replace'
      readonly expectedIdentity: null
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
      readonly cleanupVerifiedAt: string
      readonly repairId: string
    })
  | (ArtifactPublicationReceiptBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly repairFromPhase: 'cleanup-verified'
      readonly publicationMode: 'replace'
      readonly expectedIdentity: Value
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
      readonly cleanupVerifiedAt: string
      readonly repairId: string
    })

export type ArtifactPublicationReceiptV3Wire =
  ArtifactPublicationReceiptV3For<ArtifactEntryIdentityV3Wire>
export type ArtifactPublicationReceiptV3 = ArtifactPublicationReceiptV3For<ArtifactEntryIdentityV3>

const artifactPublicationReceiptBaseWireShape = {
  schemaVersion: z.literal(3),
  receiptId: IdV3Schema,
  revision: PositiveSafeIntegerV3Schema,
  previousRevision: PositiveSafeIntegerV3Schema.nullable(),
  previousFrameDigest: DigestV3Schema.nullable(),
  operation: RestoreOperationIdentityV3Schema,
  operationDigest: DigestV3Schema,
  slotRole: RestoreArtifactFsSlotRoleV3Schema,
  stagedIdentity: ArtifactEntryIdentityV3WireSchema,
  stagedDigest: DigestV3Schema,
}

export const ArtifactPublicationReceiptV3WireSchema: z.ZodType<
  ArtifactPublicationReceiptV3Wire,
  z.ZodTypeDef,
  ArtifactPublicationReceiptV3Wire
> = z
  .union([
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('prepared'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: z.null(),
        displacedIdentity: z.null(),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('prepared'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: z.null(),
        displacedIdentity: z.null(),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('exchanged'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.null(),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('exchanged'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: ArtifactEntryIdentityV3WireSchema,
        cleanupVerifiedAt: z.null(),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('cleanup-verified'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('cleanup-verified'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: ArtifactEntryIdentityV3WireSchema,
        cleanupVerifiedAt: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('prepared'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: z.null(),
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.null(),
        repairId: IdV3Schema,
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('prepared'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: z.null(),
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.null(),
        repairId: IdV3Schema,
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('exchanged'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.null(),
        repairId: IdV3Schema,
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('exchanged'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: ArtifactEntryIdentityV3WireSchema,
        cleanupVerifiedAt: z.null(),
        repairId: IdV3Schema,
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('cleanup-verified'),
        publicationMode: z.literal('no-replace'),
        expectedIdentity: z.null(),
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: z.null(),
        cleanupVerifiedAt: z.string().min(1),
        repairId: IdV3Schema,
      })
      .strict(),
    z
      .object({
        ...artifactPublicationReceiptBaseWireShape,
        phase: z.literal('repair-required'),
        repairFromPhase: z.literal('cleanup-verified'),
        publicationMode: z.literal('replace'),
        expectedIdentity: ArtifactEntryIdentityV3WireSchema,
        publishedIdentity: ArtifactEntryIdentityV3WireSchema,
        displacedIdentity: ArtifactEntryIdentityV3WireSchema,
        cleanupVerifiedAt: z.string().min(1),
        repairId: IdV3Schema,
      })
      .strict(),
  ])
  .superRefine((receipt, context) => {
    if (
      (receipt.revision === 1 &&
        (receipt.previousRevision !== null || receipt.previousFrameDigest !== null)) ||
      (receipt.revision > 1 &&
        (receipt.previousRevision !== receipt.revision - 1 || receipt.previousFrameDigest === null))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'revision-lineage-shape-mismatch' })
    }
    if (
      !constantTimeDigestEqualV3(
        receipt.operationDigest,
        digestArtifactFsOperationIdentityV3(receipt.operation),
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation-digest-mismatch' })
    }
    if (
      receipt.publishedIdentity !== null &&
      !identityWireEqualV3(receipt.stagedIdentity, receipt.publishedIdentity)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'published-not-staged' })
    }
    if (
      receipt.publicationMode === 'replace' &&
      !(
        receipt.phase === 'prepared' ||
        (receipt.phase === 'repair-required' && receipt.repairFromPhase === 'prepared')
      ) &&
      !identityWireEqualV3(receipt.expectedIdentity, receipt.displacedIdentity)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'displaced-not-expected' })
    }
  })

function decodeArtifactPublicationReceiptV3(
  wire: ArtifactPublicationReceiptV3Wire,
): ArtifactPublicationReceiptV3 {
  const base = {
    schemaVersion: 3 as const,
    receiptId: wire.receiptId,
    revision: wire.revision,
    previousRevision: wire.previousRevision,
    previousFrameDigest: wire.previousFrameDigest,
    operation: encodeRestoreOperationIdentityV3(wire.operation),
    operationDigest: wire.operationDigest,
    slotRole: wire.slotRole,
    stagedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.stagedIdentity),
    stagedDigest: wire.stagedDigest,
  }
  switch (wire.phase) {
    case 'prepared':
      return wire.publicationMode === 'no-replace'
        ? {
            ...base,
            phase: 'prepared',
            publicationMode: 'no-replace',
            expectedIdentity: null,
            publishedIdentity: null,
            displacedIdentity: null,
          }
        : {
            ...base,
            phase: 'prepared',
            publicationMode: 'replace',
            expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
            publishedIdentity: null,
            displacedIdentity: null,
          }
    case 'exchanged':
      return wire.publicationMode === 'no-replace'
        ? {
            ...base,
            phase: 'exchanged',
            publicationMode: 'no-replace',
            expectedIdentity: null,
            publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
            displacedIdentity: null,
            cleanupVerifiedAt: null,
          }
        : {
            ...base,
            phase: 'exchanged',
            publicationMode: 'replace',
            expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
            publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
            displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
            cleanupVerifiedAt: null,
          }
    case 'cleanup-verified':
      return wire.publicationMode === 'no-replace'
        ? {
            ...base,
            phase: 'cleanup-verified',
            publicationMode: 'no-replace',
            expectedIdentity: null,
            publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
            displacedIdentity: null,
            cleanupVerifiedAt: wire.cleanupVerifiedAt,
          }
        : {
            ...base,
            phase: 'cleanup-verified',
            publicationMode: 'replace',
            expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
            publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
            displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
            cleanupVerifiedAt: wire.cleanupVerifiedAt,
          }
    case 'repair-required':
      switch (wire.repairFromPhase) {
        case 'prepared':
          return wire.publicationMode === 'no-replace'
            ? {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'prepared',
                publicationMode: 'no-replace',
                expectedIdentity: null,
                publishedIdentity: null,
                displacedIdentity: null,
                cleanupVerifiedAt: null,
                repairId: wire.repairId,
              }
            : {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'prepared',
                publicationMode: 'replace',
                expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
                publishedIdentity: null,
                displacedIdentity: null,
                cleanupVerifiedAt: null,
                repairId: wire.repairId,
              }
        case 'exchanged':
          return wire.publicationMode === 'no-replace'
            ? {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'exchanged',
                publicationMode: 'no-replace',
                expectedIdentity: null,
                publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
                displacedIdentity: null,
                cleanupVerifiedAt: null,
                repairId: wire.repairId,
              }
            : {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'exchanged',
                publicationMode: 'replace',
                expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
                publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
                displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
                cleanupVerifiedAt: null,
                repairId: wire.repairId,
              }
        case 'cleanup-verified':
          return wire.publicationMode === 'no-replace'
            ? {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'cleanup-verified',
                publicationMode: 'no-replace',
                expectedIdentity: null,
                publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
                displacedIdentity: null,
                cleanupVerifiedAt: wire.cleanupVerifiedAt,
                repairId: wire.repairId,
              }
            : {
                ...base,
                phase: 'repair-required',
                repairFromPhase: 'cleanup-verified',
                publicationMode: 'replace',
                expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
                publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
                displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
                cleanupVerifiedAt: wire.cleanupVerifiedAt,
                repairId: wire.repairId,
              }
      }
  }
}

export const ArtifactPublicationReceiptV3Schema: z.ZodType<
  ArtifactPublicationReceiptV3,
  z.ZodTypeDef,
  ArtifactPublicationReceiptV3Wire
> = ArtifactPublicationReceiptV3WireSchema.transform(decodeArtifactPublicationReceiptV3)

export function encodeArtifactPublicationReceiptV3(
  decoded: ArtifactPublicationReceiptV3,
): ArtifactPublicationReceiptV3Wire {
  const base = {
    schemaVersion: 3 as const,
    receiptId: decoded.receiptId,
    revision: decoded.revision,
    previousRevision: decoded.previousRevision,
    previousFrameDigest: decoded.previousFrameDigest,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    operationDigest: decoded.operationDigest,
    slotRole: decoded.slotRole,
    stagedIdentity: encodeArtifactEntryIdentityV3(decoded.stagedIdentity),
    stagedDigest: decoded.stagedDigest,
  }
  switch (decoded.phase) {
    case 'prepared':
      return ArtifactPublicationReceiptV3WireSchema.parse({
        schemaVersion: base.schemaVersion,
        receiptId: base.receiptId,
        revision: base.revision,
        previousRevision: base.previousRevision,
        previousFrameDigest: base.previousFrameDigest,
        operation: base.operation,
        operationDigest: base.operationDigest,
        slotRole: base.slotRole,
        stagedIdentity: base.stagedIdentity,
        stagedDigest: base.stagedDigest,
        phase: 'prepared',
        publicationMode: decoded.publicationMode,
        expectedIdentity:
          decoded.expectedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        publishedIdentity: null,
        displacedIdentity: null,
      })
    case 'exchanged':
      return ArtifactPublicationReceiptV3WireSchema.parse({
        schemaVersion: base.schemaVersion,
        receiptId: base.receiptId,
        revision: base.revision,
        previousRevision: base.previousRevision,
        previousFrameDigest: base.previousFrameDigest,
        operation: base.operation,
        operationDigest: base.operationDigest,
        slotRole: base.slotRole,
        stagedIdentity: base.stagedIdentity,
        stagedDigest: base.stagedDigest,
        phase: 'exchanged',
        publicationMode: decoded.publicationMode,
        expectedIdentity:
          decoded.expectedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity:
          decoded.displacedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
        cleanupVerifiedAt: null,
      })
    case 'cleanup-verified':
      return ArtifactPublicationReceiptV3WireSchema.parse({
        schemaVersion: base.schemaVersion,
        receiptId: base.receiptId,
        revision: base.revision,
        previousRevision: base.previousRevision,
        previousFrameDigest: base.previousFrameDigest,
        operation: base.operation,
        operationDigest: base.operationDigest,
        slotRole: base.slotRole,
        stagedIdentity: base.stagedIdentity,
        stagedDigest: base.stagedDigest,
        phase: 'cleanup-verified',
        publicationMode: decoded.publicationMode,
        expectedIdentity:
          decoded.expectedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity:
          decoded.displacedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
        cleanupVerifiedAt: decoded.cleanupVerifiedAt,
      })
    case 'repair-required':
      return ArtifactPublicationReceiptV3WireSchema.parse({
        schemaVersion: base.schemaVersion,
        receiptId: base.receiptId,
        revision: base.revision,
        previousRevision: base.previousRevision,
        previousFrameDigest: base.previousFrameDigest,
        operation: base.operation,
        operationDigest: base.operationDigest,
        slotRole: base.slotRole,
        stagedIdentity: base.stagedIdentity,
        stagedDigest: base.stagedDigest,
        phase: 'repair-required',
        repairFromPhase: decoded.repairFromPhase,
        publicationMode: decoded.publicationMode,
        expectedIdentity:
          decoded.expectedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        publishedIdentity:
          decoded.publishedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity:
          decoded.displacedIdentity === null
            ? null
            : encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
        cleanupVerifiedAt: decoded.cleanupVerifiedAt,
        repairId: decoded.repairId,
      })
    default:
      return assertNeverRestoreGenerationV3(decoded)
  }
}

export function digestArtifactPublicationFrameV3(receipt: ArtifactPublicationReceiptV3): string {
  return sha256DomainV3(
    'agent-workflow/artifact-publication-frame/v3',
    encodeArtifactPublicationReceiptV3(receipt),
  )
}

export function artifactPublicationRefFromReceiptV3(
  receipt: ArtifactPublicationReceiptV3,
): ArtifactPublicationReceiptRefV3 {
  return ArtifactPublicationReceiptRefV3Schema.parse({
    receiptId: receipt.receiptId,
    revision: receipt.revision,
    frameDigest: digestArtifactPublicationFrameV3(receipt),
    operationDigest: receipt.operationDigest,
    slotRole: receipt.slotRole,
  })
}

type DurableRootKindV3 =
  | 'artifact-publication'
  | 'restore-generation-marker'
  | 'restore-sqlite-publication'

declare const DurableRootStorageKeyV3Brand: unique symbol
export interface DurableRootStorageKeyV3<Kind extends DurableRootKindV3> {
  readonly [DurableRootStorageKeyV3Brand]: Kind
  readonly namespace: 'artifact-control-v3'
  readonly rootKind: Kind
  readonly rootId: string
  readonly revision: number
  readonly frameDigest: string
}

export interface DurableRootStorageLocatorV3<Kind extends DurableRootKindV3> {
  readonly rootKind: Kind
  readonly key: DurableRootStorageKeyV3<Kind>
}

const durableRootStorageKeysV3 = new WeakSet<object>()

function createDurableRootStorageKeyV3<Kind extends DurableRootKindV3>(
  rootKind: Kind,
  rootId: string,
  revision: number,
  frameDigest: string,
): DurableRootStorageKeyV3<Kind> {
  const validatedRootId = IdV3Schema.parse(rootId)
  const validatedRevision = PositiveSafeIntegerV3Schema.parse(revision)
  const validatedFrameDigest = DigestV3Schema.parse(frameDigest)
  const key = Object.freeze({
    namespace: 'artifact-control-v3' as const,
    rootKind,
    rootId: validatedRootId,
    revision: validatedRevision,
    frameDigest: validatedFrameDigest,
  }) as DurableRootStorageKeyV3<Kind>
  durableRootStorageKeysV3.add(key)
  return key
}

export function artifactPublicationLocatorFromRefV3(
  ref: ArtifactPublicationReceiptRefV3,
): DurableRootStorageLocatorV3<'artifact-publication'> {
  const parsed = ArtifactPublicationReceiptRefV3Schema.parse(ref)
  return Object.freeze({
    rootKind: 'artifact-publication',
    key: createDurableRootStorageKeyV3(
      'artifact-publication',
      parsed.receiptId,
      parsed.revision,
      parsed.frameDigest,
    ),
  })
}

export function restoreSqlitePublicationLocatorV3(
  ref: RestoreSqlitePublicationRefV3,
): DurableRootStorageLocatorV3<'restore-sqlite-publication'> {
  const parsed = RestoreSqlitePublicationRefV3Schema.parse(ref)
  return Object.freeze({
    rootKind: 'restore-sqlite-publication',
    key: createDurableRootStorageKeyV3(
      'restore-sqlite-publication',
      parsed.publicationId,
      parsed.revision,
      parsed.frameDigest,
    ),
  })
}

export function assertTrustedDurableRootStorageKeyV3(key: unknown): void {
  if (typeof key !== 'object' || key === null || !durableRootStorageKeysV3.has(key)) {
    throw new Error('untrusted-durable-root-storage-key')
  }
}

export interface ArtifactPublicationExpectedProjectionV3 {
  readonly requiredPhase: 'prepared' | 'exchanged' | 'cleanup-verified'
  readonly publicationMode: 'no-replace' | 'replace'
  readonly stagedIdentity: ArtifactEntryIdentityV3
  readonly stagedDigest: string
  readonly expectedIdentity: ArtifactEntryIdentityV3 | null
  readonly publishedIdentity: ArtifactEntryIdentityV3 | null
  readonly displacedIdentity: ArtifactEntryIdentityV3 | null
}

function nullableIdentityEqualV3(
  left: ArtifactEntryIdentityV3 | null,
  right: ArtifactEntryIdentityV3 | null,
): boolean {
  return left === null ? right === null : right !== null && identityEqualV3(left, right)
}

export function assertPublicationRefMatchesV3(
  ref: ArtifactPublicationReceiptRefV3,
  receipt: ArtifactPublicationReceiptV3,
  expectedOperation: RestoreOperationIdentityV3,
  expectedRole: RestoreArtifactFsSlotRoleV3,
  expected: ArtifactPublicationExpectedProjectionV3,
): void {
  const parsedRef = ArtifactPublicationReceiptRefV3Schema.parse(ref)
  const parsedReceipt = ArtifactPublicationReceiptV3Schema.parse(
    encodeArtifactPublicationReceiptV3(receipt),
  )
  const expectedDigest = digestArtifactFsOperationIdentityV3(expectedOperation)
  if (
    parsedRef.receiptId !== parsedReceipt.receiptId ||
    parsedRef.revision !== parsedReceipt.revision ||
    !constantTimeDigestEqualV3(
      parsedRef.frameDigest,
      digestArtifactPublicationFrameV3(parsedReceipt),
    ) ||
    parsedRef.slotRole !== expectedRole ||
    parsedReceipt.slotRole !== expectedRole ||
    !constantTimeDigestEqualV3(parsedRef.operationDigest, expectedDigest) ||
    !constantTimeDigestEqualV3(parsedReceipt.operationDigest, expectedDigest) ||
    canonicalJsonV3(parsedReceipt.operation) !==
      canonicalJsonV3(encodeRestoreOperationIdentityV3(expectedOperation)) ||
    parsedReceipt.phase !== expected.requiredPhase ||
    parsedReceipt.publicationMode !== expected.publicationMode ||
    !identityEqualV3(parsedReceipt.stagedIdentity, expected.stagedIdentity) ||
    !constantTimeDigestEqualV3(parsedReceipt.stagedDigest, expected.stagedDigest) ||
    !nullableIdentityEqualV3(parsedReceipt.expectedIdentity, expected.expectedIdentity) ||
    !nullableIdentityEqualV3(parsedReceipt.publishedIdentity, expected.publishedIdentity) ||
    !nullableIdentityEqualV3(parsedReceipt.displacedIdentity, expected.displacedIdentity)
  ) {
    throw new Error('foreign-artifact-publication-reference')
  }
}

function artifactPublicationBaseEqualV3(
  previous: ArtifactPublicationReceiptV3,
  next: ArtifactPublicationReceiptV3,
): boolean {
  return (
    previous.receiptId === next.receiptId &&
    previous.slotRole === next.slotRole &&
    previous.publicationMode === next.publicationMode &&
    constantTimeDigestEqualV3(previous.operationDigest, next.operationDigest) &&
    canonicalJsonV3(previous.operation) === canonicalJsonV3(next.operation) &&
    identityEqualV3(previous.stagedIdentity, next.stagedIdentity) &&
    constantTimeDigestEqualV3(previous.stagedDigest, next.stagedDigest) &&
    nullableIdentityEqualV3(previous.expectedIdentity, next.expectedIdentity)
  )
}

export function assertArtifactPublicationTransitionV3(
  previous: ArtifactPublicationReceiptV3,
  next: ArtifactPublicationReceiptV3,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    next.previousRevision !== previous.revision ||
    next.previousFrameDigest === null ||
    !constantTimeDigestEqualV3(
      next.previousFrameDigest,
      digestArtifactPublicationFrameV3(previous),
    ) ||
    !artifactPublicationBaseEqualV3(previous, next)
  ) {
    throw new Error('artifact-publication-lineage-mismatch')
  }
  if (previous.phase === 'repair-required') {
    throw new Error('artifact-publication-repair-is-terminal')
  }
  if (next.phase === 'repair-required') {
    if (
      next.repairFromPhase !== previous.phase ||
      !nullableIdentityEqualV3(previous.publishedIdentity, next.publishedIdentity) ||
      !nullableIdentityEqualV3(previous.displacedIdentity, next.displacedIdentity) ||
      (previous.phase === 'prepared'
        ? next.cleanupVerifiedAt !== null
        : previous.phase === 'exchanged'
          ? next.cleanupVerifiedAt !== null
          : next.cleanupVerifiedAt !== previous.cleanupVerifiedAt)
    ) {
      throw new Error('artifact-publication-repair-lost-prefix')
    }
    return
  }
  if (
    (previous.phase === 'prepared' && next.phase !== 'exchanged') ||
    (previous.phase === 'exchanged' && next.phase !== 'cleanup-verified') ||
    previous.phase === 'cleanup-verified' ||
    (!nullableIdentityEqualV3(previous.publishedIdentity, next.publishedIdentity) &&
      previous.phase !== 'prepared') ||
    (!nullableIdentityEqualV3(previous.displacedIdentity, next.displacedIdentity) &&
      previous.phase !== 'prepared')
  ) {
    throw new Error('artifact-publication-illegal-transition')
  }
}

export function latestArtifactPublicationDescendantV3(
  anchor: ArtifactPublicationReceiptRefV3,
  revisions: readonly ArtifactPublicationReceiptV3[],
): ArtifactPublicationReceiptV3 {
  const ordered = revisions
    .filter((record) => record.receiptId === anchor.receiptId)
    .slice()
    .sort((left, right) => left.revision - right.revision)
  const anchorIndex = ordered.findIndex((record) => record.revision === anchor.revision)
  if (anchorIndex < 0) throw new Error('artifact-publication-anchor-missing')
  const anchored = ordered[anchorIndex]!
  if (!constantTimeDigestEqualV3(anchor.frameDigest, digestArtifactPublicationFrameV3(anchored))) {
    throw new Error('artifact-publication-anchor-digest-mismatch')
  }
  for (let index = anchorIndex + 1; index < ordered.length; index += 1) {
    assertArtifactPublicationTransitionV3(ordered[index - 1]!, ordered[index]!)
  }
  return ordered[ordered.length - 1]!
}

type EntryPresenceV3<Value> =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present'
      readonly identity: Value
      readonly digest: string
    }

type EntryPresenceV3Wire = EntryPresenceV3<ArtifactEntryIdentityV3Wire>
type EntryPresenceV3Decoded = EntryPresenceV3<ArtifactEntryIdentityV3>

const EntryPresenceV3WireSchema: z.ZodType<EntryPresenceV3Wire, z.ZodTypeDef, EntryPresenceV3Wire> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('absent') }).strict(),
    z
      .object({
        kind: z.literal('present'),
        identity: ArtifactEntryIdentityV3WireSchema,
        digest: DigestV3Schema,
      })
      .strict(),
  ])

function encodeEntryPresenceV3(decoded: EntryPresenceV3Decoded): EntryPresenceV3Wire {
  switch (decoded.kind) {
    case 'absent':
      return { kind: 'absent' }
    case 'present':
      return EntryPresenceV3WireSchema.parse({
        kind: 'present',
        identity: encodeArtifactEntryIdentityV3(decoded.identity),
        digest: decoded.digest,
      })
  }
}

function decodeEntryPresenceV3(wire: EntryPresenceV3Wire): EntryPresenceV3Decoded {
  switch (wire.kind) {
    case 'absent':
      return { kind: 'absent' }
    case 'present':
      return {
        kind: 'present',
        identity: ArtifactEntryIdentityV3Schema.parse(wire.identity),
        digest: wire.digest,
      }
  }
}

export interface ArtifactSqliteGenerationV3<Value> {
  readonly database: {
    readonly kind: 'present'
    readonly identity: Value
    readonly digest: string
  }
  readonly wal: EntryPresenceV3<Value>
  readonly shm: EntryPresenceV3<Value>
}

export type ArtifactSqliteGenerationV3Wire = ArtifactSqliteGenerationV3<ArtifactEntryIdentityV3Wire>
export type ArtifactSqliteGenerationV3Decoded = ArtifactSqliteGenerationV3<ArtifactEntryIdentityV3>

const ArtifactSqliteGenerationV3WireSchema: z.ZodType<
  ArtifactSqliteGenerationV3Wire,
  z.ZodTypeDef,
  ArtifactSqliteGenerationV3Wire
> = z
  .object({
    database: z
      .object({
        kind: z.literal('present'),
        identity: ArtifactEntryIdentityV3WireSchema,
        digest: DigestV3Schema,
      })
      .strict(),
    wal: EntryPresenceV3WireSchema,
    shm: EntryPresenceV3WireSchema,
  })
  .strict()

function encodeArtifactSqliteGenerationV3(
  decoded: ArtifactSqliteGenerationV3Decoded,
): ArtifactSqliteGenerationV3Wire {
  return ArtifactSqliteGenerationV3WireSchema.parse({
    database: {
      kind: 'present',
      identity: encodeArtifactEntryIdentityV3(decoded.database.identity),
      digest: decoded.database.digest,
    },
    wal: encodeEntryPresenceV3(decoded.wal),
    shm: encodeEntryPresenceV3(decoded.shm),
  })
}

function decodeArtifactSqliteGenerationV3(
  wire: ArtifactSqliteGenerationV3Wire,
): ArtifactSqliteGenerationV3Decoded {
  return {
    database: {
      kind: 'present',
      identity: ArtifactEntryIdentityV3Schema.parse(wire.database.identity),
      digest: wire.database.digest,
    },
    wal: decodeEntryPresenceV3(wire.wal),
    shm: decodeEntryPresenceV3(wire.shm),
  }
}

export interface ConsolidatedStagedSqliteGenerationV3<Value> {
  readonly database: {
    readonly kind: 'present'
    readonly identity: Value
    readonly digest: string
  }
  readonly wal: { readonly kind: 'absent' }
  readonly shm: { readonly kind: 'absent' }
  readonly consolidatedFromArchiveDigest: string
}

type ConsolidatedStagedSqliteGenerationV3Wire =
  ConsolidatedStagedSqliteGenerationV3<ArtifactEntryIdentityV3Wire>
type ConsolidatedStagedSqliteGenerationV3Decoded =
  ConsolidatedStagedSqliteGenerationV3<ArtifactEntryIdentityV3>

const ConsolidatedStagedSqliteGenerationV3WireSchema: z.ZodType<
  ConsolidatedStagedSqliteGenerationV3Wire,
  z.ZodTypeDef,
  ConsolidatedStagedSqliteGenerationV3Wire
> = z
  .object({
    database: z
      .object({
        kind: z.literal('present'),
        identity: ArtifactEntryIdentityV3WireSchema,
        digest: DigestV3Schema,
      })
      .strict(),
    wal: z.object({ kind: z.literal('absent') }).strict(),
    shm: z.object({ kind: z.literal('absent') }).strict(),
    consolidatedFromArchiveDigest: DigestV3Schema,
  })
  .strict()

function encodeConsolidatedStagedSqliteGenerationV3(
  decoded: ConsolidatedStagedSqliteGenerationV3Decoded,
): ConsolidatedStagedSqliteGenerationV3Wire {
  return ConsolidatedStagedSqliteGenerationV3WireSchema.parse({
    database: {
      kind: 'present',
      identity: encodeArtifactEntryIdentityV3(decoded.database.identity),
      digest: decoded.database.digest,
    },
    wal: { kind: 'absent' },
    shm: { kind: 'absent' },
    consolidatedFromArchiveDigest: decoded.consolidatedFromArchiveDigest,
  })
}

function decodeConsolidatedStagedSqliteGenerationV3(
  wire: ConsolidatedStagedSqliteGenerationV3Wire,
): ConsolidatedStagedSqliteGenerationV3Decoded {
  return {
    database: {
      kind: 'present',
      identity: ArtifactEntryIdentityV3Schema.parse(wire.database.identity),
      digest: wire.database.digest,
    },
    wal: { kind: 'absent' },
    shm: { kind: 'absent' },
    consolidatedFromArchiveDigest: wire.consolidatedFromArchiveDigest,
  }
}

type RestoreConfigDispositionV3<Value> =
  | { readonly kind: 'preserve' }
  | {
      readonly kind: 'replace'
      readonly fileDigest: string
      readonly stagedFileIdentity: Value
    }

type RestoreConfigDispositionV3Wire = RestoreConfigDispositionV3<ArtifactEntryIdentityV3Wire>
type RestoreConfigDispositionV3Decoded = RestoreConfigDispositionV3<ArtifactEntryIdentityV3>

const RestoreConfigDispositionV3WireSchema: z.ZodType<
  RestoreConfigDispositionV3Wire,
  z.ZodTypeDef,
  RestoreConfigDispositionV3Wire
> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preserve') }).strict(),
  z
    .object({
      kind: z.literal('replace'),
      fileDigest: DigestV3Schema,
      stagedFileIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])

function encodeRestoreConfigDispositionV3(
  decoded: RestoreConfigDispositionV3Decoded,
): RestoreConfigDispositionV3Wire {
  switch (decoded.kind) {
    case 'preserve':
      return { kind: 'preserve' }
    case 'replace':
      return RestoreConfigDispositionV3WireSchema.parse({
        kind: 'replace',
        fileDigest: decoded.fileDigest,
        stagedFileIdentity: encodeArtifactEntryIdentityV3(decoded.stagedFileIdentity),
      })
  }
}

function decodeRestoreConfigDispositionV3(
  wire: RestoreConfigDispositionV3Wire,
): RestoreConfigDispositionV3Decoded {
  switch (wire.kind) {
    case 'preserve':
      return { kind: 'preserve' }
    case 'replace':
      return {
        kind: 'replace',
        fileDigest: wire.fileDigest,
        stagedFileIdentity: ArtifactEntryIdentityV3Schema.parse(wire.stagedFileIdentity),
      }
  }
}

interface RestoreStagedGenerationV3<Value> {
  readonly restoreOperationId: string
  readonly sqlite: ConsolidatedStagedSqliteGenerationV3<Value>
  readonly configDisposition: RestoreConfigDispositionV3<Value>
  readonly skills: {
    readonly identity: Value
    readonly treeDigest: string
  }
}

type RestoreStagedGenerationV3Wire = RestoreStagedGenerationV3<ArtifactEntryIdentityV3Wire>
export type RestoreStagedGenerationV3Decoded = RestoreStagedGenerationV3<ArtifactEntryIdentityV3>

const RestoreStagedGenerationV3WireSchema: z.ZodType<
  RestoreStagedGenerationV3Wire,
  z.ZodTypeDef,
  RestoreStagedGenerationV3Wire
> = z
  .object({
    restoreOperationId: IdV3Schema,
    sqlite: ConsolidatedStagedSqliteGenerationV3WireSchema,
    configDisposition: RestoreConfigDispositionV3WireSchema,
    skills: z
      .object({
        identity: ArtifactEntryIdentityV3WireSchema,
        treeDigest: DigestV3Schema,
      })
      .strict(),
  })
  .strict()

function encodeRestoreStagedGenerationV3(
  decoded: RestoreStagedGenerationV3Decoded,
): RestoreStagedGenerationV3Wire {
  return RestoreStagedGenerationV3WireSchema.parse({
    restoreOperationId: decoded.restoreOperationId,
    sqlite: encodeConsolidatedStagedSqliteGenerationV3(decoded.sqlite),
    configDisposition: encodeRestoreConfigDispositionV3(decoded.configDisposition),
    skills: {
      identity: encodeArtifactEntryIdentityV3(decoded.skills.identity),
      treeDigest: decoded.skills.treeDigest,
    },
  })
}

function decodeRestoreStagedGenerationV3(
  wire: RestoreStagedGenerationV3Wire,
): RestoreStagedGenerationV3Decoded {
  return {
    restoreOperationId: wire.restoreOperationId,
    sqlite: decodeConsolidatedStagedSqliteGenerationV3(wire.sqlite),
    configDisposition: decodeRestoreConfigDispositionV3(wire.configDisposition),
    skills: {
      identity: ArtifactEntryIdentityV3Schema.parse(wire.skills.identity),
      treeDigest: wire.skills.treeDigest,
    },
  }
}

interface RestoreLiveGenerationObservationV3<Value> {
  readonly sqlite: {
    readonly database: EntryPresenceV3<Value>
    readonly wal: EntryPresenceV3<Value>
    readonly shm: EntryPresenceV3<Value>
  }
  readonly config: EntryPresenceV3<Value>
  readonly skills: EntryPresenceV3<Value>
  readonly observationFence: string
}

type RestoreLiveGenerationObservationV3Wire =
  RestoreLiveGenerationObservationV3<ArtifactEntryIdentityV3Wire>
export type RestoreLiveGenerationObservationV3Decoded =
  RestoreLiveGenerationObservationV3<ArtifactEntryIdentityV3>

const RestoreLiveGenerationObservationV3WireSchema: z.ZodType<
  RestoreLiveGenerationObservationV3Wire,
  z.ZodTypeDef,
  RestoreLiveGenerationObservationV3Wire
> = z
  .object({
    sqlite: z
      .object({
        database: EntryPresenceV3WireSchema,
        wal: EntryPresenceV3WireSchema,
        shm: EntryPresenceV3WireSchema,
      })
      .strict(),
    config: EntryPresenceV3WireSchema,
    skills: EntryPresenceV3WireSchema,
    observationFence: DigestV3Schema,
  })
  .strict()

function encodeRestoreLiveGenerationObservationV3(
  decoded: RestoreLiveGenerationObservationV3Decoded,
): RestoreLiveGenerationObservationV3Wire {
  return RestoreLiveGenerationObservationV3WireSchema.parse({
    sqlite: {
      database: encodeEntryPresenceV3(decoded.sqlite.database),
      wal: encodeEntryPresenceV3(decoded.sqlite.wal),
      shm: encodeEntryPresenceV3(decoded.sqlite.shm),
    },
    config: encodeEntryPresenceV3(decoded.config),
    skills: encodeEntryPresenceV3(decoded.skills),
    observationFence: decoded.observationFence,
  })
}

function decodeRestoreLiveGenerationObservationV3(
  wire: RestoreLiveGenerationObservationV3Wire,
): RestoreLiveGenerationObservationV3Decoded {
  return {
    sqlite: {
      database: decodeEntryPresenceV3(wire.sqlite.database),
      wal: decodeEntryPresenceV3(wire.sqlite.wal),
      shm: decodeEntryPresenceV3(wire.sqlite.shm),
    },
    config: decodeEntryPresenceV3(wire.config),
    skills: decodeEntryPresenceV3(wire.skills),
    observationFence: wire.observationFence,
  }
}

type RestoreSafetyCaptureV3<Value> =
  | {
      readonly kind: 'captured'
      readonly sqlite: {
        readonly database: EntryPresenceV3<Value>
        readonly wal: EntryPresenceV3<Value>
        readonly shm: EntryPresenceV3<Value>
      }
      readonly config: EntryPresenceV3<Value>
      readonly skills: EntryPresenceV3<Value>
      readonly publicationRefs: readonly ArtifactPublicationReceiptRefV3[]
    }
  | {
      readonly kind: 'skipped-by-operator'
      readonly sqlite: null
      readonly config: null
      readonly skills: null
      readonly publicationRefs: readonly []
    }

type RestoreSafetyCaptureV3Wire = RestoreSafetyCaptureV3<ArtifactEntryIdentityV3Wire>
export type RestoreSafetyCaptureV3Decoded = RestoreSafetyCaptureV3<ArtifactEntryIdentityV3>

const RestoreSafetyCaptureV3WireSchema: z.ZodType<
  RestoreSafetyCaptureV3Wire,
  z.ZodTypeDef,
  RestoreSafetyCaptureV3Wire
> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('captured'),
      sqlite: z
        .object({
          database: EntryPresenceV3WireSchema,
          wal: EntryPresenceV3WireSchema,
          shm: EntryPresenceV3WireSchema,
        })
        .strict(),
      config: EntryPresenceV3WireSchema,
      skills: EntryPresenceV3WireSchema,
      publicationRefs: z.array(ArtifactPublicationReceiptRefV3Schema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skipped-by-operator'),
      sqlite: z.null(),
      config: z.null(),
      skills: z.null(),
      publicationRefs: z.tuple([]),
    })
    .strict(),
])

function encodeRestoreSafetyCaptureV3(
  decoded: RestoreSafetyCaptureV3Decoded,
): RestoreSafetyCaptureV3Wire {
  switch (decoded.kind) {
    case 'captured':
      return RestoreSafetyCaptureV3WireSchema.parse({
        kind: 'captured',
        sqlite: {
          database: encodeEntryPresenceV3(decoded.sqlite.database),
          wal: encodeEntryPresenceV3(decoded.sqlite.wal),
          shm: encodeEntryPresenceV3(decoded.sqlite.shm),
        },
        config: encodeEntryPresenceV3(decoded.config),
        skills: encodeEntryPresenceV3(decoded.skills),
        publicationRefs: decoded.publicationRefs.map((ref) =>
          ArtifactPublicationReceiptRefV3Schema.parse({
            receiptId: ref.receiptId,
            revision: ref.revision,
            frameDigest: ref.frameDigest,
            operationDigest: ref.operationDigest,
            slotRole: ref.slotRole,
          }),
        ),
      })
    case 'skipped-by-operator':
      return {
        kind: 'skipped-by-operator',
        sqlite: null,
        config: null,
        skills: null,
        publicationRefs: [],
      }
  }
}

function decodeRestoreSafetyCaptureV3(
  wire: RestoreSafetyCaptureV3Wire,
): RestoreSafetyCaptureV3Decoded {
  switch (wire.kind) {
    case 'captured':
      return {
        kind: 'captured',
        sqlite: {
          database: decodeEntryPresenceV3(wire.sqlite.database),
          wal: decodeEntryPresenceV3(wire.sqlite.wal),
          shm: decodeEntryPresenceV3(wire.sqlite.shm),
        },
        config: decodeEntryPresenceV3(wire.config),
        skills: decodeEntryPresenceV3(wire.skills),
        publicationRefs: wire.publicationRefs.map((ref) => ({ ...ref })),
      }
    case 'skipped-by-operator':
      return {
        kind: 'skipped-by-operator',
        sqlite: null,
        config: null,
        skills: null,
        publicationRefs: [],
      }
  }
}

interface RestoreSafetyGenerationV3<Value> {
  readonly restoreOperationId: string
  readonly live: RestoreLiveGenerationObservationV3<Value>
  readonly capture: RestoreSafetyCaptureV3<Value>
}

type RestoreSafetyGenerationV3Wire = RestoreSafetyGenerationV3<ArtifactEntryIdentityV3Wire>
export type RestoreSafetyGenerationV3Decoded = RestoreSafetyGenerationV3<ArtifactEntryIdentityV3>

const RestoreSafetyGenerationV3WireSchema: z.ZodType<
  RestoreSafetyGenerationV3Wire,
  z.ZodTypeDef,
  RestoreSafetyGenerationV3Wire
> = z
  .object({
    restoreOperationId: IdV3Schema,
    live: RestoreLiveGenerationObservationV3WireSchema,
    capture: RestoreSafetyCaptureV3WireSchema,
  })
  .strict()

function encodeRestoreSafetyGenerationV3(
  decoded: RestoreSafetyGenerationV3Decoded,
): RestoreSafetyGenerationV3Wire {
  return RestoreSafetyGenerationV3WireSchema.parse({
    restoreOperationId: decoded.restoreOperationId,
    live: encodeRestoreLiveGenerationObservationV3(decoded.live),
    capture: encodeRestoreSafetyCaptureV3(decoded.capture),
  })
}

function decodeRestoreSafetyGenerationV3(
  wire: RestoreSafetyGenerationV3Wire,
): RestoreSafetyGenerationV3Decoded {
  return {
    restoreOperationId: wire.restoreOperationId,
    live: decodeRestoreLiveGenerationObservationV3(wire.live),
    capture: decodeRestoreSafetyCaptureV3(wire.capture),
  }
}

export interface RestoreSqlitePublicationRefV3 {
  readonly publicationId: string
  readonly revision: number
  readonly frameDigest: string
  readonly operationDigest: string
}

const RestoreSqlitePublicationRefV3Schema: z.ZodType<
  RestoreSqlitePublicationRefV3,
  z.ZodTypeDef,
  RestoreSqlitePublicationRefV3
> = z
  .object({
    publicationId: IdV3Schema,
    revision: PositiveSafeIntegerV3Schema,
    frameDigest: DigestV3Schema,
    operationDigest: DigestV3Schema,
  })
  .strict()

type SidecarRemovalV3<Value> =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'pending'; readonly expectedIdentity: Value }
  | {
      readonly kind: 'removing'
      readonly expectedIdentity: Value
      readonly intentRevision: number
    }
  | {
      readonly kind: 'removed'
      readonly expectedIdentity: Value
      readonly removedIdentity: Value
      readonly intentRevision: number
      readonly parentFsyncFence: string
    }

type SidecarRemovalV3Wire = SidecarRemovalV3<ArtifactEntryIdentityV3Wire>
type SidecarRemovalV3Decoded = SidecarRemovalV3<ArtifactEntryIdentityV3>
type InitialSidecarRemovalV3<Value> =
  | Extract<SidecarRemovalV3<Value>, { readonly kind: 'not-applicable' }>
  | Extract<SidecarRemovalV3<Value>, { readonly kind: 'pending' }>
type SettledSidecarRemovalV3<Value> =
  | Extract<SidecarRemovalV3<Value>, { readonly kind: 'not-applicable' }>
  | Extract<SidecarRemovalV3<Value>, { readonly kind: 'removed' }>
type InitialSidecarRemovalV3Wire = InitialSidecarRemovalV3<ArtifactEntryIdentityV3Wire>
type InitialSidecarRemovalV3Decoded = InitialSidecarRemovalV3<ArtifactEntryIdentityV3>
type SettledSidecarRemovalV3Wire = SettledSidecarRemovalV3<ArtifactEntryIdentityV3Wire>
type SettledSidecarRemovalV3Decoded = SettledSidecarRemovalV3<ArtifactEntryIdentityV3>

const SidecarRemovalV3WireSchema: z.ZodType<
  SidecarRemovalV3Wire,
  z.ZodTypeDef,
  SidecarRemovalV3Wire
> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('pending'),
      expectedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('removing'),
      expectedIdentity: ArtifactEntryIdentityV3WireSchema,
      intentRevision: PositiveSafeIntegerV3Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('removed'),
      expectedIdentity: ArtifactEntryIdentityV3WireSchema,
      removedIdentity: ArtifactEntryIdentityV3WireSchema,
      intentRevision: PositiveSafeIntegerV3Schema,
      parentFsyncFence: DigestV3Schema,
    })
    .strict(),
])

function encodeSidecarRemovalV3(decoded: SidecarRemovalV3Decoded): SidecarRemovalV3Wire {
  switch (decoded.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'pending':
      return {
        kind: 'pending',
        expectedIdentity: encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
      }
    case 'removing':
      return {
        kind: 'removing',
        expectedIdentity: encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        intentRevision: decoded.intentRevision,
      }
    case 'removed':
      return {
        kind: 'removed',
        expectedIdentity: encodeArtifactEntryIdentityV3(decoded.expectedIdentity),
        removedIdentity: encodeArtifactEntryIdentityV3(decoded.removedIdentity),
        intentRevision: decoded.intentRevision,
        parentFsyncFence: decoded.parentFsyncFence,
      }
  }
}

function decodeSidecarRemovalV3(wire: SidecarRemovalV3Wire): SidecarRemovalV3Decoded {
  switch (wire.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'pending':
      return {
        kind: 'pending',
        expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
      }
    case 'removing':
      return {
        kind: 'removing',
        expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
        intentRevision: wire.intentRevision,
      }
    case 'removed':
      return {
        kind: 'removed',
        expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
        removedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.removedIdentity),
        intentRevision: wire.intentRevision,
        parentFsyncFence: wire.parentFsyncFence,
      }
  }
}

function decodeSettledSidecarRemovalV3(
  wire: SettledSidecarRemovalV3Wire,
): SettledSidecarRemovalV3Decoded {
  switch (wire.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'removed':
      return {
        kind: 'removed',
        expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
        removedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.removedIdentity),
        intentRevision: wire.intentRevision,
        parentFsyncFence: wire.parentFsyncFence,
      }
  }
}

function decodeInitialSidecarRemovalV3(
  wire: InitialSidecarRemovalV3Wire,
): InitialSidecarRemovalV3Decoded {
  switch (wire.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'pending':
      return {
        kind: 'pending',
        expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
      }
  }
}

function decodeRemovingSidecarV3(
  wire: Extract<SidecarRemovalV3Wire, { readonly kind: 'removing' }>,
): Extract<SidecarRemovalV3Decoded, { readonly kind: 'removing' }> {
  return {
    kind: 'removing',
    expectedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.expectedIdentity),
    intentRevision: wire.intentRevision,
  }
}

type RestoreDatabaseExchangeV3<Value> =
  | {
      readonly mode: 'no-replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
    }
  | {
      readonly mode: 'replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
    }

type RestoreDatabaseExchangeV3Wire = RestoreDatabaseExchangeV3<ArtifactEntryIdentityV3Wire>
export type RestoreDatabaseExchangeV3Decoded = RestoreDatabaseExchangeV3<ArtifactEntryIdentityV3>

const RestoreDatabaseExchangeV3WireSchema: z.ZodType<
  RestoreDatabaseExchangeV3Wire,
  z.ZodTypeDef,
  RestoreDatabaseExchangeV3Wire
> = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('no-replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])

function encodeRestoreDatabaseExchangeV3(
  decoded: RestoreDatabaseExchangeV3Decoded,
): RestoreDatabaseExchangeV3Wire {
  switch (decoded.mode) {
    case 'no-replace':
      return RestoreDatabaseExchangeV3WireSchema.parse({
        mode: 'no-replace',
        publication: decoded.publication,
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: null,
      })
    case 'replace':
      return RestoreDatabaseExchangeV3WireSchema.parse({
        mode: 'replace',
        publication: decoded.publication,
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
      })
  }
}

function decodeRestoreDatabaseExchangeV3(
  wire: RestoreDatabaseExchangeV3Wire,
): RestoreDatabaseExchangeV3Decoded {
  switch (wire.mode) {
    case 'no-replace':
      return {
        mode: 'no-replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: null,
      }
    case 'replace':
      return {
        mode: 'replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
      }
  }
}

interface RestoreSqlitePublicationBaseV3<Value> {
  readonly schemaVersion: 3
  readonly publicationId: string
  readonly revision: number
  readonly previousRevision: number | null
  readonly previousFrameDigest: string | null
  readonly operation: RestoreOperationIdentityV3
  readonly operationDigest: string
  readonly stagedDatabaseIdentity: Value
  readonly liveBefore: {
    readonly database: EntryPresenceV3<Value>
    readonly wal: EntryPresenceV3<Value>
    readonly shm: EntryPresenceV3<Value>
  }
}

type RestoreSqlitePublicationV3<Value> =
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'declared'
      readonly wal: InitialSidecarRemovalV3<Value>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly database: null
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'wal-removing'
      readonly wal: Extract<SidecarRemovalV3<Value>, { readonly kind: 'removing' }>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly database: null
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'wal-settled'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly database: null
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'shm-removing'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: Extract<SidecarRemovalV3<Value>, { readonly kind: 'removing' }>
      readonly database: null
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'sidecars-settled'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly database: null
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'db-publishing'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly database: null
      readonly databasePublication: ArtifactPublicationReceiptRefV3
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'db-published'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly database: RestoreDatabaseExchangeV3<Value>
      readonly repairId: null
    })
  | (RestoreSqlitePublicationBaseV3<Value> & {
      readonly phase: 'repair-required'
      readonly forensic: RestoreSqliteRepairForensicV3<Value>
      readonly repairId: string
    })

type RestoreSqliteRepairForensicV3<Value> =
  | {
      readonly fromPhase: 'declared'
      readonly wal: InitialSidecarRemovalV3<Value>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly databasePublication: null
      readonly database: null
    }
  | {
      readonly fromPhase: 'wal-removing'
      readonly wal: Extract<SidecarRemovalV3<Value>, { readonly kind: 'removing' }>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly databasePublication: null
      readonly database: null
    }
  | {
      readonly fromPhase: 'wal-settled'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: InitialSidecarRemovalV3<Value>
      readonly databasePublication: null
      readonly database: null
    }
  | {
      readonly fromPhase: 'shm-removing'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: Extract<SidecarRemovalV3<Value>, { readonly kind: 'removing' }>
      readonly databasePublication: null
      readonly database: null
    }
  | {
      readonly fromPhase: 'sidecars-settled'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly databasePublication: null
      readonly database: null
    }
  | {
      readonly fromPhase: 'db-publishing'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly databasePublication: ArtifactPublicationReceiptRefV3
      readonly database: null
    }
  | {
      readonly fromPhase: 'db-published'
      readonly wal: SettledSidecarRemovalV3<Value>
      readonly shm: SettledSidecarRemovalV3<Value>
      readonly databasePublication: ArtifactPublicationReceiptRefV3
      readonly database: RestoreDatabaseExchangeV3<Value>
    }

export type RestoreSqlitePublicationV3Wire = RestoreSqlitePublicationV3<ArtifactEntryIdentityV3Wire>
export type RestoreSqlitePublicationV3Decoded = RestoreSqlitePublicationV3<ArtifactEntryIdentityV3>

const sqlitePublicationBaseWireShape = {
  schemaVersion: z.literal(3),
  publicationId: IdV3Schema,
  revision: PositiveSafeIntegerV3Schema,
  previousRevision: PositiveSafeIntegerV3Schema.nullable(),
  previousFrameDigest: DigestV3Schema.nullable(),
  operation: RestoreOperationIdentityV3Schema,
  operationDigest: DigestV3Schema,
  stagedDatabaseIdentity: ArtifactEntryIdentityV3WireSchema,
  liveBefore: z
    .object({
      database: EntryPresenceV3WireSchema,
      wal: EntryPresenceV3WireSchema,
      shm: EntryPresenceV3WireSchema,
    })
    .strict(),
}

const settledSidecarWireSchema = z.union([
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('removed'),
      expectedIdentity: ArtifactEntryIdentityV3WireSchema,
      removedIdentity: ArtifactEntryIdentityV3WireSchema,
      intentRevision: PositiveSafeIntegerV3Schema,
      parentFsyncFence: DigestV3Schema,
    })
    .strict(),
])

const initialSidecarWireSchema: z.ZodType<
  InitialSidecarRemovalV3Wire,
  z.ZodTypeDef,
  InitialSidecarRemovalV3Wire
> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('pending'),
      expectedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])

const removingSidecarWireSchema = z
  .object({
    kind: z.literal('removing'),
    expectedIdentity: ArtifactEntryIdentityV3WireSchema,
    intentRevision: PositiveSafeIntegerV3Schema,
  })
  .strict()

const RestoreSqliteRepairForensicV3WireSchema = z.discriminatedUnion('fromPhase', [
  z
    .object({
      fromPhase: z.literal('declared'),
      wal: initialSidecarWireSchema,
      shm: initialSidecarWireSchema,
      databasePublication: z.null(),
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('wal-removing'),
      wal: removingSidecarWireSchema,
      shm: initialSidecarWireSchema,
      databasePublication: z.null(),
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('wal-settled'),
      wal: settledSidecarWireSchema,
      shm: initialSidecarWireSchema,
      databasePublication: z.null(),
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('shm-removing'),
      wal: settledSidecarWireSchema,
      shm: removingSidecarWireSchema,
      databasePublication: z.null(),
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('sidecars-settled'),
      wal: settledSidecarWireSchema,
      shm: settledSidecarWireSchema,
      databasePublication: z.null(),
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('db-publishing'),
      wal: settledSidecarWireSchema,
      shm: settledSidecarWireSchema,
      databasePublication: ArtifactPublicationReceiptRefV3Schema,
      database: z.null(),
    })
    .strict(),
  z
    .object({
      fromPhase: z.literal('db-published'),
      wal: settledSidecarWireSchema,
      shm: settledSidecarWireSchema,
      databasePublication: ArtifactPublicationReceiptRefV3Schema,
      database: RestoreDatabaseExchangeV3WireSchema,
    })
    .strict(),
])

export const RestoreSqlitePublicationV3WireSchema: z.ZodType<
  RestoreSqlitePublicationV3Wire,
  z.ZodTypeDef,
  RestoreSqlitePublicationV3Wire
> = z
  .discriminatedUnion('phase', [
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('declared'),
        wal: initialSidecarWireSchema,
        shm: initialSidecarWireSchema,
        database: z.null(),
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('wal-removing'),
        wal: removingSidecarWireSchema,
        shm: initialSidecarWireSchema,
        database: z.null(),
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('wal-settled'),
        wal: settledSidecarWireSchema,
        shm: initialSidecarWireSchema,
        database: z.null(),
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('shm-removing'),
        wal: settledSidecarWireSchema,
        shm: removingSidecarWireSchema,
        database: z.null(),
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('sidecars-settled'),
        wal: settledSidecarWireSchema,
        shm: settledSidecarWireSchema,
        database: z.null(),
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('db-publishing'),
        wal: settledSidecarWireSchema,
        shm: settledSidecarWireSchema,
        database: z.null(),
        databasePublication: ArtifactPublicationReceiptRefV3Schema,
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('db-published'),
        wal: settledSidecarWireSchema,
        shm: settledSidecarWireSchema,
        database: RestoreDatabaseExchangeV3WireSchema,
        repairId: z.null(),
      })
      .strict(),
    z
      .object({
        ...sqlitePublicationBaseWireShape,
        phase: z.literal('repair-required'),
        forensic: RestoreSqliteRepairForensicV3WireSchema,
        repairId: IdV3Schema,
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    const expectedDigest = digestArtifactFsOperationIdentityV3(record.operation)
    if (
      (record.revision === 1 &&
        (record.previousRevision !== null || record.previousFrameDigest !== null)) ||
      (record.revision > 1 &&
        (record.previousRevision !== record.revision - 1 || record.previousFrameDigest === null))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'revision-lineage-shape-mismatch' })
    }
    if (!constantTimeDigestEqualV3(record.operationDigest, expectedDigest)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation-digest-mismatch' })
    }
    if (record.publicationId !== record.operation.restoreOperationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publication-id-operation-mismatch',
      })
    }
    const validateSidecar = (role: 'wal' | 'shm', progress: SidecarRemovalV3Wire): void => {
      const before = record.liveBefore[role]
      if (before.kind === 'absent' && progress.kind !== 'not-applicable') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-absent-must-be-not-applicable`,
        })
      }
      if (before.kind === 'present' && progress.kind === 'not-applicable') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-present-cannot-be-not-applicable`,
        })
      }
      if (
        before.kind === 'present' &&
        progress.kind !== 'not-applicable' &&
        !identityWireEqualV3(before.identity, progress.expectedIdentity)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-expected-identity-mismatch`,
        })
      }
      if (
        progress.kind === 'removed' &&
        !identityWireEqualV3(progress.expectedIdentity, progress.removedIdentity)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-removed-identity-mismatch`,
        })
      }
      if (
        progress.kind === 'removing' &&
        progress.intentRevision !==
          (record.phase === 'repair-required' ? record.previousRevision : record.revision)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-intent-revision-mismatch`,
        })
      }
      if (progress.kind === 'removed' && progress.intentRevision >= record.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role}-removed-intent-revision-mismatch`,
        })
      }
    }
    const wal = record.phase === 'repair-required' ? record.forensic.wal : record.wal
    const shm = record.phase === 'repair-required' ? record.forensic.shm : record.shm
    validateSidecar('wal', wal)
    validateSidecar('shm', shm)

    const databasePublication =
      record.phase === 'db-publishing'
        ? record.databasePublication
        : record.phase === 'repair-required'
          ? record.forensic.databasePublication
          : null
    if (
      databasePublication !== null &&
      (databasePublication.slotRole !== 'restore-database-file' ||
        !constantTimeDigestEqualV3(databasePublication.operationDigest, expectedDigest))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'database-publication-reference-mismatch',
      })
    }

    const database = record.phase === 'repair-required' ? record.forensic.database : record.database
    if (database !== null) {
      if (!identityWireEqualV3(database.publishedIdentity, record.stagedDatabaseIdentity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'database-published-not-staged',
        })
      }
      if (
        database.publication.slotRole !== 'restore-database-file' ||
        !constantTimeDigestEqualV3(database.publication.operationDigest, expectedDigest)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'database-publication-reference-mismatch',
        })
      }
      const before = record.liveBefore.database
      if (
        (before.kind === 'absent' && database.mode !== 'no-replace') ||
        (before.kind === 'present' && database.mode !== 'replace')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'database-publication-mode-mismatch',
        })
      }
      if (
        before.kind === 'present' &&
        database.mode === 'replace' &&
        !identityWireEqualV3(before.identity, database.displacedIdentity)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'database-displaced-not-live-before',
        })
      }
      if (
        databasePublication !== null &&
        canonicalJsonV3(databasePublication) !== canonicalJsonV3(database.publication)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'database-publication-forensic-ref-mismatch',
        })
      }
    }
  })

function decodeRestoreSqliteRepairForensicV3(
  wire: z.output<typeof RestoreSqliteRepairForensicV3WireSchema>,
): RestoreSqliteRepairForensicV3<ArtifactEntryIdentityV3> {
  switch (wire.fromPhase) {
    case 'declared':
      return {
        fromPhase: 'declared',
        wal: decodeInitialSidecarRemovalV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        databasePublication: null,
        database: null,
      }
    case 'wal-removing':
      return {
        fromPhase: 'wal-removing',
        wal: decodeRemovingSidecarV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        databasePublication: null,
        database: null,
      }
    case 'wal-settled':
      return {
        fromPhase: 'wal-settled',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        databasePublication: null,
        database: null,
      }
    case 'shm-removing':
      return {
        fromPhase: 'shm-removing',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeRemovingSidecarV3(wire.shm),
        databasePublication: null,
        database: null,
      }
    case 'sidecars-settled':
      return {
        fromPhase: 'sidecars-settled',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        databasePublication: null,
        database: null,
      }
    case 'db-publishing':
      return {
        fromPhase: 'db-publishing',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        databasePublication: { ...wire.databasePublication },
        database: null,
      }
    case 'db-published':
      return {
        fromPhase: 'db-published',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        databasePublication: { ...wire.databasePublication },
        database: decodeRestoreDatabaseExchangeV3(wire.database),
      }
  }
}

function decodeRestoreSqlitePublicationV3(
  wire: RestoreSqlitePublicationV3Wire,
): RestoreSqlitePublicationV3Decoded {
  const base = {
    schemaVersion: 3 as const,
    publicationId: wire.publicationId,
    revision: wire.revision,
    previousRevision: wire.previousRevision,
    previousFrameDigest: wire.previousFrameDigest,
    operation: { ...wire.operation },
    operationDigest: wire.operationDigest,
    stagedDatabaseIdentity: ArtifactEntryIdentityV3Schema.parse(wire.stagedDatabaseIdentity),
    liveBefore: {
      database: decodeEntryPresenceV3(wire.liveBefore.database),
      wal: decodeEntryPresenceV3(wire.liveBefore.wal),
      shm: decodeEntryPresenceV3(wire.liveBefore.shm),
    },
  }
  switch (wire.phase) {
    case 'declared':
      return {
        ...base,
        phase: 'declared',
        wal: decodeInitialSidecarRemovalV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        database: null,
        repairId: null,
      }
    case 'wal-removing':
      return {
        ...base,
        phase: 'wal-removing',
        wal: decodeRemovingSidecarV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        database: null,
        repairId: null,
      }
    case 'wal-settled':
      return {
        ...base,
        phase: 'wal-settled',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeInitialSidecarRemovalV3(wire.shm),
        database: null,
        repairId: null,
      }
    case 'shm-removing':
      return {
        ...base,
        phase: 'shm-removing',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeRemovingSidecarV3(wire.shm),
        database: null,
        repairId: null,
      }
    case 'sidecars-settled':
      return {
        ...base,
        phase: 'sidecars-settled',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        database: null,
        repairId: null,
      }
    case 'db-publishing':
      return {
        ...base,
        phase: 'db-publishing',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        database: null,
        databasePublication: { ...wire.databasePublication },
        repairId: null,
      }
    case 'db-published':
      return {
        ...base,
        phase: 'db-published',
        wal: decodeSettledSidecarRemovalV3(wire.wal),
        shm: decodeSettledSidecarRemovalV3(wire.shm),
        database: decodeRestoreDatabaseExchangeV3(wire.database),
        repairId: null,
      }
    case 'repair-required':
      return {
        ...base,
        phase: 'repair-required',
        forensic: decodeRestoreSqliteRepairForensicV3(wire.forensic),
        repairId: wire.repairId,
      }
  }
}

export const RestoreSqlitePublicationV3Schema: z.ZodType<
  RestoreSqlitePublicationV3Decoded,
  z.ZodTypeDef,
  RestoreSqlitePublicationV3Wire
> = RestoreSqlitePublicationV3WireSchema.transform(decodeRestoreSqlitePublicationV3)

type RestoreConfigExchangeV3<Value> =
  | {
      readonly mode: 'preserve'
      readonly publication: null
      readonly publishedIdentity: null
      readonly displacedIdentity: null
    }
  | {
      readonly mode: 'no-replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
    }
  | {
      readonly mode: 'replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
    }

type RestoreSkillsExchangeV3<Value> =
  | {
      readonly mode: 'no-replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: null
    }
  | {
      readonly mode: 'replace'
      readonly publication: ArtifactPublicationReceiptRefV3
      readonly publishedIdentity: Value
      readonly displacedIdentity: Value
    }

interface RestoreFsExchangeV3<Value> {
  readonly config: RestoreConfigExchangeV3<Value>
  readonly skills: RestoreSkillsExchangeV3<Value>
}

type RestoreFsExchangeV3Wire = RestoreFsExchangeV3<ArtifactEntryIdentityV3Wire>
export type RestoreFsExchangeV3Decoded = RestoreFsExchangeV3<ArtifactEntryIdentityV3>

const RestoreConfigExchangeV3WireSchema: z.ZodType<
  RestoreConfigExchangeV3<ArtifactEntryIdentityV3Wire>,
  z.ZodTypeDef,
  RestoreConfigExchangeV3<ArtifactEntryIdentityV3Wire>
> = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preserve'),
      publication: z.null(),
      publishedIdentity: z.null(),
      displacedIdentity: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('no-replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])

const RestoreSkillsExchangeV3WireSchema: z.ZodType<
  RestoreSkillsExchangeV3<ArtifactEntryIdentityV3Wire>,
  z.ZodTypeDef,
  RestoreSkillsExchangeV3<ArtifactEntryIdentityV3Wire>
> = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('no-replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: z.null(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('replace'),
      publication: ArtifactPublicationReceiptRefV3Schema,
      publishedIdentity: ArtifactEntryIdentityV3WireSchema,
      displacedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])

const RestoreFsExchangeV3WireSchema: z.ZodType<
  RestoreFsExchangeV3Wire,
  z.ZodTypeDef,
  RestoreFsExchangeV3Wire
> = z
  .object({
    config: RestoreConfigExchangeV3WireSchema,
    skills: RestoreSkillsExchangeV3WireSchema,
  })
  .strict()

function encodeRestoreConfigExchangeV3(
  decoded: RestoreConfigExchangeV3<ArtifactEntryIdentityV3>,
): RestoreConfigExchangeV3<ArtifactEntryIdentityV3Wire> {
  switch (decoded.mode) {
    case 'preserve':
      return {
        mode: 'preserve',
        publication: null,
        publishedIdentity: null,
        displacedIdentity: null,
      }
    case 'no-replace':
      return {
        mode: 'no-replace',
        publication: { ...decoded.publication },
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: null,
      }
    case 'replace':
      return {
        mode: 'replace',
        publication: { ...decoded.publication },
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
      }
  }
}

function decodeRestoreConfigExchangeV3(
  wire: RestoreConfigExchangeV3<ArtifactEntryIdentityV3Wire>,
): RestoreConfigExchangeV3<ArtifactEntryIdentityV3> {
  switch (wire.mode) {
    case 'preserve':
      return {
        mode: 'preserve',
        publication: null,
        publishedIdentity: null,
        displacedIdentity: null,
      }
    case 'no-replace':
      return {
        mode: 'no-replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: null,
      }
    case 'replace':
      return {
        mode: 'replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
      }
  }
}

function encodeRestoreSkillsExchangeV3(
  decoded: RestoreSkillsExchangeV3<ArtifactEntryIdentityV3>,
): RestoreSkillsExchangeV3<ArtifactEntryIdentityV3Wire> {
  switch (decoded.mode) {
    case 'no-replace':
      return {
        mode: 'no-replace',
        publication: { ...decoded.publication },
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: null,
      }
    case 'replace':
      return {
        mode: 'replace',
        publication: { ...decoded.publication },
        publishedIdentity: encodeArtifactEntryIdentityV3(decoded.publishedIdentity),
        displacedIdentity: encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
      }
  }
}

function decodeRestoreSkillsExchangeV3(
  wire: RestoreSkillsExchangeV3<ArtifactEntryIdentityV3Wire>,
): RestoreSkillsExchangeV3<ArtifactEntryIdentityV3> {
  switch (wire.mode) {
    case 'no-replace':
      return {
        mode: 'no-replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: null,
      }
    case 'replace':
      return {
        mode: 'replace',
        publication: { ...wire.publication },
        publishedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.publishedIdentity),
        displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
      }
  }
}

function encodeRestoreFsExchangeV3(decoded: RestoreFsExchangeV3Decoded): RestoreFsExchangeV3Wire {
  return RestoreFsExchangeV3WireSchema.parse({
    config: encodeRestoreConfigExchangeV3(decoded.config),
    skills: encodeRestoreSkillsExchangeV3(decoded.skills),
  })
}

function decodeRestoreFsExchangeV3(wire: RestoreFsExchangeV3Wire): RestoreFsExchangeV3Decoded {
  return {
    config: decodeRestoreConfigExchangeV3(wire.config),
    skills: decodeRestoreSkillsExchangeV3(wire.skills),
  }
}

type RestoreDatabaseMigrationV3<Value> =
  | {
      readonly disposition: 'applied'
      readonly databaseIdentity: Value
      readonly fromSchemaVersion: number
      readonly toSchemaVersion: number
      readonly migrationDigest: string
    }
  | {
      readonly disposition: 'skipped-no-migrate'
      readonly databaseIdentity: Value
      readonly fromSchemaVersion: number
      readonly toSchemaVersion: number
      readonly migrationDigest: null
    }
  | {
      readonly disposition: 'not-required'
      readonly databaseIdentity: Value
      readonly fromSchemaVersion: number
      readonly toSchemaVersion: number
      readonly migrationDigest: null
    }

type RestoreDatabaseMigrationV3Wire = RestoreDatabaseMigrationV3<ArtifactEntryIdentityV3Wire>
export type RestoreDatabaseMigrationV3Decoded = RestoreDatabaseMigrationV3<ArtifactEntryIdentityV3>

const RestoreDatabaseMigrationV3WireSchema: z.ZodType<
  RestoreDatabaseMigrationV3Wire,
  z.ZodTypeDef,
  RestoreDatabaseMigrationV3Wire
> = z.discriminatedUnion('disposition', [
  z
    .object({
      disposition: z.literal('applied'),
      databaseIdentity: ArtifactEntryIdentityV3WireSchema,
      fromSchemaVersion: NonNegativeSafeIntegerV3Schema,
      toSchemaVersion: NonNegativeSafeIntegerV3Schema,
      migrationDigest: DigestV3Schema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal('skipped-no-migrate'),
      databaseIdentity: ArtifactEntryIdentityV3WireSchema,
      fromSchemaVersion: NonNegativeSafeIntegerV3Schema,
      toSchemaVersion: NonNegativeSafeIntegerV3Schema,
      migrationDigest: z.null(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal('not-required'),
      databaseIdentity: ArtifactEntryIdentityV3WireSchema,
      fromSchemaVersion: NonNegativeSafeIntegerV3Schema,
      toSchemaVersion: NonNegativeSafeIntegerV3Schema,
      migrationDigest: z.null(),
    })
    .strict(),
])

function encodeRestoreDatabaseMigrationV3(
  decoded: RestoreDatabaseMigrationV3Decoded,
): RestoreDatabaseMigrationV3Wire {
  switch (decoded.disposition) {
    case 'applied':
      return RestoreDatabaseMigrationV3WireSchema.parse({
        disposition: 'applied',
        databaseIdentity: encodeArtifactEntryIdentityV3(decoded.databaseIdentity),
        fromSchemaVersion: decoded.fromSchemaVersion,
        toSchemaVersion: decoded.toSchemaVersion,
        migrationDigest: decoded.migrationDigest,
      })
    case 'skipped-no-migrate':
      return RestoreDatabaseMigrationV3WireSchema.parse({
        disposition: 'skipped-no-migrate',
        databaseIdentity: encodeArtifactEntryIdentityV3(decoded.databaseIdentity),
        fromSchemaVersion: decoded.fromSchemaVersion,
        toSchemaVersion: decoded.toSchemaVersion,
        migrationDigest: null,
      })
    case 'not-required':
      return RestoreDatabaseMigrationV3WireSchema.parse({
        disposition: 'not-required',
        databaseIdentity: encodeArtifactEntryIdentityV3(decoded.databaseIdentity),
        fromSchemaVersion: decoded.fromSchemaVersion,
        toSchemaVersion: decoded.toSchemaVersion,
        migrationDigest: null,
      })
  }
}

function decodeRestoreDatabaseMigrationV3(
  wire: RestoreDatabaseMigrationV3Wire,
): RestoreDatabaseMigrationV3Decoded {
  switch (wire.disposition) {
    case 'applied':
      return {
        disposition: 'applied',
        databaseIdentity: ArtifactEntryIdentityV3Schema.parse(wire.databaseIdentity),
        fromSchemaVersion: wire.fromSchemaVersion,
        toSchemaVersion: wire.toSchemaVersion,
        migrationDigest: wire.migrationDigest,
      }
    case 'skipped-no-migrate':
      return {
        disposition: 'skipped-no-migrate',
        databaseIdentity: ArtifactEntryIdentityV3Schema.parse(wire.databaseIdentity),
        fromSchemaVersion: wire.fromSchemaVersion,
        toSchemaVersion: wire.toSchemaVersion,
        migrationDigest: null,
      }
    case 'not-required':
      return {
        disposition: 'not-required',
        databaseIdentity: ArtifactEntryIdentityV3Schema.parse(wire.databaseIdentity),
        fromSchemaVersion: wire.fromSchemaVersion,
        toSchemaVersion: wire.toSchemaVersion,
        migrationDigest: null,
      }
  }
}

interface RestoreIdentityBarrierV3<Value> {
  readonly databaseIdentity: Value
  readonly config: EntryPresenceV3<Value>
  readonly skillsIdentity: Value
  readonly verifiedPublicationRefs: readonly ArtifactPublicationReceiptRefV3[]
  readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
  readonly observationFence: string
}

type RestoreIdentityBarrierV3Wire = RestoreIdentityBarrierV3<ArtifactEntryIdentityV3Wire>
export type RestoreIdentityBarrierV3Decoded = RestoreIdentityBarrierV3<ArtifactEntryIdentityV3>

const RestoreIdentityBarrierV3WireSchema: z.ZodType<
  RestoreIdentityBarrierV3Wire,
  z.ZodTypeDef,
  RestoreIdentityBarrierV3Wire
> = z
  .object({
    databaseIdentity: ArtifactEntryIdentityV3WireSchema,
    config: EntryPresenceV3WireSchema,
    skillsIdentity: ArtifactEntryIdentityV3WireSchema,
    verifiedPublicationRefs: z.array(ArtifactPublicationReceiptRefV3Schema),
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    observationFence: DigestV3Schema,
  })
  .strict()

function encodeRestoreIdentityBarrierV3(
  decoded: RestoreIdentityBarrierV3Decoded,
): RestoreIdentityBarrierV3Wire {
  return RestoreIdentityBarrierV3WireSchema.parse({
    databaseIdentity: encodeArtifactEntryIdentityV3(decoded.databaseIdentity),
    config: encodeEntryPresenceV3(decoded.config),
    skillsIdentity: encodeArtifactEntryIdentityV3(decoded.skillsIdentity),
    verifiedPublicationRefs: decoded.verifiedPublicationRefs.map((ref) => ({ ...ref })),
    sqlitePublicationRef: { ...decoded.sqlitePublicationRef },
    observationFence: decoded.observationFence,
  })
}

function decodeRestoreIdentityBarrierV3(
  wire: RestoreIdentityBarrierV3Wire,
): RestoreIdentityBarrierV3Decoded {
  return {
    databaseIdentity: ArtifactEntryIdentityV3Schema.parse(wire.databaseIdentity),
    config: decodeEntryPresenceV3(wire.config),
    skillsIdentity: ArtifactEntryIdentityV3Schema.parse(wire.skillsIdentity),
    verifiedPublicationRefs: wire.verifiedPublicationRefs.map((ref) => ({ ...ref })),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    observationFence: wire.observationFence,
  }
}

type DisplacedCleanupV3<Value> =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'removed'; readonly displacedIdentity: Value }

interface RestoreGenerationCleanupV3<Value> {
  readonly database: DisplacedCleanupV3<Value>
  readonly config: DisplacedCleanupV3<Value>
  readonly skills: DisplacedCleanupV3<Value>
  readonly walRemoval:
    | { readonly kind: 'not-applicable' }
    | {
        readonly kind: 'removed'
        readonly removedIdentity: Value
        readonly parentFsyncFence: string
      }
  readonly shmRemoval:
    | { readonly kind: 'not-applicable' }
    | {
        readonly kind: 'removed'
        readonly removedIdentity: Value
        readonly parentFsyncFence: string
      }
  readonly cleanupPublicationRefs: readonly ArtifactPublicationReceiptRefV3[]
  readonly observationFence: string
}

type RestoreGenerationCleanupV3Wire = RestoreGenerationCleanupV3<ArtifactEntryIdentityV3Wire>
export type RestoreGenerationCleanupV3Decoded = RestoreGenerationCleanupV3<ArtifactEntryIdentityV3>

const DisplacedCleanupV3WireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('removed'),
      displacedIdentity: ArtifactEntryIdentityV3WireSchema,
    })
    .strict(),
])
const SidecarCleanupV3WireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('removed'),
      removedIdentity: ArtifactEntryIdentityV3WireSchema,
      parentFsyncFence: DigestV3Schema,
    })
    .strict(),
])

const RestoreGenerationCleanupV3WireSchema: z.ZodType<
  RestoreGenerationCleanupV3Wire,
  z.ZodTypeDef,
  RestoreGenerationCleanupV3Wire
> = z
  .object({
    database: DisplacedCleanupV3WireSchema,
    config: DisplacedCleanupV3WireSchema,
    skills: DisplacedCleanupV3WireSchema,
    walRemoval: SidecarCleanupV3WireSchema,
    shmRemoval: SidecarCleanupV3WireSchema,
    cleanupPublicationRefs: z.array(ArtifactPublicationReceiptRefV3Schema),
    observationFence: DigestV3Schema,
  })
  .strict()

function encodeDisplacedCleanupV3(
  decoded: DisplacedCleanupV3<ArtifactEntryIdentityV3>,
): DisplacedCleanupV3<ArtifactEntryIdentityV3Wire> {
  switch (decoded.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'removed':
      return {
        kind: 'removed',
        displacedIdentity: encodeArtifactEntryIdentityV3(decoded.displacedIdentity),
      }
  }
}

function decodeDisplacedCleanupV3(
  wire: DisplacedCleanupV3<ArtifactEntryIdentityV3Wire>,
): DisplacedCleanupV3<ArtifactEntryIdentityV3> {
  switch (wire.kind) {
    case 'not-applicable':
      return { kind: 'not-applicable' }
    case 'removed':
      return {
        kind: 'removed',
        displacedIdentity: ArtifactEntryIdentityV3Schema.parse(wire.displacedIdentity),
      }
  }
}

function encodeRestoreGenerationCleanupV3(
  decoded: RestoreGenerationCleanupV3Decoded,
): RestoreGenerationCleanupV3Wire {
  const encodeSidecar = (
    value: RestoreGenerationCleanupV3Decoded['walRemoval'],
  ): RestoreGenerationCleanupV3Wire['walRemoval'] => {
    switch (value.kind) {
      case 'not-applicable':
        return { kind: 'not-applicable' }
      case 'removed':
        return {
          kind: 'removed',
          removedIdentity: encodeArtifactEntryIdentityV3(value.removedIdentity),
          parentFsyncFence: value.parentFsyncFence,
        }
    }
  }
  return RestoreGenerationCleanupV3WireSchema.parse({
    database: encodeDisplacedCleanupV3(decoded.database),
    config: encodeDisplacedCleanupV3(decoded.config),
    skills: encodeDisplacedCleanupV3(decoded.skills),
    walRemoval: encodeSidecar(decoded.walRemoval),
    shmRemoval: encodeSidecar(decoded.shmRemoval),
    cleanupPublicationRefs: decoded.cleanupPublicationRefs.map((ref) => ({ ...ref })),
    observationFence: decoded.observationFence,
  })
}

function decodeRestoreGenerationCleanupV3(
  wire: RestoreGenerationCleanupV3Wire,
): RestoreGenerationCleanupV3Decoded {
  const decodeSidecar = (
    value: RestoreGenerationCleanupV3Wire['walRemoval'],
  ): RestoreGenerationCleanupV3Decoded['walRemoval'] => {
    switch (value.kind) {
      case 'not-applicable':
        return { kind: 'not-applicable' }
      case 'removed':
        return {
          kind: 'removed',
          removedIdentity: ArtifactEntryIdentityV3Schema.parse(value.removedIdentity),
          parentFsyncFence: value.parentFsyncFence,
        }
    }
  }
  return {
    database: decodeDisplacedCleanupV3(wire.database),
    config: decodeDisplacedCleanupV3(wire.config),
    skills: decodeDisplacedCleanupV3(wire.skills),
    walRemoval: decodeSidecar(wire.walRemoval),
    shmRemoval: decodeSidecar(wire.shmRemoval),
    cleanupPublicationRefs: wire.cleanupPublicationRefs.map((ref) => ({ ...ref })),
    observationFence: wire.observationFence,
  }
}

interface RestoreGenerationMarkerBaseV3<Value> {
  readonly schemaVersion: 3
  readonly revision: number
  readonly operation: RestoreOperationIdentityV3
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
  readonly staged: RestoreStagedGenerationV3<Value>
}

type RestoreGenerationMarkerV3<Value> =
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'staging'
      readonly safety: null
      readonly sqlitePublicationRef: null
      readonly dbExchange: null
      readonly fsExchange: null
      readonly migration: null
      readonly identityBarrier: null
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'safety-snapshotted'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: null
      readonly fsExchange: null
      readonly migration: null
      readonly identityBarrier: null
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'db-swapped'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: RestoreDatabaseExchangeV3<Value>
      readonly fsExchange: null
      readonly migration: null
      readonly identityBarrier: null
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'fs-swapped'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: RestoreDatabaseExchangeV3<Value>
      readonly fsExchange: RestoreFsExchangeV3<Value>
      readonly migration: null
      readonly identityBarrier: null
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'db-migrated'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: RestoreDatabaseExchangeV3<Value>
      readonly fsExchange: RestoreFsExchangeV3<Value>
      readonly migration: RestoreDatabaseMigrationV3<Value>
      readonly identityBarrier: null
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'identity-verified'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: RestoreDatabaseExchangeV3<Value>
      readonly fsExchange: RestoreFsExchangeV3<Value>
      readonly migration: RestoreDatabaseMigrationV3<Value>
      readonly identityBarrier: RestoreIdentityBarrierV3<Value>
      readonly cleanup: null
    })
  | (RestoreGenerationMarkerBaseV3<Value> & {
      readonly phase: 'complete'
      readonly safety: RestoreSafetyGenerationV3<Value>
      readonly sqlitePublicationRef: RestoreSqlitePublicationRefV3
      readonly dbExchange: RestoreDatabaseExchangeV3<Value>
      readonly fsExchange: RestoreFsExchangeV3<Value>
      readonly migration: RestoreDatabaseMigrationV3<Value>
      readonly identityBarrier: RestoreIdentityBarrierV3<Value>
      readonly cleanup: RestoreGenerationCleanupV3<Value>
    })

export type RestoreGenerationMarkerV3Wire = RestoreGenerationMarkerV3<ArtifactEntryIdentityV3Wire>
export type RestoreGenerationMarkerV3Decoded = RestoreGenerationMarkerV3<ArtifactEntryIdentityV3>

type RestoreGenerationStagingMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'staging' }
>
type RestoreGenerationSafetyMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'safety-snapshotted' }
>
type RestoreGenerationDbSwappedMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'db-swapped' }
>
type RestoreGenerationFsSwappedMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'fs-swapped' }
>
type RestoreGenerationDbMigratedMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'db-migrated' }
>
type RestoreGenerationIdentityVerifiedMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'identity-verified' }
>
type RestoreGenerationCompleteMarkerV3Wire = Extract<
  RestoreGenerationMarkerV3Wire,
  { readonly phase: 'complete' }
>

type RestoreGenerationStagingMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'staging' }
>
type RestoreGenerationSafetyMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'safety-snapshotted' }
>
type RestoreGenerationDbSwappedMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'db-swapped' }
>
type RestoreGenerationFsSwappedMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'fs-swapped' }
>
type RestoreGenerationDbMigratedMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'db-migrated' }
>
type RestoreGenerationIdentityVerifiedMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'identity-verified' }
>
type RestoreGenerationCompleteMarkerV3Decoded = Extract<
  RestoreGenerationMarkerV3Decoded,
  { readonly phase: 'complete' }
>

const restoreMarkerBaseWireShape = {
  schemaVersion: z.literal(3),
  revision: PositiveSafeIntegerV3Schema,
  operation: RestoreOperationIdentityV3Schema,
  options: RestoreExecutionOptionsV3Schema,
  optionsDigest: DigestV3Schema,
  staged: RestoreStagedGenerationV3WireSchema,
}

export const RestoreGenerationStagingMarkerV3WireSchema: z.ZodType<
  RestoreGenerationStagingMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationStagingMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('staging'),
    safety: z.null(),
    sqlitePublicationRef: z.null(),
    dbExchange: z.null(),
    fsExchange: z.null(),
    migration: z.null(),
    identityBarrier: z.null(),
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationSafetyMarkerV3WireSchema: z.ZodType<
  RestoreGenerationSafetyMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationSafetyMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('safety-snapshotted'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: z.null(),
    fsExchange: z.null(),
    migration: z.null(),
    identityBarrier: z.null(),
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationDbSwappedMarkerV3WireSchema: z.ZodType<
  RestoreGenerationDbSwappedMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationDbSwappedMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('db-swapped'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: RestoreDatabaseExchangeV3WireSchema,
    fsExchange: z.null(),
    migration: z.null(),
    identityBarrier: z.null(),
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationFsSwappedMarkerV3WireSchema: z.ZodType<
  RestoreGenerationFsSwappedMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationFsSwappedMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('fs-swapped'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: RestoreDatabaseExchangeV3WireSchema,
    fsExchange: RestoreFsExchangeV3WireSchema,
    migration: z.null(),
    identityBarrier: z.null(),
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationDbMigratedMarkerV3WireSchema: z.ZodType<
  RestoreGenerationDbMigratedMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationDbMigratedMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('db-migrated'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: RestoreDatabaseExchangeV3WireSchema,
    fsExchange: RestoreFsExchangeV3WireSchema,
    migration: RestoreDatabaseMigrationV3WireSchema,
    identityBarrier: z.null(),
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationIdentityVerifiedMarkerV3WireSchema: z.ZodType<
  RestoreGenerationIdentityVerifiedMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationIdentityVerifiedMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('identity-verified'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: RestoreDatabaseExchangeV3WireSchema,
    fsExchange: RestoreFsExchangeV3WireSchema,
    migration: RestoreDatabaseMigrationV3WireSchema,
    identityBarrier: RestoreIdentityBarrierV3WireSchema,
    cleanup: z.null(),
  })
  .strict()

export const RestoreGenerationCompleteMarkerV3WireSchema: z.ZodType<
  RestoreGenerationCompleteMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationCompleteMarkerV3Wire
> = z
  .object({
    ...restoreMarkerBaseWireShape,
    phase: z.literal('complete'),
    safety: RestoreSafetyGenerationV3WireSchema,
    sqlitePublicationRef: RestoreSqlitePublicationRefV3Schema,
    dbExchange: RestoreDatabaseExchangeV3WireSchema,
    fsExchange: RestoreFsExchangeV3WireSchema,
    migration: RestoreDatabaseMigrationV3WireSchema,
    identityBarrier: RestoreIdentityBarrierV3WireSchema,
    cleanup: RestoreGenerationCleanupV3WireSchema,
  })
  .strict()

function decodeRestoreMarkerBaseV3(wire: RestoreGenerationMarkerV3Wire): {
  readonly schemaVersion: 3
  readonly revision: number
  readonly operation: RestoreOperationIdentityV3
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
  readonly staged: RestoreStagedGenerationV3Decoded
} {
  return {
    schemaVersion: 3,
    revision: wire.revision,
    operation: { ...wire.operation, options: { ...wire.operation.options } },
    options: { ...wire.options },
    optionsDigest: wire.optionsDigest,
    staged: decodeRestoreStagedGenerationV3(wire.staged),
  }
}

function decodeRestoreGenerationStagingMarkerV3(
  wire: RestoreGenerationStagingMarkerV3Wire,
): RestoreGenerationStagingMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'staging',
    safety: null,
    sqlitePublicationRef: null,
    dbExchange: null,
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  }
}

function decodeRestoreGenerationSafetyMarkerV3(
  wire: RestoreGenerationSafetyMarkerV3Wire,
): RestoreGenerationSafetyMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'safety-snapshotted',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: null,
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  }
}

function decodeRestoreGenerationDbSwappedMarkerV3(
  wire: RestoreGenerationDbSwappedMarkerV3Wire,
): RestoreGenerationDbSwappedMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'db-swapped',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: decodeRestoreDatabaseExchangeV3(wire.dbExchange),
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  }
}

function decodeRestoreGenerationFsSwappedMarkerV3(
  wire: RestoreGenerationFsSwappedMarkerV3Wire,
): RestoreGenerationFsSwappedMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'fs-swapped',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: decodeRestoreDatabaseExchangeV3(wire.dbExchange),
    fsExchange: decodeRestoreFsExchangeV3(wire.fsExchange),
    migration: null,
    identityBarrier: null,
    cleanup: null,
  }
}

function decodeRestoreGenerationDbMigratedMarkerV3(
  wire: RestoreGenerationDbMigratedMarkerV3Wire,
): RestoreGenerationDbMigratedMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'db-migrated',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: decodeRestoreDatabaseExchangeV3(wire.dbExchange),
    fsExchange: decodeRestoreFsExchangeV3(wire.fsExchange),
    migration: decodeRestoreDatabaseMigrationV3(wire.migration),
    identityBarrier: null,
    cleanup: null,
  }
}

function decodeRestoreGenerationIdentityVerifiedMarkerV3(
  wire: RestoreGenerationIdentityVerifiedMarkerV3Wire,
): RestoreGenerationIdentityVerifiedMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'identity-verified',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: decodeRestoreDatabaseExchangeV3(wire.dbExchange),
    fsExchange: decodeRestoreFsExchangeV3(wire.fsExchange),
    migration: decodeRestoreDatabaseMigrationV3(wire.migration),
    identityBarrier: decodeRestoreIdentityBarrierV3(wire.identityBarrier),
    cleanup: null,
  }
}

function decodeRestoreGenerationCompleteMarkerV3(
  wire: RestoreGenerationCompleteMarkerV3Wire,
): RestoreGenerationCompleteMarkerV3Decoded {
  return {
    ...decodeRestoreMarkerBaseV3(wire),
    phase: 'complete',
    safety: decodeRestoreSafetyGenerationV3(wire.safety),
    sqlitePublicationRef: { ...wire.sqlitePublicationRef },
    dbExchange: decodeRestoreDatabaseExchangeV3(wire.dbExchange),
    fsExchange: decodeRestoreFsExchangeV3(wire.fsExchange),
    migration: decodeRestoreDatabaseMigrationV3(wire.migration),
    identityBarrier: decodeRestoreIdentityBarrierV3(wire.identityBarrier),
    cleanup: decodeRestoreGenerationCleanupV3(wire.cleanup),
  }
}

function addSemanticIssueV3(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message })
}

function entryPresenceMatchesV3(
  left: EntryPresenceV3Decoded,
  right: EntryPresenceV3Decoded,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'absent' || right.kind === 'absent') return true
  return left.digest === right.digest && !identityEqualV3(left.identity, right.identity)
}

function entryPresenceExactEqualV3(
  left: EntryPresenceV3Decoded,
  right: EntryPresenceV3Decoded,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'absent' || right.kind === 'absent') return true
  return left.digest === right.digest && identityEqualV3(left.identity, right.identity)
}

function expectedSafetyRolesV3(
  live: RestoreLiveGenerationObservationV3Decoded,
): readonly RestoreArtifactFsSlotRoleV3[] {
  const roles: RestoreArtifactFsSlotRoleV3[] = []
  if (live.sqlite.database.kind === 'present') roles.push('restore-safety-database-file')
  if (live.sqlite.wal.kind === 'present') roles.push('restore-safety-database-wal')
  if (live.sqlite.shm.kind === 'present') roles.push('restore-safety-database-shm')
  if (live.config.kind === 'present') roles.push('restore-safety-config-file')
  if (live.skills.kind === 'present') roles.push('restore-safety-skills-root')
  return roles.sort()
}

function publicationRefsHaveExactRolesV3(
  refs: readonly ArtifactPublicationReceiptRefV3[],
  roles: readonly RestoreArtifactFsSlotRoleV3[],
  operationDigest: string,
): boolean {
  const actualRoles = refs.map((ref) => ref.slotRole).sort()
  return (
    refs.every((ref) => constantTimeDigestEqualV3(ref.operationDigest, operationDigest)) &&
    new Set(refs.map((ref) => ref.receiptId)).size === refs.length &&
    canonicalJsonV3(actualRoles) === canonicalJsonV3([...roles].sort())
  )
}

function restoreExchangeRefsV3(
  marker: Extract<
    RestoreGenerationMarkerV3Decoded,
    {
      readonly phase: 'fs-swapped' | 'db-migrated' | 'identity-verified' | 'complete'
    }
  >,
): readonly ArtifactPublicationReceiptRefV3[] {
  const refs: ArtifactPublicationReceiptRefV3[] = [
    marker.dbExchange.publication,
    marker.fsExchange.skills.publication,
  ]
  if (marker.fsExchange.config.publication !== null) {
    refs.push(marker.fsExchange.config.publication)
  }
  return refs
}

function publicationRefSetsEqualV3(
  left: readonly ArtifactPublicationReceiptRefV3[],
  right: readonly ArtifactPublicationReceiptRefV3[],
): boolean {
  const sorted = (refs: readonly ArtifactPublicationReceiptRefV3[]) =>
    refs.slice().sort((a, b) => a.slotRole.localeCompare(b.slotRole))
  return canonicalJsonV3(sorted(left)) === canonicalJsonV3(sorted(right))
}

function publicationRefSetDescendsV3(
  descendants: readonly ArtifactPublicationReceiptRefV3[],
  ancestors: readonly ArtifactPublicationReceiptRefV3[],
): boolean {
  if (descendants.length !== ancestors.length) return false
  const byRole = new Map(descendants.map((ref) => [ref.slotRole, ref]))
  return ancestors.every((ancestor) => {
    const descendant = byRole.get(ancestor.slotRole)
    return (
      descendant !== undefined &&
      descendant.receiptId === ancestor.receiptId &&
      descendant.revision >= ancestor.revision &&
      constantTimeDigestEqualV3(descendant.operationDigest, ancestor.operationDigest)
    )
  })
}

export function assertRestoreGenerationMarkerV3Decoded(
  marker: RestoreGenerationMarkerV3Decoded,
  context: z.RefinementCtx,
): void {
  const operation = RestoreOperationIdentityV3Schema.parse(marker.operation)
  const options = RestoreExecutionOptionsV3Schema.parse(marker.options)
  const optionsDigest = digestRestoreExecutionOptionsV3(options)
  const operationDigest = digestArtifactFsOperationIdentityV3(operation)

  if (
    canonicalJsonV3(operation.options) !== canonicalJsonV3(options) ||
    !constantTimeDigestEqualV3(marker.optionsDigest, optionsDigest) ||
    !constantTimeDigestEqualV3(operation.optionsDigest, optionsDigest)
  ) {
    addSemanticIssueV3(context, 'marker-operation-options-mismatch')
  }
  if (
    marker.staged.restoreOperationId !== operation.restoreOperationId ||
    marker.staged.sqlite.consolidatedFromArchiveDigest !== operation.archiveDigest ||
    marker.staged.sqlite.database.digest !== operation.incomingDatabaseDigest ||
    marker.staged.skills.treeDigest !== operation.incomingSkillsTreeDigest
  ) {
    addSemanticIssueV3(context, 'staged-generation-operation-mismatch')
  }
  if (
    (marker.staged.configDisposition.kind === 'preserve' &&
      operation.incomingConfigDigest !== null) ||
    (marker.staged.configDisposition.kind === 'replace' &&
      marker.staged.configDisposition.fileDigest !== operation.incomingConfigDigest)
  ) {
    addSemanticIssueV3(context, 'staged-config-operation-mismatch')
  }

  if (marker.safety !== null) {
    if (marker.safety.restoreOperationId !== operation.restoreOperationId) {
      addSemanticIssueV3(context, 'safety-operation-mismatch')
    }
    if (options.noSafetyBackup !== (marker.safety.capture.kind === 'skipped-by-operator')) {
      addSemanticIssueV3(context, 'safety-disposition-options-mismatch')
    }
    if (marker.safety.capture.kind === 'captured') {
      const capture = marker.safety.capture
      const live = marker.safety.live
      if (
        !entryPresenceMatchesV3(capture.sqlite.database, live.sqlite.database) ||
        !entryPresenceMatchesV3(capture.sqlite.wal, live.sqlite.wal) ||
        !entryPresenceMatchesV3(capture.sqlite.shm, live.sqlite.shm) ||
        !entryPresenceMatchesV3(capture.config, live.config) ||
        !entryPresenceMatchesV3(capture.skills, live.skills) ||
        !publicationRefsHaveExactRolesV3(
          capture.publicationRefs,
          expectedSafetyRolesV3(live),
          operationDigest,
        )
      ) {
        addSemanticIssueV3(context, 'captured-safety-generation-mismatch')
      }
    }
  }

  if (marker.sqlitePublicationRef !== null) {
    if (
      marker.sqlitePublicationRef.publicationId !== operation.restoreOperationId ||
      !constantTimeDigestEqualV3(marker.sqlitePublicationRef.operationDigest, operationDigest)
    ) {
      addSemanticIssueV3(context, 'sqlite-publication-ref-mismatch')
    }
  }

  if (marker.dbExchange !== null && marker.safety !== null) {
    if (
      !identityEqualV3(
        marker.dbExchange.publishedIdentity,
        marker.staged.sqlite.database.identity,
      ) ||
      marker.dbExchange.publication.slotRole !== 'restore-database-file' ||
      !constantTimeDigestEqualV3(marker.dbExchange.publication.operationDigest, operationDigest)
    ) {
      addSemanticIssueV3(context, 'database-publication-mismatch')
    }
    const liveDatabase = marker.safety.live.sqlite.database
    if (
      (liveDatabase.kind === 'absent' &&
        (marker.dbExchange.mode !== 'no-replace' ||
          marker.dbExchange.displacedIdentity !== null)) ||
      (liveDatabase.kind === 'present' &&
        (marker.dbExchange.mode !== 'replace' ||
          !identityEqualV3(marker.dbExchange.displacedIdentity, liveDatabase.identity)))
    ) {
      addSemanticIssueV3(context, 'database-live-target-algebra-mismatch')
    }
  }

  if (marker.fsExchange !== null && marker.safety !== null && marker.dbExchange !== null) {
    const config = marker.fsExchange.config
    const configDisposition = marker.staged.configDisposition
    const liveConfig = marker.safety.live.config
    if (
      (configDisposition.kind === 'preserve' && config.mode !== 'preserve') ||
      (configDisposition.kind === 'replace' &&
        liveConfig.kind === 'absent' &&
        config.mode !== 'no-replace') ||
      (configDisposition.kind === 'replace' &&
        liveConfig.kind === 'present' &&
        config.mode !== 'replace')
    ) {
      addSemanticIssueV3(context, 'config-publication-mode-mismatch')
    }
    if (
      configDisposition.kind === 'replace' &&
      config.mode !== 'preserve' &&
      (!identityEqualV3(config.publishedIdentity, configDisposition.stagedFileIdentity) ||
        config.publication.slotRole !== 'restore-config-file' ||
        !constantTimeDigestEqualV3(config.publication.operationDigest, operationDigest))
    ) {
      addSemanticIssueV3(context, 'config-publication-identity-mismatch')
    }
    if (
      config.mode === 'replace' &&
      (liveConfig.kind !== 'present' ||
        !identityEqualV3(config.displacedIdentity, liveConfig.identity))
    ) {
      addSemanticIssueV3(context, 'config-displaced-identity-mismatch')
    }

    const skills = marker.fsExchange.skills
    const liveSkills = marker.safety.live.skills
    if (
      (liveSkills.kind === 'absent' && skills.mode !== 'no-replace') ||
      (liveSkills.kind === 'present' && skills.mode !== 'replace') ||
      !identityEqualV3(skills.publishedIdentity, marker.staged.skills.identity) ||
      skills.publication.slotRole !== 'restore-skills-root' ||
      !constantTimeDigestEqualV3(skills.publication.operationDigest, operationDigest)
    ) {
      addSemanticIssueV3(context, 'skills-publication-algebra-mismatch')
    }
    if (
      skills.mode === 'replace' &&
      (liveSkills.kind !== 'present' ||
        !identityEqualV3(skills.displacedIdentity, liveSkills.identity))
    ) {
      addSemanticIssueV3(context, 'skills-displaced-identity-mismatch')
    }
  }

  if (marker.migration !== null && marker.dbExchange !== null) {
    const migration = marker.migration
    if (!identityEqualV3(migration.databaseIdentity, marker.dbExchange.publishedIdentity)) {
      addSemanticIssueV3(context, 'migration-database-identity-mismatch')
    }
    const schemaChanged = migration.fromSchemaVersion !== migration.toSchemaVersion
    const expectedDisposition = schemaChanged
      ? options.noMigrate
        ? 'skipped-no-migrate'
        : 'applied'
      : 'not-required'
    if (migration.disposition !== expectedDisposition) {
      addSemanticIssueV3(context, 'migration-disposition-options-mismatch')
    }
  }

  if (
    marker.identityBarrier !== null &&
    marker.safety !== null &&
    marker.dbExchange !== null &&
    marker.fsExchange !== null &&
    marker.sqlitePublicationRef !== null
  ) {
    const barrierConfig = marker.identityBarrier.config
    const configExchange = marker.fsExchange.config
    const configDisposition = marker.staged.configDisposition
    const configMatches =
      configExchange.mode === 'preserve'
        ? entryPresenceExactEqualV3(barrierConfig, marker.safety.live.config)
        : configDisposition.kind === 'replace' &&
          barrierConfig.kind === 'present' &&
          identityEqualV3(barrierConfig.identity, configExchange.publishedIdentity) &&
          barrierConfig.digest === configDisposition.fileDigest
    const barrierRoles: RestoreArtifactFsSlotRoleV3[] = [
      'restore-database-file',
      'restore-skills-root',
    ]
    if (configExchange.mode !== 'preserve') {
      barrierRoles.push('restore-config-file')
    }
    if (
      !identityEqualV3(
        marker.identityBarrier.databaseIdentity,
        marker.dbExchange.publishedIdentity,
      ) ||
      !identityEqualV3(
        marker.identityBarrier.skillsIdentity,
        marker.fsExchange.skills.publishedIdentity,
      ) ||
      !configMatches ||
      !publicationRefsHaveExactRolesV3(
        marker.identityBarrier.verifiedPublicationRefs,
        barrierRoles,
        operationDigest,
      ) ||
      !publicationRefSetsEqualV3(
        marker.identityBarrier.verifiedPublicationRefs,
        restoreExchangeRefsV3(marker),
      ) ||
      canonicalJsonV3(marker.identityBarrier.sqlitePublicationRef) !==
        canonicalJsonV3(marker.sqlitePublicationRef)
    ) {
      addSemanticIssueV3(context, 'identity-barrier-generation-mismatch')
    }
  }

  if (
    marker.cleanup !== null &&
    marker.safety !== null &&
    marker.dbExchange !== null &&
    marker.fsExchange !== null
  ) {
    const expectedCleanup = (
      mode: 'no-replace' | 'replace',
      displaced: ArtifactEntryIdentityV3 | null,
      actual: DisplacedCleanupV3<ArtifactEntryIdentityV3>,
      label: string,
    ): void => {
      if (
        (mode === 'no-replace' && actual.kind !== 'not-applicable') ||
        (mode === 'replace' &&
          (actual.kind !== 'removed' ||
            displaced === null ||
            !identityEqualV3(actual.displacedIdentity, displaced)))
      ) {
        addSemanticIssueV3(context, `${label}-cleanup-mismatch`)
      }
    }
    expectedCleanup(
      marker.dbExchange.mode,
      marker.dbExchange.displacedIdentity,
      marker.cleanup.database,
      'database',
    )
    if (marker.fsExchange.config.mode === 'preserve') {
      if (marker.cleanup.config.kind !== 'not-applicable') {
        addSemanticIssueV3(context, 'config-cleanup-mismatch')
      }
    } else {
      expectedCleanup(
        marker.fsExchange.config.mode,
        marker.fsExchange.config.displacedIdentity,
        marker.cleanup.config,
        'config',
      )
    }
    expectedCleanup(
      marker.fsExchange.skills.mode,
      marker.fsExchange.skills.displacedIdentity,
      marker.cleanup.skills,
      'skills',
    )

    const sidecarCleanupMatches = (
      live: EntryPresenceV3Decoded,
      cleanup: RestoreGenerationCleanupV3Decoded['walRemoval'],
    ): boolean =>
      live.kind === 'absent'
        ? cleanup.kind === 'not-applicable'
        : cleanup.kind === 'removed' && identityEqualV3(cleanup.removedIdentity, live.identity)
    if (
      !sidecarCleanupMatches(marker.safety.live.sqlite.wal, marker.cleanup.walRemoval) ||
      !sidecarCleanupMatches(marker.safety.live.sqlite.shm, marker.cleanup.shmRemoval)
    ) {
      addSemanticIssueV3(context, 'sidecar-cleanup-mismatch')
    }
    const cleanupRoles: RestoreArtifactFsSlotRoleV3[] = [
      'restore-database-file',
      'restore-skills-root',
    ]
    if (marker.fsExchange.config.mode !== 'preserve') {
      cleanupRoles.push('restore-config-file')
    }
    if (
      !publicationRefsHaveExactRolesV3(
        marker.cleanup.cleanupPublicationRefs,
        cleanupRoles,
        operationDigest,
      ) ||
      !publicationRefSetDescendsV3(
        marker.cleanup.cleanupPublicationRefs,
        restoreExchangeRefsV3(marker),
      )
    ) {
      addSemanticIssueV3(context, 'cleanup-publication-refs-mismatch')
    }
  }
}

export function assertRestoreSafetyPublicationReceiptsV3(
  operation: RestoreOperationIdentityV3,
  safety: RestoreSafetyGenerationV3Decoded,
  receipts: readonly ArtifactPublicationReceiptV3[],
): void {
  if (safety.capture.kind === 'skipped-by-operator') {
    if (receipts.length !== 0) throw new Error('skipped-safety-cannot-have-receipts')
    return
  }
  const entries = new Map<
    RestoreArtifactFsSlotRoleV3,
    Extract<EntryPresenceV3Decoded, { readonly kind: 'present' }>
  >()
  const add = (role: RestoreArtifactFsSlotRoleV3, entry: EntryPresenceV3Decoded): void => {
    if (entry.kind === 'present') entries.set(role, entry)
  }
  add('restore-safety-database-file', safety.capture.sqlite.database)
  add('restore-safety-database-wal', safety.capture.sqlite.wal)
  add('restore-safety-database-shm', safety.capture.sqlite.shm)
  add('restore-safety-config-file', safety.capture.config)
  add('restore-safety-skills-root', safety.capture.skills)
  if (
    entries.size !== safety.capture.publicationRefs.length ||
    receipts.length !== safety.capture.publicationRefs.length
  ) {
    throw new Error('safety-publication-cardinality-mismatch')
  }
  for (const ref of safety.capture.publicationRefs) {
    const captured = entries.get(ref.slotRole)
    const receipt = receipts.find(
      (candidate) => candidate.receiptId === ref.receiptId && candidate.revision === ref.revision,
    )
    if (captured === undefined || receipt === undefined) {
      throw new Error('safety-publication-receipt-missing')
    }
    assertPublicationRefMatchesV3(ref, receipt, operation, ref.slotRole, {
      requiredPhase: 'cleanup-verified',
      publicationMode: 'no-replace',
      stagedIdentity: captured.identity,
      stagedDigest: captured.digest,
      expectedIdentity: null,
      publishedIdentity: captured.identity,
      displacedIdentity: null,
    })
  }
}

export function assertRestoreExchangePublicationReceiptsV3(
  marker: RestoreGenerationCompleteMarkerV3Decoded,
  purpose: 'identity-barrier' | 'cleanup',
  receipts: readonly ArtifactPublicationReceiptV3[],
): void {
  const refs =
    purpose === 'identity-barrier'
      ? marker.identityBarrier.verifiedPublicationRefs
      : marker.cleanup.cleanupPublicationRefs
  const expectedByRole = new Map<
    RestoreArtifactFsSlotRoleV3,
    ArtifactPublicationExpectedProjectionV3
  >()
  const addExchange = (
    role: RestoreArtifactFsSlotRoleV3,
    mode: 'no-replace' | 'replace',
    stagedIdentity: ArtifactEntryIdentityV3,
    stagedDigest: string,
    publishedIdentity: ArtifactEntryIdentityV3,
    displacedIdentity: ArtifactEntryIdentityV3 | null,
  ): void => {
    expectedByRole.set(role, {
      requiredPhase: purpose === 'identity-barrier' ? 'exchanged' : 'cleanup-verified',
      publicationMode: mode,
      stagedIdentity,
      stagedDigest,
      expectedIdentity: mode === 'replace' ? displacedIdentity : null,
      publishedIdentity,
      displacedIdentity,
    })
  }
  addExchange(
    'restore-database-file',
    marker.dbExchange.mode,
    marker.staged.sqlite.database.identity,
    marker.staged.sqlite.database.digest,
    marker.dbExchange.publishedIdentity,
    marker.dbExchange.displacedIdentity,
  )
  if (
    marker.staged.configDisposition.kind === 'replace' &&
    marker.fsExchange.config.mode !== 'preserve' &&
    marker.fsExchange.config.publishedIdentity !== null
  ) {
    addExchange(
      'restore-config-file',
      marker.fsExchange.config.mode,
      marker.staged.configDisposition.stagedFileIdentity,
      marker.staged.configDisposition.fileDigest,
      marker.fsExchange.config.publishedIdentity,
      marker.fsExchange.config.displacedIdentity,
    )
  }
  addExchange(
    'restore-skills-root',
    marker.fsExchange.skills.mode,
    marker.staged.skills.identity,
    marker.staged.skills.treeDigest,
    marker.fsExchange.skills.publishedIdentity,
    marker.fsExchange.skills.displacedIdentity,
  )
  if (refs.length !== expectedByRole.size || receipts.length !== refs.length) {
    throw new Error('restore-exchange-publication-cardinality-mismatch')
  }
  for (const ref of refs) {
    const expected = expectedByRole.get(ref.slotRole)
    const receipt = receipts.find(
      (candidate) => candidate.receiptId === ref.receiptId && candidate.revision === ref.revision,
    )
    if (expected === undefined || receipt === undefined) {
      throw new Error('restore-exchange-publication-receipt-missing')
    }
    assertPublicationRefMatchesV3(ref, receipt, marker.operation, ref.slotRole, expected)
  }
}

export function assertRestoreGenerationMarkerV3Wire(
  wire: RestoreGenerationMarkerV3Wire,
  context: z.RefinementCtx,
): void {
  switch (wire.phase) {
    case 'staging':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationStagingMarkerV3(wire),
        context,
      )
    case 'safety-snapshotted':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationSafetyMarkerV3(wire),
        context,
      )
    case 'db-swapped':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationDbSwappedMarkerV3(wire),
        context,
      )
    case 'fs-swapped':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationFsSwappedMarkerV3(wire),
        context,
      )
    case 'db-migrated':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationDbMigratedMarkerV3(wire),
        context,
      )
    case 'identity-verified':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationIdentityVerifiedMarkerV3(wire),
        context,
      )
    case 'complete':
      return assertRestoreGenerationMarkerV3Decoded(
        decodeRestoreGenerationCompleteMarkerV3(wire),
        context,
      )
  }
}

export const RestoreGenerationMarkerV3WireSchema: z.ZodType<
  RestoreGenerationMarkerV3Wire,
  z.ZodTypeDef,
  RestoreGenerationMarkerV3Wire
> = z
  .union([
    RestoreGenerationStagingMarkerV3WireSchema,
    RestoreGenerationSafetyMarkerV3WireSchema,
    RestoreGenerationDbSwappedMarkerV3WireSchema,
    RestoreGenerationFsSwappedMarkerV3WireSchema,
    RestoreGenerationDbMigratedMarkerV3WireSchema,
    RestoreGenerationIdentityVerifiedMarkerV3WireSchema,
    RestoreGenerationCompleteMarkerV3WireSchema,
  ])
  .superRefine(assertRestoreGenerationMarkerV3Wire)

export const RestoreGenerationStagingMarkerV3Schema: z.ZodType<
  RestoreGenerationStagingMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationStagingMarkerV3Wire
> = RestoreGenerationStagingMarkerV3WireSchema.transform(
  decodeRestoreGenerationStagingMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationSafetyMarkerV3Schema: z.ZodType<
  RestoreGenerationSafetyMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationSafetyMarkerV3Wire
> = RestoreGenerationSafetyMarkerV3WireSchema.transform(
  decodeRestoreGenerationSafetyMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationDbSwappedMarkerV3Schema: z.ZodType<
  RestoreGenerationDbSwappedMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationDbSwappedMarkerV3Wire
> = RestoreGenerationDbSwappedMarkerV3WireSchema.transform(
  decodeRestoreGenerationDbSwappedMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationFsSwappedMarkerV3Schema: z.ZodType<
  RestoreGenerationFsSwappedMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationFsSwappedMarkerV3Wire
> = RestoreGenerationFsSwappedMarkerV3WireSchema.transform(
  decodeRestoreGenerationFsSwappedMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationDbMigratedMarkerV3Schema: z.ZodType<
  RestoreGenerationDbMigratedMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationDbMigratedMarkerV3Wire
> = RestoreGenerationDbMigratedMarkerV3WireSchema.transform(
  decodeRestoreGenerationDbMigratedMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationIdentityVerifiedMarkerV3Schema: z.ZodType<
  RestoreGenerationIdentityVerifiedMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationIdentityVerifiedMarkerV3Wire
> = RestoreGenerationIdentityVerifiedMarkerV3WireSchema.transform(
  decodeRestoreGenerationIdentityVerifiedMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationCompleteMarkerV3Schema: z.ZodType<
  RestoreGenerationCompleteMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationCompleteMarkerV3Wire
> = RestoreGenerationCompleteMarkerV3WireSchema.transform(
  decodeRestoreGenerationCompleteMarkerV3,
).superRefine(assertRestoreGenerationMarkerV3Decoded)

export const RestoreGenerationMarkerV3Schema: z.ZodType<
  RestoreGenerationMarkerV3Decoded,
  z.ZodTypeDef,
  RestoreGenerationMarkerV3Wire
> = z.union([
  RestoreGenerationStagingMarkerV3Schema,
  RestoreGenerationSafetyMarkerV3Schema,
  RestoreGenerationDbSwappedMarkerV3Schema,
  RestoreGenerationFsSwappedMarkerV3Schema,
  RestoreGenerationDbMigratedMarkerV3Schema,
  RestoreGenerationIdentityVerifiedMarkerV3Schema,
  RestoreGenerationCompleteMarkerV3Schema,
])

export function encodeRestoreGenerationStagingMarkerV3(
  decoded: RestoreGenerationStagingMarkerV3Decoded,
): RestoreGenerationStagingMarkerV3Wire {
  return RestoreGenerationStagingMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'staging',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: null,
    sqlitePublicationRef: null,
    dbExchange: null,
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  })
}

export function encodeRestoreGenerationSafetyMarkerV3(
  decoded: RestoreGenerationSafetyMarkerV3Decoded,
): RestoreGenerationSafetyMarkerV3Wire {
  return RestoreGenerationSafetyMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'safety-snapshotted',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: null,
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  })
}

export function encodeRestoreGenerationDbSwappedMarkerV3(
  decoded: RestoreGenerationDbSwappedMarkerV3Decoded,
): RestoreGenerationDbSwappedMarkerV3Wire {
  return RestoreGenerationDbSwappedMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'db-swapped',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: encodeRestoreDatabaseExchangeV3(decoded.dbExchange),
    fsExchange: null,
    migration: null,
    identityBarrier: null,
    cleanup: null,
  })
}

export function encodeRestoreGenerationFsSwappedMarkerV3(
  decoded: RestoreGenerationFsSwappedMarkerV3Decoded,
): RestoreGenerationFsSwappedMarkerV3Wire {
  return RestoreGenerationFsSwappedMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'fs-swapped',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: encodeRestoreDatabaseExchangeV3(decoded.dbExchange),
    fsExchange: encodeRestoreFsExchangeV3(decoded.fsExchange),
    migration: null,
    identityBarrier: null,
    cleanup: null,
  })
}

export function encodeRestoreGenerationDbMigratedMarkerV3(
  decoded: RestoreGenerationDbMigratedMarkerV3Decoded,
): RestoreGenerationDbMigratedMarkerV3Wire {
  return RestoreGenerationDbMigratedMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'db-migrated',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: encodeRestoreDatabaseExchangeV3(decoded.dbExchange),
    fsExchange: encodeRestoreFsExchangeV3(decoded.fsExchange),
    migration: encodeRestoreDatabaseMigrationV3(decoded.migration),
    identityBarrier: null,
    cleanup: null,
  })
}

export function encodeRestoreGenerationIdentityVerifiedMarkerV3(
  decoded: RestoreGenerationIdentityVerifiedMarkerV3Decoded,
): RestoreGenerationIdentityVerifiedMarkerV3Wire {
  return RestoreGenerationIdentityVerifiedMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'identity-verified',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: encodeRestoreDatabaseExchangeV3(decoded.dbExchange),
    fsExchange: encodeRestoreFsExchangeV3(decoded.fsExchange),
    migration: encodeRestoreDatabaseMigrationV3(decoded.migration),
    identityBarrier: encodeRestoreIdentityBarrierV3(decoded.identityBarrier),
    cleanup: null,
  })
}

export function encodeRestoreGenerationCompleteMarkerV3(
  decoded: RestoreGenerationCompleteMarkerV3Decoded,
): RestoreGenerationCompleteMarkerV3Wire {
  return RestoreGenerationCompleteMarkerV3WireSchema.parse({
    schemaVersion: 3,
    revision: decoded.revision,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    options: encodeRestoreExecutionOptionsV3(decoded.options),
    optionsDigest: decoded.optionsDigest,
    phase: 'complete',
    staged: encodeRestoreStagedGenerationV3(decoded.staged),
    safety: encodeRestoreSafetyGenerationV3(decoded.safety),
    sqlitePublicationRef: {
      publicationId: decoded.sqlitePublicationRef.publicationId,
      revision: decoded.sqlitePublicationRef.revision,
      frameDigest: decoded.sqlitePublicationRef.frameDigest,
      operationDigest: decoded.sqlitePublicationRef.operationDigest,
    },
    dbExchange: encodeRestoreDatabaseExchangeV3(decoded.dbExchange),
    fsExchange: encodeRestoreFsExchangeV3(decoded.fsExchange),
    migration: encodeRestoreDatabaseMigrationV3(decoded.migration),
    identityBarrier: encodeRestoreIdentityBarrierV3(decoded.identityBarrier),
    cleanup: encodeRestoreGenerationCleanupV3(decoded.cleanup),
  })
}

function assertNeverRestoreGenerationV3(value: never): never {
  throw new Error(`unhandled-restore-generation-phase:${String(value)}`)
}

export function encodeRestoreGenerationMarkerV3(
  decoded: RestoreGenerationMarkerV3Decoded,
): RestoreGenerationMarkerV3Wire {
  switch (decoded.phase) {
    case 'staging':
      return encodeRestoreGenerationStagingMarkerV3(decoded)
    case 'safety-snapshotted':
      return encodeRestoreGenerationSafetyMarkerV3(decoded)
    case 'db-swapped':
      return encodeRestoreGenerationDbSwappedMarkerV3(decoded)
    case 'fs-swapped':
      return encodeRestoreGenerationFsSwappedMarkerV3(decoded)
    case 'db-migrated':
      return encodeRestoreGenerationDbMigratedMarkerV3(decoded)
    case 'identity-verified':
      return encodeRestoreGenerationIdentityVerifiedMarkerV3(decoded)
    case 'complete':
      return encodeRestoreGenerationCompleteMarkerV3(decoded)
    default:
      return assertNeverRestoreGenerationV3(decoded)
  }
}

interface DurableRootCodecV3<Kind extends DurableRootKindV3, Wire, Decoded> {
  readonly rootKind: Kind
  readonly wireSchema: z.ZodType<Wire, z.ZodTypeDef, Wire>
  readonly decodedSchema: z.ZodType<Decoded, z.ZodTypeDef, Wire>
  readonly encode: (decoded: Decoded) => Wire
}

export const RestoreGenerationMarkerV3Codec = {
  rootKind: 'restore-generation-marker',
  wireSchema: RestoreGenerationMarkerV3WireSchema,
  decodedSchema: RestoreGenerationMarkerV3Schema,
  encode: encodeRestoreGenerationMarkerV3,
} satisfies DurableRootCodecV3<
  'restore-generation-marker',
  RestoreGenerationMarkerV3Wire,
  RestoreGenerationMarkerV3Decoded
>

function encodeRestoreSqlitePublicationBaseV3(decoded: RestoreSqlitePublicationV3Decoded): {
  readonly schemaVersion: 3
  readonly publicationId: string
  readonly revision: number
  readonly previousRevision: number | null
  readonly previousFrameDigest: string | null
  readonly operation: RestoreOperationIdentityV3
  readonly operationDigest: string
  readonly stagedDatabaseIdentity: ArtifactEntryIdentityV3Wire
  readonly liveBefore: {
    readonly database: EntryPresenceV3Wire
    readonly wal: EntryPresenceV3Wire
    readonly shm: EntryPresenceV3Wire
  }
} {
  return {
    schemaVersion: 3,
    publicationId: decoded.publicationId,
    revision: decoded.revision,
    previousRevision: decoded.previousRevision,
    previousFrameDigest: decoded.previousFrameDigest,
    operation: encodeRestoreOperationIdentityV3(decoded.operation),
    operationDigest: decoded.operationDigest,
    stagedDatabaseIdentity: encodeArtifactEntryIdentityV3(decoded.stagedDatabaseIdentity),
    liveBefore: {
      database: encodeEntryPresenceV3(decoded.liveBefore.database),
      wal: encodeEntryPresenceV3(decoded.liveBefore.wal),
      shm: encodeEntryPresenceV3(decoded.liveBefore.shm),
    },
  }
}

export const RestoreSqlitePublicationV3Codec = {
  rootKind: 'restore-sqlite-publication',
  wireSchema: RestoreSqlitePublicationV3WireSchema,
  decodedSchema: RestoreSqlitePublicationV3Schema,
  encode: (decoded: RestoreSqlitePublicationV3Decoded): RestoreSqlitePublicationV3Wire => {
    const base = encodeRestoreSqlitePublicationBaseV3(decoded)
    switch (decoded.phase) {
      case 'declared':
      case 'wal-removing':
      case 'wal-settled':
      case 'shm-removing':
      case 'sidecars-settled':
        return RestoreSqlitePublicationV3WireSchema.parse({
          schemaVersion: base.schemaVersion,
          publicationId: base.publicationId,
          revision: base.revision,
          previousRevision: base.previousRevision,
          previousFrameDigest: base.previousFrameDigest,
          operation: base.operation,
          operationDigest: base.operationDigest,
          stagedDatabaseIdentity: base.stagedDatabaseIdentity,
          liveBefore: base.liveBefore,
          phase: decoded.phase,
          wal: encodeSidecarRemovalV3(decoded.wal),
          shm: encodeSidecarRemovalV3(decoded.shm),
          database: null,
          repairId: null,
        })
      case 'db-publishing':
        return RestoreSqlitePublicationV3WireSchema.parse({
          schemaVersion: base.schemaVersion,
          publicationId: base.publicationId,
          revision: base.revision,
          previousRevision: base.previousRevision,
          previousFrameDigest: base.previousFrameDigest,
          operation: base.operation,
          operationDigest: base.operationDigest,
          stagedDatabaseIdentity: base.stagedDatabaseIdentity,
          liveBefore: base.liveBefore,
          phase: 'db-publishing',
          wal: encodeSidecarRemovalV3(decoded.wal),
          shm: encodeSidecarRemovalV3(decoded.shm),
          database: null,
          databasePublication: ArtifactPublicationReceiptRefV3Schema.parse(
            decoded.databasePublication,
          ),
          repairId: null,
        })
      case 'db-published':
        return RestoreSqlitePublicationV3WireSchema.parse({
          schemaVersion: base.schemaVersion,
          publicationId: base.publicationId,
          revision: base.revision,
          previousRevision: base.previousRevision,
          previousFrameDigest: base.previousFrameDigest,
          operation: base.operation,
          operationDigest: base.operationDigest,
          stagedDatabaseIdentity: base.stagedDatabaseIdentity,
          liveBefore: base.liveBefore,
          phase: 'db-published',
          wal: encodeSidecarRemovalV3(decoded.wal),
          shm: encodeSidecarRemovalV3(decoded.shm),
          database: encodeRestoreDatabaseExchangeV3(decoded.database),
          repairId: null,
        })
      case 'repair-required':
        return RestoreSqlitePublicationV3WireSchema.parse({
          schemaVersion: base.schemaVersion,
          publicationId: base.publicationId,
          revision: base.revision,
          previousRevision: base.previousRevision,
          previousFrameDigest: base.previousFrameDigest,
          operation: base.operation,
          operationDigest: base.operationDigest,
          stagedDatabaseIdentity: base.stagedDatabaseIdentity,
          liveBefore: base.liveBefore,
          phase: 'repair-required',
          forensic: encodeRestoreSqliteRepairForensicV3(decoded.forensic),
          repairId: decoded.repairId,
        })
      default:
        return assertNeverRestoreGenerationV3(decoded)
    }
  },
} satisfies DurableRootCodecV3<
  'restore-sqlite-publication',
  RestoreSqlitePublicationV3Wire,
  RestoreSqlitePublicationV3Decoded
>

export function digestRestoreSqlitePublicationFrameV3(
  publication: RestoreSqlitePublicationV3Decoded,
): string {
  return sha256DomainV3(
    'agent-workflow/restore-sqlite-publication-frame/v3',
    RestoreSqlitePublicationV3Codec.encode(publication),
  )
}

export function restoreSqlitePublicationRefFromRecordV3(
  publication: RestoreSqlitePublicationV3Decoded,
): RestoreSqlitePublicationRefV3 {
  return RestoreSqlitePublicationRefV3Schema.parse({
    publicationId: publication.publicationId,
    revision: publication.revision,
    frameDigest: digestRestoreSqlitePublicationFrameV3(publication),
    operationDigest: publication.operationDigest,
  })
}

function sqlitePublicationBaseEqualV3(
  previous: RestoreSqlitePublicationV3Decoded,
  next: RestoreSqlitePublicationV3Decoded,
): boolean {
  return (
    previous.publicationId === next.publicationId &&
    constantTimeDigestEqualV3(previous.operationDigest, next.operationDigest) &&
    canonicalJsonV3(previous.operation) === canonicalJsonV3(next.operation) &&
    identityEqualV3(previous.stagedDatabaseIdentity, next.stagedDatabaseIdentity) &&
    canonicalJsonV3(encodeEntryPresenceV3(previous.liveBefore.database)) ===
      canonicalJsonV3(encodeEntryPresenceV3(next.liveBefore.database)) &&
    canonicalJsonV3(encodeEntryPresenceV3(previous.liveBefore.wal)) ===
      canonicalJsonV3(encodeEntryPresenceV3(next.liveBefore.wal)) &&
    canonicalJsonV3(encodeEntryPresenceV3(previous.liveBefore.shm)) ===
      canonicalJsonV3(encodeEntryPresenceV3(next.liveBefore.shm))
  )
}

function sqliteForensicFromRecordV3(
  record: Exclude<RestoreSqlitePublicationV3Decoded, { readonly phase: 'repair-required' }>,
): RestoreSqliteRepairForensicV3<ArtifactEntryIdentityV3> {
  switch (record.phase) {
    case 'declared':
      return {
        fromPhase: 'declared',
        wal: record.wal,
        shm: record.shm,
        databasePublication: null,
        database: null,
      }
    case 'wal-removing':
      return {
        fromPhase: 'wal-removing',
        wal: record.wal,
        shm: record.shm,
        databasePublication: null,
        database: null,
      }
    case 'wal-settled':
      return {
        fromPhase: 'wal-settled',
        wal: record.wal,
        shm: record.shm,
        databasePublication: null,
        database: null,
      }
    case 'shm-removing':
      return {
        fromPhase: 'shm-removing',
        wal: record.wal,
        shm: record.shm,
        databasePublication: null,
        database: null,
      }
    case 'sidecars-settled':
      return {
        fromPhase: 'sidecars-settled',
        wal: record.wal,
        shm: record.shm,
        databasePublication: null,
        database: null,
      }
    case 'db-publishing':
      return {
        fromPhase: 'db-publishing',
        wal: record.wal,
        shm: record.shm,
        databasePublication: record.databasePublication,
        database: null,
      }
    case 'db-published':
      return {
        fromPhase: 'db-published',
        wal: record.wal,
        shm: record.shm,
        databasePublication: record.database.publication,
        database: record.database,
      }
  }
}

function encodeRestoreSqliteRepairForensicV3(
  forensic: RestoreSqliteRepairForensicV3<ArtifactEntryIdentityV3>,
): z.output<typeof RestoreSqliteRepairForensicV3WireSchema> {
  return RestoreSqliteRepairForensicV3WireSchema.parse({
    fromPhase: forensic.fromPhase,
    wal: encodeSidecarRemovalV3(forensic.wal),
    shm: encodeSidecarRemovalV3(forensic.shm),
    databasePublication:
      forensic.databasePublication === null
        ? null
        : ArtifactPublicationReceiptRefV3Schema.parse(forensic.databasePublication),
    database:
      forensic.database === null ? null : encodeRestoreDatabaseExchangeV3(forensic.database),
  })
}

export function assertRestoreSqlitePublicationTransitionV3(
  previous: RestoreSqlitePublicationV3Decoded,
  next: RestoreSqlitePublicationV3Decoded,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    next.previousRevision !== previous.revision ||
    next.previousFrameDigest === null ||
    !constantTimeDigestEqualV3(
      next.previousFrameDigest,
      digestRestoreSqlitePublicationFrameV3(previous),
    ) ||
    !sqlitePublicationBaseEqualV3(previous, next)
  ) {
    throw new Error('restore-sqlite-publication-lineage-mismatch')
  }
  if (previous.phase === 'repair-required') {
    throw new Error('restore-sqlite-repair-is-terminal')
  }
  if (next.phase === 'repair-required') {
    if (
      canonicalJsonV3(encodeRestoreSqliteRepairForensicV3(next.forensic)) !==
      canonicalJsonV3(encodeRestoreSqliteRepairForensicV3(sqliteForensicFromRecordV3(previous)))
    ) {
      throw new Error('restore-sqlite-repair-lost-prefix')
    }
    return
  }
  const nextPhase = {
    declared: 'wal-removing',
    'wal-removing': 'wal-settled',
    'wal-settled': 'shm-removing',
    'shm-removing': 'sidecars-settled',
    'sidecars-settled': 'db-publishing',
    'db-publishing': 'db-published',
    'db-published': null,
  } as const
  if (nextPhase[previous.phase] !== next.phase) {
    throw new Error('restore-sqlite-publication-illegal-transition')
  }
}

export function latestRestoreSqlitePublicationDescendantV3(
  anchor: RestoreSqlitePublicationRefV3,
  revisions: readonly RestoreSqlitePublicationV3Decoded[],
): RestoreSqlitePublicationV3Decoded {
  const ordered = revisions
    .filter((record) => record.publicationId === anchor.publicationId)
    .slice()
    .sort((left, right) => left.revision - right.revision)
  const anchorIndex = ordered.findIndex((record) => record.revision === anchor.revision)
  if (anchorIndex < 0) throw new Error('restore-sqlite-publication-anchor-missing')
  const anchored = ordered[anchorIndex]!
  if (
    !constantTimeDigestEqualV3(anchor.frameDigest, digestRestoreSqlitePublicationFrameV3(anchored))
  ) {
    throw new Error('restore-sqlite-publication-anchor-digest-mismatch')
  }
  for (let index = anchorIndex + 1; index < ordered.length; index += 1) {
    assertRestoreSqlitePublicationTransitionV3(ordered[index - 1]!, ordered[index]!)
  }
  return ordered[ordered.length - 1]!
}

export function assertRestoreSqlitePublicationRefMatchesV3(
  ref: RestoreSqlitePublicationRefV3,
  publication: RestoreSqlitePublicationV3Decoded,
  expectedOperation: RestoreOperationIdentityV3,
  expectedStagedDatabaseIdentity: ArtifactEntryIdentityV3,
  expectedPhase: RestoreSqlitePublicationV3Decoded['phase'],
): void {
  const parsedRef = RestoreSqlitePublicationRefV3Schema.parse(ref)
  const parsedPublication = RestoreSqlitePublicationV3Schema.parse(
    RestoreSqlitePublicationV3Codec.encode(publication),
  )
  const expectedDigest = digestArtifactFsOperationIdentityV3(expectedOperation)
  const locator = restoreSqlitePublicationLocatorV3(parsedRef)
  assertTrustedDurableRootStorageKeyV3(locator.key)
  if (
    locator.key.rootId !== parsedRef.publicationId ||
    locator.key.revision !== parsedRef.revision ||
    !constantTimeDigestEqualV3(locator.key.frameDigest, parsedRef.frameDigest) ||
    parsedRef.publicationId !== parsedPublication.publicationId ||
    parsedRef.revision !== parsedPublication.revision ||
    !constantTimeDigestEqualV3(
      parsedRef.frameDigest,
      digestRestoreSqlitePublicationFrameV3(parsedPublication),
    ) ||
    !constantTimeDigestEqualV3(parsedRef.operationDigest, expectedDigest) ||
    !constantTimeDigestEqualV3(parsedPublication.operationDigest, expectedDigest) ||
    canonicalJsonV3(parsedPublication.operation) !==
      canonicalJsonV3(encodeRestoreOperationIdentityV3(expectedOperation)) ||
    !identityEqualV3(parsedPublication.stagedDatabaseIdentity, expectedStagedDatabaseIdentity) ||
    parsedPublication.phase !== expectedPhase
  ) {
    throw new Error('foreign-restore-sqlite-publication-reference')
  }
}

type _MarkerWireInputIsExact = Expect<
  Equal<z.input<typeof RestoreGenerationMarkerV3WireSchema>, RestoreGenerationMarkerV3Wire>
>
type _MarkerWireOutputIsExact = Expect<
  Equal<z.output<typeof RestoreGenerationMarkerV3WireSchema>, RestoreGenerationMarkerV3Wire>
>
type _MarkerDecodedInputIsWire = Expect<
  Equal<z.input<typeof RestoreGenerationMarkerV3Schema>, RestoreGenerationMarkerV3Wire>
>
type _MarkerDecodedOutputIsExact = Expect<
  Equal<z.output<typeof RestoreGenerationMarkerV3Schema>, RestoreGenerationMarkerV3Decoded>
>

function proofDigestV3(label: string): string {
  return sha256DomainV3('agent-workflow/rfc235-v21-proof', label)
}

function proofIdentityV3(seed: number): ArtifactEntryIdentityV3 {
  return {
    dev: 9_007_199_254_740_992n + BigInt(seed),
    ino: 9_007_199_254_750_000n + BigInt(seed),
    mode: 0o100600,
    nlink: 1,
    fsid: [7, 11],
  }
}

function proofPublicationRefV3(
  operation: RestoreOperationIdentityV3,
  role: RestoreArtifactFsSlotRoleV3,
  seed: number,
): ArtifactPublicationReceiptRefV3 {
  return {
    receiptId: `receipt-${seed}`,
    revision: seed,
    frameDigest: proofDigestV3(`publication-frame-${seed}`),
    operationDigest: digestArtifactFsOperationIdentityV3(operation),
    slotRole: role,
  }
}

function proofArtifactPublicationChainV3(input: {
  readonly operation: RestoreOperationIdentityV3
  readonly receiptId: string
  readonly slotRole: RestoreArtifactFsSlotRoleV3
  readonly stagedIdentity: ArtifactEntryIdentityV3
  readonly stagedDigest: string
  readonly publicationMode: 'no-replace' | 'replace'
  readonly expectedIdentity: ArtifactEntryIdentityV3 | null
}): readonly [
  ArtifactPublicationReceiptV3,
  ArtifactPublicationReceiptV3,
  ArtifactPublicationReceiptV3,
] {
  const base = {
    schemaVersion: 3 as const,
    receiptId: input.receiptId,
    operation: input.operation,
    operationDigest: digestArtifactFsOperationIdentityV3(input.operation),
    slotRole: input.slotRole,
    stagedIdentity: input.stagedIdentity,
    stagedDigest: input.stagedDigest,
  }
  if (input.publicationMode === 'no-replace') {
    if (input.expectedIdentity !== null) {
      throw new Error('no-replace-proof-cannot-have-expected-identity')
    }
    const prepared: ArtifactPublicationReceiptV3 = {
      ...base,
      revision: 1,
      previousRevision: null,
      previousFrameDigest: null,
      phase: 'prepared',
      publicationMode: 'no-replace',
      expectedIdentity: null,
      publishedIdentity: null,
      displacedIdentity: null,
    }
    const exchanged: ArtifactPublicationReceiptV3 = {
      ...base,
      revision: 2,
      previousRevision: prepared.revision,
      previousFrameDigest: digestArtifactPublicationFrameV3(prepared),
      phase: 'exchanged',
      publicationMode: 'no-replace',
      expectedIdentity: null,
      publishedIdentity: input.stagedIdentity,
      displacedIdentity: null,
      cleanupVerifiedAt: null,
    }
    const cleanupVerified: ArtifactPublicationReceiptV3 = {
      ...base,
      revision: 3,
      previousRevision: exchanged.revision,
      previousFrameDigest: digestArtifactPublicationFrameV3(exchanged),
      phase: 'cleanup-verified',
      publicationMode: 'no-replace',
      expectedIdentity: null,
      publishedIdentity: input.stagedIdentity,
      displacedIdentity: null,
      cleanupVerifiedAt: 'proof-cleanup-checkpoint',
    }
    return [prepared, exchanged, cleanupVerified]
  }
  if (input.expectedIdentity === null) {
    throw new Error('replace-proof-requires-expected-identity')
  }
  const expectedIdentity = input.expectedIdentity
  const prepared: ArtifactPublicationReceiptV3 = {
    ...base,
    revision: 1,
    previousRevision: null,
    previousFrameDigest: null,
    phase: 'prepared',
    publicationMode: 'replace',
    expectedIdentity,
    publishedIdentity: null,
    displacedIdentity: null,
  }
  const exchanged: ArtifactPublicationReceiptV3 = {
    ...base,
    revision: 2,
    previousRevision: prepared.revision,
    previousFrameDigest: digestArtifactPublicationFrameV3(prepared),
    phase: 'exchanged',
    publicationMode: 'replace',
    expectedIdentity,
    publishedIdentity: input.stagedIdentity,
    displacedIdentity: expectedIdentity,
    cleanupVerifiedAt: null,
  }
  const cleanupVerified: ArtifactPublicationReceiptV3 = {
    ...base,
    revision: 3,
    previousRevision: exchanged.revision,
    previousFrameDigest: digestArtifactPublicationFrameV3(exchanged),
    phase: 'cleanup-verified',
    publicationMode: 'replace',
    expectedIdentity,
    publishedIdentity: input.stagedIdentity,
    displacedIdentity: expectedIdentity,
    cleanupVerifiedAt: 'proof-cleanup-checkpoint',
  }
  return [prepared, exchanged, cleanupVerified]
}

function proofOperationV3(options: RestoreExecutionOptionsV3): RestoreOperationIdentityV3 {
  const optionsDigest = digestRestoreExecutionOptionsV3(options)
  return {
    kind: 'app-generation-restore',
    restoreOperationId: 'restore-proof',
    archiveDigest: proofDigestV3('archive'),
    incomingDatabaseDigest: proofDigestV3('incoming-database'),
    incomingConfigDigest: proofDigestV3('incoming-config'),
    incomingSkillsTreeDigest: proofDigestV3('incoming-skills'),
    options,
    optionsDigest,
  }
}

function proofCompleteMarkerV3(
  options: RestoreExecutionOptionsV3,
  liveTargets:
    | 'present'
    | 'absent'
    | {
        readonly database: 'present' | 'absent'
        readonly config: 'present' | 'absent'
        readonly skills: 'present' | 'absent'
      },
  configDisposition: 'replace' | 'preserve' = 'replace',
): RestoreGenerationCompleteMarkerV3Decoded {
  const baseOperation = proofOperationV3(options)
  const operation: RestoreOperationIdentityV3 =
    configDisposition === 'preserve'
      ? { ...baseOperation, incomingConfigDigest: null }
      : baseOperation
  const operationDigest = digestArtifactFsOperationIdentityV3(operation)
  const stagedDatabase = proofIdentityV3(1)
  const stagedConfig = proofIdentityV3(2)
  const stagedSkills = proofIdentityV3(3)
  const liveDatabase = proofIdentityV3(4)
  const liveWal = proofIdentityV3(5)
  const liveShm = proofIdentityV3(6)
  const liveConfig = proofIdentityV3(7)
  const liveSkills = proofIdentityV3(8)
  const targetMatrix =
    typeof liveTargets === 'string'
      ? {
          database: liveTargets,
          config: liveTargets,
          skills: liveTargets,
        }
      : liveTargets
  const presence = (
    identity: ArtifactEntryIdentityV3,
    label: string,
    target: 'present' | 'absent',
  ): EntryPresenceV3Decoded =>
    target === 'present'
      ? { kind: 'present', identity, digest: proofDigestV3(label) }
      : { kind: 'absent' }
  const live: RestoreLiveGenerationObservationV3Decoded = {
    sqlite: {
      database: presence(liveDatabase, 'live-database', targetMatrix.database),
      wal: presence(liveWal, 'live-wal', targetMatrix.database),
      shm: presence(liveShm, 'live-shm', targetMatrix.database),
    },
    config: presence(liveConfig, 'live-config', targetMatrix.config),
    skills: presence(liveSkills, 'live-skills', targetMatrix.skills),
    observationFence: proofDigestV3('live-observation'),
  }
  const safetyRefs: ArtifactPublicationReceiptRefV3[] = []
  if (live.sqlite.database.kind === 'present') {
    safetyRefs.push(proofPublicationRefV3(operation, 'restore-safety-database-file', 10))
  }
  if (live.sqlite.wal.kind === 'present') {
    safetyRefs.push(proofPublicationRefV3(operation, 'restore-safety-database-wal', 11))
  }
  if (live.sqlite.shm.kind === 'present') {
    safetyRefs.push(proofPublicationRefV3(operation, 'restore-safety-database-shm', 12))
  }
  if (live.config.kind === 'present') {
    safetyRefs.push(proofPublicationRefV3(operation, 'restore-safety-config-file', 13))
  }
  if (live.skills.kind === 'present') {
    safetyRefs.push(proofPublicationRefV3(operation, 'restore-safety-skills-root', 14))
  }
  const capture: RestoreSafetyCaptureV3Decoded = options.noSafetyBackup
    ? {
        kind: 'skipped-by-operator',
        sqlite: null,
        config: null,
        skills: null,
        publicationRefs: [],
      }
    : {
        kind: 'captured',
        sqlite: {
          database:
            live.sqlite.database.kind === 'absent'
              ? { kind: 'absent' }
              : {
                  kind: 'present',
                  identity: proofIdentityV3(20),
                  digest: live.sqlite.database.digest,
                },
          wal:
            live.sqlite.wal.kind === 'absent'
              ? { kind: 'absent' }
              : {
                  kind: 'present',
                  identity: proofIdentityV3(21),
                  digest: live.sqlite.wal.digest,
                },
          shm:
            live.sqlite.shm.kind === 'absent'
              ? { kind: 'absent' }
              : {
                  kind: 'present',
                  identity: proofIdentityV3(22),
                  digest: live.sqlite.shm.digest,
                },
        },
        config:
          live.config.kind === 'absent'
            ? { kind: 'absent' }
            : {
                kind: 'present',
                identity: proofIdentityV3(23),
                digest: live.config.digest,
              },
        skills:
          live.skills.kind === 'absent'
            ? { kind: 'absent' }
            : {
                kind: 'present',
                identity: proofIdentityV3(24),
                digest: live.skills.digest,
              },
        publicationRefs: safetyRefs,
      }
  const staged: RestoreStagedGenerationV3Decoded = {
    restoreOperationId: operation.restoreOperationId,
    sqlite: {
      database: {
        kind: 'present',
        identity: stagedDatabase,
        digest: operation.incomingDatabaseDigest,
      },
      wal: { kind: 'absent' },
      shm: { kind: 'absent' },
      consolidatedFromArchiveDigest: operation.archiveDigest,
    },
    configDisposition:
      configDisposition === 'preserve'
        ? { kind: 'preserve' }
        : {
            kind: 'replace',
            fileDigest: operation.incomingConfigDigest ?? proofDigestV3('never'),
            stagedFileIdentity: stagedConfig,
          },
    skills: {
      identity: stagedSkills,
      treeDigest: operation.incomingSkillsTreeDigest,
    },
  }
  const databaseRef = proofPublicationRefV3(operation, 'restore-database-file', 30)
  const configRef = proofPublicationRefV3(operation, 'restore-config-file', 31)
  const skillsRef = proofPublicationRefV3(operation, 'restore-skills-root', 32)
  const dbExchange: RestoreDatabaseExchangeV3Decoded =
    live.sqlite.database.kind === 'absent'
      ? {
          mode: 'no-replace',
          publication: databaseRef,
          publishedIdentity: stagedDatabase,
          displacedIdentity: null,
        }
      : {
          mode: 'replace',
          publication: databaseRef,
          publishedIdentity: stagedDatabase,
          displacedIdentity: live.sqlite.database.identity,
        }
  const configExchange: RestoreConfigExchangeV3<ArtifactEntryIdentityV3> =
    configDisposition === 'preserve'
      ? {
          mode: 'preserve',
          publication: null,
          publishedIdentity: null,
          displacedIdentity: null,
        }
      : live.config.kind === 'absent'
        ? {
            mode: 'no-replace',
            publication: configRef,
            publishedIdentity: stagedConfig,
            displacedIdentity: null,
          }
        : {
            mode: 'replace',
            publication: configRef,
            publishedIdentity: stagedConfig,
            displacedIdentity: live.config.identity,
          }
  const skillsExchange: RestoreSkillsExchangeV3<ArtifactEntryIdentityV3> =
    live.skills.kind === 'absent'
      ? {
          mode: 'no-replace',
          publication: skillsRef,
          publishedIdentity: stagedSkills,
          displacedIdentity: null,
        }
      : {
          mode: 'replace',
          publication: skillsRef,
          publishedIdentity: stagedSkills,
          displacedIdentity: live.skills.identity,
        }
  const migration: RestoreDatabaseMigrationV3Decoded = options.noMigrate
    ? {
        disposition: 'skipped-no-migrate',
        databaseIdentity: stagedDatabase,
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrationDigest: null,
      }
    : {
        disposition: 'applied',
        databaseIdentity: stagedDatabase,
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrationDigest: proofDigestV3('migration'),
      }
  const sqlitePublicationRef: RestoreSqlitePublicationRefV3 = {
    publicationId: operation.restoreOperationId,
    revision: 7,
    frameDigest: proofDigestV3('sqlite-publication-frame-placeholder'),
    operationDigest,
  }
  const displacedCleanup = (
    presenceValue: EntryPresenceV3Decoded,
  ): DisplacedCleanupV3<ArtifactEntryIdentityV3> =>
    presenceValue.kind === 'absent'
      ? { kind: 'not-applicable' }
      : { kind: 'removed', displacedIdentity: presenceValue.identity }
  const sidecarCleanup = (
    presenceValue: EntryPresenceV3Decoded,
    label: string,
  ): RestoreGenerationCleanupV3Decoded['walRemoval'] =>
    presenceValue.kind === 'absent'
      ? { kind: 'not-applicable' }
      : {
          kind: 'removed',
          removedIdentity: presenceValue.identity,
          parentFsyncFence: proofDigestV3(label),
        }
  const provisional: RestoreGenerationCompleteMarkerV3Decoded = {
    schemaVersion: 3,
    revision: 7,
    operation,
    options,
    optionsDigest: operation.optionsDigest,
    phase: 'complete',
    staged,
    safety: {
      restoreOperationId: operation.restoreOperationId,
      live,
      capture,
    },
    sqlitePublicationRef,
    dbExchange,
    fsExchange: {
      config: configExchange,
      skills: skillsExchange,
    },
    migration,
    identityBarrier: {
      databaseIdentity: stagedDatabase,
      config:
        configDisposition === 'preserve'
          ? live.config
          : {
              kind: 'present',
              identity: stagedConfig,
              digest: operation.incomingConfigDigest ?? proofDigestV3('never'),
            },
      skillsIdentity: stagedSkills,
      verifiedPublicationRefs:
        configDisposition === 'preserve'
          ? [databaseRef, skillsRef]
          : [databaseRef, configRef, skillsRef],
      sqlitePublicationRef,
      observationFence: proofDigestV3('barrier'),
    },
    cleanup: {
      database: displacedCleanup(live.sqlite.database),
      config:
        configDisposition === 'preserve'
          ? { kind: 'not-applicable' }
          : displacedCleanup(live.config),
      skills: displacedCleanup(live.skills),
      walRemoval: sidecarCleanup(live.sqlite.wal, 'wal-parent-fsync'),
      shmRemoval: sidecarCleanup(live.sqlite.shm, 'shm-parent-fsync'),
      cleanupPublicationRefs:
        configDisposition === 'preserve'
          ? [databaseRef, skillsRef]
          : [databaseRef, configRef, skillsRef],
      observationFence: proofDigestV3('cleanup'),
    },
  }
  if (
    live.sqlite.database.kind !== 'present' ||
    live.sqlite.wal.kind !== 'present' ||
    live.sqlite.shm.kind !== 'present'
  ) {
    return provisional
  }
  const finalSqliteRef = restoreSqlitePublicationRefFromRecordV3(
    proofSqlitePublicationV3(provisional, 'db-published'),
  )
  return {
    ...provisional,
    sqlitePublicationRef: finalSqliteRef,
    identityBarrier: {
      ...provisional.identityBarrier,
      sqlitePublicationRef: finalSqliteRef,
    },
  }
}

function markerAtPhaseV3(
  complete: RestoreGenerationCompleteMarkerV3Decoded,
  phase:
    | 'staging'
    | 'safety-snapshotted'
    | 'db-swapped'
    | 'fs-swapped'
    | 'db-migrated'
    | 'identity-verified'
    | 'complete',
): RestoreGenerationMarkerV3Decoded {
  const sqliteDeclarationAnchor = restoreSqlitePublicationRefFromRecordV3(
    proofDeclaredSqlitePublicationV3(complete),
  )
  const common = {
    schemaVersion: 3 as const,
    revision: complete.revision,
    operation: complete.operation,
    options: complete.options,
    optionsDigest: complete.optionsDigest,
    staged: complete.staged,
  }
  switch (phase) {
    case 'staging':
      return {
        ...common,
        phase,
        safety: null,
        sqlitePublicationRef: null,
        dbExchange: null,
        fsExchange: null,
        migration: null,
        identityBarrier: null,
        cleanup: null,
      }
    case 'safety-snapshotted':
      return {
        ...common,
        phase,
        safety: complete.safety,
        sqlitePublicationRef: sqliteDeclarationAnchor,
        dbExchange: null,
        fsExchange: null,
        migration: null,
        identityBarrier: null,
        cleanup: null,
      }
    case 'db-swapped':
      return {
        ...common,
        phase,
        safety: complete.safety,
        sqlitePublicationRef: complete.sqlitePublicationRef,
        dbExchange: complete.dbExchange,
        fsExchange: null,
        migration: null,
        identityBarrier: null,
        cleanup: null,
      }
    case 'fs-swapped':
      return {
        ...common,
        phase,
        safety: complete.safety,
        sqlitePublicationRef: complete.sqlitePublicationRef,
        dbExchange: complete.dbExchange,
        fsExchange: complete.fsExchange,
        migration: null,
        identityBarrier: null,
        cleanup: null,
      }
    case 'db-migrated':
      return {
        ...common,
        phase,
        safety: complete.safety,
        sqlitePublicationRef: complete.sqlitePublicationRef,
        dbExchange: complete.dbExchange,
        fsExchange: complete.fsExchange,
        migration: complete.migration,
        identityBarrier: null,
        cleanup: null,
      }
    case 'identity-verified':
      return {
        ...common,
        phase,
        safety: complete.safety,
        sqlitePublicationRef: complete.sqlitePublicationRef,
        dbExchange: complete.dbExchange,
        fsExchange: complete.fsExchange,
        migration: complete.migration,
        identityBarrier: complete.identityBarrier,
        cleanup: null,
      }
    case 'complete':
      return complete
  }
}

function proofDeclaredSqlitePublicationV3(
  complete: RestoreGenerationCompleteMarkerV3Decoded,
): Extract<RestoreSqlitePublicationV3Decoded, { readonly phase: 'declared' }> {
  const initial = (
    presence: EntryPresenceV3Decoded,
  ): InitialSidecarRemovalV3<ArtifactEntryIdentityV3> =>
    presence.kind === 'absent'
      ? { kind: 'not-applicable' }
      : { kind: 'pending', expectedIdentity: presence.identity }
  return {
    schemaVersion: 3,
    publicationId: complete.operation.restoreOperationId,
    revision: 1,
    previousRevision: null,
    previousFrameDigest: null,
    operation: complete.operation,
    operationDigest: digestArtifactFsOperationIdentityV3(complete.operation),
    stagedDatabaseIdentity: complete.staged.sqlite.database.identity,
    liveBefore: complete.safety.live.sqlite,
    phase: 'declared',
    wal: initial(complete.safety.live.sqlite.wal),
    shm: initial(complete.safety.live.sqlite.shm),
    database: null,
    repairId: null,
  }
}

function proofSqlitePublicationV3(
  complete: RestoreGenerationCompleteMarkerV3Decoded,
  phase:
    | 'declared'
    | 'wal-removing'
    | 'wal-settled'
    | 'shm-removing'
    | 'sidecars-settled'
    | 'db-publishing'
    | 'db-published',
): RestoreSqlitePublicationV3Decoded {
  if (phase === 'declared') return proofDeclaredSqlitePublicationV3(complete)
  const live = complete.safety.live.sqlite
  if (
    live.wal.kind !== 'present' ||
    live.shm.kind !== 'present' ||
    live.database.kind !== 'present'
  ) {
    throw new Error('proof-sqlite-publication-requires-present-live-targets')
  }
  const walPending: SidecarRemovalV3Decoded = {
    kind: 'pending',
    expectedIdentity: live.wal.identity,
  }
  const walRemoving: SidecarRemovalV3Decoded = {
    kind: 'removing',
    expectedIdentity: live.wal.identity,
    intentRevision: 2,
  }
  const walRemoved: SidecarRemovalV3Decoded = {
    kind: 'removed',
    expectedIdentity: live.wal.identity,
    removedIdentity: live.wal.identity,
    intentRevision: 2,
    parentFsyncFence: proofDigestV3('wal-fsync'),
  }
  const shmPending: SidecarRemovalV3Decoded = {
    kind: 'pending',
    expectedIdentity: live.shm.identity,
  }
  const shmRemoving: SidecarRemovalV3Decoded = {
    kind: 'removing',
    expectedIdentity: live.shm.identity,
    intentRevision: 4,
  }
  const shmRemoved: SidecarRemovalV3Decoded = {
    kind: 'removed',
    expectedIdentity: live.shm.identity,
    removedIdentity: live.shm.identity,
    intentRevision: 4,
    parentFsyncFence: proofDigestV3('shm-fsync'),
  }
  const revisionByPhase = {
    declared: 1,
    'wal-removing': 2,
    'wal-settled': 3,
    'shm-removing': 4,
    'sidecars-settled': 5,
    'db-publishing': 6,
    'db-published': 7,
  } as const
  const previousPhaseByPhase = {
    'wal-removing': 'declared',
    'wal-settled': 'wal-removing',
    'shm-removing': 'wal-settled',
    'sidecars-settled': 'shm-removing',
    'db-publishing': 'sidecars-settled',
    'db-published': 'db-publishing',
  } as const
  const previousPhase = previousPhaseByPhase[phase]
  const previous = proofSqlitePublicationV3(complete, previousPhase)
  const base = {
    schemaVersion: 3 as const,
    publicationId: complete.operation.restoreOperationId,
    revision: revisionByPhase[phase],
    previousRevision: previous.revision,
    previousFrameDigest: digestRestoreSqlitePublicationFrameV3(previous),
    operation: complete.operation,
    operationDigest: digestArtifactFsOperationIdentityV3(complete.operation),
    stagedDatabaseIdentity: complete.staged.sqlite.database.identity,
    liveBefore: live,
  }
  switch (phase) {
    case 'wal-removing':
      return {
        ...base,
        phase,
        wal: walRemoving,
        shm: shmPending,
        database: null,
        repairId: null,
      }
    case 'wal-settled':
      return {
        ...base,
        phase,
        wal: walRemoved,
        shm: shmPending,
        database: null,
        repairId: null,
      }
    case 'shm-removing':
      return {
        ...base,
        phase,
        wal: walRemoved,
        shm: shmRemoving,
        database: null,
        repairId: null,
      }
    case 'sidecars-settled':
      return {
        ...base,
        phase,
        wal: walRemoved,
        shm: shmRemoved,
        database: null,
        repairId: null,
      }
    case 'db-publishing':
      return {
        ...base,
        phase,
        wal: walRemoved,
        shm: shmRemoved,
        database: null,
        databasePublication: complete.dbExchange.publication,
        repairId: null,
      }
    case 'db-published':
      return {
        ...base,
        phase,
        wal: walRemoved,
        shm: shmRemoved,
        database: complete.dbExchange,
        repairId: null,
      }
  }
}

function expectProofFailureV3(label: string, action: () => unknown): void {
  let failed = false
  try {
    action()
  } catch {
    failed = true
  }
  if (!failed) throw new Error(`expected-proof-failure:${label}`)
}

async function runWalWriterChildV3(directory: string, rowCount: number): Promise<never> {
  mkdirSync(directory, { recursive: true })
  const database = new Database(join(directory, 'db.sqlite'))
  database.exec('PRAGMA journal_mode=WAL')
  database.exec('PRAGMA wal_autocheckpoint=0')
  database.exec('CREATE TABLE proof_rows(id INTEGER PRIMARY KEY)')
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const insert = database.prepare('INSERT INTO proof_rows(id) VALUES (?)')
  database.transaction(() => {
    for (let id = 1; id <= rowCount; id += 1) insert.run(id)
  })()
  if (!existsSync(join(directory, 'db.sqlite-wal'))) {
    throw new Error('wal-writer-did-not-create-sidecar')
  }
  writeFileSync(join(directory, 'ready'), String(rowCount), 'utf8')
  process.stdout.write('ready\n')
  return await new Promise<never>(() => undefined)
}

async function spawnKilledWalGenerationV3(directory: string, rowCount: number): Promise<void> {
  const child = Bun.spawn(
    [Bun.argv[0], import.meta.path, 'wal-child', directory, String(rowCount)],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  const first = await reader.read()
  if (first.done || new TextDecoder().decode(first.value) !== 'ready\n') {
    child.kill(9)
    throw new Error('wal-child-not-ready')
  }
  child.kill(9)
  await child.exited
  if (
    !existsSync(join(directory, 'db.sqlite-wal')) ||
    statSync(join(directory, 'db.sqlite-wal')).size === 0
  ) {
    throw new Error('killed-wal-generation-missing')
  }
}

function fsyncDirectoryV3(directory: string): void {
  const descriptor = openSync(directory, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

async function proveRealWalGenerationV3(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rfc235-v21-wal-'))
  const incoming = join(root, 'incoming')
  const staged = join(root, 'staged')
  const live = join(root, 'live')
  const safety = join(root, 'safety')
  const displaced = join(root, 'displaced.sqlite')
  try {
    await spawnKilledWalGenerationV3(incoming, 5)
    mkdirSync(staged)
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(incoming, `db.sqlite${suffix}`)
      if (existsSync(source)) copyFileSync(source, join(staged, `db.sqlite${suffix}`))
    }

    const stagedDatabase = new Database(join(staged, 'db.sqlite'))
    const stagedCount = stagedDatabase.query('SELECT count(*) AS count FROM proof_rows').get() as {
      count: number
    }
    if (stagedCount.count !== 5) throw new Error('incoming-wal-rows-lost')
    stagedDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    stagedDatabase.close()
    for (const suffix of ['-wal', '-shm']) {
      const path = join(staged, `db.sqlite${suffix}`)
      if (existsSync(path)) unlinkSync(path)
    }
    fsyncDirectoryV3(staged)

    await spawnKilledWalGenerationV3(live, 9)
    mkdirSync(safety)
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(live, `db.sqlite${suffix}`)
      if (existsSync(source)) copyFileSync(source, join(safety, `db.sqlite${suffix}`))
    }
    fsyncDirectoryV3(safety)

    for (const suffix of ['-wal', '-shm']) {
      const sidecar = join(live, `db.sqlite${suffix}`)
      if (existsSync(sidecar)) {
        unlinkSync(sidecar)
        fsyncDirectoryV3(live)
      }
    }
    renameSync(join(live, 'db.sqlite'), displaced)
    renameSync(join(staged, 'db.sqlite'), join(live, 'db.sqlite'))
    fsyncDirectoryV3(live)

    const restored = new Database(join(live, 'db.sqlite'))
    const restoredCount = restored.query('SELECT count(*) AS count FROM proof_rows').get() as {
      count: number
    }
    restored.close()
    if (restoredCount.count !== 5) throw new Error('stale-live-wal-replayed')
    if (!existsSync(displaced)) throw new Error('displaced-database-lost')

    const safetyDatabase = new Database(join(safety, 'db.sqlite'))
    const safetyCount = safetyDatabase.query('SELECT count(*) AS count FROM proof_rows').get() as {
      count: number
    }
    safetyDatabase.close()
    if (safetyCount.count !== 9) throw new Error('safety-wal-generation-incomplete')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runNormativeProofV3(): Promise<void> {
  const phases = [
    'staging',
    'safety-snapshotted',
    'db-swapped',
    'fs-swapped',
    'db-migrated',
    'identity-verified',
    'complete',
  ] as const
  const capturedPresent = proofCompleteMarkerV3(
    { noMigrate: false, noSafetyBackup: false, skipIntegrityCheck: false },
    'present',
  )
  const capturedAbsent = proofCompleteMarkerV3(
    { noMigrate: true, noSafetyBackup: false, skipIntegrityCheck: true },
    'absent',
  )
  const skippedPresent = proofCompleteMarkerV3(
    { noMigrate: true, noSafetyBackup: true, skipIntegrityCheck: false },
    'present',
  )
  const skippedAbsent = proofCompleteMarkerV3(
    { noMigrate: false, noSafetyBackup: true, skipIntegrityCheck: true },
    'absent',
  )
  const preservedPresent = proofCompleteMarkerV3(
    { noMigrate: false, noSafetyBackup: false, skipIntegrityCheck: true },
    'present',
    'preserve',
  )
  const preservedAbsent = proofCompleteMarkerV3(
    { noMigrate: true, noSafetyBackup: true, skipIntegrityCheck: false },
    'absent',
    'preserve',
  )
  const databasePresentSkillsAbsent = proofCompleteMarkerV3(
    { noMigrate: false, noSafetyBackup: false, skipIntegrityCheck: false },
    { database: 'present', config: 'absent', skills: 'absent' },
  )
  const databaseAbsentSkillsPresent = proofCompleteMarkerV3(
    { noMigrate: true, noSafetyBackup: true, skipIntegrityCheck: true },
    { database: 'absent', config: 'present', skills: 'present' },
  )
  const notRequiredMigration: RestoreGenerationCompleteMarkerV3Decoded = {
    ...capturedPresent,
    migration: {
      disposition: 'not-required',
      databaseIdentity: capturedPresent.dbExchange.publishedIdentity,
      fromSchemaVersion: 2,
      toSchemaVersion: 2,
      migrationDigest: null,
    },
  }
  const completeVariants = [
    capturedPresent,
    capturedAbsent,
    skippedPresent,
    skippedAbsent,
    preservedPresent,
    preservedAbsent,
    databasePresentSkillsAbsent,
    databaseAbsentSkillsPresent,
    notRequiredMigration,
  ] as const
  for (const complete of completeVariants) {
    for (const phase of phases) {
      const marker = markerAtPhaseV3(complete, phase)
      const wire = encodeRestoreGenerationMarkerV3(marker)
      const decoded = RestoreGenerationMarkerV3Schema.parse(wire)
      if (
        decoded.phase !== phase ||
        decoded.staged.sqlite.database.identity.dev <= 9_007_199_254_740_991n
      ) {
        throw new Error(`marker-round-trip-failed:${phase}`)
      }
      if (complete !== capturedPresent) continue
      expectProofFailureV3(`marker-top-extra:${phase}`, () =>
        RestoreGenerationMarkerV3WireSchema.parse({
          ...wire,
          unexpected: true,
        }),
      )
      expectProofFailureV3(`marker-nested-extra:${phase}`, () =>
        RestoreGenerationMarkerV3WireSchema.parse({
          ...wire,
          staged: { ...wire.staged, unexpected: true },
        }),
      )
      expectProofFailureV3(`marker-unsafe-revision:${phase}`, () =>
        RestoreGenerationMarkerV3WireSchema.parse({
          ...wire,
          revision: Number.MAX_SAFE_INTEGER + 1,
        }),
      )
      expectProofFailureV3(`marker-decoded-identity-on-wire:${phase}`, () =>
        RestoreGenerationMarkerV3WireSchema.parse({
          ...wire,
          staged: {
            ...wire.staged,
            sqlite: {
              ...wire.staged.sqlite,
              database: {
                ...wire.staged.sqlite.database,
                identity: capturedPresent.staged.sqlite.database.identity,
              },
            },
          },
        }),
      )
      if (wire.sqlitePublicationRef !== null) {
        expectProofFailureV3(`marker-foreign-ref:${phase}`, () =>
          RestoreGenerationMarkerV3WireSchema.parse({
            ...wire,
            sqlitePublicationRef: {
              ...wire.sqlitePublicationRef,
              operationDigest: proofDigestV3(`foreign-ref-${phase}`),
            },
          }),
        )
      }
      switch (phase) {
        case 'staging':
          expectProofFailureV3('marker-prefix-suffix:staging', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              safety: encodeRestoreSafetyGenerationV3(capturedPresent.safety),
            }),
          )
          break
        case 'safety-snapshotted':
          expectProofFailureV3('marker-prefix-suffix:safety', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              dbExchange: encodeRestoreDatabaseExchangeV3(capturedPresent.dbExchange),
            }),
          )
          break
        case 'db-swapped':
          expectProofFailureV3('marker-prefix-suffix:db', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              fsExchange: encodeRestoreFsExchangeV3(capturedPresent.fsExchange),
            }),
          )
          break
        case 'fs-swapped':
          expectProofFailureV3('marker-prefix-suffix:fs', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              migration: encodeRestoreDatabaseMigrationV3(capturedPresent.migration),
            }),
          )
          break
        case 'db-migrated':
          expectProofFailureV3('marker-prefix-suffix:migration', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              identityBarrier: encodeRestoreIdentityBarrierV3(capturedPresent.identityBarrier),
            }),
          )
          break
        case 'identity-verified':
          expectProofFailureV3('marker-prefix-suffix:barrier', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              cleanup: encodeRestoreGenerationCleanupV3(capturedPresent.cleanup),
            }),
          )
          break
        case 'complete':
          expectProofFailureV3('marker-prefix-suffix:complete', () =>
            RestoreGenerationMarkerV3WireSchema.parse({
              ...wire,
              cleanup: null,
            }),
          )
          break
      }
    }
  }

  const captured = capturedPresent
  const declaredSqliteWire = RestoreSqlitePublicationV3Codec.encode(
    proofSqlitePublicationV3(captured, 'declared'),
  )
  expectProofFailureV3('declared-sidecar-already-removed', () =>
    RestoreSqlitePublicationV3WireSchema.parse({
      ...declaredSqliteWire,
      wal: {
        kind: 'removed',
        expectedIdentity: encodeArtifactEntryIdentityV3(proofIdentityV3(5)),
        removedIdentity: encodeArtifactEntryIdentityV3(proofIdentityV3(5)),
        intentRevision: 1,
        parentFsyncFence: proofDigestV3('invalid-declared-removal'),
      },
    }),
  )

  const absentDeclaredSqlite: RestoreSqlitePublicationV3Decoded = {
    schemaVersion: 3,
    publicationId: skippedAbsent.operation.restoreOperationId,
    revision: 1,
    previousRevision: null,
    previousFrameDigest: null,
    operation: skippedAbsent.operation,
    operationDigest: digestArtifactFsOperationIdentityV3(skippedAbsent.operation),
    stagedDatabaseIdentity: skippedAbsent.staged.sqlite.database.identity,
    liveBefore: skippedAbsent.safety.live.sqlite,
    phase: 'declared',
    wal: { kind: 'not-applicable' },
    shm: { kind: 'not-applicable' },
    database: null,
    repairId: null,
  }
  const absentDeclaredSqliteWire = RestoreSqlitePublicationV3Codec.encode(absentDeclaredSqlite)
  expectProofFailureV3('absent-sidecar-pending', () =>
    RestoreSqlitePublicationV3WireSchema.parse({
      ...absentDeclaredSqliteWire,
      wal: {
        kind: 'pending',
        expectedIdentity: encodeArtifactEntryIdentityV3(proofIdentityV3(5)),
      },
    }),
  )

  const sqlitePhases = [
    'declared',
    'wal-removing',
    'wal-settled',
    'shm-removing',
    'sidecars-settled',
    'db-publishing',
    'db-published',
  ] as const
  const sqliteChain = sqlitePhases.map((phase) => proofSqlitePublicationV3(captured, phase))
  for (const [index, phase] of sqlitePhases.entries()) {
    const record = sqliteChain[index]!
    const wire = RestoreSqlitePublicationV3Codec.encode(record)
    const decoded = RestoreSqlitePublicationV3Schema.parse(wire)
    if (decoded.phase !== phase) throw new Error(`sqlite-publication-round-trip:${phase}`)
    if (index > 0) {
      assertRestoreSqlitePublicationTransitionV3(sqliteChain[index - 1]!, record)
    }
  }
  const declaredSqlite = sqliteChain[0]!
  const publishedSqlite = sqliteChain[sqliteChain.length - 1]!
  if (publishedSqlite.phase !== 'db-published') {
    throw new Error('published-sqlite-proof-must-be-db-published')
  }
  const declarationAnchor = restoreSqlitePublicationRefFromRecordV3(declaredSqlite)
  const publishedCheckpoint = restoreSqlitePublicationRefFromRecordV3(publishedSqlite)
  const latestFromDeclaration = latestRestoreSqlitePublicationDescendantV3(
    declarationAnchor,
    sqliteChain,
  )
  if (latestFromDeclaration.phase !== 'db-published') {
    throw new Error('sqlite-latest-descendant-not-published')
  }
  assertRestoreSqlitePublicationRefMatchesV3(
    declarationAnchor,
    declaredSqlite,
    captured.operation,
    captured.staged.sqlite.database.identity,
    'declared',
  )
  assertRestoreSqlitePublicationRefMatchesV3(
    publishedCheckpoint,
    publishedSqlite,
    captured.operation,
    captured.staged.sqlite.database.identity,
    'db-published',
  )
  expectProofFailureV3('sqlite-publication-revision', () =>
    assertRestoreSqlitePublicationRefMatchesV3(
      {
        ...publishedCheckpoint,
        revision: publishedCheckpoint.revision + 1,
      },
      publishedSqlite,
      captured.operation,
      captured.staged.sqlite.database.identity,
      'db-published',
    ),
  )
  const foreignSqliteOperation: RestoreOperationIdentityV3 = {
    ...captured.operation,
    archiveDigest: proofDigestV3('foreign-sqlite-archive'),
  }
  const foreignSqlitePublication: RestoreSqlitePublicationV3Decoded = {
    ...publishedSqlite,
    operation: foreignSqliteOperation,
    operationDigest: digestArtifactFsOperationIdentityV3(foreignSqliteOperation),
  }
  expectProofFailureV3('sqlite-publication-full-operation', () =>
    assertRestoreSqlitePublicationRefMatchesV3(
      restoreSqlitePublicationRefFromRecordV3(foreignSqlitePublication),
      foreignSqlitePublication,
      captured.operation,
      captured.staged.sqlite.database.identity,
      'db-published',
    ),
  )
  const foreignStagedDatabaseIdentity = proofIdentityV3(98)
  const foreignStagedSqlitePublication: RestoreSqlitePublicationV3Decoded = {
    ...publishedSqlite,
    stagedDatabaseIdentity: foreignStagedDatabaseIdentity,
    database: {
      ...publishedSqlite.database,
      publishedIdentity: foreignStagedDatabaseIdentity,
    },
  }
  expectProofFailureV3('sqlite-publication-staged-identity', () =>
    assertRestoreSqlitePublicationRefMatchesV3(
      restoreSqlitePublicationRefFromRecordV3(foreignStagedSqlitePublication),
      foreignStagedSqlitePublication,
      captured.operation,
      captured.staged.sqlite.database.identity,
      'db-published',
    ),
  )

  const dbPublishingSqlite = sqliteChain[5]
  if (dbPublishingSqlite.phase !== 'db-publishing') {
    throw new Error('sqlite-repair-proof-requires-db-publishing-prefix')
  }
  const sqliteRepairFromPublishing: RestoreSqlitePublicationV3Decoded = {
    schemaVersion: 3,
    publicationId: dbPublishingSqlite.publicationId,
    revision: dbPublishingSqlite.revision + 1,
    previousRevision: dbPublishingSqlite.revision,
    previousFrameDigest: digestRestoreSqlitePublicationFrameV3(dbPublishingSqlite),
    operation: dbPublishingSqlite.operation,
    operationDigest: dbPublishingSqlite.operationDigest,
    stagedDatabaseIdentity: dbPublishingSqlite.stagedDatabaseIdentity,
    liveBefore: dbPublishingSqlite.liveBefore,
    phase: 'repair-required',
    forensic: sqliteForensicFromRecordV3(dbPublishingSqlite),
    repairId: 'sqlite-repair-after-publishing',
  }
  assertRestoreSqlitePublicationTransitionV3(dbPublishingSqlite, sqliteRepairFromPublishing)
  const sqliteRepairWire = RestoreSqlitePublicationV3Codec.encode(sqliteRepairFromPublishing)
  if (
    sqliteRepairWire.phase !== 'repair-required' ||
    sqliteRepairWire.forensic.fromPhase !== 'db-publishing' ||
    sqliteRepairFromPublishing.phase !== 'repair-required' ||
    sqliteRepairFromPublishing.forensic.fromPhase !== 'db-publishing'
  ) {
    throw new Error('sqlite-repair-wire-lost-db-publishing-discriminant')
  }
  RestoreSqlitePublicationV3Schema.parse(sqliteRepairWire)
  const latestRepairFromDeclaration = latestRestoreSqlitePublicationDescendantV3(
    declarationAnchor,
    [...sqliteChain.slice(0, 6), sqliteRepairFromPublishing],
  )
  if (latestRepairFromDeclaration.phase !== 'repair-required') {
    throw new Error('sqlite-latest-descendant-did-not-retain-repair')
  }
  assertRestoreSqlitePublicationRefMatchesV3(
    restoreSqlitePublicationRefFromRecordV3(sqliteRepairFromPublishing),
    sqliteRepairFromPublishing,
    captured.operation,
    captured.staged.sqlite.database.identity,
    'repair-required',
  )
  expectProofFailureV3('sqlite-repair-cannot-drop-database-publication', () =>
    RestoreSqlitePublicationV3WireSchema.parse({
      ...sqliteRepairWire,
      forensic: {
        ...sqliteRepairWire.forensic,
        databasePublication: null,
      },
    }),
  )
  const foreignDatabasePublicationRef: ArtifactPublicationReceiptRefV3 = {
    ...dbPublishingSqlite.databasePublication,
    frameDigest: proofDigestV3('foreign-database-publication-frame'),
  }
  const sqliteRepairWithForeignPublication: RestoreSqlitePublicationV3Decoded = {
    ...sqliteRepairFromPublishing,
    forensic: {
      ...sqliteRepairFromPublishing.forensic,
      databasePublication: foreignDatabasePublicationRef,
    },
  }
  expectProofFailureV3('sqlite-repair-cannot-rewrite-database-publication', () =>
    assertRestoreSqlitePublicationTransitionV3(
      dbPublishingSqlite,
      sqliteRepairWithForeignPublication,
    ),
  )
  const walSettledSqlite = sqliteChain[2]
  if (walSettledSqlite.phase !== 'wal-settled' || walSettledSqlite.wal.kind !== 'removed') {
    throw new Error('sqlite-sidecar-repair-proof-requires-removed-wal')
  }
  const sidecarRepair: RestoreSqlitePublicationV3Decoded = {
    schemaVersion: 3,
    publicationId: walSettledSqlite.publicationId,
    revision: walSettledSqlite.revision + 1,
    previousRevision: walSettledSqlite.revision,
    previousFrameDigest: digestRestoreSqlitePublicationFrameV3(walSettledSqlite),
    operation: walSettledSqlite.operation,
    operationDigest: walSettledSqlite.operationDigest,
    stagedDatabaseIdentity: walSettledSqlite.stagedDatabaseIdentity,
    liveBefore: walSettledSqlite.liveBefore,
    phase: 'repair-required',
    forensic: sqliteForensicFromRecordV3(walSettledSqlite),
    repairId: 'sqlite-repair-after-wal',
  }
  assertRestoreSqlitePublicationTransitionV3(walSettledSqlite, sidecarRepair)
  const sidecarRepairWire = RestoreSqlitePublicationV3Codec.encode(sidecarRepair)
  if (
    sidecarRepairWire.phase !== 'repair-required' ||
    sidecarRepairWire.forensic.fromPhase !== 'wal-settled' ||
    sidecarRepairWire.forensic.wal.kind !== 'removed'
  ) {
    throw new Error('sqlite-repair-wire-lost-wal-settled-discriminant')
  }
  const removedWalWire = sidecarRepairWire.forensic.wal
  expectProofFailureV3('sqlite-repair-cannot-drop-sidecar-intent-revision', () =>
    RestoreSqlitePublicationV3WireSchema.parse({
      ...sidecarRepairWire,
      forensic: {
        ...sidecarRepairWire.forensic,
        wal: {
          kind: 'removed',
          expectedIdentity: removedWalWire.expectedIdentity,
          removedIdentity: removedWalWire.removedIdentity,
          parentFsyncFence: removedWalWire.parentFsyncFence,
        },
      },
    }),
  )

  const completeWire = encodeRestoreGenerationCompleteMarkerV3(captured)
  for (const option of ['noMigrate', 'noSafetyBackup', 'skipIntegrityCheck'] as const) {
    expectProofFailureV3(`changed-${option}-same-digest`, () =>
      RestoreGenerationMarkerV3WireSchema.parse({
        ...completeWire,
        options: { ...completeWire.options, [option]: true },
      }),
    )
  }
  expectProofFailureV3('dishonest-migration-disposition', () =>
    RestoreGenerationMarkerV3WireSchema.parse({
      ...completeWire,
      migration: {
        ...completeWire.migration,
        disposition: 'skipped-no-migrate',
        migrationDigest: null,
      },
    }),
  )
  expectProofFailureV3('foreign-published-database', () =>
    RestoreGenerationMarkerV3WireSchema.parse({
      ...completeWire,
      dbExchange: {
        ...completeWire.dbExchange,
        publishedIdentity: encodeArtifactEntryIdentityV3(proofIdentityV3(99)),
      },
    }),
  )

  const locator = artifactPublicationLocatorFromRefV3(captured.dbExchange.publication)
  assertTrustedDurableRootStorageKeyV3(locator.key)
  expectProofFailureV3('invalid-publication-key-segment', () =>
    artifactPublicationLocatorFromRefV3({
      ...captured.dbExchange.publication,
      receiptId: '../foreign',
    }),
  )
  const forgedKey = {
    namespace: 'artifact-control-v3',
    rootKind: 'artifact-publication',
    rootId: captured.dbExchange.publication.receiptId,
    revision: captured.dbExchange.publication.revision,
    frameDigest: captured.dbExchange.publication.frameDigest,
  }
  expectProofFailureV3('forged-storage-key', () => assertTrustedDurableRootStorageKeyV3(forgedKey))
  if (captured.dbExchange.mode !== 'replace') {
    throw new Error('captured-present-proof-must-replace')
  }
  const validReceiptChain = proofArtifactPublicationChainV3({
    operation: captured.operation,
    receiptId: 'proof-database-publication',
    slotRole: 'restore-database-file',
    stagedIdentity: captured.dbExchange.publishedIdentity,
    stagedDigest: captured.operation.incomingDatabaseDigest,
    publicationMode: 'replace',
    expectedIdentity: captured.dbExchange.displacedIdentity,
  })
  const validReceipt = validReceiptChain[1]
  if (validReceipt.phase !== 'exchanged' || validReceipt.publicationMode !== 'replace') {
    throw new Error('valid-receipt-proof-must-be-exchanged-replace')
  }
  const validReceiptRef = artifactPublicationRefFromReceiptV3(validReceipt)
  const validReceiptExpected: ArtifactPublicationExpectedProjectionV3 = {
    requiredPhase: 'exchanged',
    publicationMode: 'replace',
    stagedIdentity: captured.dbExchange.publishedIdentity,
    stagedDigest: captured.operation.incomingDatabaseDigest,
    expectedIdentity: captured.dbExchange.displacedIdentity,
    publishedIdentity: captured.dbExchange.publishedIdentity,
    displacedIdentity: captured.dbExchange.displacedIdentity,
  }
  assertPublicationRefMatchesV3(
    validReceiptRef,
    validReceipt,
    captured.operation,
    'restore-database-file',
    validReceiptExpected,
  )
  expectProofFailureV3('foreign-receipt-revision', () =>
    assertPublicationRefMatchesV3(
      validReceiptRef,
      { ...validReceipt, revision: validReceipt.revision + 1 },
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  expectProofFailureV3('foreign-receipt-id', () =>
    assertPublicationRefMatchesV3(
      validReceiptRef,
      { ...validReceipt, receiptId: 'foreign-receipt' },
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  expectProofFailureV3('foreign-receipt-slot-role', () =>
    assertPublicationRefMatchesV3(
      validReceiptRef,
      { ...validReceipt, slotRole: 'restore-config-file' },
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  expectProofFailureV3('foreign-receipt-operation-digest', () =>
    assertPublicationRefMatchesV3(
      validReceiptRef,
      { ...validReceipt, operationDigest: proofDigestV3('foreign-operation') },
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const foreignReceiptOperation: RestoreOperationIdentityV3 = {
    ...captured.operation,
    incomingSkillsTreeDigest: proofDigestV3('foreign-skills-operation'),
  }
  expectProofFailureV3('foreign-receipt-full-operation', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3({
        ...validReceipt,
        operation: foreignReceiptOperation,
        operationDigest: digestArtifactFsOperationIdentityV3(foreignReceiptOperation),
      }),
      {
        ...validReceipt,
        operation: foreignReceiptOperation,
        operationDigest: digestArtifactFsOperationIdentityV3(foreignReceiptOperation),
      },
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const collidingForeignRef: ArtifactPublicationReceiptRefV3 = {
    ...validReceiptRef,
    operationDigest: proofDigestV3('colliding-foreign-ref'),
  }
  const collidingLocator = artifactPublicationLocatorFromRefV3(collidingForeignRef)
  if (
    collidingLocator.key.rootId !== validReceiptRef.receiptId ||
    collidingLocator.key.revision !== validReceiptRef.revision
  ) {
    throw new Error('collision-proof-must-address-same-revision')
  }
  expectProofFailureV3('same-segment-foreign-reference', () =>
    assertPublicationRefMatchesV3(
      collidingForeignRef,
      validReceipt,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )

  for (let index = 1; index < validReceiptChain.length; index += 1) {
    assertArtifactPublicationTransitionV3(validReceiptChain[index - 1]!, validReceiptChain[index]!)
  }
  const latestArtifactReceipt = latestArtifactPublicationDescendantV3(
    artifactPublicationRefFromReceiptV3(validReceiptChain[0]),
    validReceiptChain,
  )
  if (latestArtifactReceipt.phase !== 'cleanup-verified') {
    throw new Error('artifact-publication-latest-descendant-not-cleanup-verified')
  }
  const preparedReceipt = validReceiptChain[0]
  expectProofFailureV3('prepared-receipt-cannot-prove-exchange', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3(preparedReceipt),
      preparedReceipt,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const foreignProjectionIdentity = proofIdentityV3(103)
  const foreignStagedProjection: ArtifactPublicationReceiptV3 = {
    ...validReceipt,
    stagedIdentity: foreignProjectionIdentity,
    publishedIdentity: foreignProjectionIdentity,
  }
  expectProofFailureV3('foreign-staged-and-published-projection', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3(foreignStagedProjection),
      foreignStagedProjection,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const foreignDisplacedProjection: ArtifactPublicationReceiptV3 = {
    ...validReceipt,
    expectedIdentity: foreignProjectionIdentity,
    displacedIdentity: foreignProjectionIdentity,
  }
  expectProofFailureV3('foreign-expected-and-displaced-projection', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3(foreignDisplacedProjection),
      foreignDisplacedProjection,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const foreignDigestProjection: ArtifactPublicationReceiptV3 = {
    ...validReceipt,
    stagedDigest: proofDigestV3('foreign-staged-digest'),
  }
  expectProofFailureV3('foreign-staged-digest-projection', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3(foreignDigestProjection),
      foreignDigestProjection,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )
  const noReplaceProjection = proofArtifactPublicationChainV3({
    operation: captured.operation,
    receiptId: 'proof-wrong-mode-publication',
    slotRole: 'restore-database-file',
    stagedIdentity: captured.dbExchange.publishedIdentity,
    stagedDigest: captured.operation.incomingDatabaseDigest,
    publicationMode: 'no-replace',
    expectedIdentity: null,
  })[1]
  expectProofFailureV3('foreign-publication-mode-projection', () =>
    assertPublicationRefMatchesV3(
      artifactPublicationRefFromReceiptV3(noReplaceProjection),
      noReplaceProjection,
      captured.operation,
      'restore-database-file',
      validReceiptExpected,
    ),
  )

  const repairFromExchange: ArtifactPublicationReceiptV3 = {
    schemaVersion: 3,
    receiptId: validReceipt.receiptId,
    revision: validReceipt.revision + 1,
    previousRevision: validReceipt.revision,
    previousFrameDigest: digestArtifactPublicationFrameV3(validReceipt),
    operation: validReceipt.operation,
    operationDigest: validReceipt.operationDigest,
    slotRole: validReceipt.slotRole,
    stagedIdentity: validReceipt.stagedIdentity,
    stagedDigest: validReceipt.stagedDigest,
    phase: 'repair-required',
    repairFromPhase: 'exchanged',
    publicationMode: 'replace',
    expectedIdentity: validReceipt.expectedIdentity,
    publishedIdentity: validReceipt.publishedIdentity,
    displacedIdentity: validReceipt.displacedIdentity,
    cleanupVerifiedAt: null,
    repairId: 'artifact-repair-proof',
  }
  assertArtifactPublicationTransitionV3(validReceipt, repairFromExchange)
  ArtifactPublicationReceiptV3Schema.parse(encodeArtifactPublicationReceiptV3(repairFromExchange))
  const lossyRepairIdentity = proofIdentityV3(104)
  const lossyRepair: ArtifactPublicationReceiptV3 = {
    ...repairFromExchange,
    expectedIdentity: lossyRepairIdentity,
    displacedIdentity: lossyRepairIdentity,
  }
  expectProofFailureV3('artifact-repair-cannot-rewrite-known-identities', () =>
    assertArtifactPublicationTransitionV3(validReceipt, lossyRepair),
  )

  if (
    captured.staged.configDisposition.kind !== 'replace' ||
    captured.fsExchange.config.mode !== 'replace' ||
    captured.fsExchange.skills.mode !== 'replace'
  ) {
    throw new Error('captured-present-proof-must-replace-all-artifacts')
  }
  const databasePublicationChain = proofArtifactPublicationChainV3({
    operation: captured.operation,
    receiptId: 'bound-database-publication',
    slotRole: 'restore-database-file',
    stagedIdentity: captured.staged.sqlite.database.identity,
    stagedDigest: captured.staged.sqlite.database.digest,
    publicationMode: 'replace',
    expectedIdentity: captured.dbExchange.displacedIdentity,
  })
  const configPublicationChain = proofArtifactPublicationChainV3({
    operation: captured.operation,
    receiptId: 'bound-config-publication',
    slotRole: 'restore-config-file',
    stagedIdentity: captured.staged.configDisposition.stagedFileIdentity,
    stagedDigest: captured.staged.configDisposition.fileDigest,
    publicationMode: 'replace',
    expectedIdentity: captured.fsExchange.config.displacedIdentity,
  })
  const skillsPublicationChain = proofArtifactPublicationChainV3({
    operation: captured.operation,
    receiptId: 'bound-skills-publication',
    slotRole: 'restore-skills-root',
    stagedIdentity: captured.staged.skills.identity,
    stagedDigest: captured.staged.skills.treeDigest,
    publicationMode: 'replace',
    expectedIdentity: captured.fsExchange.skills.displacedIdentity,
  })
  const boundExchangeRefs = [
    artifactPublicationRefFromReceiptV3(databasePublicationChain[1]),
    artifactPublicationRefFromReceiptV3(configPublicationChain[1]),
    artifactPublicationRefFromReceiptV3(skillsPublicationChain[1]),
  ] as const
  const boundCleanupRefs = [
    artifactPublicationRefFromReceiptV3(databasePublicationChain[2]),
    artifactPublicationRefFromReceiptV3(configPublicationChain[2]),
    artifactPublicationRefFromReceiptV3(skillsPublicationChain[2]),
  ] as const
  const receiptBoundMarker: RestoreGenerationCompleteMarkerV3Decoded = {
    ...captured,
    dbExchange: {
      ...captured.dbExchange,
      publication: boundExchangeRefs[0],
    },
    fsExchange: {
      config: {
        ...captured.fsExchange.config,
        publication: boundExchangeRefs[1],
      },
      skills: {
        ...captured.fsExchange.skills,
        publication: boundExchangeRefs[2],
      },
    },
    identityBarrier: {
      ...captured.identityBarrier,
      verifiedPublicationRefs: boundExchangeRefs,
    },
    cleanup: {
      ...captured.cleanup,
      cleanupPublicationRefs: boundCleanupRefs,
    },
  }
  RestoreGenerationCompleteMarkerV3Schema.parse(
    encodeRestoreGenerationCompleteMarkerV3(receiptBoundMarker),
  )
  assertRestoreExchangePublicationReceiptsV3(receiptBoundMarker, 'identity-barrier', [
    databasePublicationChain[1],
    configPublicationChain[1],
    skillsPublicationChain[1],
  ])
  assertRestoreExchangePublicationReceiptsV3(receiptBoundMarker, 'cleanup', [
    databasePublicationChain[2],
    configPublicationChain[2],
    skillsPublicationChain[2],
  ])
  const alternateDatabaseReceipt: ArtifactPublicationReceiptV3 = {
    ...databasePublicationChain[1],
    receiptId: 'alternate-database-publication',
  }
  expectProofFailureV3('alternate-receipt-cannot-satisfy-marker-reference', () =>
    assertRestoreExchangePublicationReceiptsV3(receiptBoundMarker, 'identity-barrier', [
      alternateDatabaseReceipt,
      configPublicationChain[1],
      skillsPublicationChain[1],
    ]),
  )
  const duplicateReceiptMarker: RestoreGenerationCompleteMarkerV3Decoded = {
    ...receiptBoundMarker,
    identityBarrier: {
      ...receiptBoundMarker.identityBarrier,
      verifiedPublicationRefs: [
        boundExchangeRefs[0],
        {
          ...boundExchangeRefs[1],
          receiptId: boundExchangeRefs[0].receiptId,
        },
        boundExchangeRefs[2],
      ],
    },
  }
  expectProofFailureV3('receipt-id-cannot-be-reused-across-roles', () =>
    RestoreGenerationCompleteMarkerV3Schema.parse(
      encodeRestoreGenerationCompleteMarkerV3(duplicateReceiptMarker),
    ),
  )

  if (
    captured.safety.capture.kind !== 'captured' ||
    captured.safety.capture.sqlite.database.kind !== 'present' ||
    captured.safety.capture.sqlite.wal.kind !== 'present' ||
    captured.safety.capture.sqlite.shm.kind !== 'present' ||
    captured.safety.capture.config.kind !== 'present' ||
    captured.safety.capture.skills.kind !== 'present'
  ) {
    throw new Error('captured-present-proof-must-have-complete-safety-generation')
  }
  const safetyEntries: readonly {
    readonly role: RestoreArtifactFsSlotRoleV3
    readonly identity: ArtifactEntryIdentityV3
    readonly digest: string
  }[] = [
    {
      role: 'restore-safety-database-file',
      identity: captured.safety.capture.sqlite.database.identity,
      digest: captured.safety.capture.sqlite.database.digest,
    },
    {
      role: 'restore-safety-database-wal',
      identity: captured.safety.capture.sqlite.wal.identity,
      digest: captured.safety.capture.sqlite.wal.digest,
    },
    {
      role: 'restore-safety-database-shm',
      identity: captured.safety.capture.sqlite.shm.identity,
      digest: captured.safety.capture.sqlite.shm.digest,
    },
    {
      role: 'restore-safety-config-file',
      identity: captured.safety.capture.config.identity,
      digest: captured.safety.capture.config.digest,
    },
    {
      role: 'restore-safety-skills-root',
      identity: captured.safety.capture.skills.identity,
      digest: captured.safety.capture.skills.digest,
    },
  ]
  const safetyPublicationChains = safetyEntries.map((entry, index) =>
    proofArtifactPublicationChainV3({
      operation: captured.operation,
      receiptId: `bound-safety-publication-${index + 1}`,
      slotRole: entry.role,
      stagedIdentity: entry.identity,
      stagedDigest: entry.digest,
      publicationMode: 'no-replace',
      expectedIdentity: null,
    }),
  )
  const safetyPublicationReceipts = safetyPublicationChains.map((chain) => chain[2])
  const safetyPublicationRefs = safetyPublicationReceipts.map(artifactPublicationRefFromReceiptV3)
  const safetyReceiptBoundMarker: RestoreGenerationCompleteMarkerV3Decoded = {
    ...captured,
    safety: {
      ...captured.safety,
      capture: {
        ...captured.safety.capture,
        publicationRefs: safetyPublicationRefs,
      },
    },
  }
  RestoreGenerationCompleteMarkerV3Schema.parse(
    encodeRestoreGenerationCompleteMarkerV3(safetyReceiptBoundMarker),
  )
  assertRestoreSafetyPublicationReceiptsV3(
    captured.operation,
    safetyReceiptBoundMarker.safety,
    safetyPublicationReceipts,
  )

  await proveRealWalGenerationV3()
  process.stdout.write(
    'rfc235-v21 normative restore proof: marker=7 variants=9 sqlite=7 artifact=lineage-bound repair=lossless wal=real ok\n',
  )
}

if (Bun.argv[2] === 'wal-child') {
  await runWalWriterChildV3(Bun.argv[3] ?? '', Number(Bun.argv[4] ?? '0'))
} else if (import.meta.main) {
  await runNormativeProofV3()
}
