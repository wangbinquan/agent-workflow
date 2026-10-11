import { z } from 'zod'
import {
  ObservationTokenUsageSchema,
  type HistoricalNativeObservationIdentity,
  type HistoricalNativeObservationPage,
} from '@agent-workflow/shared'
import { isDeepStrictEqual } from 'node:util'
import { sha256Hex } from '@/util/hash'
import type { HistoricalNativeSourceProof } from '../application/ports/historicalNativeVersion'

const text = z.string().min(1),
  natural = z.string().regex(/^(0|[1-9]\d*)$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  counts = z.object({ sessions: natural, parts: natural, steps: natural }).strict()
const identity = z
  .object({
    kind: z.literal('historical-observed'),
    passId: digest,
    referenceId: text,
    nativeSource: digest,
    sourceGeneration: digest,
    rootSessionId: text,
  })
  .strict()
const pageSchema = z
  .object({
    identity,
    ordinal: natural,
    cursor: text,
    nextCursor: text.nullable(),
    previousDigest: digest,
    payloadDigest: digest,
    cumulativeDigest: digest,
    scanPositionBefore: natural,
    scanPositionAfter: natural,
    scannedRawRows: natural,
    counts,
    sessions: z.array(z.object({ id: text, parentSessionId: text.nullable() }).strict()),
    steps: z.array(
      z
        .object({
          id: text,
          parentSessionId: text.nullable(),
          stepId: text,
          occurredAt: time,
          usage: ObservationTokenUsageSchema,
          model: z.object({ provider: text, id: text }).strict().nullable(),
        })
        .strict(),
    ),
    issues: z.array(text),
    eof: z.object({ fingerprint: digest, counts }).strict().nullable(),
  })
  .strict()

export interface HistoricalNativePagePosition {
  readonly ordinal: string
  readonly digest: string
  readonly scanPosition: string
  readonly counts: HistoricalNativeObservationPage['counts']
  readonly eof: boolean
}

/** The existing reader's exact identity formula, without a current model or price lookup. */
export function originalHistoricalNativeIdentity(
  proof: HistoricalNativeSourceProof,
  referenceId: string,
  rootSessionId: string,
): HistoricalNativeObservationIdentity {
  return {
    kind: 'historical-observed',
    referenceId,
    passId: sha256Hex(
      JSON.stringify([
        'historical-original-pass',
        proof.sourceGeneration,
        referenceId,
        rootSessionId,
      ]),
    ),
    nativeSource: proof.nativeSource,
    sourceGeneration: proof.sourceGeneration,
    rootSessionId,
  }
}

export function initialHistoricalNativePagePosition(
  original: HistoricalNativeObservationIdentity,
): HistoricalNativePagePosition {
  return {
    ordinal: '0',
    digest: sha256Hex(JSON.stringify(original)),
    scanPosition: '0',
    counts: { sessions: '0', parts: '0', steps: '0' },
    eof: false,
  }
}

export function originalHistoricalNativePageCursor(
  original: HistoricalNativeObservationIdentity,
  position: HistoricalNativePagePosition,
): string {
  return JSON.stringify([original.passId, position.ordinal, position.digest])
}

/** Validate the original packet body and chain, retaining raw JSON property order for its digest. */
export function advanceOriginalHistoricalNativePage(
  value: unknown,
  original: HistoricalNativeObservationIdentity,
  before: HistoricalNativePagePosition,
): {
  readonly page: HistoricalNativeObservationPage
  readonly position: HistoricalNativePagePosition
} {
  if (!pageSchema.safeParse(value).success) throw new Error('Original native numeric page invalid')
  const page = value as HistoricalNativeObservationPage
  if (
    before.eof ||
    !isDeepStrictEqual(page.identity, original) ||
    page.ordinal !== before.ordinal ||
    page.cursor !== originalHistoricalNativePageCursor(original, before) ||
    page.previousDigest !== before.digest ||
    page.scanPositionBefore !== before.scanPosition ||
    BigInt(page.scanPositionAfter) !== BigInt(before.scanPosition) + BigInt(page.scannedRawRows)
  )
    throw new Error('Original native page position or identity changed')
  const body = {
    identity: page.identity,
    ordinal: page.ordinal,
    scanPositionBefore: page.scanPositionBefore,
    scanPositionAfter: page.scanPositionAfter,
    scannedRawRows: page.scannedRawRows,
    counts: page.counts,
    sessions: page.sessions,
    steps: page.steps,
    issues: page.issues,
    eof: page.eof,
  }
  if (
    page.payloadDigest !== sha256Hex(JSON.stringify(body)) ||
    page.cumulativeDigest !== sha256Hex(JSON.stringify([before.digest, page.payloadDigest]))
  )
    throw new Error('Original native numeric payload or cumulative digest changed')
  const sessions = BigInt(page.counts.sessions) - BigInt(before.counts.sessions),
    parts = BigInt(page.counts.parts) - BigInt(before.counts.parts),
    steps = BigInt(page.counts.steps) - BigInt(before.counts.steps)
  if (
    sessions !== BigInt(page.sessions.length) ||
    parts < 0n ||
    steps < BigInt(page.steps.length) ||
    steps > parts ||
    sessions + parts > BigInt(page.scannedRawRows)
  )
    throw new Error('Original native raw population counters changed')
  const position: HistoricalNativePagePosition = {
    ordinal: String(BigInt(before.ordinal) + 1n),
    digest: page.cumulativeDigest,
    scanPosition: page.scanPositionAfter,
    counts: page.counts,
    eof: page.eof !== null,
  }
  if (
    page.nextCursor !==
      (position.eof ? null : originalHistoricalNativePageCursor(original, position)) ||
    (page.eof !== null && !isDeepStrictEqual(page.eof.counts, page.counts))
  )
    throw new Error('Original native next cursor or EOF counters changed')
  return { page, position }
}
