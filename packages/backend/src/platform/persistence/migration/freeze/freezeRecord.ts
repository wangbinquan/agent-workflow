// RFC-626 §4.2: the durable record of a freeze. The plan step of an automatic upgrade freezes
// the old database once; the run step, and a process that is started again after it was killed,
// take that freeze over instead of copying and measuring the database a second time.
//
// Publication order is what makes a half-written freeze recognisable:
//   frozen copy written and flushed → freeze.json (atomic) → work copy → binding.json (atomic).
// A directory without freeze.json is an unfinished freeze and is cleared. A freeze.json without
// a matching binding.json means only the work copy has to be made again.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../../schema/canonical'
import type { SourceIdentityHighWater, SourcePreflight } from '../sourceTypes'
import { atomicSourceFile, flushSourceFile } from './artifacts'

export const FREEZE_RECORD_FILE = 'freeze.json'
/** The frozen copy of a file source; a database source has no file of its own. */
export const FROZEN_COPY_FILE = 'original.sqlite'

interface FreezeIdentity {
  readonly version: 1
  /** The watermark the reader of the old database reported for this freeze. */
  readonly watermark: string
  readonly sourceGenerationId: string
  /** Digest of the counted fingerprint, and of its catalog alone. */
  readonly fingerprintDigest: string
  readonly catalogDigest: string
  /**
   * The binding digest of the work copy made from this freeze (`binding.json` carries the
   * same value), or null when the source is already at the head and needs no work copy.
   */
  readonly bindingDigest: string | null
}
/** A file source: the frozen copy lies next to the record. */
export interface FileFreeze extends FreezeIdentity {
  readonly provider: 'sqlite'
  /** Content identity of the old database, taken from the frozen copy. */
  readonly content: string
  readonly copy: { readonly file: typeof FROZEN_COPY_FILE; readonly bytes: number }
  /** Rows whose foreign key dangled in the old database when it was frozen. */
  readonly foreignKeyViolations: number
}
/**
 * A database source: its freeze is a snapshot transaction that ends with the handle, so only
 * the identity and the cheap evidence it was confirmed at are kept. Reopening takes a new
 * snapshot and the reader decides whether the identity still holds.
 */
export interface DatabaseFreeze extends FreezeIdentity {
  readonly provider: 'postgresql'
  readonly tableRows: Readonly<Record<string, number>>
  readonly identityHighWater: readonly SourceIdentityHighWater[]
  /** What the reader remembered as its cheap evidence, when it reported one. */
  readonly evidence: string | null
}
export type FreezePayload = FileFreeze | DatabaseFreeze
export type FreezeRecord = FreezePayload & { readonly digest: string }

/** The part of a record every source has, read off the preflight of the old database. */
export function freezeIdentity(
  preflight: SourcePreflight,
  bindingDigest: string | null,
): FreezeIdentity {
  return {
    version: 1,
    watermark: preflight.watermark,
    sourceGenerationId: preflight.sourceGenerationId,
    fingerprintDigest: preflight.fingerprint.digest,
    catalogDigest: preflight.fingerprint.catalogDigest,
    bindingDigest,
  }
}
/** Whether a record is the record of the source as this preflight sees it. */
export function describesFreeze(record: FreezeRecord, preflight: SourcePreflight): boolean {
  return (
    record.watermark === preflight.watermark &&
    record.sourceGenerationId === preflight.sourceGenerationId &&
    record.fingerprintDigest === preflight.fingerprint.digest
  )
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** Null for no record, and for anything that is not a complete record this build wrote. */
export function readFreezeRecord(root: string): FreezeRecord | null {
  const path = join(root, FREEZE_RECORD_FILE)
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const { digest, ...payload } = parsed
  if (
    payload.version !== 1 ||
    digest !== digestSchemaContract(payload) ||
    !isText(payload.watermark) ||
    !isText(payload.sourceGenerationId) ||
    !isText(payload.fingerprintDigest) ||
    !isText(payload.catalogDigest) ||
    !(payload.bindingDigest === null || isText(payload.bindingDigest))
  )
    return null
  if (payload.provider === 'sqlite')
    return isText(payload.content) &&
      isObject(payload.copy) &&
      payload.copy.file === FROZEN_COPY_FILE &&
      isCount(payload.copy.bytes) &&
      isCount(payload.foreignKeyViolations)
      ? (parsed as unknown as FreezeRecord)
      : null
  if (payload.provider === 'postgresql')
    return isObject(payload.tableRows) &&
      Array.isArray(payload.identityHighWater) &&
      (payload.evidence === null || typeof payload.evidence === 'string')
      ? (parsed as unknown as FreezeRecord)
      : null
  return null
}

/**
 * Publishes the record of a completed freeze. A frozen copy is flushed first: the record must
 * never be durable ahead of the bytes it vouches for.
 */
export async function publishFreezeRecord(
  root: string,
  payload: FreezePayload,
): Promise<FreezeRecord> {
  if (payload.provider === 'sqlite') {
    await flushSourceFile(join(root, payload.copy.file))
    if (process.platform !== 'win32') {
      const directory = await open(root, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  }
  const record: FreezeRecord = { ...payload, digest: digestSchemaContract(payload) }
  await atomicSourceFile(join(root, FREEZE_RECORD_FILE), canonicalSchemaJson(record))
  return record
}

/**
 * Clears a freeze that cannot be taken over. The record goes first: if the process dies between
 * the two steps, what is left is a copy without a record, which the next entry clears — never a
 * record that vouches for a copy being replaced.
 */
export function discardFreezeRecord(root: string): void {
  if (!existsSync(root)) return
  rmSync(join(root, FREEZE_RECORD_FILE), { force: true })
  for (const entry of readdirSync(root))
    if (entry.startsWith(FROZEN_COPY_FILE) || entry.endsWith('.tmp'))
      rmSync(join(root, entry), { recursive: true, force: true })
}
