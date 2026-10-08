import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativePassAckSchema,
  ObservationNativePassAdmissionSchema,
  ObservationNativePassIdentitySchema,
  ObservationNativePassPageSchema,
  ObservationNativePassCountsSchema,
} from '@agent-workflow/shared'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeScopeReferenceSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { nativeUsagePreparations, nativeUsagePasses } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { chunkedAll } from '@/util/sqlChunk'
import { insertInBatches } from '@/platform/persistence/batchInsert'
import type {
  NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding,
  NativeUsagePersistence,
} from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import {
  nativeUsageSourceWatermark,
  withNativeUsageOwner,
  type NativeUsageOwnerFacts,
} from './nativeUsageOwnerTransaction'
import { emitNativeUsagePage, type NativeUsagePageBaselineMembers } from './nativeUsagePageEmission'
import type { NativeUsageBaselineReadView } from '../application/ports/nativeUsageBaseline'
import { bindOriginalNativeUsageStore } from './nativeUsageStoreBinding'
import { originalNativeRootHead } from './nativeUsageRootSource'

type Pass = typeof nativeUsagePasses.$inferSelect
type Preparation = typeof nativeUsagePreparations.$inferSelect
type PagesPort = Pick<
  NativeUsagePersistence,
  'prepare' | 'admit' | 'persist' | 'interrupt' | 'baselineMember' | 'steps' | 'parent'
>

async function preparation(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  facts: NativeUsageOwnerFacts,
): Promise<Preparation> {
  const { nativeUsagePreparations } = nativeUsageEvidenceStorage(binding.sourceKind)

  const row = (
    await tx
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
      .limit(1)
  )[0]
  if (
    !row ||
    row.taskId !== binding.taskId ||
    row.nodeRunId !== binding.nodeRunId ||
    row.fence !== facts.fence
  )
    throw new Error('Original native preparation is absent or changed')
  return row
}

async function passFor(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  passId: string,
): Promise<Pass> {
  const { nativeUsagePasses } = nativeUsageEvidenceStorage(binding.sourceKind)

  const row = (
    await tx.select().from(nativeUsagePasses).where(eq(nativeUsagePasses.passId, passId)).limit(1)
  )[0]
  if (!row || row.invocationId !== binding.invocationId)
    throw new Error('Original native pass is absent or changed')
  return row
}

function completePass(row: Pass, phase?: 'baseline'): void {
  const identity = ObservationNativePassIdentitySchema.parse(JSON.parse(row.identity))
  const ack = ObservationNativePassAckSchema.parse(JSON.parse(row.lastAck ?? 'null'))
  if (
    row.state !== 'eof' ||
    ack.eof === null ||
    ack.nextCursor !== null ||
    (phase !== undefined && identity.phase !== phase)
  )
    throw new Error('Original native pass has not reached its complete EOF')
}

/** Durable pages are original evidence; the numeric usage ledger remains the only total. */
export class DrizzleNativeUsagePages implements PagesPort {
  constructor(
    private readonly db: ProviderNeutralDatabase,
    private readonly numericPages = false,
    private readonly originalBeforeIndex?: NativeUsageBaselineReadView | null,
  ) {}

