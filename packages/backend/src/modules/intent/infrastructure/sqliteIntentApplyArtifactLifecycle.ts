import { existsSync, rmSync } from 'node:fs'
import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { plugins } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { INTENT_APPLY_DIAGNOSTICS } from '../application/journalConvergence'
import type { IntentJournalArtifact } from '@/modules/intent/domain/journalArtifacts'
import type { SqliteSkillArtifactCompensation } from '../ports/skillArtifactCompensation'
import type { Logger } from '@/util/log'

/** Closed artifact lifecycle consumed by the SQLite apply engine and recovery. */
export interface SqliteIntentApplyArtifactLifecycle {
  compensate(artifact: IntentJournalArtifact): Promise<void>
  /** False means at least one committed tail remains retryable. */
  rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger): Promise<boolean>
}

async function compensate(
  rc: SqliteSkillArtifactCompensation,
  db: DbClient,
  artifact: IntentJournalArtifact,
): Promise<void> {
  switch (artifact.kind) {
    case 'legacy-plugin-install-untracked':
      // Historical rows did not record a generation path. Installer GC owns
      // any residue; recovery must not pretend the old envelope was precise.
      return
    case 'plugin-install':
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      await rc.compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage': {
      await rc.abortStagedSkillVersion(db, artifact.staged)
      if (artifact.staged.opId === null) return
      const operation = rc.loadSkillOperationState(db, artifact.staged.opId)
      if (operation === undefined || operation.active === 1) {
        throw new Error(
          `skill version compensation remains active for operation ${artifact.staged.opId}`,
        )
      }
    }
  }
}

/**
 * RFC-359 W7 抬齐③ —— 插件发布是否真的落地了。
 *
 * 判据与 PostgreSQL 侧逐条相同（`postgresqlIntentApplyArtifactLifecycle.ts`
 * 的 `assertPluginPublished`）：行在 + 目录在 = 装成了。缺任一条就说明提交后的
 * 尾巴还没走完，这条 journal 行必须留着重试，而不是被当成已收敛。
 */
async function assertPluginPublished(db: DbClient, pluginId: string): Promise<void> {
  const [row] = await db
    .select({ cachedPath: plugins.cachedPath })
    .from(plugins)
    .where(eq(plugins.id, pluginId))
    .limit(1)
  if (row === undefined || !existsSync(row.cachedPath)) {
    throw new Error(`intent-apply-plugin-publication-missing:${pluginId}`)
  }
}

async function rollForward(
  rc: SqliteSkillArtifactCompensation,
  db: DbClient,
  appHome: string,
  artifacts: readonly IntentJournalArtifact[],
  log: Logger,
): Promise<boolean> {
  let complete = true

  // RFC-359 W7 抬齐③: plugin artifacts used to be skipped as a whole class here,
  // so "the plugin never actually installed" could not be discovered on this
  // path at all. Same check, same word as the PostgreSQL engine; per-artifact
  // isolation so one unfinished plugin does not hide the skill tails below.
  for (const artifact of artifacts) {
    if (artifact.kind !== 'plugin-install') continue
    try {
      await assertPluginPublished(db, artifact.pluginId)
    } catch (error) {
      complete = false
      log.warn(INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable, {
        kind: artifact.kind,
        operationId: artifact.generationId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const skillVersionStages = artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
  )
  const skillStages = artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-stage' ? [{ skillId: artifact.skillId, opId: artifact.opId }] : [],
  )

  const pendingSkillVersions: typeof skillVersionStages = []
  for (const staged of skillVersionStages) {
    if (staged.noop !== null) continue
    if (staged.opId === null) {
      pendingSkillVersions.push(staged)
      continue
    }
    const operation = rc.loadSkillOperationState(db, staged.opId)
    if (
      operation?.active === 1 &&
      (operation.phase === 'db-committed' || operation.phase === 'fs-published')
    ) {
      pendingSkillVersions.push(staged)
      continue
    }
    if (operation?.phase !== 'done') {
      complete = false
      log.warn('intent-skill-publish-op-not-replayable', {
        skillId: staged.skillId,
        opId: staged.opId,
        phase: operation?.phase ?? 'missing',
      })
    }
  }

  for (const staged of pendingSkillVersions) rc.unmarkSkillBootVerified(staged.skillId)
  for (const staged of pendingSkillVersions) {
    try {
      await rc.publishStagedSkillVersion(db, { appHome }, staged)
    } catch (error) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const stage of skillStages) {
    const operation = rc.loadSkillOperationState(db, stage.opId)
    if (operation?.active === 0 && operation.phase === 'done') continue
    if (operation?.active !== 1 || operation.phase !== 'db-committed') {
      complete = false
      log.warn('intent-skill-finish-op-not-replayable', {
        skillId: stage.skillId,
        opId: stage.opId,
        phase: operation?.phase ?? 'missing',
      })
      continue
    }
    try {
      await databaseSessionFor(db).transaction(
        async (transaction) => await rc.finishOperation(transaction, stage.opId),
      )
    } catch (error) {
      complete = false
      log.warn('intent-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return complete
}

export function createSqliteIntentApplyArtifactLifecycle(input: {
  readonly db: DbClient
  readonly appHome: string
  /** RFC-355 T6：技能工件的补偿原语由 resource-catalog 提供、bootstrap 注入。 */
  readonly skillArtifacts: SqliteSkillArtifactCompensation
}): SqliteIntentApplyArtifactLifecycle {
  return Object.freeze({
    async compensate(artifact: IntentJournalArtifact) {
      await compensate(input.skillArtifacts, input.db, artifact)
    },
    async rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger) {
      return await rollForward(input.skillArtifacts, input.db, input.appHome, artifacts, log)
    },
  })
}
