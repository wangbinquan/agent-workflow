// RFC-395 II-b R2: dormant v2 authority. Existing v1 runtime stays unchanged until A.
import {
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
import { canonicalSchemaJson, digestSchemaContract } from './schema/canonical'
import { unhandledDatabaseProvider, type DatabaseProvider } from './databaseProviders'

function databaseLocationKind(provider: DatabaseProvider): 'sqlite-file' | 'postgresql-target' {
  switch (provider) {
    case 'sqlite':
      return 'sqlite-file'
    case 'postgresql':
      return 'postgresql-target'
    default:
      return unhandledDatabaseProvider(provider)
  }
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const generationId = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
export const GenerationPointerV2PayloadSchema = z
  .object({
    version: z.literal(2),
    schemaEpoch: z.number().int().positive(),
    generationId,
    provider: z.enum(['sqlite', 'postgresql']),
    role: z.enum(['installed', 'converted', 'restored']),
    database: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sqlite-file'), relativePath: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('postgresql-target'), profileRef: z.string().min(1) }).strict(),
    ]),
    contractDigest: digest,
    planDigest: digest,
    operationId: z
      .string()
      .regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
      .nullable(),
    manifestDigest: digest.nullable(),
    activatedAt: z.number().int().nonnegative(),
    previous: z.object({ generationId, pointerDigest: digest }).strict().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role !== 'installed' && value.operationId === null)
      context.addIssue({
        code: 'custom',
        path: ['operationId'],
        message: 'converted/restored generation requires operationId',
      })
    if (databaseLocationKind(value.provider) !== value.database.kind)
      context.addIssue({
        code: 'custom',
        path: ['database'],
        message: 'database location must match provider',
      })
  })
const documentSchema = z.object({ payload: GenerationPointerV2PayloadSchema, digest }).strict()
export type GenerationPointerV2Payload = z.infer<typeof GenerationPointerV2PayloadSchema>
export type GenerationPointerV2 = z.infer<typeof documentSchema>
export type PointerCrashPoint = 'temp-written' | 'temp-synced' | 'renamed' | 'directory-synced'

export function parseGenerationPointerV2(text: string): GenerationPointerV2 {
  const document = documentSchema.parse(JSON.parse(text) as unknown)
  if (digestSchemaContract(document.payload) !== document.digest)
    throw new Error('generation-pointer-digest-mismatch')
  return document
}
/** Deliberately no missing-pointer or epoch-1 fallback in the runtime-facing API. */
export function readGenerationPointerV2(pointerPath: string): GenerationPointerV2 {
  return parseGenerationPointerV2(readFileSync(pointerPath, 'utf8'))
}
function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    // Preserve the existing pointer adapter's Windows filesystem limitation.
    // File flush + atomic rename still apply; directory handles are not supported there.
    if (process.platform !== 'win32') throw error
  }
}
export function replaceGenerationPointerBytes(input: {
  readonly pointerPath: string
  readonly bytes: Uint8Array
  readonly onCrashPoint?: (point: PointerCrashPoint) => void
}): void {
  const directory = dirname(input.pointerPath)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.database-generation-${crypto.randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(temporary, input.bytes)
    input.onCrashPoint?.('temp-written')
    const descriptor = openSync(temporary, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    input.onCrashPoint?.('temp-synced')
    renameSync(temporary, input.pointerPath)
    renamed = true
    input.onCrashPoint?.('renamed')
    syncDirectory(directory)
    input.onCrashPoint?.('directory-synced')
  } finally {
    if (!renamed && existsSync(temporary)) unlinkSync(temporary)
  }
}
export function writeGenerationPointerV2(input: {
  readonly pointerPath: string
  readonly payload: GenerationPointerV2Payload
  readonly onCrashPoint?: (point: PointerCrashPoint) => void
}): GenerationPointerV2 {
  const payload = GenerationPointerV2PayloadSchema.parse(input.payload)
  const document = { payload, digest: digestSchemaContract(payload) }
  replaceGenerationPointerBytes({ ...input, bytes: Buffer.from(canonicalSchemaJson(document)) })
  const written = readGenerationPointerV2(input.pointerPath)
  if (
    written.digest !== document.digest ||
    canonicalSchemaJson(written) !== canonicalSchemaJson(document)
  )
    throw new Error('generation-pointer-readback-mismatch')
  return written
}
/** Caller closes connections and obtains the durable marker before invoking this rollback primitive. */
export function restorePreviousPointerBytes(input: {
  readonly pointerPath: string
  readonly previousBytes: Uint8Array | null
  readonly firstLiveWriteAt: number | null
}): void {
  if (input.firstLiveWriteAt !== null) throw new Error('generation-rollback-after-first-write')
  if (input.previousBytes !== null) {
    replaceGenerationPointerBytes({ pointerPath: input.pointerPath, bytes: input.previousBytes })
  } else if (existsSync(input.pointerPath)) {
    unlinkSync(input.pointerPath)
    syncDirectory(dirname(input.pointerPath))
  }
}

/** Retain pointer bytes before activation so a failed move can restore exact authority. */
export function retainGenerationPointer(pointerPath: string, operationId: string): void {
  const retained = join(dirname(pointerPath), `.${operationId}-previous-pointer.json`)
  if (!existsSync(retained) && existsSync(pointerPath)) {
    writeFileSync(retained, readFileSync(pointerPath), { flag: 'wx' })
  }
}
export function restoreRetainedGenerationPointer(pointerPath: string, operationId: string): void {
  replaceGenerationPointerBytes({
    pointerPath,
    bytes: readFileSync(join(dirname(pointerPath), `.${operationId}-previous-pointer.json`)),
  })
}
