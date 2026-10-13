import type {
  AcceptedObservationInvocation,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationMaintenanceOperations as operations,
  observationMaintenanceMembers as members,
  observationInvocationPricePolicies as policies,
  observationInvocationPriceAudit as audit,
  observationInvocationPriceRecords as priceRecords,
} from '@/db/observationAnalysis'
import { observationProjectionWork, observationProjectionHeads } from '@/db/observationProjection'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import {
  ObservationMaintenanceRequestSchema,
  ObservationMaintenanceOperationSchema,
  ObservationMaintenanceConfirmSchema,
  type ObservationMaintenanceOperation,
  type ObservationMaintenanceRequest,
  type ObservationInvocationPricePolicy,
  type CompleteObservationInvocation,
  type CompleteObservationAllocation,
} from '@agent-workflow/shared'
import { CompleteObservationError } from '../domain/completeObservationError'
import { sumCnyAmounts, cnyPicos, valueTokenUsage } from '../domain/cnyPricing'
import { createObservationInvocationStore } from './invocationPersistence'
import { createObservationPriceStore } from './pricingPersistence'
import { enqueueIncrementalObservationWork } from './incrementalObservationWork'
import type { CompleteObservationReportQueries } from '../public/queries'
import type { ObservationMaintenanceCommands } from '../ports/observationMaintenance'
interface ComponentMember {
  readonly component: string
}
interface Member {
  readonly call: CompleteObservationInvocation
  readonly accepted: AcceptedObservationInvocation
  readonly fingerprint: string
  readonly original: string | null
  readonly proposed: string | null
  readonly pairedDelta: string | null
  readonly records: string
  readonly unpriced: string
}
const decode = (s: string) => ObservationMaintenanceOperationSchema.parse(JSON.parse(s))
const signed = (picos: bigint) =>
  picos < 0n
    ? '-' +
      sumCnyAmounts([
        String(-picos / 1000000000000n) + '.' + String(-picos % 1000000000000n).padStart(12, '0'),
      ])
    : sumCnyAmounts([
        String(picos / 1000000000000n) + '.' + String(picos % 1000000000000n).padStart(12, '0'),
      ])
/** Explicit administrative maintenance. Original acceptances and native numbers
 * are immutable; only confirmed, frozen members receive a corrective policy. */
