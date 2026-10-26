import { decodeCurrentIntentArtifact } from './intentApplyCurrentCodec'
export { decodeIntentApplyRecoveryArtifacts } from './intentApplyArtifactCodec'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { first } from '@/platform/persistence/queryHelpers'
import type { SkillContentLocationQuery } from '@/platform/content/contentStore'
import type { ContentRef } from '@/platform/content/contentRef'
import type { IntentArtifactContentPort } from '../application/ports/intentArtifactContent'
import { createFileIntentArtifactContent } from './local/fileIntentArtifactContent'
import { eq } from 'drizzle-orm'
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

function referencePath(ref: ContentRef, skillId: string, version: number | null): string {
  if (
    ref.kind === 'local-file' &&
    ref.location.codec === 'skill-path' &&
    typeof ref.location.value === 'string'
  )
    return ref.location.value
  if (ref.kind === 'database-bytes' && ref.location.codec === 'skill-tree') {
    const location = ref.location.value as { skillId?: unknown; tree?: unknown }
    const tree = version === null ? 'live' : `version:${version}`
    if (location?.skillId === skillId && location.tree === tree)
      return version === null
        ? `skills/${skillId}/files`
        : `skills/${skillId}/versions/v${version}/files`
  }
  throw new Error('intent-apply-skill-reference-invalid')
}

function operationArtifact(
  artifact: Exclude<IntentApplyArtifact, { kind: 'plugin-install' }>,
): IntentJournalArtifact | null {
  const recovery = artifact.recovery
  if (artifact.kind === 'skill-stage' && recovery?.kind === 'create')
    return {
      kind: 'skill-stage',
      skillId: artifact.skillId,
      opId: recovery.operationId,
      skillDir: recovery.rootDirectory,
    }
  if (artifact.kind === 'skill-version-stage' && recovery?.kind === 'version')
    return {
      kind: 'skill-version-stage',
      staged: {
        skillId: artifact.skillId,
        skillName: recovery.skillName,
        opId: recovery.operationId,
        publishId: recovery.publishId,
        newVersion: artifact.version,
        newHash: recovery.contentHash,
        filesDir: recovery.liveDirectory,
        versionDir: artifact.versionDirectory,
        stagingDir: artifact.stagingDirectory,
        noop: null,
      },
    }
  return null
}

