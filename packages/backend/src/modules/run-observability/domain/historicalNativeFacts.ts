import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { sha256Hex } from '@/util/hash'
import {
  HISTORICAL_NATIVE_NUMERIC_PAGE_VERSION,
  initialHistoricalNativePagePosition,
  originalHistoricalNativePageCursor,
  originalHistoricalNativeIdentity,
  type HistoricalNativeSourceProof,
} from '@/modules/runtime-management/public/participants'
import type { HistoricalNativeFactRoot } from '../ports/historicalNativeFacts'

const text = z.string().min(1),
  natural = z.string().regex(/^(0|[1-9]\d*)$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/)
export const HistoricalNativeSourceProofSchema = z
  .object({
    nativeSource: digest,
    sourceGeneration: digest,
    connectionEpoch: text,
    revisionToken: text,
    parserVersion: z.literal(HISTORICAL_NATIVE_NUMERIC_PAGE_VERSION),
  })
  .strict()
const rootSchema = z
  .object({
    cacheKey: digest,
    proof: HistoricalNativeSourceProofSchema,
    identity: z
      .object({
        kind: z.literal('historical-observed'),
        referenceId: text,
        passId: digest,
        nativeSource: digest,
        sourceGeneration: digest,
        rootSessionId: text,
      })
      .strict(),
    initialCursor: text,
    rootCreatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    pages: z.string().regex(/^[1-9]\d*$/),
    finalDigest: digest,
    eof: z
      .object({
        fingerprint: digest,
        counts: z.object({ sessions: natural, parts: natural, steps: natural }).strict(),
      })
      .strict(),
    issues: z.array(text),
  })
  .strict()

/** Propagates past the original root's source-gap catch to one fresh uncached build. */
export class HistoricalNativeFactInvalidation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoricalNativeFactInvalidation'
  }
}
export function historicalNativeProofKey(proof: HistoricalNativeSourceProof): string {
  return sha256Hex(
    JSON.stringify([
      'original-native-numeric-proof-v1',
      proof.nativeSource,
      proof.sourceGeneration,
      proof.connectionEpoch,
      proof.revisionToken,
      proof.parserVersion,
    ]),
  )
}
export function historicalNativeFactRootKey(
  proof: HistoricalNativeSourceProof,
  selection: { readonly referenceId: string; readonly rootSessionId: string },
): string {
  return sha256Hex(
    JSON.stringify([
      historicalNativeProofKey(proof),
      selection.referenceId,
      selection.rootSessionId,
    ]),
  )
}
export function parseHistoricalNativeFactRoot(
  value: unknown,
  proof: HistoricalNativeSourceProof,
  input: { readonly referenceId: string; readonly rootSessionId: string },
): HistoricalNativeFactRoot {
  if (!rootSchema.safeParse(value).success)
    throw new HistoricalNativeFactInvalidation('Original native fact header invalid')
  const root = value as HistoricalNativeFactRoot,
    original = originalHistoricalNativeIdentity(proof, input.referenceId, input.rootSessionId)
  if (
    !isDeepStrictEqual(root.proof, proof) ||
    root.cacheKey !== historicalNativeFactRootKey(proof, input) ||
    !isDeepStrictEqual(root.identity, original) ||
    root.initialCursor !==
      originalHistoricalNativePageCursor(original, initialHistoricalNativePagePosition(original))
  )
    throw new HistoricalNativeFactInvalidation('Original native fact header identity changed')
  return root
}
