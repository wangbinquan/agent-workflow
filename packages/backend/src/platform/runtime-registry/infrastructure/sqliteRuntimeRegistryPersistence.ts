import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { agents, runtimes } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  transitionInheritedRuntimeTestsInTx,
  transitionRuntimeTestsInTx,
} from '@/modules/resource-catalog/infrastructure/legacy/mcpRuntimeTestTransitions'
import type {
  RuntimeRegistryPersistence,
  RuntimeRow,
  RuntimeUpdateRecord,
} from '../application/runtimeRegistryOperations'

function runtimePatch(patch: RuntimeUpdateRecord): Record<string, unknown> {
  const { incrementProbeFence, ...values } = patch
  return incrementProbeFence ? { ...values, probeFence: sql`${runtimes.probeFence} + 1` } : values
}

export class SqliteRuntimeRegistryPersistence implements RuntimeRegistryPersistence {
  constructor(private readonly db: DbClient) {}

  async listRuntimes(): Promise<readonly RuntimeRow[]> {
    return this.db.select().from(runtimes).all()
  }

  async getRuntime(name: string): Promise<RuntimeRow | null> {
    return this.db.select().from(runtimes).where(eq(runtimes.name, name)).get() ?? null
  }

  async insertRuntime(record: Parameters<RuntimeRegistryPersistence['insertRuntime']>[0]) {
    this.db.insert(runtimes).values(record).run()
  }

  async updateRuntime(
    input: Parameters<RuntimeRegistryPersistence['updateRuntime']>[0],
  ): Promise<void> {
    dbTxSync(this.db, (transaction) => {
      transaction
        .update(runtimes)
        .set(runtimePatch(input.patch))
        .where(eq(runtimes.name, input.name))
        .run()
      if (input.executionProfileChanged) {
        transitionRuntimeTestsInTx(transaction, {
          runtimeName: input.name,
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
    const updated = this.db
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
      .all()
    return updated.length === 1
  }

  async invalidateInheritedRuntimeProbeReceipts(
    input: Parameters<RuntimeRegistryPersistence['invalidateInheritedRuntimeProbeReceipts']>[0],
  ): Promise<number> {
    if (input.protocols.length === 0) return 0
    return dbTxSync(this.db, (transaction) => {
      const updated = transaction
        .update(runtimes)
        .set({
          probeFence: sql`${runtimes.probeFence} + 1`,
          lastProbeJson: null,
          updatedAt: input.now,
        })
        .where(and(inArray(runtimes.protocol, [...input.protocols]), isNull(runtimes.binaryPath)))
        .returning({ id: runtimes.id })
        .all()
      transitionInheritedRuntimeTestsInTx(transaction, {
        protocols: input.protocols,
        now: input.now,
      })
      return updated.length
    })
  }

  async setRuntimeEnabled(
    input: Parameters<RuntimeRegistryPersistence['setRuntimeEnabled']>[0],
  ): ReturnType<RuntimeRegistryPersistence['setRuntimeEnabled']> {
    return dbTxSync(this.db, (transaction) => {
      const row = transaction
        .select({ enabled: runtimes.enabled })
        .from(runtimes)
        .where(eq(runtimes.name, input.name))
        .get()
      if (row === undefined) return { status: 'not-found' as const }
      if (!input.enabled && input.name === input.effectiveDefaultName) {
        return { status: 'default-cannot-disable' as const }
      }
      if (row.enabled === input.enabled) return { status: 'unchanged' as const }
      transaction
        .update(runtimes)
        .set({ enabled: input.enabled, updatedAt: input.now })
        .where(eq(runtimes.name, input.name))
        .run()
      if (!input.enabled) {
        transitionRuntimeTestsInTx(transaction, {
          runtimeName: input.name,
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
    return dbTxSync(this.db, (transaction) => {
      const all = transaction
        .select({ name: runtimes.name, binaryPath: runtimes.binaryPath })
        .from(runtimes)
        .all()
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
      const referencedAgents = transaction
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.runtime, input.name))
        .all()
      references.push(...referencedAgents.map((agent) => `agent '${agent.name}'`))
      if (references.length > 0) return { status: 'in-use' as const, references }

      transitionRuntimeTestsInTx(transaction, {
        runtimeName: input.name,
        reason: 'runtime-deleted',
        now: input.now,
      })
      transaction.delete(runtimes).where(eq(runtimes.name, input.name)).run()
      return { status: 'deleted' as const, binaryPath: row.binaryPath }
    })
  }

  async seedBuiltinRuntimes(
    builtins: Parameters<RuntimeRegistryPersistence['seedBuiltinRuntimes']>[0],
  ): Promise<void> {
    dbTxSync(this.db, (transaction) => {
      const exists = transaction.select({ id: runtimes.id }).from(runtimes).limit(1).get()
      if (exists !== undefined) return
      for (const builtin of builtins) transaction.insert(runtimes).values(builtin).run()
    })
  }

  async backfillBuiltinBinary(
    input: Parameters<RuntimeRegistryPersistence['backfillBuiltinBinary']>[0],
  ): Promise<void> {
    this.db
      .update(runtimes)
      .set({ binaryPath: input.binaryPath, updatedAt: input.updatedAt })
      .where(
        and(
          eq(runtimes.name, input.name),
          eq(runtimes.protocol, input.protocol),
          isNull(runtimes.binaryPath),
        ),
      )
      .run()
  }

  async listBuiltinProfiles(
    names: Parameters<RuntimeRegistryPersistence['listBuiltinProfiles']>[0],
  ): ReturnType<RuntimeRegistryPersistence['listBuiltinProfiles']> {
    if (names.length === 0) return []
    return this.db
      .select({
        name: runtimes.name,
        protocol: runtimes.protocol,
        model: runtimes.model,
        variant: runtimes.variant,
        temperature: runtimes.temperature,
        steps: runtimes.steps,
        maxSteps: runtimes.maxSteps,
      })
      .from(runtimes)
      .where(inArray(runtimes.name, [...names]))
      .all()
  }
}
