// RFC-359 W4-D28b —— runtime 注册表持久化：一份实现，两个 provider 共用。
//
// 合一前是 247 行（SQLite，`dbTxSync`）对 336 行（PostgreSQL，`SET TRANSACTION ISOLATION LEVEL
// SERIALIZABLE` + 40001 重放），十二个方法逐个同名同序、业务判据逐行相同——纯重复。PG 那份还把
// 会话失效逻辑（`transitionRuntimeTests` / `transitionRuntimeTest`）**内联重写了一遍**，与
// `legacy/mcpRuntimeTestTransitions.ts` 的同步版并存；两份逐字段对过账后合并进中立的
// `infrastructure/mcpRuntimeTestTransitions.ts`。
//
// **隔离级别按 PG 那份逐方法保留**（SQLite 的 `BEGIN IMMEDIATE` 本就全库独占，两种都满足）：
//   · `updateRuntime` / `invalidateInheritedRuntimeProbeReceipts` —— 普通写事务；
//   · `setRuntimeEnabled` / `deleteRuntime` / `seedBuiltinRuntimes` —— `serializable`
//     （都是「先查后写」跨行判据：默认 runtime 不能停用、最后一个 runtime 不能删、种子只种一次）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { RuntimeProfileTestInvalidationInTx } from '@/modules/resource-catalog/public/participants'
import type { RuntimeProfileUsageReader } from '../application/ports/runtimeProfileParticipants'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  RuntimeRegistryPersistence,
  RuntimeRow,
  RuntimeUpdateRecord,
} from '@/modules/runtime-management/application/ports/runtimeRegistry'

function runtimePatch(db: object, patch: RuntimeUpdateRecord): Record<string, unknown> {
  const { incrementProbeFence, ...values } = patch
  const { runtimes } = tablesOf(db)
  return incrementProbeFence ? { ...values, probeFence: sql`${runtimes.probeFence} + 1` } : values
}

export class DrizzleRuntimeRegistryPersistence implements RuntimeRegistryPersistence {
  constructor(
    private readonly db: PersistenceDb,
    private readonly participants: {
      readonly testInvalidation: RuntimeProfileTestInvalidationInTx<PersistenceTx>
      readonly usage: RuntimeProfileUsageReader<PersistenceTx>
    },
  ) {}

  async listRuntimes(): Promise<readonly RuntimeRow[]> {
    const { runtimes } = tablesOf(this.db)
    return await this.db.select().from(runtimes)
  }

  async getRuntime(name: string): Promise<RuntimeRow | null> {
    const { runtimes } = tablesOf(this.db)
    return (await first(this.db.select().from(runtimes).where(eq(runtimes.name, name)))) ?? null
  }

  async insertRuntime(record: Parameters<RuntimeRegistryPersistence['insertRuntime']>[0]) {
    const { runtimes } = tablesOf(this.db)
    await insertOne(this.db, runtimes, record)
  }

  async updateRuntime(
    input: Parameters<RuntimeRegistryPersistence['updateRuntime']>[0],
  ): Promise<void> {
    const persistenceDb = this.db

    await databaseSessionFor(this.db).transaction(async (transaction) => {
      const { runtimes } = tablesOf(transaction)
      await transaction
        .update(runtimes)
        .set(runtimePatch(persistenceDb, input.patch))
        .where(eq(runtimes.name, input.name))
      if (input.executionProfileChanged) {
        await this.participants.testInvalidation.invalidate(transaction, {
          runtimeNames: [input.name],
          reason: 'runtime-profile-changed',
          now: input.patch.updatedAt,
        })
      }
    })
  }

  async cacheRuntimeProbe(
    input: Parameters<RuntimeRegistryPersistence['cacheRuntimeProbe']>[0],
  ): Promise<boolean> {
    const fingerprint = input.target.fingerprint
    const { runtimes } = tablesOf(this.db)
    const updated = await this.db
      .update(runtimes)
      .set({ lastProbeJson: input.lastProbeJson, updatedAt: input.updatedAt })
      .where(
        and(
          eq(runtimes.id, input.target.id),
          eq(runtimes.name, input.target.name),
          eq(runtimes.probeFence, input.target.probeFence),
          eq(runtimes.protocol, fingerprint.protocol),
          fingerprint.binaryPath === null
            ? isNull(runtimes.binaryPath)
            : eq(runtimes.binaryPath, fingerprint.binaryPath),
          fingerprint.model === null
            ? isNull(runtimes.model)
            : eq(runtimes.model, fingerprint.model),
          fingerprint.variant === null
            ? isNull(runtimes.variant)
            : eq(runtimes.variant, fingerprint.variant),
          fingerprint.temperature === null
            ? isNull(runtimes.temperature)
            : eq(runtimes.temperature, fingerprint.temperature),
          fingerprint.steps === null
            ? isNull(runtimes.steps)
            : eq(runtimes.steps, fingerprint.steps),
          fingerprint.maxSteps === null
            ? isNull(runtimes.maxSteps)
            : eq(runtimes.maxSteps, fingerprint.maxSteps),
          eq(runtimes.isSandbox, fingerprint.isSandbox),
          fingerprint.configDirEnv === null
            ? isNull(runtimes.configDirEnv)
            : eq(runtimes.configDirEnv, fingerprint.configDirEnv),
          fingerprint.configDirName === null
            ? isNull(runtimes.configDirName)
            : eq(runtimes.configDirName, fingerprint.configDirName),
        ),
      )
      .returning({ id: runtimes.id })
    return updated.length === 1
  }

