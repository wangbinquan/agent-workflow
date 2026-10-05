import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativePassPageSchema,
  ObservationNativePassAckSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nativeUsagePasses,
  nativeUsagePassPages,
  nativeUsageSessionParents,
  nativeUsageStepMembers,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import {
  nativeHistoryFingerprint,
  NativeHistoryPreparationSchema,
  type ObservationNativeHistorySource,
  type NativeHistoryPreparation,
} from '@/modules/run-observability/public/participants'
import {
  qualifyOriginalNativeUsage,
  readOriginalNativeCaptureBinding,
} from './observationNativeQualification'

type Pass = typeof nativeUsagePasses.$inferSelect
const headerFingerprint = (pass: Pass) => sha256Hex(JSON.stringify(pass))
/** Called only inside the original platform snapshot, never while holding a ledger write transaction. */
export async function prepareOriginalNativeHistory(
  db: ProviderNeutralDatabase,
  value: NativeHistoryPreparation['value'],
  snapshot: { readonly snapshotId: string; readonly generationId: string },
): Promise<NativeHistoryPreparation | null> {
  if (value.capture.contract !== 'opencode-child-pages-v2') return null
  const qualified = await qualifyOriginalNativeUsage(db, value)
  if (qualified.records === null) return null
  const facts = await readOriginalNativeCaptureBinding(db, value)
  const baseline = facts.proof.baseline.kind === 'resume' ? facts.proof.baseline.pass : null
  if (!facts.proof.final || (facts.proof.baseline.kind === 'resume' && !baseline)) return null
  const ids = [
    facts.proof.final.ack.identity.passId,
    ...(baseline ? [baseline.ack.identity.passId] : []),
  ]
  const passes = await db
    .select()
    .from(nativeUsagePasses)
    .where(inArray(nativeUsagePasses.passId, ids))
    .all()
  if (passes.length !== ids.length)
    throw new Error('Original history preparation lost a verified pass')
  return NativeHistoryPreparationSchema.parse({
    value,
    valueFingerprint: nativeHistoryFingerprint(value),
    sourceFingerprint: facts.sourceFingerprint,
    beforeSpawnFingerprint: facts.beforeSpawnFingerprint,
    passHeaders: ids.map((passId) => ({
      passId,
      fingerprint: headerFingerprint(passes.find((pass) => pass.passId === passId)!),
    })),
    expectedSteps: baseline?.ack.counts.steps ?? '0',
    databaseGeneration: snapshot.generationId,
    originalSnapshotId: snapshot.snapshotId,
  })
}

