// RFC-338 / RFC-359 W8 —— 维护 run 的耐久准入 + 租约存储：**一份实现，两个 provider 共用**。
//
// # 语义（RFC-338 起不变）
//
// 认领之后的每一次状态迁移都带**精确的租约 token** 作围栏：一个崩掉 / 被顶替的 Worker 迟到的
// 结算收据改不动它的后继者那一行。「同一 job 同时最多一条在排队 / 最多一条在跑」由 DB 的两条
// 部分唯一索引兜底（`idx_maintenance_runs_one_queued` / `_one_running`，见 0216 迁移），
// 应用层的 enqueue / recover / deferred-settle 只负责在事务里把补课槽原子吸收掉。
//
// # 为什么合成一份（本文件的由来）
//
// 合一之前这一对是：SQLite 侧一份**同步**实现（4 处 `dbTxSync`）外面套一层逐方法
// `async X(){ return store.X(...) }` 的恒等适配器；PostgreSQL 侧一份原生重写（4 处
// `db.transaction`）。同一张状态机表抄了两遍，而 PG 那一份在**真库上**从来没有被执行过——
// 它此前的全部覆盖是脚本化 SQL 抄本。合一的前提（`tests/rfc359-w8-maintenance-run-store-
// conformance.test.ts`）先把同一批场景通过同一个端口在两个真引擎上各跑一遍：40 条判据两侧
// 全绿、**零行为差异**，这一对是真的可以直接合。
//
// 事务边界走中立原语 `databaseSessionFor(db).transaction(...)`：SQLite 上是显式
// `BEGIN IMMEDIATE` + async 体 + `COMMIT`/`ROLLBACK`（不碰 bun:sqlite 那个会在第一个 await
// 处提前 COMMIT 的同步包装器），PostgreSQL 上是驱动自己的 async 事务，两侧语义相同。
//
// # 唯一一处按引擎渲染：NULL 落位
//
// `readProjection` 的 `ORDER BY … DESC` 必须显式要 NULL 排最后。两个引擎的默认**正好相反**
// （SQLite 视 NULL 最小、PostgreSQL 视 NULL 最大），裸 `desc(...)` 会让 PostgreSQL 把一条
// 还没开工 / 还没收工的行选成 active / last。端口自己造不出这种行，但逻辑复制 / 恢复出来的库
// 里有，所以从能力矩阵取 `descNullsLast`，判据锁在上面那份对拍文件里。

import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { maintenanceRuns } from '@/db/schema'
import type {
  ClaimedMaintenanceRun,
  MaintenanceRunRecord,
  MaintenanceRunStore,
} from '@/platform/background/maintenanceRunStorePort'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

const QUEUED = ['pending', 'deferred'] as const

function json(value: unknown): string {
  return JSON.stringify(value ?? {})
}

function record(value: typeof maintenanceRuns.$inferSelect): MaintenanceRunRecord {
  return value
}

