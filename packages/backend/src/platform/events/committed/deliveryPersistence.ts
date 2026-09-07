// RFC-359 W7 —— 已提交事件出站存储的**唯一**实现：一份代码，两个引擎。
//
// # 合并前的形态
//
// SQLite 侧是 `sqlitePersistence.ts`（41 行薄壳）转发给 `sqliteStore.ts` 里的七个同步函数；
// PG 侧是 `postgresqlPersistence.ts`（363 行）把同样的语句用 async 又抄了一遍。两边的行数差
// （802 vs 363）几乎全在 `sqliteStore.ts` 的 **append 半区**——那半区 RFC-359 已在 `append.ts`
// 合成一份，与本端口无关；端口那一半两侧本来就一样大。
//
// # 合并时实测出的两处真差异（`tests/rfc359-w7-committed-events-conformance.test.ts`）
//
//   1. **结算写逃出外层事务（PG 侧红）**。旧 PG 适配器的 accept / reject / retry 是事务外的裸
//      语句，`postgresqlDatabaseClient` 的写栅栏会给它们各自 reserve 一条连接、自带
//      BEGIN/COMMIT——于是外层 `DatabaseSession` 事务回滚**带不走**它们：业务回滚了，投递却已
//      记成 accepted，那条事件从此不再重投，等于静默丢事件。SQLite 侧同样的语句落在
//      `dbTxSync` 打开的事务里，回滚得掉。本实现把三个结算写全部放进 `session.transaction`，
//      两个引擎同为「随外层事务同生共死」，且重入安全。
//   2. **stage 筛子与 stage 投影自相矛盾（SQLite 侧红）**。`stage` 的投影在 JS 里按
//      `startsWith('event-center.')` 算（大小写敏感），旧筛子却用 SQL `LIKE`——SQLite 的 LIKE
//      对 ASCII 大小写不敏感，于是 `Event-Center.x` 这类消费者会被筛进 producer-publication、
//      自报的 stage 却是 consumer-delivery；PG 的 LIKE 大小写敏感，本来自洽。本实现改用
//      `substr(consumer_id, 1, <前缀长>)` 的等值比较：两个引擎都按字节比，且与 JS 投影共用
//      同一个前缀常量，再也漂不开。
//
// 另一处**查证后确认没有差异**：`deliveryPage` 在 updatedAt 打平时按 `eventId` 降序兜底，
// 两个引擎给出同一串（对拍里用 `evt-b` / `evt_a` / `evtA` 三个只在标点与大小写上不同的 id 压过）。
//
// # 保留的既有形状
//
// `claimNext` 的**只读预检**照搬 SQLite 侧：连续派发器每秒对账一次，空队列时进事务等于在
// daemon 的写连接上排队（SQLite 上是 BEGIN IMMEDIATE 排在无关的维护写者后面，PG 上是白拿一条
// reserve 连接 + 一次 generation 栅栏）。预检用与事务体**完全相同**的可派发 / 到期谓词，只有
// 看得见活的时候才占写者；预检之后落地的投递由 after-commit nudge 兜、一秒对账是耐久兜底。
// 事务体重读每一个字段并保留最终的认领 CAS，所以预检不承担任何正确性。
// 源码形状锁在 `tests/rfc341-collaboration-source-locks.test.ts`。

