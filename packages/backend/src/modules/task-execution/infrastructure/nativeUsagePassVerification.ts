import { and, eq, inArray, sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativePassAckSchema,
  ObservationNativePassAdmissionSchema,
  ObservationNativePassIdentitySchema,
  ObservationNativePassPageSchema,
  type ObservationNativePassAck,
} from '@agent-workflow/shared'
import {
  nativeUsagePasses,
  nativeUsagePassPages,
  nativeUsageSessionParents,
  nativeUsageStepMembers,
} from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

type ObservationNativePassCounts = ObservationNativePassAck['counts']

/** Verify every original page and index entry with bounded batches, including partial progress. */
export async function verifyNativeUsagePass(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  reference: { readonly ack: ObservationNativePassAck; readonly pageCount: string },
  requireEof: boolean,
): Promise<{
  readonly counts: ObservationNativePassCounts
  readonly rootCreatedAt: number | null
  readonly hasIssues: boolean
  readonly hasPopulationIssues: boolean
}> {
  const last = ObservationNativePassAckSchema.parse(reference.ack)
  const pass = (
    await tx
      .select()
      .from(nativeUsagePasses)
      .where(eq(nativeUsagePasses.passId, last.identity.passId))
      .limit(1)
  )[0]
  if (
    !pass ||
    pass.invocationId !== binding.invocationId ||
    !pass.lastAck ||
    !isDeepStrictEqual(JSON.parse(pass.identity), last.identity) ||
    !isDeepStrictEqual(JSON.parse(pass.lastAck), last) ||
    pass.ownerReceiptId !== last.ownerReceiptId ||
    pass.nextOrdinal !== reference.pageCount ||
    BigInt(reference.pageCount) !== BigInt(last.ordinal) + 1n ||
    (requireEof && (pass.state !== 'eof' || last.eof === null)) ||
    (!requireEof && !['open', 'eof', 'interrupted', 'superseded'].includes(pass.state))
  )
    throw new Error('Native pass verification changed its original progress')
  const identity = ObservationNativePassIdentitySchema.parse(JSON.parse(pass.identity))
  const admission = ObservationNativePassAdmissionSchema.parse(JSON.parse(pass.admission))
  if (
    !isDeepStrictEqual(admission.identity, identity) ||
    admission.initialCursor !== pass.initialCursor ||
    admission.ownerReceiptId !== pass.ownerReceiptId
  )
    throw new Error('Native pass verification changed its original admission')
  let digest = sha256Hex(JSON.stringify(identity))
  let cursor: string | null = pass.initialCursor
  let position = '0'
  let watermark = BigInt(admission.sourceWatermark)
  let counts: ObservationNativePassCounts = { sessions: '0', parts: '0', steps: '0' }
  let sessions = 0n,
    steps = 0n,
    hasIssues = false
  let hasPopulationIssues = false
  const pageCount = BigInt(reference.pageCount)
  // Eight pages bound decoded JSON bytes; no page-count or population limit exists.
  for (let after = 0n; after < pageCount; after += 8n) {
    const ordinals: string[] = []
    for (let ordinal = after; ordinal < pageCount && ordinal < after + 8n; ordinal++)
      ordinals.push(String(ordinal))
    const rows = await tx
      .select()
      .from(nativeUsagePassPages)
      .where(
        and(
          eq(nativeUsagePassPages.passId, pass.passId),
          inArray(nativeUsagePassPages.ordinal, ordinals),
        ),
      )
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]))
    for (const ordinal of ordinals) {
      const row = byOrdinal.get(ordinal)
      if (!row) throw new Error('Native pass verification is missing an original page')
      // Preserve the original JSON property order for its payload digest.
      const page = JSON.parse(row.document)
      ObservationNativePassPageSchema.parse(page)
      const typed = page as ReturnType<typeof ObservationNativePassPageSchema.parse>
      const ack = ObservationNativePassAckSchema.parse(JSON.parse(row.ack))
      if (ordinal === last.ordinal && !isDeepStrictEqual(ack, last))
        throw new Error('Native pass verification changed its original final ACK')
      const payload = sha256Hex(
        JSON.stringify({
          identity: typed.identity,
          ordinal: typed.ordinal,
          scanPositionBefore: typed.scanPositionBefore,
          scanPositionAfter: typed.scanPositionAfter,
          scannedRawRows: typed.scannedRawRows,
          counts: typed.counts,
          sessions: typed.sessions,
          steps: typed.steps,
          issues: typed.issues,
          eof: typed.eof,
        }),
      )
      const expectedAck = {
        contract: 'native-usage-page-ack-v2',
        identity: typed.identity,
        ownerReceiptId: pass.ownerReceiptId,
        ordinal,
        payloadDigest: payload,
        cumulativeDigest: typed.cumulativeDigest,
        scanPositionAfter: typed.scanPositionAfter,
        counts: typed.counts,
        nextCursor: typed.nextCursor,
        sourceWatermark: ack.sourceWatermark,
        eof: typed.eof,
      }
      const partDelta = BigInt(typed.counts.parts) - BigInt(counts.parts)
      const stepDelta = BigInt(typed.counts.steps) - BigInt(counts.steps)
      if (
        typed.ordinal !== ordinal ||
        typed.cursor !== cursor ||
        typed.previousDigest !== digest ||
        typed.scanPositionBefore !== position ||
        !isDeepStrictEqual(typed.identity, identity) ||
        payload !== typed.payloadDigest ||
        payload !== row.payloadDigest ||
        typed.cumulativeDigest !== sha256Hex(JSON.stringify([digest, payload])) ||
        typed.cumulativeDigest !== row.cumulativeDigest ||
        !isDeepStrictEqual(ack, expectedAck) ||
        BigInt(ack.sourceWatermark) < watermark ||
        BigInt(ack.sourceWatermark) > BigInt(last.sourceWatermark) ||
        BigInt(typed.counts.sessions) - BigInt(counts.sessions) !== BigInt(typed.sessions.length) ||
        partDelta < 0n ||
        stepDelta < BigInt(typed.steps.length) ||
        stepDelta > partDelta ||
        (stepDelta !== BigInt(typed.steps.length) &&
          !typed.issues.includes('native-step-identity')) ||
        partDelta + BigInt(typed.sessions.length) > BigInt(typed.scannedRawRows) ||
        (typed.eof !== null) !== (BigInt(ordinal) + 1n === pageCount && last.eof !== null)
      )
        throw new Error('Native pass verification changed an original page or count')
      const parentIds = [
        ...new Set([
          ...typed.sessions.flatMap((session) => [
            session.id,
            ...(session.parentSessionId ? [session.parentSessionId] : []),
          ]),
          ...typed.steps.map((step) => step.id),
        ]),
      ]
      const parents = new Map(
        (
          await chunkedAll(parentIds, (ids) =>
            tx
              .select()
              .from(nativeUsageSessionParents)
              .where(
                and(
                  eq(nativeUsageSessionParents.passId, pass.passId),
                  inArray(nativeUsageSessionParents.sessionId, ids),
                ),
              ),
          )
        ).map((parent) => [parent.sessionId, parent]),
      )
      for (const session of typed.sessions) {
        const current = parents.get(session.id)
        const parent =
          session.parentSessionId === null ? undefined : parents.get(session.parentSessionId)
        if (
          !current ||
          current.ordinal !== ordinal ||
          current.parentSessionId !== session.parentSessionId ||
          (session.parentSessionId !== null &&
            (!parent || BigInt(parent.ordinal) > BigInt(ordinal))) ||
          current.depth !== (parent ? String(BigInt(parent.depth) + 1n) : '0') ||
          current.pathDigest !== sha256Hex(JSON.stringify([parent?.pathDigest ?? null, session.id]))
        )
          throw new Error('Native pass verification changed an original parent member')
      }
      const members = new Map(
        (
          await chunkedAll(
            typed.steps.map((step) => step.stepId),
            (ids) =>
              tx
                .select()
                .from(nativeUsageStepMembers)
                .where(
                  and(
                    eq(nativeUsageStepMembers.passId, pass.passId),
                    inArray(nativeUsageStepMembers.stepId, ids),
                  ),
                ),
          )
        ).map((member) => [member.stepId, member]),
      )
      for (const step of typed.steps) {
        const member = members.get(step.stepId),
          parent = parents.get(step.id)
        if (
          !member ||
          member.ordinal !== ordinal ||
          member.sessionId !== step.id ||
          !isDeepStrictEqual(JSON.parse(member.document), step) ||
          !parent ||
          parent.parentSessionId !== step.parentSessionId ||
          BigInt(parent.ordinal) > BigInt(ordinal)
        )
          throw new Error('Native pass verification changed an original step member')
      }
      sessions += BigInt(typed.sessions.length)
      steps += BigInt(typed.steps.length)
      hasIssues ||= typed.issues.length > 0
      hasPopulationIssues ||= typed.issues.some(
        (issue) =>
          ![
            'native-model-unavailable',
            'native-token-bucket-unknown',
            'native-time-unavailable',
          ].includes(issue),
      )
      digest = typed.cumulativeDigest
      cursor = typed.nextCursor
      position = typed.scanPositionAfter
      counts = typed.counts
      watermark = BigInt(ack.sourceWatermark)
    }
  }
  if (
    digest !== last.cumulativeDigest ||
    position !== last.scanPositionAfter ||
    cursor !== last.nextCursor ||
    !isDeepStrictEqual(counts, last.counts) ||
    pass.digest !== digest ||
    pass.position !== position ||
    pass.nextCursor !== cursor ||
    !isDeepStrictEqual(JSON.parse(pass.counts), counts)
  )
    throw new Error('Native pass verification changed its original final header')
  for (const [table, expected] of [
    [nativeUsagePassPages, pageCount],
    [nativeUsageSessionParents, sessions],
    [nativeUsageStepMembers, steps],
  ] as const) {
    const row = (
      await tx
        .select({ count: sql<string>`CAST(count(*) AS TEXT)` })
        .from(table)
        .where(eq(table.passId, pass.passId))
    )[0]
    if (!row || BigInt(row.count) !== expected)
      throw new Error('Native pass verification omitted or added original members')
  }
  return { counts, rootCreatedAt: pass.rootCreatedAt, hasIssues, hasPopulationIssues }
}