export function createMaintenanceRunStore(db: ProviderNeutralDatabase): MaintenanceRunStore {
  const session = databaseSessionFor(db)

  const store: MaintenanceRunStore = {
    async enqueue(input) {
      return await session.transaction(async (tx) => {
        const current = (
          await tx
            .select()
            .from(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, input.jobKey),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
            .orderBy(asc(maintenanceRuns.createdAt))
            .limit(1)
        )[0]
        if (current !== undefined) {
          return { row: record(current), inserted: false, coalesced: true }
        }

        await tx
          .insert(maintenanceRuns)
          .values({
            id: input.id,
            jobKey: input.jobKey,
            jobClass: input.jobClass,
            slotKey: input.slotKey,
            cycleKey: input.cycleKey ?? null,
            state: 'pending',
            payloadJson: json(input.payload),
            scheduledAt: input.scheduledAt,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()

        const exact = (
          await tx
            .select()
            .from(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, input.jobKey),
                eq(maintenanceRuns.slotKey, input.slotKey),
              ),
            )
            .limit(1)
        )[0]
        if (exact !== undefined) {
          return { row: record(exact), inserted: exact.id === input.id, coalesced: false }
        }
        // A concurrent connection may have won the one-queued partial unique
        // index with a different slot after our first read.
        const winner = (
          await tx
            .select()
            .from(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, input.jobKey),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
            .limit(1)
        )[0]
        if (winner === undefined) throw new Error('maintenance-enqueue-lost')
        return { row: record(winner), inserted: false, coalesced: true }
      })
    },

    async recoverRunning(now) {
      return await session.transaction(async (tx) => {
        const rows = await tx
          .select({ id: maintenanceRuns.id, jobKey: maintenanceRuns.jobKey })
          .from(maintenanceRuns)
          .where(eq(maintenanceRuns.state, 'running'))
        let recovered = 0
        for (const candidate of rows) {
          // A future schedule slot is allowed to queue while this job is
          // running. Recovery resumes the interrupted cursor and therefore
          // absorbs that queued catch-up before running -> deferred, preserving
          // the one-queued-per-job invariant atomically.
          await tx
            .delete(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, candidate.jobKey),
                ne(maintenanceRuns.id, candidate.id),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
          const updated = await tx
            .update(maintenanceRuns)
            .set({
              state: 'deferred',
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              scheduledAt: now,
              updatedAt: now,
              errorCode: 'worker-restarted',
              errorMessage: 'maintenance worker restarted before completion receipt',
            })
            .where(and(eq(maintenanceRuns.id, candidate.id), eq(maintenanceRuns.state, 'running')))
            .returning({ id: maintenanceRuns.id })
          recovered += updated.length
        }
        return recovered
      })
    },

    async claimNext(input): Promise<ClaimedMaintenanceRun | null> {
      return await session.transaction(async (tx) => {
        const candidate = (
          await tx
            .select()
            .from(maintenanceRuns)
            .where(
              and(
                inArray(maintenanceRuns.state, ['pending', 'deferred']),
                lte(maintenanceRuns.scheduledAt, input.now),
              ),
            )
            .orderBy(
              sql`case ${maintenanceRuns.jobClass}
              when 'recovery' then 0
              when 'checkpoint' then 1
              else 2 end`,
              asc(maintenanceRuns.scheduledAt),
              asc(maintenanceRuns.createdAt),
            )
            .limit(1)
        )[0]
        if (candidate === undefined) return null
        const claimed = await tx
          .update(maintenanceRuns)
          .set({
            state: 'running',
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.now + input.leaseMs,
            heartbeatAt: input.now,
            attempt: sql`${maintenanceRuns.attempt} + 1`,
            startedAt: candidate.startedAt ?? input.now,
            updatedAt: input.now,
            errorCode: null,
            errorMessage: null,
          })
          .where(
            and(
              eq(maintenanceRuns.id, candidate.id),
              inArray(maintenanceRuns.state, ['pending', 'deferred']),
            ),
          )
          .returning()
        return claimed[0] === undefined
          ? null
          : { row: record(claimed[0]), leaseToken: input.leaseToken }
      })
    },

    async heartbeat(input) {
      // Single fenced statement: atomic on its own, no transaction needed.
      const updated = await db
        .update(maintenanceRuns)
        .set({
          heartbeatAt: input.now,
          leaseExpiresAt: input.now + input.leaseMs,
          updatedAt: input.now,
          ...(input.counters === undefined ? {} : { countersJson: json(input.counters) }),
        })
        .where(
          and(
            eq(maintenanceRuns.id, input.runId),
            eq(maintenanceRuns.state, 'running'),
            eq(maintenanceRuns.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: maintenanceRuns.id })
      return updated.length === 1
    },

    async settle(input) {
      if (input.outcome === 'deferred') {
        return await session.transaction(async (tx) => {
          const owned = (
            await tx
              .select({ jobKey: maintenanceRuns.jobKey })
              .from(maintenanceRuns)
              .where(
                and(
                  eq(maintenanceRuns.id, input.runId),
                  eq(maintenanceRuns.state, 'running'),
                  eq(maintenanceRuns.leaseToken, input.leaseToken),
                ),
              )
              .limit(1)
          )[0]
          if (owned === undefined) return false
          // A later schedule slot may already be queued while this slice is
          // running. The retrying current slice subsumes that one catch-up;
          // remove the unclaimed row before changing current -> deferred so
          // the one-queued invariant stays true.
          await tx
            .delete(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, owned.jobKey),
                ne(maintenanceRuns.id, input.runId),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
          const updated = await tx
            .update(maintenanceRuns)
            .set({
              state: 'deferred',
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              countersJson: json(input.counters ?? {}),
              cursorJson:
                input.cursor === undefined || input.cursor === null ? null : json(input.cursor),
              sliceNo: sql`${maintenanceRuns.sliceNo} + 1`,
              errorCode: input.errorCode ?? null,
              errorMessage: input.errorMessage ?? null,
              scheduledAt: input.nextAttemptAt ?? input.now,
              finishedAt: null,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(maintenanceRuns.id, input.runId),
                eq(maintenanceRuns.state, 'running'),
                eq(maintenanceRuns.leaseToken, input.leaseToken),
              ),
            )
            .returning({ id: maintenanceRuns.id })
          return updated.length === 1
        })
      }
      const updated = await db
        .update(maintenanceRuns)
        .set({
          state: input.outcome,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          countersJson: json(input.counters ?? {}),
          cursorJson:
            input.cursor === undefined || input.cursor === null ? null : json(input.cursor),
          sliceNo: sql`${maintenanceRuns.sliceNo} + 1`,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          scheduledAt: sql`${maintenanceRuns.scheduledAt}`,
          finishedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(maintenanceRuns.id, input.runId),
            eq(maintenanceRuns.state, 'running'),
            eq(maintenanceRuns.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: maintenanceRuns.id })
      return updated.length === 1
    },

    async read(runId) {
      const rows = await db
        .select()
        .from(maintenanceRuns)
        .where(eq(maintenanceRuns.id, runId))
        .limit(1)
      return rows[0] === undefined ? null : record(rows[0])
    },

    async readProjection() {
      // NULL 落位按 SQLite 语义显式渲染（见文件头注释）。
      const { descNullsLast } = session.engine
      const [activeRows, lastRows, backlog] = await Promise.all([
        db
          .select()
          .from(maintenanceRuns)
          .where(eq(maintenanceRuns.state, 'running'))
          .orderBy(descNullsLast(maintenanceRuns.startedAt))
          .limit(1),
        db
          .select()
          .from(maintenanceRuns)
          .where(inArray(maintenanceRuns.state, ['succeeded', 'failed']))
          .orderBy(descNullsLast(maintenanceRuns.finishedAt))
          .limit(1),
        db
          .select()
          .from(maintenanceRuns)
          .where(inArray(maintenanceRuns.state, ['pending', 'deferred', 'failed']))
          .orderBy(asc(maintenanceRuns.createdAt))
          .limit(50),
      ])
      return {
        active: activeRows[0] === undefined ? null : record(activeRows[0]),
        last: lastRows[0] === undefined ? null : record(lastRows[0]),
        backlog: backlog.map(record),
      }
    },
  }
  return Object.freeze(store)
}