  async prepare(input: Parameters<PagesPort['prepare']>[0]) {
    const { nativeUsagePreparations } = nativeUsageEvidenceStorage(input.binding.sourceKind)

    return withNativeUsageOwner(
      this.db,
      input.binding,
      async (tx, facts) => {
        if (input.nativeSource !== facts.nativeSource)
          throw new Error('Original native preparation changed its accepted source')
        const preparedAt = Date.now()
        const absent =
          input.sourceAbsentAt === undefined ? {} : { sourceAbsentAt: input.sourceAbsentAt }
        const receiptFields = [
          'prepare',
          input.binding.taskId,
          input.binding.nodeRunId,
          input.binding.invocationId,
          facts.fence,
          input.sourceGeneration,
          input.resumeRootSessionId,
          ...(input.sourceGeneration === null ? ['absent', input.sourceAbsentAt] : []),
        ]
        const candidate = ObservationNativeBeforeSpawnAckSchema.parse({
          contract: 'native-usage-before-spawn-v2',
          invocationId: input.binding.invocationId,
          nativeSource: facts.nativeSource,
          sourceGeneration: input.sourceGeneration,
          ...absent,
          lineage: facts.lineage,
          epoch: facts.epoch,
          ownerReceiptId: sha256Hex(JSON.stringify(receiptFields)),
          preparedAt,
          mode: input.resumeRootSessionId === null ? 'fresh' : 'resume',
          rootSessionId: input.resumeRootSessionId,
        })
        const existing = (
          await tx
            .select()
            .from(nativeUsagePreparations)
            .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
            .limit(1)
        )[0]
        if (existing) {
          await preparation(tx, input.binding, facts)
          const ack = ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(existing.document))
          if (
            ack.nativeSource !== input.nativeSource ||
            ack.sourceGeneration !== input.sourceGeneration ||
            ack.rootSessionId !== input.resumeRootSessionId
          )
            throw new Error('Original native before-spawn operation changed on replay')
          return ack
        }
        const ack = candidate
        await tx.insert(nativeUsagePreparations).values({
          invocationId: input.binding.invocationId,
          taskId: input.binding.taskId,
          nodeRunId: input.binding.nodeRunId,
          ownerReceiptId: ack.ownerReceiptId,
          fence: facts.fence,
          document: JSON.stringify(ack),
          state: 'open',
        })
        if (ack.sourceGeneration !== null)
          await bindOriginalNativeUsageStore(
            tx,
            ack,
            ack.sourceGeneration,
            input.binding.sourceKind,
          )
        return ack
      },
      { allowFinalization: false },
    )
  }

  async admit(input: Parameters<PagesPort['admit']>[0]) {
    const {
      nativeUsageRootSets,
      nativeUsageRootTransitions,
      nativeUsagePasses,
      nativeUsagePassHeads,
    } = nativeUsageEvidenceStorage(input.binding.sourceKind)

    ObservationNativePassIdentitySchema.parse(input.identity)
    if (
      input.rootCreatedAt !== null &&
      (!Number.isSafeInteger(input.rootCreatedAt) || input.rootCreatedAt < 0)
    )
      throw new Error('Original native root creation time is not exact')
    return withNativeUsageOwner(
      this.db,
      input.binding,
      async (tx, facts) => {
        const prepared = await preparation(tx, input.binding, facts)
        const before = ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document))
        const identity = input.identity
        const seed = sha256Hex(JSON.stringify(identity))
        if (
          prepared.state !== 'open' ||
          input.beforeSpawnReceiptId !== before.ownerReceiptId ||
          identity.invocationId !== input.binding.invocationId ||
          identity.nativeSource !== before.nativeSource ||
          (before.sourceGeneration !== null &&
            identity.sourceGeneration !== before.sourceGeneration) ||
          identity.lineage !== facts.lineage ||
          identity.epoch !== facts.epoch ||
          (before.mode === 'resume' &&
            identity.rootSessionId !== before.rootSessionId &&
            (facts.contract !== 'opencode-child-root-pages-v3' || identity.phase === 'baseline')) ||
          (before.mode === 'fresh' && identity.phase !== 'final') ||
          input.initialCursor !== JSON.stringify([identity.passId, '0', seed])
        )
          throw new Error('Original native admission changed the before-spawn binding')
        if (facts.contract === 'opencode-child-root-pages-v3' && identity.phase === 'final') {
          const frozen = (
            await tx
              .select()
              .from(nativeUsageRootSets)
              .where(eq(nativeUsageRootSets.invocationId, input.binding.invocationId))
              .limit(1)
          )[0]
          const source = await originalNativeRootHead(tx, input.binding, facts)
          const member = (
            await tx
              .select({ key: nativeUsageRootTransitions.ordinalKey })
              .from(nativeUsageRootTransitions)
              .where(
                and(
                  eq(nativeUsageRootTransitions.invocationId, input.binding.invocationId),
                  eq(nativeUsageRootTransitions.rootSessionId, identity.rootSessionId),
                ),
              )
              .limit(1)
          )[0]
          if (
            !frozen ||
            !source ||
            !member ||
            frozen.nextOrdinal !== source.nextOrdinal ||
            frozen.rootDigest !== source.digest
          )
            throw new Error('Native final root is absent from its original frozen lease population')
        }
        await bindOriginalNativeUsageStore(
          tx,
          before,
          identity.sourceGeneration,
          input.binding.sourceKind,
        )
        const existing = (
          await tx
            .select()
            .from(nativeUsagePasses)
            .where(eq(nativeUsagePasses.passId, identity.passId))
            .limit(1)
        )[0]
        if (existing) {
          if (
            existing.identity !== JSON.stringify(identity) ||
            existing.initialCursor !== input.initialCursor ||
            existing.rootCreatedAt !== input.rootCreatedAt ||
            !['open', 'eof'].includes(existing.state)
          )
            throw new Error('Original native pass cannot reopen a lost snapshot')
          return ObservationNativePassAdmissionSchema.parse(JSON.parse(existing.admission))
        }
        const headKey = JSON.stringify([
          identity.invocationId,
          identity.nativeSource,
          identity.sourceGeneration,
          identity.rootSessionId,
          identity.lineage,
          identity.epoch,
          identity.phase,
        ])
        const head = (
          await tx
            .select()
            .from(nativeUsagePassHeads)
            .where(eq(nativeUsagePassHeads.key, headKey))
            .limit(1)
        )[0]
        if (head) {
          const previous = await passFor(tx, input.binding, head.passId)
          if (input.supersedes !== head.passId || previous.state === 'eof')
            throw new Error('A lost native snapshot requires explicit new-pass supersession')
          await tx
            .update(nativeUsagePasses)
            .set({ state: 'superseded' })
            .where(eq(nativeUsagePasses.passId, head.passId))
        } else if (input.supersedes !== undefined)
          throw new Error('Original native superseded pass is absent')
        const admission = ObservationNativePassAdmissionSchema.parse({
          identity,
          initialCursor: input.initialCursor,
          ownerReceiptId: sha256Hex(JSON.stringify([before.ownerReceiptId, identity, headKey])),
          sourceWatermark: await nativeUsageSourceWatermark(
            tx,
            input.binding.nodeRunId,
            input.binding.sourceKind,
          ),
        })
        await tx.insert(nativeUsagePasses).values({
          passId: identity.passId,
          invocationId: input.binding.invocationId,
          headKey,
          ownerReceiptId: admission.ownerReceiptId,
          identity: JSON.stringify(identity),
          initialCursor: input.initialCursor,
          admission: JSON.stringify(admission),
          rootCreatedAt: input.rootCreatedAt,
          state: 'open',
          nextOrdinal: '0',
          nextCursor: input.initialCursor,
          digest: seed,
          position: '0',
          counts: JSON.stringify({ sessions: '0', parts: '0', steps: '0' }),
        })
        await tx
          .insert(nativeUsagePassHeads)
          .values({ key: headKey, passId: identity.passId })
          .onConflictDoUpdate({
            target: nativeUsagePassHeads.key,
            set: { passId: identity.passId },
          })
        return admission
      },
      { allowFinalization: input.identity.phase === 'final' },
    )
  }

  async persist(input: Parameters<PagesPort['persist']>[0]) {
    const {
      nativeUsagePassPages,
      nativeUsageSessionParents,
      nativeUsageStepMembers,
      nativeUsagePasses,
    } = nativeUsageEvidenceStorage(input.binding.sourceKind)

    // Validate without replacing the original field order used by the native reader's digest.
    ObservationNativePassPageSchema.parse(input.page)
    const page = input.page
    const document = JSON.stringify(page)
    const payload = sha256Hex(
      JSON.stringify({
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
      }),
    )
    if (
      payload !== page.payloadDigest ||
      sha256Hex(JSON.stringify([page.previousDigest, payload])) !== page.cumulativeDigest
    )
      throw new Error('Original native page digest changed')
    // A Worker/independent PG read may yield; it must finish before the original write lease.
    // Copy its membership while the verified snapshot is still live. The write below retains
    // the original preparation/fence checks and atomically commits pages, numbers and ACK.
    const originalBeforeIndex: NativeUsagePageBaselineMembers | null | undefined =
      this.originalBeforeIndex == null
        ? this.originalBeforeIndex
        : {
            original: this.originalBeforeIndex.original,
            members: new Set(
              this.numericPages && page.identity.phase === 'final' && page.steps.length > 0
                ? await this.originalBeforeIndex.members(page.steps.map((step) => step.stepId))
                : [],
            ),
          }
    return withNativeUsageOwner(
      this.db,
      input.binding,
      async (tx, facts) => {
        const prepared = await preparation(tx, input.binding, facts)
        const pass = await passFor(tx, input.binding, page.identity.passId)
        const original = (
          await tx
            .select()
            .from(nativeUsagePassPages)
            .where(
              and(
                eq(nativeUsagePassPages.passId, pass.passId),
                eq(nativeUsagePassPages.ordinal, page.ordinal),
              ),
            )
            .limit(1)
        )[0]
        if (original) {
          if (original.document !== document)
            throw new Error('Original native persisted page changed on replay')
          return ObservationNativePassAckSchema.parse(JSON.parse(original.ack))
        }
        const oldCounts = ObservationNativePassCountsSchema.parse(JSON.parse(pass.counts))
        const parts = BigInt(page.counts.parts) - BigInt(oldCounts.parts)
        const steps = BigInt(page.counts.steps) - BigInt(oldCounts.steps)
        if (
          prepared.state !== 'open' ||
          pass.state !== 'open' ||
          !isDeepStrictEqual(page.identity, JSON.parse(pass.identity)) ||
          page.ordinal !== pass.nextOrdinal ||
          page.cursor !== pass.nextCursor ||
          page.previousDigest !== pass.digest ||
          page.scanPositionBefore !== pass.position ||
          BigInt(page.counts.sessions) - BigInt(oldCounts.sessions) !==
            BigInt(page.sessions.length) ||
          parts < 0n ||
          steps < BigInt(page.steps.length) ||
          steps > parts ||
          (steps !== BigInt(page.steps.length) && !page.issues.includes('native-step-identity')) ||
          parts + BigInt(page.sessions.length) > BigInt(page.scannedRawRows)
        )
          throw new Error('Original native page skipped, repeated or changed scan progress')
        const ids = [
          ...new Set([
            ...page.sessions.flatMap((row) => (row.parentSessionId ? [row.parentSessionId] : [])),
            ...page.steps.map((row) => row.id),
          ]),
        ]
        const parents = new Map(
          (
            await chunkedAll(ids, (chunk) =>
              tx
                .select()
                .from(nativeUsageSessionParents)
                .where(
                  and(
                    eq(nativeUsageSessionParents.passId, pass.passId),
                    inArray(nativeUsageSessionParents.sessionId, chunk),
                  ),
                ),
            )
          ).map((row) => [row.sessionId, row]),
        )
        const additions: (typeof nativeUsageSessionParents.$inferInsert)[] = []
        for (const session of page.sessions) {
          const parent =
            session.parentSessionId === null ? null : parents.get(session.parentSessionId)
          if (parents.has(session.id) || (session.parentSessionId !== null && !parent))
            throw new Error('Original native parent index is missing, cyclic or repeated')
          const row = {
            passId: pass.passId,
            sessionId: session.id,
            parentSessionId: session.parentSessionId,
            ordinal: page.ordinal,
            pathDigest: sha256Hex(JSON.stringify([parent?.pathDigest ?? null, session.id])),
            depth: parent ? (BigInt(parent.depth) + 1n).toString() : '0',
          }
          parents.set(session.id, row)
          additions.push(row)
        }
        for (const step of page.steps) {
          const parent = parents.get(step.id)
          if (!parent || parent.parentSessionId !== step.parentSessionId)
            throw new Error('Original native step changed its persisted parent')
        }
        if (additions.length)
          await insertInBatches(tx, nativeUsageSessionParents, additions, (batch) =>
            tx.insert(nativeUsageSessionParents).values([...batch]),
          )
        if (page.steps.length)
          await insertInBatches(
            tx,
            nativeUsageStepMembers,
            page.steps.map((step) => ({
              passId: pass.passId,
              stepId: step.stepId,
              sessionId: step.id,
              ordinal: page.ordinal,
              document: JSON.stringify(step),
            })),
            (batch) => tx.insert(nativeUsageStepMembers).values([...batch]),
          )
        let ack = ObservationNativePassAckSchema.parse({
          contract: 'native-usage-page-ack-v2',
          identity: page.identity,
          ownerReceiptId: pass.ownerReceiptId,
          ordinal: page.ordinal,
          payloadDigest: page.payloadDigest,
          cumulativeDigest: page.cumulativeDigest,
          scanPositionAfter: page.scanPositionAfter,
          counts: page.counts,
          nextCursor: page.nextCursor,
          sourceWatermark: await nativeUsageSourceWatermark(
            tx,
            input.binding.nodeRunId,
            input.binding.sourceKind,
          ),
          eof: page.eof,
        })
        await tx.insert(nativeUsagePassPages).values({
          passId: pass.passId,
          ordinal: page.ordinal,
          payloadDigest: payload,
          cumulativeDigest: page.cumulativeDigest,
          document,
          ack: JSON.stringify(ack),
        })
        if (this.numericPages) {
          await emitNativeUsagePage(
            tx,
            facts,
            input.binding,
            page,
            ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document)),
            pass.ownerReceiptId,
            originalBeforeIndex,
          )
          ack = ObservationNativePassAckSchema.parse({
            ...ack,
            sourceWatermark: await nativeUsageSourceWatermark(
              tx,
              input.binding.nodeRunId,
              input.binding.sourceKind,
            ),
          })
          await tx
            .update(nativeUsagePassPages)
            .set({ ack: JSON.stringify(ack) })
            .where(
              and(
                eq(nativeUsagePassPages.passId, pass.passId),
                eq(nativeUsagePassPages.ordinal, page.ordinal),
              ),
            )
        }
        await tx
          .update(nativeUsagePasses)
          .set({
            nextOrdinal: (BigInt(page.ordinal) + 1n).toString(),
            nextCursor: page.nextCursor,
            digest: page.cumulativeDigest,
            position: page.scanPositionAfter,
            counts: JSON.stringify(page.counts),
            lastAck: JSON.stringify(ack),
            state: page.eof === null ? 'open' : 'eof',
          })
          .where(eq(nativeUsagePasses.passId, pass.passId))
        return ack
      },
      { allowFinalization: page.identity.phase === 'final' },
    )
  }

  async interrupt(input: Parameters<PagesPort['interrupt']>[0]) {
    const { nativeUsagePasses } = nativeUsageEvidenceStorage(input.binding.sourceKind)

    return withNativeUsageOwner(
      this.db,
      input.binding,
      async (tx, facts) => {
        await preparation(tx, input.binding, facts)
        const pass = await passFor(tx, input.binding, input.identity.passId)
        if (!isDeepStrictEqual(JSON.parse(pass.identity), input.identity))
          throw new Error('Original native interruption changed its pass')
        if (pass.state === 'open' || pass.state === 'eof')
          await tx
            .update(nativeUsagePasses)
            .set({ state: 'interrupted', interruption: input.reason })
            .where(eq(nativeUsagePasses.passId, pass.passId))
      },
      { allowFinalization: input.identity.phase === 'final' },
    )
  }

  async baselineMember(input: Parameters<PagesPort['baselineMember']>[0]) {
    const { nativeUsagePassPages, nativeUsageStepMembers } = nativeUsageEvidenceStorage(
      input.binding.sourceKind,
    )

    return withNativeUsageOwner(this.db, input.binding, async (tx, facts) => {
      await preparation(tx, input.binding, facts)
      const pass = await passFor(tx, input.binding, input.passId)
      completePass(pass, 'baseline')
      const last = ObservationNativePassPageSchema.parse(
        JSON.parse(
          (
            await tx
              .select({ document: nativeUsagePassPages.document })
              .from(nativeUsagePassPages)
              .where(
                and(
                  eq(nativeUsagePassPages.passId, pass.passId),
                  eq(nativeUsagePassPages.ordinal, (BigInt(pass.nextOrdinal) - 1n).toString()),
                ),
              )
              .limit(1)
          )[0]?.document ?? 'null',
        ),
      )
      if (
        last.issues.some((issue) =>
          ['native-step-identity', 'native-tree-conflict'].includes(issue),
        )
      )
        throw new Error('Original native baseline membership is incomplete')
      return (
        (
          await tx
            .select({ id: nativeUsageStepMembers.stepId })
            .from(nativeUsageStepMembers)
            .where(
              and(
                eq(nativeUsageStepMembers.passId, pass.passId),
                eq(nativeUsageStepMembers.stepId, input.stepId),
              ),
            )
            .limit(1)
        ).length === 1
      )
    })
  }

  async steps(input: Parameters<PagesPort['steps']>[0]) {
    const { nativeUsageStepMembers } = nativeUsageEvidenceStorage(input.binding.sourceKind)

    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
      throw new RangeError('Invalid native step response size')
    return withNativeUsageOwner(this.db, input.binding, async (tx, facts) => {
      await preparation(tx, input.binding, facts)
      const pass = await passFor(tx, input.binding, input.passId)
      completePass(pass)
      let after: string | undefined
      if (input.after !== null) {
        const value: unknown = JSON.parse(input.after)
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          value[0] !== input.passId ||
          typeof value[1] !== 'string' ||
          !value[1]
        )
          throw new RangeError('Original native step cursor changed pass')
        after = value[1]
      }
      const rows = await tx
        .select()
        .from(nativeUsageStepMembers)
        .where(
          and(
            eq(nativeUsageStepMembers.passId, input.passId),
            after === undefined ? undefined : gt(nativeUsageStepMembers.stepId, after),
          ),
        )
        .orderBy(nativeUsageStepMembers.stepId)
        .limit(input.limit + 1)
      const page = rows.slice(0, input.limit)
      return {
        items: page.map((row) =>
          ObservationNativePassPageSchema.innerType().shape.steps.element.parse(
            JSON.parse(row.document),
          ),
        ),
        nextCursor:
          rows.length > input.limit
            ? JSON.stringify([input.passId, page[page.length - 1]!.stepId])
            : null,
      }
    })
  }

  async parent(input: Parameters<PagesPort['parent']>[0]) {
    const { nativeUsagePassPages, nativeUsageSessionParents } = nativeUsageEvidenceStorage(
      input.binding.sourceKind,
    )

    const reference = ObservationNativeScopeReferenceSchema.parse(input.reference)
    return withNativeUsageOwner(this.db, input.binding, async (tx, facts) => {
      await preparation(tx, input.binding, facts)
      const pass = await passFor(tx, input.binding, reference.ancestry.identity.passId)
      const page = (
        await tx
          .select()
          .from(nativeUsagePassPages)
          .where(
            and(
              eq(nativeUsagePassPages.passId, pass.passId),
              eq(nativeUsagePassPages.ordinal, reference.ancestry.pageOrdinal),
            ),
          )
          .limit(1)
      )[0]
      const link = (
        await tx
          .select()
          .from(nativeUsageSessionParents)
          .where(
            and(
              eq(nativeUsageSessionParents.passId, pass.passId),
              eq(nativeUsageSessionParents.sessionId, input.sessionId),
            ),
          )
          .limit(1)
      )[0]
      if (
        !page ||
        !link ||
        !isDeepStrictEqual(JSON.parse(pass.identity), reference.ancestry.identity) ||
        pass.ownerReceiptId !== reference.ancestry.ownerReceiptId ||
        page.cumulativeDigest !== reference.ancestry.cumulativeDigest ||
        BigInt(link.ordinal) > BigInt(reference.ancestry.pageOrdinal) ||
        (input.sessionId === reference.session && link.parentSessionId !== reference.parentSession)
      )
        throw new Error('Original native scope parent is absent or outside its persisted page')
      return link.parentSessionId
    })
  }
}