interface IntentArtifactLifecycleBaseDependencies {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly skillContentLocations: SkillContentLocationQuery
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
    input.content ??
    createFileIntentArtifactContent({
      appHome: input.appHome,
      pluginsDir: input.pluginsDir,
      skillArtifacts: input.skillArtifacts!,
    })
  return Object.freeze({
    async compensate(value: IntentApplyRecoveryArtifact) {
      const artifact = decodeCurrentIntentArtifact(value)
      if (artifact === null) throw new Error('intent-apply-current-artifact-required')
      if (artifact.kind === 'plugin-install') {
        await content.discardPlugin(artifact.generationDir)
        return
      }
      const instructions = (value as IntentApplyArtifact & { kind: typeof artifact.kind }).recovery
      if (instructions?.kind === 'create') {
        // This is an already-published source root. Its bytes belong to content maintenance,
        // which checks live/history/backup holders; journal compensation never removes it.
        return
      }
      await content.discardSkill({
        artifact:
          instructions?.kind === 'version'
            ? { ...artifact, operationId: instructions.publishId }
            : artifact,
        version: artifact.kind === 'skill-stage' ? 1 : artifact.version,
      })
    },
    async rollForward(values: readonly IntentApplyRecoveryArtifact[], log: Logger) {
      let complete = true
      const operations: IntentJournalArtifact[] = []
      for (const value of values) {
        try {
          const decoded = decodeCurrentIntentArtifact(value)
          if (decoded === null) throw new Error('intent-apply-current-artifact-required')
          const artifact = {
            ...decoded,
            ...('recovery' in value ? { recovery: value.recovery } : {}),
          } as IntentApplyArtifact
          if (artifact.kind === 'plugin-install') {
            const { plugins } = tablesOf(input.db)
            const row = await first(
              input.db
                .select({ cachedPath: plugins.cachedPath })
                .from(plugins)
                .where(eq(plugins.id, artifact.pluginId))
                .limit(1),
            )
            if (row !== undefined && !(await content.pluginExists(row.cachedPath)))
              throw new Error(`intent-apply-plugin-publication-missing:${artifact.pluginId}`)
            continue
          }
          const version = artifact.kind === 'skill-stage' ? 1 : artifact.version
          const skill = await input.skillContentLocations.publication(artifact.skillId, version)
          if (skill === null) {
            if (artifact.recovery?.kind !== 'create')
              await content.discardSkill({
                artifact:
                  artifact.recovery?.kind === 'version'
                    ? { ...artifact, operationId: artifact.recovery.publishId }
                    : artifact,
                version,
              })
            continue
          }
          if (skill.live === null || skill.contentVersion < version)
            throw new Error(`intent-apply-skill-publication-missing:${artifact.skillId}`)
          const snapshot = skill.snapshot
          if (snapshot === null || snapshot.version !== version || snapshot.contentHash === null)
            throw new Error(`intent-apply-skill-snapshot-missing:${artifact.skillId}:${version}`)
          const managedPath = referencePath(skill.live, artifact.skillId, null)
          const filesPath = referencePath(snapshot.content, artifact.skillId, version)
          if (
            artifact.recovery?.kind === 'version' &&
            artifact.recovery.contentHash !== snapshot.contentHash
          )
            throw new Error(
              `intent-apply-skill-snapshot-hash-mismatch:${artifact.skillId}:${version}`,
            )
          const operation = operationArtifact(artifact)
          if (operation !== null) {
            if (skill.contentVersion > version) {
              if (artifact.recovery?.kind === 'version')
                await content.discardSkill({
                  artifact: { ...artifact, operationId: artifact.recovery.publishId },
                  version,
                })
              continue
            }
            operations.push(operation)
            continue
          }
          if (
            input.content === undefined &&
            (skill.live.kind !== 'local-file' || snapshot.content.kind !== 'local-file')
          )
            throw new Error('intent-apply-skill-content-binding-required')
          await content.publishSkill({
            artifact,
            version,
            managedPath,
            filesPath,
            contentHash: snapshot.contentHash,
            disposition: skill.contentVersion > version ? 'superseded' : 'current',
          })
        } catch (error) {
          complete = false
          log.warn(INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable, {
            kind: value.kind,
            operationId:
              value.kind === 'plugin-install'
                ? value.generationId
                : 'operationId' in value
                  ? value.operationId
                  : 'unrecognized',
            err: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (operations.length > 0) {
        if (input.legacySkillArtifacts === undefined) {
          complete = false
          log.warn(INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable, {
            kind: 'skill-operation',
            operationId: 'unconfigured',
            err: 'skill operation recovery is not composed',
          })
        } else if (
          !(await rollForwardSkillOperations({
            recovery: input.legacySkillArtifacts,
            db: input.db,
            appHome: input.appHome,
            artifacts: operations,
            log,
          }))
        )
          complete = false
      }
      return complete
    },
  })
}

export async function rollForwardSkillOperations(input: {
  readonly recovery: LegacyIntentSkillArtifactCompat
  readonly db: PersistenceDb
  readonly appHome: string
  readonly artifacts: readonly IntentJournalArtifact[]
  readonly log: Logger
}): Promise<boolean> {
  const { recovery, db, log } = input
  let complete = true

  const stagedVersions = input.artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
  )
  const stages = input.artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-stage' ? [{ skillId: artifact.skillId, opId: artifact.opId }] : [],
  )

  const pending: typeof stagedVersions = []
  for (const staged of stagedVersions) {
    if (staged.noop !== null) continue
    if (staged.opId === null) {
      pending.push(staged)
      continue
    }
    const operation = await recovery.loadSkillOperationState(db, staged.opId)
    if (
      operation?.active === 1 &&
      (operation.phase === 'db-committed' || operation.phase === 'fs-published')
    ) {
      pending.push(staged)
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

  for (const staged of pending) recovery.unmarkSkillBootVerified(staged.skillId)
  for (const staged of pending) {
    try {
      await recovery.publishStagedSkillVersion(db, { appHome: input.appHome }, staged)
    } catch (error) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const stage of stages) {
    const operation = await recovery.loadSkillOperationState(db, stage.opId)
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
        async (transaction) => await recovery.finishOperation(transaction, stage.opId),
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
