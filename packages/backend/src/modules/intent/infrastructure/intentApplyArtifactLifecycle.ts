import { decodeCurrentIntentArtifact } from './intentApplyCurrentCodec'
import { rollForwardLegacySkillArtifacts } from './intentApplyLegacyCodec'
export { decodeIntentApplyRecoveryArtifacts } from './intentApplyArtifactCodec'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { IntentArtifactContentPort } from '../application/ports/intentArtifactContent'
import { createFileIntentArtifactContent } from './local/fileIntentArtifactContent'
import { and, eq } from 'drizzle-orm'

import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type {
  LegacyIntentSkillArtifactCompat,
  PostgresqlSkillArtifactCompensation,
} from '../ports/skillArtifactCompensation'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntentJournalArtifact } from '../domain/journalArtifacts'
import { INTENT_APPLY_DIAGNOSTICS } from '../application/journalConvergence'
import type { Logger } from '@/util/log'
import type { IntentApplyArtifactLifecycle, IntentApplyRecoveryArtifact } from './intentApplyEngine'

export type { IntentApplyRecoveryArtifact }

function operationIdOf(artifact: IntentApplyArtifact): string {
  return artifact.kind === 'plugin-install' ? artifact.generationId : artifact.operationId
}

function versionOf(
  artifact: Extract<IntentApplyArtifact, { kind: 'skill-stage' | 'skill-version-stage' }>,
): number {
  return artifact.kind === 'skill-stage' ? 1 : artifact.version
}

async function assertPluginPublished(input: {
  readonly db: PersistenceDb
  readonly artifact: Extract<IntentApplyRecoveryArtifact, { kind: 'plugin-install' }>
  readonly content: IntentArtifactContentPort
}): Promise<void> {
  const { plugins } = tablesOf(input.db)
  const row = await first(
    input.db
      .select({ cachedPath: plugins.cachedPath })
      .from(plugins)
      .where(eq(plugins.id, input.artifact.pluginId))
      .limit(1),
  )
  if (row === undefined) return
  if (!(await input.content.pluginExists(row.cachedPath))) {
    throw new Error(`intent-apply-plugin-publication-missing:${input.artifact.pluginId}`)
  }
}

async function rollForwardPostgresqlSkill(input: {
  readonly content: IntentArtifactContentPort
  readonly db: PersistenceDb
  readonly artifact: Extract<IntentApplyArtifact, { kind: 'skill-stage' | 'skill-version-stage' }>
}): Promise<void> {
  const version = versionOf(input.artifact)
  const { skills, skillVersions } = tablesOf(input.db)
  const skill = await first(
    input.db
      .select({ managedPath: skills.managedPath, contentVersion: skills.contentVersion })
      .from(skills)
      .where(eq(skills.id, input.artifact.skillId))
      .limit(1),
  )
  if (skill === undefined) {
    await input.content.discardSkill({ artifact: input.artifact, version })
    return
  }
  if (skill.managedPath === null || skill.contentVersion < version) {
    throw new Error(`intent-apply-skill-publication-missing:${input.artifact.skillId}`)
  }
  const snapshot = await first(
    input.db
      .select({ filesPath: skillVersions.filesPath, contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, input.artifact.skillId),
          eq(skillVersions.versionIndex, version),
        ),
      )
      .limit(1),
  )
  if (snapshot === undefined || snapshot.contentHash === null) {
    throw new Error(`intent-apply-skill-snapshot-missing:${input.artifact.skillId}:${version}`)
  }

  await input.content.publishSkill({
    artifact: input.artifact,
    version,
    managedPath: skill.managedPath,
    disposition: skill.contentVersion > version ? 'superseded' : 'current',
    filesPath: snapshot.filesPath,
    contentHash: snapshot.contentHash,
  })
}

/** Real PostgreSQL artifact recovery shared by apply-time and boot/hourly convergence. */
interface IntentArtifactLifecycleBaseDependencies {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly legacySkillArtifacts?: LegacyIntentSkillArtifactCompat
}