import { and, asc, count, desc, eq, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import {
  affectedRows,
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { assertNonNegativeInteger, assertPositiveInteger, storedEventFromRow } from './appendShared'
import type {
  CommittedEventDeliveryPageInput,
  CommittedEventDeliveryPersistencePort,
} from './persistence'
import type {
  ClaimedCommittedEventDelivery,
  CommittedEventAggregateKind,
  CommittedEventDeliveryPage,
  CommittedEventFamily,
  CommittedEventProducer,
} from './types'

/**
 * 生产者自投递（Event Center 的发布阶段）的消费者 id 前缀。SQL 筛子与 JS 投影共用它，
 * 两处不可能再各说各话。
 */
const PRODUCER_PUBLICATION_PREFIX = 'event-center.'

/** `stage` 的 SQL 判据：按字节比前缀，避开两个引擎相反的 LIKE 大小写语义。 */
function producerPublicationPrefixExpr(): SQL<string> {
  return sql<string>`substr(${committedEventDeliveries.consumerId}, 1, ${PRODUCER_PUBLICATION_PREFIX.length})`
}

/** `stage` 的 JS 投影：与上面同一个前缀常量、同样大小写敏感。 */
function stageOf(consumerId: string): 'producer-publication' | 'consumer-delivery' {
  return consumerId.startsWith(PRODUCER_PUBLICATION_PREFIX)
    ? 'producer-publication'
    : 'consumer-delivery'
}

/** 可派发（家族在当前 epoch 上 dispatchable）且已到期（pending，或 claimed 但租约过期）。 */
function duePredicate(at: number): SQL<unknown> {
  return and(
    eq(committedEvents.deliveryMode, 'dispatchable'),
    eq(committedEventFamilyCutovers.mode, 'dispatchable'),
    eq(committedEvents.producerEpoch, committedEventFamilyCutovers.epoch),
    lte(committedEventDeliveries.nextAttemptAt, at),
    or(
      eq(committedEventDeliveries.state, 'pending'),
      and(
        eq(committedEventDeliveries.state, 'claimed'),
        lte(committedEventDeliveries.claimExpiresAt, at),
      ),
    ),
  )!
}

/** 只读预检（不占写者）：这一刻有没有值得认领的投递。判据与事务体完全相同。 */
async function hasDueDelivery(db: ProviderNeutralDatabase, at: number): Promise<boolean> {
  const rows = await db
    .select({ eventId: committedEventDeliveries.eventId })
    .from(committedEventDeliveries)
    .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
    .innerJoin(
      committedEventFamilyCutovers,
      and(
        eq(committedEventFamilyCutovers.producer, committedEvents.producer),
        eq(committedEventFamilyCutovers.family, committedEvents.family),
      ),
    )
    .where(duePredicate(at))
    .limit(1)
    .all()
  return rows.length > 0
}

/**
 * 同一聚合内的顺序交付：这条候选之前（同 producer/family/aggregate、同 epoch、seq 更小）
 * 还有没有**同一个消费者**尚未 accepted 的投递。有就先别认领它。
 */
async function priorDeliveryBlocks(
  tx: DatabaseTransaction,
  candidate: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    aggregateKind: CommittedEventAggregateKind
    aggregateId: string
    aggregateSeq: number
    producerEpoch: number
    consumerId: string
  }>,
): Promise<boolean> {
  const priorIds = (
    await tx
      .select({ id: committedEvents.id })
      .from(committedEvents)
      .where(
        and(
          eq(committedEvents.producer, candidate.producer),
          eq(committedEvents.family, candidate.family),
          eq(committedEvents.aggregateKind, candidate.aggregateKind),
          eq(committedEvents.aggregateId, candidate.aggregateId),
          eq(committedEvents.deliveryMode, 'dispatchable'),
          eq(committedEvents.producerEpoch, candidate.producerEpoch),
          lt(committedEvents.aggregateSeq, candidate.aggregateSeq),
        ),
      )
      .all()
  ).map((row) => row.id)
  if (priorIds.length === 0) return false
  const blockers = await tx
    .select({ eventId: committedEventDeliveries.eventId })
    .from(committedEventDeliveries)
    .where(
      and(
        inArray(committedEventDeliveries.eventId, priorIds),
        eq(committedEventDeliveries.consumerId, candidate.consumerId),
        ne(committedEventDeliveries.state, 'accepted'),
      ),
    )
    .limit(1)
    .all()
  return blockers.length > 0
}

function pageConditions(input: CommittedEventDeliveryPageInput): SQL[] {
  const conditions: SQL[] = []
  if (input.stage === 'producer-publication') {
    conditions.push(eq(producerPublicationPrefixExpr(), PRODUCER_PUBLICATION_PREFIX))
  } else if (input.stage === 'consumer-delivery') {
    conditions.push(ne(producerPublicationPrefixExpr(), PRODUCER_PUBLICATION_PREFIX))
  }
  if (input.state != null) conditions.push(eq(committedEventDeliveries.state, input.state))
  if (input.producer != null) conditions.push(eq(committedEvents.producer, input.producer))
  if (input.family != null) conditions.push(eq(committedEvents.family, input.family))
  if (input.aggregateId != null && input.aggregateId.length > 0) {
    conditions.push(eq(committedEvents.aggregateId, input.aggregateId))
  }
  if (input.consumerId != null && input.consumerId.length > 0) {
    conditions.push(eq(committedEventDeliveries.consumerId, input.consumerId))
  }
  return conditions
}

function leaseLost(eventId: string, consumerId: string): Error {
  return new Error(`committed event delivery lease lost: ${eventId}/${consumerId}`)
}

export function createCommittedEventDeliveryPersistence(
  db: ProviderNeutralDatabase,
): CommittedEventDeliveryPersistencePort {
  const session = databaseSessionFor(db)
  return {
    async getStored(eventIds) {
      if (eventIds.length === 0) return []
      const rows = await db
        .select()
        .from(committedEvents)
        .where(inArray(committedEvents.id, [...eventIds]))
        .orderBy(asc(committedEvents.eventGroupId), asc(committedEvents.eventGroupOrdinal))
        .all()
      return rows.map(storedEventFromRow)
    },

    async claimNext(input) {
      const at = input.now
      const leaseMs = input.leaseMs ?? 60_000
      const scanLimit = input.scanLimit ?? 64
      if (input.workerId.length === 0) throw new Error('committed event claim requires workerId')
      assertPositiveInteger(leaseMs, 'leaseMs')
      assertPositiveInteger(scanLimit, 'scanLimit')

      // 只读预检；理由见文件头注释「保留的既有形状」。
      if (!(await hasDueDelivery(db, at))) return null

      return await session.transaction(async (tx) => {
        const candidates = await tx
          .select({
            event: committedEvents,
            consumerId: committedEventDeliveries.consumerId,
            deliveryClass: committedEventDeliveries.deliveryClass,
            state: committedEventDeliveries.state,
            attemptCount: committedEventDeliveries.attemptCount,
            leaseEpoch: committedEventDeliveries.leaseEpoch,
          })
          .from(committedEventDeliveries)
          .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
          .innerJoin(
            committedEventFamilyCutovers,
            and(
              eq(committedEventFamilyCutovers.producer, committedEvents.producer),
              eq(committedEventFamilyCutovers.family, committedEvents.family),
            ),
          )
          .where(duePredicate(at))
          .orderBy(
            asc(committedEvents.createdAt),
            asc(committedEvents.eventGroupOrdinal),
            asc(committedEventDeliveries.consumerId),
          )
          .limit(scanLimit)
          .all()

        for (const candidate of candidates) {
          if (
            await priorDeliveryBlocks(tx, {
              producer: candidate.event.producer,
              family: candidate.event.family,
              aggregateKind: candidate.event.aggregateKind,
              aggregateId: candidate.event.aggregateId,
              aggregateSeq: candidate.event.aggregateSeq,
              producerEpoch: candidate.event.producerEpoch,
              consumerId: candidate.consumerId,
            })
          ) {
            continue
          }
          const nextLeaseEpoch = candidate.leaseEpoch + 1
          const claimed = await tx
            .update(committedEventDeliveries)
            .set({
              state: 'claimed',
              attemptCount: candidate.attemptCount + 1,
              claimedBy: input.workerId,
              leaseEpoch: nextLeaseEpoch,
              claimExpiresAt: at + leaseMs,
              updatedAt: at,
            })
            .where(
              and(
                eq(committedEventDeliveries.eventId, candidate.event.id),
                eq(committedEventDeliveries.consumerId, candidate.consumerId),
                eq(committedEventDeliveries.state, candidate.state),
                eq(committedEventDeliveries.leaseEpoch, candidate.leaseEpoch),
              ),
            )
            .run()
          // 认领 CAS 输了（另一个 worker 抢先改了 state / leaseEpoch）⇒ 换下一个候选。
          if (affectedRows(claimed) !== 1) continue
          return {
            event: storedEventFromRow(candidate.event),
            consumerId: candidate.consumerId,
            deliveryClass: candidate.deliveryClass,
            attemptCount: candidate.attemptCount + 1,
            leaseEpoch: nextLeaseEpoch,
            claimedBy: input.workerId,
            claimExpiresAt: at + leaseMs,
          } satisfies ClaimedCommittedEventDelivery
        }
        return null
      })
    },

    async accept(input) {
      const eventId = input.claim.event.envelope.eventId
      await session.transaction(async (tx) => {
        const result = await tx
          .update(committedEventDeliveries)
          .set({
            state: 'accepted',
            claimedBy: null,
            claimExpiresAt: null,
            lastErrorCode: null,
            lastErrorSummary: null,
            acceptedAt: input.now,
            deadLetterAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(committedEventDeliveries.eventId, eventId),
              eq(committedEventDeliveries.consumerId, input.claim.consumerId),
              eq(committedEventDeliveries.state, 'claimed'),
              eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
              eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
            ),
          )
          .run()
        if (affectedRows(result) !== 1) throw leaseLost(eventId, input.claim.consumerId)
      })
    },

    async reject(input) {
      assertPositiveInteger(input.maxAttempts, 'maxAttempts')
      const eventId = input.claim.event.envelope.eventId
      const terminal = input.claim.attemptCount >= input.maxAttempts
      await session.transaction(async (tx) => {
        const result = await tx
          .update(committedEventDeliveries)
          .set({
            state: terminal ? 'dead-letter' : 'pending',
            claimedBy: null,
            claimExpiresAt: null,
            nextAttemptAt: terminal
              ? input.now
              : input.now +
                Math.min(30_000, 1_000 * 2 ** Math.max(0, input.claim.attemptCount - 1)),
            lastErrorCode: input.errorCode.slice(0, 200),
            lastErrorSummary: input.errorSummary.slice(0, 2_000),
            deadLetterAt: terminal ? input.now : null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(committedEventDeliveries.eventId, eventId),
              eq(committedEventDeliveries.consumerId, input.claim.consumerId),
              eq(committedEventDeliveries.state, 'claimed'),
              eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
              eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
            ),
          )
          .run()
        if (affectedRows(result) !== 1) throw leaseLost(eventId, input.claim.consumerId)
      })
      return terminal ? 'dead-letter' : 'retried'
    },

    async retry(input) {
      assertNonNegativeInteger(input.observedLeaseEpoch, 'observedLeaseEpoch')
      assertNonNegativeInteger(input.observedUpdatedAt, 'observedUpdatedAt')
      const at = input.now ?? Date.now()
      return await session.transaction(async (tx) => {
        const result = await tx
          .update(committedEventDeliveries)
          .set({
            state: 'pending',
            nextAttemptAt: at,
            claimedBy: null,
            claimExpiresAt: null,
            lastErrorCode: null,
            lastErrorSummary: null,
            deadLetterAt: null,
            replayGeneration: sql`${committedEventDeliveries.replayGeneration} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(committedEventDeliveries.eventId, input.eventId),
              eq(committedEventDeliveries.consumerId, input.consumerId),
              eq(committedEventDeliveries.state, 'dead-letter'),
              eq(committedEventDeliveries.leaseEpoch, input.observedLeaseEpoch),
              eq(committedEventDeliveries.updatedAt, input.observedUpdatedAt),
            ),
          )
          .run()
        if (affectedRows(result) !== 1) {
          throw new Error(
            `committed event delivery retry lost CAS: ${input.eventId}/${input.consumerId}`,
          )
        }
        // 回执里的 replayGeneration 是 SQL 自增出来的，只能读回；同一事务内读，看得到自己的写。
        const rows = await tx
          .select({
            replayGeneration: committedEventDeliveries.replayGeneration,
            updatedAt: committedEventDeliveries.updatedAt,
          })
          .from(committedEventDeliveries)
          .where(
            and(
              eq(committedEventDeliveries.eventId, input.eventId),
              eq(committedEventDeliveries.consumerId, input.consumerId),
            ),
          )
          .all()
        const row = rows[0]
        if (row === undefined) {
          throw new Error(
            `committed event delivery retry lost CAS: ${input.eventId}/${input.consumerId}`,
          )
        }
        return {
          eventId: input.eventId,
          consumerId: input.consumerId,
          replayGeneration: row.replayGeneration,
          state: 'pending' as const,
          updatedAt: row.updatedAt,
        }
      })
    },

    async deliveryPage(input): Promise<CommittedEventDeliveryPage> {
      assertPositiveInteger(input.page, 'page')
      assertPositiveInteger(input.limit, 'limit')
      const conditions = pageConditions(input)
      const where = conditions.length === 0 ? undefined : and(...conditions)
      const countRows = await db
        .select({ count: count() })
        .from(committedEventDeliveries)
        .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
        .where(where)
        .all()
      const total = Number(countRows[0]?.count ?? 0)
      const rows = await db
        .select({ event: committedEvents, delivery: committedEventDeliveries })
        .from(committedEventDeliveries)
        .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
        .where(where)
        .orderBy(desc(committedEventDeliveries.updatedAt), desc(committedEvents.id))
        .limit(input.limit)
        .offset((input.page - 1) * input.limit)
        .all()
      return {
        items: rows.map(({ event, delivery }) => ({
          eventId: event.id,
          stage: stageOf(delivery.consumerId),
          producer: event.producer,
          family: event.family,
          eventType: event.eventType,
          aggregateKind: event.aggregateKind,
          aggregateId: event.aggregateId,
          aggregateSeq: event.aggregateSeq,
          consumerId: delivery.consumerId,
          mode: event.deliveryMode,
          state: delivery.state,
          attemptCount: delivery.attemptCount,
          nextAttemptAt:
            delivery.state === 'accepted' || delivery.state === 'dead-letter'
              ? null
              : new Date(delivery.nextAttemptAt).toISOString(),
          leaseEpoch: delivery.leaseEpoch,
          lastErrorSummary: delivery.lastErrorSummary,
          updatedAt: new Date(delivery.updatedAt).toISOString(),
          canRetry: event.deliveryMode === 'dispatchable' && delivery.state === 'dead-letter',
        })),
        page: input.page,
        limit: input.limit,
        total,
        pageCount: Math.max(1, Math.ceil(total / input.limit)),
      }
    },

    async health() {
      const rows = await db
        .select({
          state: committedEventDeliveries.state,
          createdAt: committedEventDeliveries.createdAt,
          updatedAt: committedEventDeliveries.updatedAt,
          lastErrorSummary: committedEventDeliveries.lastErrorSummary,
        })
        .from(committedEventDeliveries)
        .all()
      const pendingRows = rows.filter((row) => row.state === 'pending')
      const lastError = [...rows]
        .filter((row) => row.lastErrorSummary !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      return {
        pending: pendingRows.length,
        claimed: rows.filter((row) => row.state === 'claimed').length,
        deadLetter: rows.filter((row) => row.state === 'dead-letter').length,
        oldestPendingAt:
          pendingRows.length === 0 ? null : Math.min(...pendingRows.map((row) => row.createdAt)),
        lastErrorSummary: lastError?.lastErrorSummary ?? null,
      }
    },
  }
}
