// Epoch-2 skill operation instructions. The factory name remains until A rewires composition.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { ResourcePackageRecoveryEffectsFactory } from '../application/package/recoveryContentEffects'
import {
  selectedResourcePackageRecoveryEffects,
  withResourcePackageRecoveryEffects,
} from './recoveryContentEffects'
import { pluginCachedPathQuery } from './pluginCachedPathQuery'
import { errorValue } from './resourcePackageMaintenancePaths'

import { eq } from 'drizzle-orm'
import {
  decodeResourcePackageArtifacts,
  decodeResourcePackageReceipt,
} from './resourcePackageArtifactCodec'
import { createSkillContentLocationQuery } from './databaseSkillTrees'

type SkillOperationArtifact =
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | {
      kind: 'skill-version-stage'
      staged: {
        skillId: string
        skillName: string
        opId: string | null
        publishId: string
        newVersion: number
        newHash: string
        filesDir: string
        versionDir: string
        stagingDir: string
        noop: null
      }
    }
  | { kind: 'plugin-install'; pluginId: string; generationId: string; generationDir: string }
type SkillVersionOperationArtifact = Extract<
  SkillOperationArtifact,
  { kind: 'skill-version-stage' }
>

function operationArtifacts(json: string): readonly SkillOperationArtifact[] {
  return decodeResourcePackageArtifacts(json).map((artifact): SkillOperationArtifact => {
    const recovery = artifact.recovery
    if (artifact.kind === 'plugin-install')
      return {
        kind: artifact.kind,
        pluginId: artifact.pluginId,
        generationId: artifact.generationId,
        generationDir: artifact.generationDirectory,
      }
    if (artifact.kind === 'skill-stage' && recovery?.kind === 'create')
      return {
        kind: artifact.kind,
        skillId: artifact.skillId,
        opId: recovery.operationId,
        skillDir: recovery.rootDirectory,
      }
    if (artifact.kind === 'skill-version-stage' && recovery?.kind === 'version')
      return {
        kind: artifact.kind,
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
    throw new Error('resource-package-skill-operation-instructions-missing')
  })
}

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { skillOperationStateQuery } from './skillOperationStateQuery'
import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
  ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'

import { markSkillBootVerified, unmarkSkillBootVerified } from './legacy/skillBootVerify'
import { resourcePackageSkillRecoveryDisposition } from '../domain/resourcePackageSkillRecovery'
import { abandonOperation, finishOperation } from './legacy/skillOperations'

async function publishStagedVersion(
  db: PersistenceDb,
  appHome: string,
  artifact: SkillVersionOperationArtifact,
  factory: ResourcePackageRecoveryEffectsFactory,
): Promise<void> {
  const staged = artifact.staged
  if (staged.noop !== null) return
  const filesDir = factory.live(staged.skillId)
  const versionDir = factory.version(staged.skillId, staged.newVersion)
  factory.assertManaged(appHome, filesDir)
  factory.assertManaged(appHome, versionDir)
  if (
    factory.normalize(staged.filesDir) !== factory.normalize(filesDir) ||
    factory.normalize(staged.versionDir) !== factory.normalize(versionDir) ||
    factory.normalize(staged.stagingDir) !==
      factory.normalize(factory.staged(filesDir, staged.publishId))
  ) {
    throw new Error('resource-package-skill-version-artifact-path-mismatch')
  }

  const { skills } = tablesOf(db)
  // RFC-359 W9（判据缺口 13b）：换盘之前先问账面还认不认这一代。崩溃到收敛之间用户可能又发布了
  // 一版、或把技能删了；此前这里从头到尾不读 `content_version`，于是无条件 `swapInStaged` 会把
  // **陈旧代际**换回 live、或把**已删技能的目录复活**成一棵没有数据库行的孤儿树，两者都无声无息。
  // 判定与 PostgreSQL 侧共用中立的 `resourcePackageSkillRecoveryDisposition`（纯算术，无引擎差异）。
  const current = await first(
    db
      .select({ contentVersion: skills.contentVersion })
      .from(skills)
      .where(eq(skills.id, staged.skillId)),
  )
  const disposition = resourcePackageSkillRecoveryDisposition({
    currentContentVersion: current?.contentVersion ?? null,
    artifactVersion: staged.newVersion,
  })
  if (disposition === 'cleanup-deleted' || disposition === 'cleanup-superseded') {
    // live 树一个字节都不动，只清掉这次操作留下的 staged / backup / candidate。
    // 两种 provider 的新旧格式都不补 `markSkillBootVerified`，启动复核仍由启动复核器负责。
    await withResourcePackageRecoveryEffects(factory, async (effects) => {
      await effects.cleanupOperation(filesDir, staged.publishId)
      await effects.removeDirectory(factory.candidate(versionDir, staged.publishId))
    })
    return
  }
  if (disposition === 'reject-missing-generation') {
    throw new Error(`resource-package-skill-publication-missing:${staged.skillId}`)
  }

  const publication = await createSkillContentLocationQuery(db).publication(
    staged.skillId,
    staged.newVersion,
  )
  if (
    publication?.snapshot === null ||
    publication?.snapshot === undefined ||
    publication.snapshot.contentHash !== staged.newHash
  )
    throw new Error(
      `resource-package-skill-snapshot-missing:${staged.skillId}:${staged.newVersion}`,
    )

  await withResourcePackageRecoveryEffects(factory, async (effects) => {
    await effects.createDirectory(factory.parent(filesDir))
    await effects.swapStaged(filesDir, staged.publishId)
    if (
      (await effects.directoryChainState(factory.root(staged.skillId), filesDir)) !==
      'real-directory'
    ) {
      throw new Error('resource-package-skill-live-directory-invalid')
    }
    if ((await effects.hashRegularTree(filesDir)) !== staged.newHash) {
      throw new Error('resource-package-skill-live-hash-mismatch')
    }
    await effects.cleanupOperation(filesDir, staged.publishId)
  })
  const opId = staged.opId
  if (opId !== null)
    await databaseSessionFor(db).transaction(async (tx) => await finishOperation(tx, opId))
  markSkillBootVerified(staged.skillId)
}

async function compensateArtifact(
  db: PersistenceDb,
  appHome: string,
  pluginsDir: string,
  artifact: SkillOperationArtifact,
  factory: ResourcePackageRecoveryEffectsFactory,
): Promise<void> {
  switch (artifact.kind) {
    case 'plugin-install':
      factory.assertManaged(pluginsDir, artifact.generationDir)
      await withResourcePackageRecoveryEffects(factory, (effects) =>
        effects.removeDirectory(artifact.generationDir),
      )
      return
    case 'skill-stage': {
      const skillDir = factory.root(artifact.skillId)
      factory.assertManaged(appHome, skillDir)
      if (factory.normalize(artifact.skillDir) !== factory.normalize(skillDir)) {
        throw new Error('resource-package-skill-root-path-mismatch')
      }
      // Published source roots are reclaimed by content maintenance after all holders expire.
      await databaseSessionFor(db).transaction(async (tx) => {
        const { skills } = tablesOf(tx)
        await tx.delete(skills).where(eq(skills.id, artifact.skillId))
        await abandonOperation(tx, artifact.opId)
      })
      return
    }
    case 'skill-version-stage': {
      const staged = artifact.staged
      const filesDir = factory.live(staged.skillId)
      const versionDir = factory.version(staged.skillId, staged.newVersion)
      factory.assertManaged(appHome, filesDir)
      factory.assertManaged(appHome, versionDir)
      if (
        factory.normalize(staged.filesDir) !== factory.normalize(filesDir) ||
        factory.normalize(staged.versionDir) !== factory.normalize(versionDir) ||
        factory.normalize(staged.stagingDir) !==
          factory.normalize(factory.staged(filesDir, staged.publishId))
      ) {
        throw new Error('resource-package-skill-version-artifact-path-mismatch')
      }
      await withResourcePackageRecoveryEffects(factory, async (effects) => {
        await effects.cleanupOperation(filesDir, staged.publishId)
        await effects.removeDirectory(factory.candidate(versionDir, staged.publishId))
      })
      const opId = staged.opId
      if (opId !== null)
        await databaseSessionFor(db).transaction(async (tx) => await abandonOperation(tx, opId))
    }
  }
}

async function rollForwardArtifacts(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly artifacts: readonly SkillOperationArtifact[]
  readonly effectsFactory: ResourcePackageRecoveryEffectsFactory
  readonly log?: ResourcePackageApplyMaintenanceLog
}): Promise<void> {
  const pendingVersions: SkillVersionOperationArtifact[] = []
  let failure: Error | undefined
  for (const artifact of input.artifacts) {
    try {
      if (artifact.kind === 'skill-stage') {
        const operation = await first(skillOperationStateQuery(input.db, artifact.opId))
        if (operation?.active === 0 && operation.phase === 'done') continue
        if (operation?.active !== 1 || operation.phase !== 'db-committed')
          throw new Error(`resource-package-skill-operation-not-replayable:${artifact.opId}`)
        await databaseSessionFor(input.db).transaction(
          async (tx) => await finishOperation(tx, artifact.opId),
        )
        continue
      }
      if (artifact.kind === 'plugin-install') {
        const row = await first(pluginCachedPathQuery(input.db, artifact))
        if (
          row !== undefined &&
          !(await withResourcePackageRecoveryEffects(input.effectsFactory, (effects) =>
            effects.exists(row.cachedPath),
          ))
        ) {
          throw new Error(`resource-package-plugin-publication-missing:${artifact.pluginId}`)
        }
        continue
      }
      const opId = artifact.staged.opId
      if (opId === null) {
        pendingVersions.push(artifact)
        continue
      }
      // RFC-359 W8：这里的 `await` 不是装饰。bun:sqlite 的 `.get()` 是同步的，漏掉它今天恰好无害；
      // 但同一段代码只要接上 PostgreSQL（或换成中立设施），`operation` 就成了 Promise，
      // `operation?.active === 1` 恒 false、`operation?.phase !== 'done'` 恒真 —— 静默改走告警分支。
      // 同函数上一处读 `plugins` 一直是 await 的，这一处是漏的。
      const operation = await first(skillOperationStateQuery(input.db, opId))
      if (operation?.active === 1) {
        pendingVersions.push(artifact)
        continue
      }
      if (operation?.phase !== 'done') {
        input.log?.warn('resource-package-skill-publish-op-not-replayable', {
          skillId: artifact.staged.skillId,
          operationId: opId,
          phase: operation?.phase ?? 'missing',
        })
        throw new Error(`resource-package-skill-operation-not-replayable:${opId}`)
      }
    } catch (error) {
      failure ??= errorValue(error)
    }
  }
  for (const artifact of pendingVersions) unmarkSkillBootVerified(artifact.staged.skillId)
  for (const artifact of pendingVersions) {
    try {
      await publishStagedVersion(input.db, input.appHome, artifact, input.effectsFactory)
    } catch (error) {
      failure ??= errorValue(error)
    }
  }
  if (failure !== undefined) throw failure
}

export function createResourcePackageOperationArtifactRecovery(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly log?: ResourcePackageApplyMaintenanceLog
  readonly effectsFactory?: ResourcePackageRecoveryEffectsFactory
}): ResourcePackageApplyArtifactRecoveryPort {
  const factory = selectedResourcePackageRecoveryEffects(input.effectsFactory, input.appHome)
  return Object.freeze({
    async rollForward(journal: ResourcePackageApplyJournalSnapshot) {
      // Source receipts were converted before activation; only target payloads reach this adapter.
      decodeResourcePackageReceipt(journal)
      await rollForwardArtifacts({
        db: input.db,
        appHome: input.appHome,
        effectsFactory: factory,
        artifacts: operationArtifacts(journal.preparedArtifactsJson),
        ...(input.log === undefined ? {} : { log: input.log }),
      })
    },
    async compensate(journal: ResourcePackageApplyJournalSnapshot) {
      let failure: Error | undefined
      for (const artifact of [...operationArtifacts(journal.preparedArtifactsJson)].reverse()) {
        try {
          await compensateArtifact(input.db, input.appHome, input.pluginsDir, artifact, factory)
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