export function observationMaintenance(input: {
  db: ProviderNeutralDatabase
  reports: CompleteObservationReportQueries
  scopeOf: (actor: Actor) => string
  failed: (error: unknown) => void
  now?: () => number
}) {
  const { db, reports } = input,
    now = input.now ?? Date.now,
    session = databaseSessionFor(db),
    invocations = createObservationInvocationStore(db),
    prices = createObservationPriceStore(db)
  const read = async (actor: Actor, id: string) => {
    const row = await db.select().from(operations).where(eq(operations.id, id)).get()
    if (!row || row.actorId !== actor.user.id || row.actorScope !== input.scopeOf(actor))
      throw new CompleteObservationError('not-found', 'Maintenance operation is unavailable')
    await reports.status(actor, decode(row.document).request.reportId)
    return decode(row.document)
  }
  async function buildPreview(
    actor: Actor,
    raw: ObservationMaintenanceRequest,
    leaseToken: string,
  ) {
    const request = ObservationMaintenanceRequestSchema.parse(raw),
      previous = await db
        .select()
        .from(operations)
        .where(
          and(eq(operations.actorId, actor.user.id), eq(operations.requestKey, request.requestKey)),
        )
        .get()
    if (previous) {
      const op = await read(actor, previous.id)
      if (JSON.stringify(op.request) !== JSON.stringify(request))
        throw new CompleteObservationError('scope-changed', 'Maintenance request key changed')
      if (op.state !== 'preparing') return op
    }
    const previousOperation = previous ? decode(previous.document) : undefined
    if (!previous || previous.leaseToken !== leaseToken || previous.leaseUntil <= now())
      throw new CompleteObservationError('scope-changed', 'Maintenance preview lease expired')
    const finish = async (operation: ObservationMaintenanceOperation) =>
      session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(tx, operations, operations.id, previous.id)
        const current = await tx
          .select()
          .from(operations)
          .where(eq(operations.id, previous.id))
          .get()
        if (
          !current ||
          current.state !== 'preparing' ||
          current.leaseToken !== leaseToken ||
          current.leaseUntil <= now()
        )
          return false
        await tx
          .update(operations)
          .set({ state: operation.state, document: JSON.stringify(operation) })
          .where(
            and(
              eq(operations.id, previous.id),
              eq(operations.leaseToken, leaseToken),
              eq(operations.state, 'preparing'),
            ),
          )
          .run()
        return true
      })
    const report = await reports.status(actor, request.reportId),
      facts =
        report.state === 'ready' ? report : report.state === 'not-ready' ? report.facts : undefined
    if (!facts)
      throw new CompleteObservationError(
        'not-ready',
        'Select a published report before maintenance',
      )
    const id = previousOperation?.id ?? randomUUID(),
      createdAt = previousOperation?.createdAt ?? now(),
      base: ObservationMaintenanceOperation = {
        id,
        request,
        filters: facts.header.filters,
        state: 'preparing',
        sourceRevision: facts.header.sourceRevision,
        scopeDigest: '',
        createdAt,
        confirmedAt: null,
        confirmationOrder: null,
        tasks: facts.summary.inventory.tasks,
        invocations: '0',
        records: '0',
        processed: '0',
        unpricedRecords: '0',
        knownOriginalCny: null,
        knownProposedCny: null,
        knownPairedDeltaCny: null,
        gaps: [],
      }
    await db
      .insert(operations)
      .values({
        id,
        requestKey: request.requestKey,
        actorId: actor.user.id,
        actorScope: input.scopeOf(actor),
        actorDocument: JSON.stringify({ ...actor, permissions: [...actor.permissions] }),
        state: base.state,
        sourceRevision: base.sourceRevision,
        createdAt,
        document: JSON.stringify(base),
      })
      .onConflictDoNothing()
      .run()
    let original = 0n,
      proposed = 0n,
      paired = 0n,
      count = 0n,
      records = 0n,
      unpriced = 0n,
      knownOld = 0n,
      knownNew = 0n,
      knownPairs = 0n,
      digest = sha256Hex(JSON.stringify([id, request, facts.header]))
    try {
      let after: string | undefined
      for (;;) {
        const page = await reports.page<CompleteObservationInvocation>(actor, request.reportId, {
          section: 'invocations',
          limit: 200,
          ...(after ? { after } : {}),
        })
        for (const call of page.items) {
          const accepted = await invocations.get(call.invocationId)
          if (!accepted)
            throw new CompleteObservationError(
              'not-ready',
              'Original invocation acceptance missing',
            )
          if (
            request.mode === 'reprice' &&
            (accepted.authority.kind !== 'local' ||
              accepted.authority.runtime?.registrationId !== request.registrationId)
          )
            continue
          let oldTotal = 0n,
            newTotal = 0n,
            memberPaired = 0n,
            memberRecords = 0n,
            memberUnpriced = 0n,
            memberKnownOld = 0n,
            memberKnownNew = 0n,
            memberKnownPairs = 0n,
            allocationAfter: string | undefined,
            fingerprint = sha256Hex(JSON.stringify(accepted))
          for (;;) {
            const allocationPage = await reports.page<CompleteObservationAllocation>(
              actor,
              request.reportId,
              {
                section: 'allocations',
                parent: JSON.stringify(['invocation', call.invocationId]),
                limit: 200,
                ...(allocationAfter ? { after: allocationAfter } : {}),
              },
            )
            for (const allocation of allocationPage.items) {
              if (allocation.invocation.invocationId !== call.invocationId)
                throw new CompleteObservationError('scope-changed', 'Allocation membership changed')
              memberRecords++
              const runtime =
                  accepted.authority.kind === 'local' ? accepted.authority.runtime : null,
                model = allocation.model
              const price =
                request.mode === 'reprice' && runtime && model?.provider
                  ? await prices.priceAt(
                      runtime.registrationId,
                      {
                        configurationRevision: runtime.configurationRevision,
                        protocol: runtime.protocol,
                        provider: model.provider,
                        model: model.id,
                        condition: null,
                      },
                      createdAt,
                      request.targetPriceBookRevision,
                    )
                  : undefined
              const estimate = price
                  ? valueTokenUsage(allocation.contribution, price.rates)
                  : undefined,
                old = allocation.cost.hidden ? null : allocation.cost.amount,
                newValue =
                  estimate && estimate.completeness !== 'unpriced' ? estimate.knownAmount : null
              if (old !== null) {
                oldTotal += cnyPicos(old)
                memberKnownOld++
              }
              if (newValue !== null) {
                newTotal += cnyPicos(newValue)
                memberKnownNew++
              }
              if (
                allocation.qualified !== false &&
                old !== null &&
                allocation.cost.complete &&
                newValue !== null &&
                estimate?.completeness === 'complete'
              ) {
                memberPaired += cnyPicos(newValue) - cnyPicos(old)
                memberKnownPairs++
              } else if (request.mode === 'reprice') memberUnpriced++
              fingerprint = sha256Hex(fingerprint + JSON.stringify(allocation))
              if (request.mode === 'reprice')
                await db
                  .insert(members)
                  .values({
                    operationId: id,
                    key:
                      'record/' +
                      sha256Hex(call.invocationId) +
                      '/' +
                      sha256Hex(JSON.stringify([allocation.sourceId, allocation.recordId])),
                    document: JSON.stringify({ record: allocation }),
                    state: 'frozen-record',
                  })
                  .onConflictDoNothing()
                  .run()
            }
            if (allocationPage.nextCursor === null) break
            allocationAfter = allocationPage.nextCursor
          }
          const member: Member = {
            call,
            accepted,
            fingerprint,
            original: memberKnownOld ? signed(oldTotal) : null,
            proposed: memberKnownNew ? signed(newTotal) : null,
            pairedDelta: memberKnownPairs ? signed(memberPaired) : null,
            records: String(memberRecords),
            unpriced: String(memberUnpriced),
          }
          await db
            .insert(members)
            .values({ operationId: id, key: call.invocationId, document: JSON.stringify(member) })
            .onConflictDoNothing()
            .run()
          count++
          records += memberRecords
          unpriced += memberUnpriced
          original += oldTotal
          proposed += newTotal
          paired += memberPaired
          knownOld += memberKnownOld
          knownNew += memberKnownNew
          knownPairs += memberKnownPairs
          digest = sha256Hex(digest + call.invocationId + fingerprint)
        }
        if (page.nextCursor === null) break
        after = page.nextCursor
      }
      if (request.mode !== 'reprice')
        for (const section of ['tasks', 'attempts', 'historical-executions'] as const) {
          let cursor: string | undefined
          for (;;) {
            const page = await reports.page<{
              task?: { id: string }
              id?: string
              execution?: HistoricalObservationExecution
            }>(actor, request.reportId, {
              section,
              limit: 200,
              ...(cursor ? { after: cursor } : {}),
            })
            for (const row of page.items) {
              const keys =
                section === 'tasks' && row.task
                  ? [JSON.stringify(['task-metadata', row.task.id])]
                  : section === 'attempts' && row.id
                    ? [JSON.stringify(['attempt', row.id])]
                    : row.execution
                      ? [
                          JSON.stringify([row.execution.sourceKind, row.execution.ownerId]),
                          ...(row.execution.rootSessionId
                            ? [JSON.stringify(['root', row.execution.rootSessionId])]
                            : []),
                        ]
                      : []
              for (const component of keys) {
                await db
                  .insert(members)
                  .values({
                    operationId: id,
                    key: 'component/' + sha256Hex(component),
                    document: JSON.stringify({ component }),
                  })
                  .onConflictDoNothing()
                  .run()
                digest = sha256Hex(digest + component)
              }
            }
            if (page.nextCursor === null) break
            cursor = page.nextCursor
          }
        }
      const op: ObservationMaintenanceOperation = {
        ...base,
        state: 'preview',
        scopeDigest: digest,
        invocations: String(count),
        records: String(records),
        unpricedRecords: String(unpriced),
        knownOriginalCny: knownOld ? signed(original) : null,
        knownProposedCny: knownNew ? signed(proposed) : null,
        knownPairedDeltaCny: knownPairs ? signed(paired) : null,
        gaps: unpriced ? ['unpriced-or-partial-records'] : [],
      }
      if (!(await finish(op)))
        throw new CompleteObservationError('scope-changed', 'Maintenance preview lease expired')
      return op
    } catch (error) {
      await finish({ ...base, state: 'failed', gaps: ['maintenance-preview-failed'] })
      throw error
    }
  }
  async function prepare(actor: Actor, raw: ObservationMaintenanceRequest) {
    const request = ObservationMaintenanceRequestSchema.parse(raw),
      previous = await db
        .select()
        .from(operations)
        .where(
          and(eq(operations.actorId, actor.user.id), eq(operations.requestKey, request.requestKey)),
        )
        .get()
    if (previous) {
      const op = await read(actor, previous.id)
      if (JSON.stringify(op.request) !== JSON.stringify(request))
        throw new CompleteObservationError('scope-changed', 'Maintenance request key changed')
      return op
    }
    const report = await reports.status(actor, request.reportId),
      facts =
        report.state === 'ready' ? report : report.state === 'not-ready' ? report.facts : undefined
    if (!facts)
      throw new CompleteObservationError(
        'not-ready',
        'Select a published report before maintenance',
      )
    if (
      request.mode === 'reprice' &&
      (await prices.heads([request.registrationId!])).get(request.registrationId!) !==
        request.targetPriceBookRevision
    )
      throw new CompleteObservationError(
        'scope-changed',
        'Select the current published CNY catalogue revision',
      )
    const op: ObservationMaintenanceOperation = {
      id: randomUUID(),
      request,
      filters: facts.header.filters,
      state: 'preparing',
      sourceRevision: facts.header.sourceRevision,
      scopeDigest: '',
      createdAt: now(),
      confirmedAt: null,
      confirmationOrder: null,
      tasks: facts.summary.inventory.tasks,
      invocations: '0',
      records: '0',
      processed: '0',
      unpricedRecords: '0',
      knownOriginalCny: null,
      knownProposedCny: null,
      knownPairedDeltaCny: null,
      gaps: [],
    }
    await db
      .insert(operations)
      .values({
        id: op.id,
        requestKey: request.requestKey,
        actorId: actor.user.id,
        actorScope: input.scopeOf(actor),
        actorDocument: JSON.stringify({ ...actor, permissions: [...actor.permissions] }),
        state: op.state,
        sourceRevision: op.sourceRevision,
        createdAt: op.createdAt,
        document: JSON.stringify(op),
      })
      .onConflictDoNothing()
      .run()
    const stored = await db
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(eq(operations.actorId, actor.user.id), eq(operations.requestKey, request.requestKey)),
      )
      .get()
    return read(actor, stored!.id)
  }
  const commands: ObservationMaintenanceCommands = {
    prepare,
    status: read,
    async confirm(actor, id, raw) {
      const confirmation = ObservationMaintenanceConfirmSchema.parse(raw)
      await read(actor, id)
      return session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(tx, operations, operations.id, id)
        const row = await tx.select().from(operations).where(eq(operations.id, id)).get()
        if (!row) throw new CompleteObservationError('not-found', 'Maintenance missing')
        const op = decode(row.document)
        if (op.scopeDigest !== confirmation.expectedDigest)
          throw new CompleteObservationError('scope-changed', 'Maintenance preview changed')
        if (op.confirmedAt !== null) return op
        if (op.state !== 'preview')
          throw new CompleteObservationError('not-ready', 'Maintenance preview is not ready')
        await tx
          .insert(observationProjectionHeads)
          .values({ id: 'maintenance-confirmation', revision: '0', asOf: 0 })
          .onConflictDoNothing()
          .run()
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationProjectionHeads,
          observationProjectionHeads.id,
          'maintenance-confirmation',
        )
        const head = await tx
            .select()
            .from(observationProjectionHeads)
            .where(eq(observationProjectionHeads.id, 'maintenance-confirmation'))
            .get(),
          confirmationOrder = String(BigInt(head!.revision) + 1n)
        await tx
          .update(observationProjectionHeads)
          .set({ revision: confirmationOrder, asOf: now() })
          .where(eq(observationProjectionHeads.id, 'maintenance-confirmation'))
          .run()
        const next = { ...op, state: 'running' as const, confirmedAt: now(), confirmationOrder }
        await tx
          .update(operations)
          .set({ state: next.state, document: JSON.stringify(next) })
          .where(eq(operations.id, id))
          .run()
        return next
      })
    },
  }
  async function tick() {
    const picked = await db
      .select()
      .from(operations)
      .where(
        and(
          or(eq(operations.state, 'running'), eq(operations.state, 'preparing')),
          lte(operations.leaseUntil, now()),
        ),
      )
      .orderBy(asc(operations.createdAt), asc(operations.id))
      .limit(1)
      .get()
    if (!picked) return false
    const token = randomUUID()
    const claimed = await session.transaction(async (tx) => {
      await engineOf(tx).lockAggregateRoot(tx, operations, operations.id, picked.id)
      const row = await tx.select().from(operations).where(eq(operations.id, picked.id)).get()
      if (!row || !['running', 'preparing'].includes(row.state) || row.leaseUntil > now())
        return false
      await tx
        .update(operations)
        .set({ leaseToken: token, leaseUntil: now() + 30000 })
        .where(eq(operations.id, row.id))
        .run()
      return true
    })
    if (!claimed) return true
    try {
      if (picked.state === 'preparing') {
        const stored = JSON.parse(picked.actorDocument) as Omit<Actor, 'permissions'> & {
            permissions: readonly string[]
          },
          actor = { ...stored, permissions: new Set(stored.permissions) } as Actor
        const timer = setInterval(() => {
          void Promise.resolve()
            .then(() =>
              db
                .update(operations)
                .set({ leaseUntil: now() + 30000 })
                .where(
                  and(
                    eq(operations.id, picked.id),
                    eq(operations.leaseToken, token),
                    eq(operations.state, 'preparing'),
                    gt(operations.leaseUntil, now()),
                  ),
                )
                .run(),
            )
            .catch(input.failed)
        }, 5000)
        try {
          await buildPreview(actor, decode(picked.document).request, token)
        } finally {
          clearInterval(timer)
          await db
            .update(operations)
            .set({ leaseToken: null, leaseUntil: 0 })
            .where(and(eq(operations.id, picked.id), eq(operations.leaseToken, token)))
            .run()
        }
        return true
      }
      return await session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(tx, operations, operations.id, picked.id)
        const current = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.id, picked.id), eq(operations.leaseToken, token)))
          .get()
        if (!current) return true
        let op = decode(current.document)
        const packet = await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.operationId, op.id),
              or(eq(members.state, 'pending'), eq(members.state, 'projecting')),
            ),
          )
          .orderBy(asc(members.key))
          .limit(100)
          .all()
        let advanced = false
        for (const row of packet) {
          const decoded = JSON.parse(row.document) as Member | ComponentMember,
            member = decoded as Member,
            workId = 'maintenance/' + op.id + '/' + sha256Hex(row.key)
          if (row.state === 'projecting') {
            const work = await tx
              .select()
              .from(observationProjectionWork)
              .where(eq(observationProjectionWork.id, workId))
              .get()
            if (!work?.completedRevision) continue
            await tx
              .update(members)
              .set({ state: 'complete' })
              .where(and(eq(members.operationId, op.id), eq(members.key, row.key)))
              .run()
            op = { ...op, processed: String(BigInt(op.processed) + 1n) }
            advanced = true
            continue
          }
          if (op.request.mode === 'reprice') {
            const accepted = await createObservationInvocationStore(tx).get(
              member.accepted.invocationId,
            )
            if (sha256Hex(JSON.stringify(accepted)) !== sha256Hex(JSON.stringify(member.accepted)))
              throw new CompleteObservationError('scope-changed', 'Original acceptance changed')
            const policy: ObservationInvocationPricePolicy = {
                invocationId: member.accepted.invocationId,
                operationId: op.id,
                confirmedAt: op.confirmedAt!,
                confirmationOrder: op.confirmationOrder!,
                repriceAt: op.createdAt,
                originalAccepted: member.accepted,
                targetPriceBookRevision: op.request.targetPriceBookRevision!,
              },
              prior = await tx
                .select()
                .from(policies)
                .where(eq(policies.invocationId, policy.invocationId))
                .get()
            if (
              prior &&
              BigInt(
                (JSON.parse(prior.document) as { confirmationOrder?: string }).confirmationOrder ??
                  '0',
              ) > BigInt(policy.confirmationOrder)
            )
              throw new CompleteObservationError(
                'scope-changed',
                'A newer confirmed correction already exists',
              )
            const document = JSON.stringify(policy),
              fingerprint = sha256Hex(document + member.fingerprint)
            const existing = await tx
              .select()
              .from(audit)
              .where(and(eq(audit.operationId, op.id), eq(audit.invocationId, policy.invocationId)))
              .get()
            if (existing && existing.fingerprint !== fingerprint)
              throw new Error('Corrective audit replay changed')
            await tx
              .insert(audit)
              .values({
                operationId: op.id,
                invocationId: policy.invocationId,
                document,
                fingerprint,
              })
              .onConflictDoNothing()
              .run()
            await tx
              .insert(policies)
              .values({
                invocationId: policy.invocationId,
                operationId: op.id,
                confirmedAt: policy.confirmedAt,
                document,
              })
              .onConflictDoUpdate({
                target: policies.invocationId,
                set: { operationId: op.id, confirmedAt: policy.confirmedAt, document },
              })
              .run()
            let recordAfter: string | undefined
            for (;;) {
              const records = await tx
                .select()
                .from(members)
                .where(
                  and(
                    eq(members.operationId, op.id),
                    eq(members.state, 'frozen-record'),
                    sql`${members.key} LIKE ${'record/' + sha256Hex(policy.invocationId) + '/%'}`,
                    recordAfter ? gt(members.key, recordAfter) : undefined,
                  ),
                )
                .orderBy(asc(members.key))
                .limit(200)
                .all()
              if (!records.length) break
              for (const item of records) {
                const allocation = (
                  JSON.parse(item.document) as { record: CompleteObservationAllocation }
                ).record
                if (allocation.invocation.invocationId !== policy.invocationId) continue
                await tx
                  .insert(priceRecords)
                  .values({
                    invocationId: policy.invocationId,
                    sourceId: allocation.sourceId,
                    recordId: allocation.recordId,
                    operationId: op.id,
                    document,
                  })
                  .onConflictDoUpdate({
                    target: [
                      priceRecords.invocationId,
                      priceRecords.sourceId,
                      priceRecords.recordId,
                    ],
                    set: { operationId: op.id, document },
                  })
                  .run()
              }
              recordAfter = records.at(-1)!.key
            }
          }
          await enqueueIncrementalObservationWork(tx, {
            id: workId,
            components: [
              'component' in decoded ? decoded.component : JSON.stringify(['invocation', row.key]),
            ],
            source: 'explicit-maintenance',
            revision: op.sourceRevision,
          })
          await tx
            .update(members)
            .set({ state: 'projecting' })
            .where(and(eq(members.operationId, op.id), eq(members.key, row.key)))
            .run()
          advanced = true
        }
        const outstanding = await tx
          .select({ key: members.key })
          .from(members)
          .where(
            and(
              eq(members.operationId, op.id),
              or(eq(members.state, 'pending'), eq(members.state, 'projecting')),
            ),
          )
          .limit(1)
          .get()
        if (!outstanding) op = { ...op, state: op.gaps.length ? 'partial' : 'complete' }
        await tx
          .update(operations)
          .set({
            state: op.state,
            document: JSON.stringify(op),
            leaseToken: null,
            leaseUntil: advanced ? 0 : now() + 1000,
          })
          .where(and(eq(operations.id, op.id), eq(operations.leaseToken, token)))
          .run()
        return true
      })
    } catch (error) {
      await session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(tx, operations, operations.id, picked.id)
        const current = await tx.select().from(operations).where(eq(operations.id, picked.id)).get()
        if (
          !current ||
          current.leaseToken !== token ||
          current.state !== picked.state ||
          current.leaseUntil <= now()
        )
          return
        const op = decode(current.document)
        await tx
          .update(operations)
          .set({
            leaseToken: null,
            leaseUntil: now() + 1000,
            ...(error instanceof CompleteObservationError
              ? {
                  state: 'failed',
                  document: JSON.stringify({
                    ...op,
                    state: 'failed',
                    gaps: [...op.gaps, error.code],
                  }),
                }
              : {}),
          })
          .where(
            and(
              eq(operations.id, picked.id),
              eq(operations.leaseToken, token),
              eq(operations.state, picked.state),
            ),
          )
          .run()
      })
      input.failed(error)
      return false
    }
  }
  return { commands, tick }
}