  async invalidateInheritedRuntimeProbeReceipts(
    input: Parameters<RuntimeRegistryPersistence['invalidateInheritedRuntimeProbeReceipts']>[0],
  ): Promise<number> {
    if (input.protocols.length === 0) return 0
    return await databaseSessionFor(this.db).transaction(async (transaction) => {
      const { runtimes } = tablesOf(transaction)
      const updated = await transaction
        .update(runtimes)
        .set({
          probeFence: sql`${runtimes.probeFence} + 1`,
          lastProbeJson: null,
          updatedAt: input.now,
        })
        .where(and(inArray(runtimes.protocol, [...input.protocols]), isNull(runtimes.binaryPath)))
        .returning({ name: runtimes.name })
      await this.participants.testInvalidation.invalidate(transaction, {
        runtimeNames: updated.map((row) => row.name),
        reason: 'runtime-profile-changed',
        now: input.now,
      })
      return updated.length
    })
  }

  async setRuntimeEnabled(
    input: Parameters<RuntimeRegistryPersistence['setRuntimeEnabled']>[0],
  ): ReturnType<RuntimeRegistryPersistence['setRuntimeEnabled']> {
    return await databaseSessionFor(this.db).serializable(async (transaction) => {
      const { runtimes } = tablesOf(transaction)
      const row = await first(
        transaction
          .select({ enabled: runtimes.enabled })
          .from(runtimes)
          .where(eq(runtimes.name, input.name)),
      )
      if (row === undefined) return { status: 'not-found' as const }
      if (!input.enabled && input.name === input.effectiveDefaultName) {
        return { status: 'default-cannot-disable' as const }
      }
      if (row.enabled === input.enabled) return { status: 'unchanged' as const }
      await transaction
        .update(runtimes)
        .set({ enabled: input.enabled, updatedAt: input.now })
        .where(eq(runtimes.name, input.name))
      if (!input.enabled) {
        await this.participants.testInvalidation.invalidate(transaction, {
          runtimeNames: [input.name],
          reason: 'runtime-disabled',
          now: input.now,
        })
      }
      return { status: 'changed' as const }
    })
  }

  async deleteRuntime(
    input: Parameters<RuntimeRegistryPersistence['deleteRuntime']>[0],
  ): ReturnType<RuntimeRegistryPersistence['deleteRuntime']> {
    return await databaseSessionFor(this.db).serializable(async (transaction) => {
      const { runtimes } = tablesOf(transaction)
      const all = await transaction
        .select({ name: runtimes.name, binaryPath: runtimes.binaryPath })
        .from(runtimes)
      const row = all.find((candidate) => candidate.name === input.name)
      if (row === undefined) return { status: 'not-found' as const }
      if (all.length <= 1) return { status: 'last-runtime' as const }

      const configured = input.refs.defaultRuntime
      const configuredResolves =
        configured != null &&
        configured.length > 0 &&
        (all.some((candidate) => candidate.name === configured) ||
          input.builtinNames.has(configured))
      const effectiveDefault = configuredResolves ? configured : 'opencode'
      const references: string[] = []
      if (effectiveDefault === input.name) references.push('config.defaultRuntime')
      if (input.refs.memoryDistillRuntime === input.name) {
        references.push('config.memoryDistillRuntime')
      }
      if (input.refs.commitPushRuntime === input.name) references.push('config.commitPushRuntime')
      if (input.refs.mergeAgentRuntime === input.name) references.push('config.mergeAgentRuntime')
      if (input.refs.intentBuilderRuntime === input.name) {
        references.push('config.intentBuilderRuntime')
      }
      if (input.refs.changeNarrativeRuntime === input.name) {
        references.push('config.changeNarrativeRuntime')
      }
      references.push(
        ...(await this.participants.usage.inspect(transaction, { runtimeName: input.name })),
      )
      if (references.length > 0) return { status: 'in-use' as const, references }

      await this.participants.testInvalidation.invalidate(transaction, {
        runtimeNames: [input.name],
        reason: 'runtime-deleted',
        now: input.now,
      })
      await transaction.delete(runtimes).where(eq(runtimes.name, input.name))
      return { status: 'deleted' as const, binaryPath: row.binaryPath }
    })
  }

  async seedBuiltinRuntimes(
    builtins: Parameters<RuntimeRegistryPersistence['seedBuiltinRuntimes']>[0],
  ): Promise<void> {
    await databaseSessionFor(this.db).serializable(async (transaction) => {
      const { runtimes } = tablesOf(transaction)
      const exists = await first(transaction.select({ id: runtimes.id }).from(runtimes).limit(1))
      if (exists !== undefined) return
      for (const builtin of builtins) await insertOne(transaction, runtimes, builtin)
    })
  }
}
