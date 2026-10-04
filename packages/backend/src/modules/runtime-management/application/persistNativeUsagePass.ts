import {
  ObservationNativePassAckSchema,
  ObservationNativePassAdmissionSchema,
  ObservationNativePassPageSchema,
  ObservationNativePassIdentitySchema,
  type ObservationNativePassAck,
} from '@agent-workflow/shared/schemas/observationNativePages'
import type { AsyncNativeUsagePassReader, NativeUsagePassOwner } from './ports/nativeUsageOwner'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
async function persistPages(
  reader: AsyncNativeUsagePassReader,
  owner: NativeUsagePassOwner,
): Promise<ObservationNativePassAck> {
  const identity = ObservationNativePassIdentitySchema.parse(reader.identity)
  const admission = ObservationNativePassAdmissionSchema.parse(
    await owner.admit(reader.identity, reader.initialCursor, reader.rootCreatedAt),
  )
  if (!same(admission.identity, identity) || admission.initialCursor !== reader.initialCursor)
    throw new Error('Native owner admission changed original pass')
  let cursor = reader.initialCursor,
    ordinal = 0n,
    position = '0'
  let previousDigest: string | undefined,
    watermark = BigInt(admission.sourceWatermark)
  let counts = { sessions: '0', parts: '0', steps: '0' }
  for (;;) {
    const originalPage = await reader.next(cursor)
    const page = ObservationNativePassPageSchema.parse(originalPage)
    if (
      !same(page.identity, admission.identity) ||
      page.cursor !== cursor ||
      page.ordinal !== ordinal.toString() ||
      page.scanPositionBefore !== position ||
      (previousDigest !== undefined && page.previousDigest !== previousDigest) ||
      Object.keys(counts).some(
        (key) =>
          BigInt(page.counts[key as keyof typeof counts]) <
          BigInt(counts[key as keyof typeof counts]),
      )
    )
      throw new Error('Native page changed original snapshot or progress')
    const ack = ObservationNativePassAckSchema.parse(await owner.persist(originalPage))
    if (
      !same(ack.identity, page.identity) ||
      ack.ownerReceiptId !== admission.ownerReceiptId ||
      ack.ordinal !== page.ordinal ||
      ack.payloadDigest !== page.payloadDigest ||
      ack.cumulativeDigest !== page.cumulativeDigest ||
      ack.scanPositionAfter !== page.scanPositionAfter ||
      !same(ack.counts, page.counts) ||
      ack.nextCursor !== page.nextCursor ||
      !same(ack.eof, page.eof) ||
      BigInt(ack.sourceWatermark) < watermark
    )
      throw new Error('Native original owner ACK changed frozen page')
    await reader.acknowledge(page.ordinal, page.payloadDigest)
    if (page.eof !== null) return ack
    cursor = page.nextCursor!
    ordinal++
    position = page.scanPositionAfter
    previousDigest = page.cumulativeDigest
    watermark = BigInt(ack.sourceWatermark)
    counts = page.counts
  }
}
/** Release each page only after durable ACK, and close the actual snapshot on every outcome. */
export async function persistNativeUsagePass(
  reader: AsyncNativeUsagePassReader,
  owner: NativeUsagePassOwner,
): Promise<ObservationNativePassAck> {
  let result: ObservationNativePassAck | undefined
  const failures: unknown[] = []
  try {
    result = await persistPages(reader, owner)
  } catch (error) {
    failures.push(error)
  }
  try {
    await reader.close()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) {
    const error = failures[0]
    let interruptionFailed = false
    try {
      await owner.interrupt(
        reader.identity,
        error instanceof Error ? error.message : 'Native pass failed',
      )
    } catch (interruption) {
      failures.push(interruption)
      interruptionFailed = true
    }
    if (failures.length === 1) throw error
    throw new AggregateError(
      failures,
      interruptionFailed
        ? 'Native pass failure could not be recorded'
        : 'Native pass and reader close failed',
    )
  }
  return result!
}