/** Every read in this adapter binds to the actual ledger transaction. No root pool acquisition. */
export function createObservationNativeHistory(
  db: ProviderNeutralDatabase,
  prepare: ObservationNativeHistorySource['prepare'],
): ObservationNativeHistorySource {
  return {
    onReader: (reader) => {
      if (!('select' in reader) || typeof reader.select !== 'function')
        throw new Error('Original native history reader is unavailable')
      return createObservationNativeHistory(reader as ProviderNeutralDatabase, prepare)
    },
    prepare,
    async page(raw, after) {
      const prepared = NativeHistoryPreparationSchema.parse(raw)
      if (nativeHistoryFingerprint(prepared.value) !== prepared.valueFingerprint)
        throw new Error('Original history value fingerprint changed')
      const facts = await readOriginalNativeCaptureBinding(db, prepared.value)
      if (
        facts.sourceFingerprint !== prepared.sourceFingerprint ||
        facts.beforeSpawnFingerprint !== prepared.beforeSpawnFingerprint
      )
        throw new Error('Original history source or before-spawn ACK changed')
      const proof = facts.proof
      const baseline = proof.baseline.kind === 'resume' ? proof.baseline.pass : null
      if (
        !proof.final ||
        (proof.baseline.kind === 'resume' && !baseline) ||
        prepared.expectedSteps !== (baseline?.ack.counts.steps ?? '0')
      )
        throw new Error('Original history lost its actual before/final EOF')
      const ids = [
        proof.final.ack.identity.passId,
        ...(baseline ? [baseline.ack.identity.passId] : []),
      ]
      if (
        !isDeepStrictEqual(
          ids,
          prepared.passHeaders.map((row) => row.passId),
        )
      )
        throw new Error('Original history pass references changed')
      const rows = await db
        .select()
        .from(nativeUsagePasses)
        .where(inArray(nativeUsagePasses.passId, ids))
        .all()
      const passes = new Map(rows.map((pass) => [pass.passId, pass]))
      for (const reference of prepared.passHeaders) {
        const pass = passes.get(reference.passId)
        if (!pass || pass.state !== 'eof' || headerFingerprint(pass) !== reference.fingerprint)
          throw new Error('Original history pass header or generation changed')
      }
      if (!baseline) return []
      const members = await db
        .select()
        .from(nativeUsageStepMembers)
        .where(
          and(
            eq(nativeUsageStepMembers.passId, baseline.ack.identity.passId),
            after === null ? undefined : gt(nativeUsageStepMembers.stepId, after),
          ),
        )
        .orderBy(asc(nativeUsageStepMembers.stepId))
        .limit(400)
        .all()
      if (!members.length) return []
      const finalRows = await db
        .select()
        .from(nativeUsageStepMembers)
        .where(
          and(
            eq(nativeUsageStepMembers.passId, proof.final.ack.identity.passId),
            inArray(
              nativeUsageStepMembers.stepId,
              members.map((row) => row.stepId),
            ),
          ),
        )
        .all()
      const finalMembers = new Map(finalRows.map((member) => [member.stepId, member]))
      // Decoded original pages are bounded independently of how many ordinals a packet touches.
      const pages = new Map<string, ReturnType<typeof ObservationNativePassPageSchema.parse>>()
      const paths = new Map<
        string,
        { readonly parentSessionId: string | null; readonly path: string }
      >()
      const parents = new Map<string, typeof nativeUsageSessionParents.$inferSelect>()
      const page = async (passId: string, ordinal: string) => {
        const key = JSON.stringify([passId, ordinal])
        const cached = pages.get(key)
        if (cached) return cached
        const pass = passes.get(passId)!
        const saved = (
          await db
            .select()
            .from(nativeUsagePassPages)
            .where(
              and(
                eq(nativeUsagePassPages.passId, passId),
                eq(nativeUsagePassPages.ordinal, ordinal),
              ),
            )
            .limit(1)
        )[0]
        if (!saved) throw new Error('Original history is missing an original page')
        const document = JSON.parse(saved.document)
        const parsed = ObservationNativePassPageSchema.parse(document)
        const payload = sha256Hex(
          JSON.stringify({
            identity: document.identity,
            ordinal: document.ordinal,
            scanPositionBefore: document.scanPositionBefore,
            scanPositionAfter: document.scanPositionAfter,
            scannedRawRows: document.scannedRawRows,
            counts: document.counts,
            sessions: document.sessions,
            steps: document.steps,
            issues: document.issues,
            eof: document.eof,
          }),
        )
        const ack = ObservationNativePassAckSchema.parse(JSON.parse(saved.ack))
        if (
          parsed.ordinal !== ordinal ||
          !isDeepStrictEqual(parsed.identity, JSON.parse(pass.identity)) ||
          parsed.payloadDigest !== payload ||
          saved.payloadDigest !== payload ||
          parsed.cumulativeDigest !== sha256Hex(JSON.stringify([parsed.previousDigest, payload])) ||
          saved.cumulativeDigest !== parsed.cumulativeDigest ||
          !isDeepStrictEqual(ack.identity, parsed.identity) ||
          ack.ownerReceiptId !== pass.ownerReceiptId ||
          ack.ordinal !== ordinal ||
          ack.payloadDigest !== payload ||
          ack.cumulativeDigest !== parsed.cumulativeDigest ||
          ack.scanPositionAfter !== parsed.scanPositionAfter ||
          ack.nextCursor !== parsed.nextCursor ||
          !isDeepStrictEqual(ack.counts, parsed.counts) ||
          !isDeepStrictEqual(ack.eof, parsed.eof) ||
          BigInt(ordinal) >= BigInt(pass.nextOrdinal) ||
          BigInt(ack.sourceWatermark) > BigInt(JSON.parse(pass.lastAck!).sourceWatermark)
        )
          throw new Error('Original history page changed its actual payload or ACK')
        pages.set(key, parsed)
        if (pages.size > 2) pages.delete(pages.keys().next().value!)
        return parsed
      }
      const anchored = async (member: typeof nativeUsageStepMembers.$inferSelect) => {
        const original = await page(member.passId, member.ordinal)
        const step = original.steps.find((row) => row.stepId === member.stepId)
        if (
          !step ||
          step.id !== member.sessionId ||
          !isDeepStrictEqual(step, JSON.parse(member.document))
        )
          throw new Error('Original history member is absent from its actual page')
        const pathKey = JSON.stringify([member.passId, member.sessionId])
        const checked = paths.get(pathKey)
        if (checked) {
          if (checked.parentSessionId !== step.parentSessionId)
            throw new Error('Original history member changed its checked direct parent')
          return { step, path: checked.path }
        }
        let session: string | null = member.sessionId
        let child: typeof nativeUsageSessionParents.$inferSelect | undefined
        let path: string | undefined
        while (session !== null) {
          const parentKey = JSON.stringify([member.passId, session])
          const parent =
            parents.get(parentKey) ??
            (
              await db
                .select()
                .from(nativeUsageSessionParents)
                .where(
                  and(
                    eq(nativeUsageSessionParents.passId, member.passId),
                    eq(nativeUsageSessionParents.sessionId, session),
                  ),
                )
                .limit(1)
            )[0]
          if (!parent || BigInt(parent.ordinal) > BigInt(member.ordinal))
            throw new Error('Original history is missing a complete parent chain')
          parents.set(parentKey, parent)
          if (parents.size > 4096) parents.delete(parents.keys().next().value!)
          const birthPage = await page(member.passId, parent.ordinal)
          const birth = birthPage.sessions.find((row) => row.id === session)
          if (
            !birth ||
            birth.parentSessionId !== parent.parentSessionId ||
            (!child && parent.parentSessionId !== step.parentSessionId) ||
            (child &&
              (BigInt(child.depth) !== BigInt(parent.depth) + 1n ||
                child.pathDigest !==
                  sha256Hex(JSON.stringify([parent.pathDigest, child.sessionId])))) ||
            (parent.sessionId === original.identity.rootSessionId) !==
              (parent.parentSessionId === null) ||
            (parent.parentSessionId === null &&
              (parent.depth !== '0' ||
                parent.pathDigest !== sha256Hex(JSON.stringify([null, parent.sessionId]))))
          )
            throw new Error('Original history parent changed its actual page or path')
          path ??= parent.pathDigest
          child = parent
          session = parent.parentSessionId
        }
        if (path === undefined) throw new Error('Original history parent path is absent')
        paths.set(pathKey, { parentSessionId: step.parentSessionId, path })
        return { step, path }
      }
      const result = []
      for (const member of members) {
        const before = await anchored(member)
        const latest = finalMembers.get(member.stepId)
        const final = latest ? await anchored(latest) : null
        result.push({
          before: before.step,
          final: final?.step ?? null,
          beforePath: before.path,
          finalPath: final?.path ?? null,
        })
      }
      return result
    },
  }
}