type IntentArtifactLifecycleDependencies = IntentArtifactLifecycleBaseDependencies &
  (
    | {
        readonly content: IntentArtifactContentPort
        readonly skillArtifacts?: PostgresqlSkillArtifactCompensation
      }
    | { readonly content?: undefined; readonly skillArtifacts: PostgresqlSkillArtifactCompensation }
  )

export function createIntentApplyArtifactLifecycle(
  input: IntentArtifactLifecycleDependencies,
): IntentApplyArtifactLifecycle {
  const content =
    input.content !== undefined
      ? input.content
      : createFileIntentArtifactContent({
          appHome: input.appHome,
          pluginsDir: input.pluginsDir,
          skillArtifacts: input.skillArtifacts,
        })
  return Object.freeze({
    async compensate(artifact: Parameters<IntentApplyArtifactLifecycle['compensate']>[0]) {
      const postgresql = decodeCurrentIntentArtifact(artifact)
      if (postgresql?.kind === 'plugin-install') {
        await content.discardPlugin(postgresql.generationDir)
        return
      }
      if (postgresql?.kind === 'skill-stage' || postgresql?.kind === 'skill-version-stage') {
        await content.discardSkill({ artifact: postgresql, version: versionOf(postgresql) })
        return
      }
      await content.discardLegacy(artifact as IntentJournalArtifact)
    },
    async rollForward(
      artifacts: Parameters<IntentApplyArtifactLifecycle['rollForward']>[0],
      log: Logger,
    ) {
      let complete = true
      // 旧词汇的技能工件按**批**前滚（先整批 unmark、再逐条发布），与合一之前 SQLite 那台
      // 引擎的顺序逐字相同——单条处理会让「同一次 apply 里多个技能版本」的 boot 标记状态
      // 中途可见。
      const legacySkillArtifacts: IntentJournalArtifact[] = []
      for (const artifact of artifacts) {
        try {
          const postgresql = decodeCurrentIntentArtifact(artifact)
          if (postgresql?.kind === 'plugin-install') {
            await assertPluginPublished({ db: input.db, artifact: postgresql, content })
            continue
          }
          if (postgresql?.kind === 'skill-stage' || postgresql?.kind === 'skill-version-stage') {
            await rollForwardPostgresqlSkill({
              content,
              db: input.db,
              artifact: postgresql,
            })
            continue
          }
          if ((artifact as IntentJournalArtifact).kind === 'legacy-plugin-install-untracked') {
            continue
          }
          const legacy = artifact as IntentJournalArtifact
          if (legacy.kind === 'skill-stage' || legacy.kind === 'skill-version-stage') {
            const skillId = legacy.kind === 'skill-stage' ? legacy.skillId : legacy.staged.skillId
            const { skills } = tablesOf(input.db)
            const skill = await first(
              input.db.select({ id: skills.id }).from(skills).where(eq(skills.id, skillId)),
            )
            if (skill === undefined) {
              // RFC-395 II-a A6：已删除技能不再发布，但仍须清掉这次 journal 的暂存内容。
              await content.discardLegacy(legacy)
              continue
            }
          }
          legacySkillArtifacts.push(legacy)
          continue
        } catch (error) {
          complete = false
          log.warn(INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable, {
            kind: artifact.kind,
            operationId:
              decodeCurrentIntentArtifact(artifact) === null
                ? 'legacy'
                : operationIdOf(decodeCurrentIntentArtifact(artifact)!),
            err: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (legacySkillArtifacts.length > 0) {
        const recovery = input.legacySkillArtifacts
        if (recovery === undefined) {
          complete = false
          log.warn(INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable, {
            kind: 'legacy-skill',
            operationId: 'legacy',
            err: 'legacy intent artifact recovery is not composed',
          })
        } else if (
          !(await rollForwardLegacySkillArtifacts({
            recovery,
            db: input.db,
            appHome: input.appHome,
            artifacts: legacySkillArtifacts,
            log,
          }))
        ) {
          complete = false
        }
      }
      return complete
    },
  })
}
