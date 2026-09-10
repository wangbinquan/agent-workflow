import { pluginCachedPathQuery } from './pluginCachedPathQuery'
import { assertManagedPath, errorValue } from './resourcePackageMaintenancePaths'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { skills } from '@/db/schema'
import { skillOperationStateQuery } from './skillOperationStateQuery'
import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
  ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'
import { cleanupOpDirs, opCandidateDir, opStagedDir, swapInStaged } from './legacy/skillFsPublish'
import { hashRegularFileTree } from './legacy/skillHash'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from './legacy/skillIdentityPaths'
import { markSkillBootVerified, unmarkSkillBootVerified } from './legacy/skillBootVerify'
import { assertCommittedApplyReceipt } from '../domain/resourcePackageApplyReceipt'
import { resourcePackageSkillRecoveryDisposition } from '../domain/resourcePackageSkillRecovery'
import { abandonOperation, finishOperation } from './legacy/skillOperations'

const LegacySkillStageArtifactSchema = z
  .object({
    kind: z.literal('skill-stage'),
    skillId: z.string().min(1),
    opId: z.string().min(1),
    skillDir: z.string().min(1),
  })
  .strict()

const LegacySkillVersionStageArtifactSchema = z
  .object({
    kind: z.literal('skill-version-stage'),
    staged: z
      .object({
        skillId: z.string().min(1),
        skillName: z.string(),
        opId: z.string().min(1).nullable(),
        publishId: z.string().min(1),
        newVersion: z.number().int().positive(),
        newHash: z.string().min(1),
        filesDir: z.string().min(1),
        versionDir: z.string().min(1),
        stagingDir: z.string().min(1),
        noop: z.unknown(),
      })
      .strict(),
  })
  .strict()

const LegacyPluginInstallArtifactSchema = z
  .object({
    kind: z.literal('plugin-install'),
    pluginId: z.string().min(1),
    generationId: z.string().min(1),
    generationDir: z.string().min(1),
  })
  .strict()

const LegacyArtifactSchema = z.discriminatedUnion('kind', [
  LegacySkillStageArtifactSchema,
  LegacySkillVersionStageArtifactSchema,
  LegacyPluginInstallArtifactSchema,
])

type LegacyArtifact = z.infer<typeof LegacyArtifactSchema>
type LegacySkillVersionArtifact = z.infer<typeof LegacySkillVersionStageArtifactSchema>

function parseArtifacts(json: string): readonly LegacyArtifact[] {
  return z.array(LegacyArtifactSchema).parse(JSON.parse(json))
}

async function publishStagedVersion(
  db: DbClient,
  appHome: string,
  artifact: LegacySkillVersionArtifact,
): Promise<void> {
  const staged = artifact.staged
  if (staged.noop !== null) return
  const filesDir = skillFilesAbs(appHome, staged.skillId)
  const versionDir = skillVersionAbs(appHome, staged.skillId, staged.newVersion)
  assertManagedPath(appHome, filesDir)
  assertManagedPath(appHome, versionDir)
  if (
    resolve(staged.filesDir) !== resolve(filesDir) ||
    resolve(staged.versionDir) !== resolve(versionDir) ||
    resolve(staged.stagingDir) !== resolve(opStagedDir(filesDir, staged.publishId))
  ) {
    throw new Error('resource-package-skill-version-artifact-path-mismatch')
  }

  // RFC-359 W9（判据缺口 13b）：换盘之前先问账面还认不认这一代。崩溃到收敛之间用户可能又发布了
  // 一版、或把技能删了；此前这里从头到尾不读 `content_version`，于是无条件 `swapInStaged` 会把
  // **陈旧代际**换回 live、或把**已删技能的目录复活**成一棵没有数据库行的孤儿树，两者都无声无息。
  // 判定与 PostgreSQL 侧共用中立的 `resourcePackageSkillRecoveryDisposition`（纯算术，无引擎差异）。
  const current = await db
    .select({ contentVersion: skills.contentVersion })
    .from(skills)
    .where(eq(skills.id, staged.skillId))
    .get()
  const disposition = resourcePackageSkillRecoveryDisposition({
    currentContentVersion: current?.contentVersion ?? null,
    artifactVersion: staged.newVersion,
  })
  if (disposition === 'cleanup-deleted' || disposition === 'cleanup-superseded') {
    // live 树一个字节都不动，只清掉这次操作留下的 staged / backup / candidate。
    // 与 PostgreSQL 侧一样**不**补 `markSkillBootVerified`——启动复核由启动复核器负责，
    // 在这里补一次会造出一条只有 SQLite 才有的分支。
    cleanupOpDirs(filesDir, staged.publishId)
    rmSync(opCandidateDir(versionDir, staged.publishId), { recursive: true, force: true })
    return
  }
  if (disposition === 'reject-missing-generation') {
    throw new Error(`resource-package-skill-publication-missing:${staged.skillId}`)
  }

  mkdirSync(dirname(filesDir), { recursive: true })
  swapInStaged(filesDir, staged.publishId)
  if (
    realDirectoryChainState(skillRootAbs(appHome, staged.skillId), filesDir) !== 'real-directory'
  ) {
    throw new Error('resource-package-skill-live-directory-invalid')
  }
  if (hashRegularFileTree(filesDir) !== staged.newHash) {
    throw new Error('resource-package-skill-live-hash-mismatch')
  }
  cleanupOpDirs(filesDir, staged.publishId)
  const opId = staged.opId
  if (opId !== null)
    await databaseSessionFor(db).transaction(async (tx) => await finishOperation(tx, opId))
  markSkillBootVerified(staged.skillId)
}

async function compensateArtifact(
  db: DbClient,
  appHome: string,
  pluginsDir: string,
  artifact: LegacyArtifact,
): Promise<void> {
  switch (artifact.kind) {
    case 'plugin-install':
      assertManagedPath(pluginsDir, artifact.generationDir)
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage': {
      const skillDir = skillRootAbs(appHome, artifact.skillId)
      assertManagedPath(appHome, skillDir)
      if (resolve(artifact.skillDir) !== resolve(skillDir)) {
        throw new Error('resource-package-skill-root-path-mismatch')
      }
      rmSync(skillDir, { recursive: true, force: true })
      await databaseSessionFor(db).transaction(async (tx) => {
        await tx.delete(skills).where(eq(skills.id, artifact.skillId))
        await abandonOperation(tx, artifact.opId)
      })
      return
    }
    case 'skill-version-stage': {
      const staged = artifact.staged
      const filesDir = skillFilesAbs(appHome, staged.skillId)
      const versionDir = skillVersionAbs(appHome, staged.skillId, staged.newVersion)
      assertManagedPath(appHome, filesDir)
      assertManagedPath(appHome, versionDir)
      if (
        resolve(staged.filesDir) !== resolve(filesDir) ||
        resolve(staged.versionDir) !== resolve(versionDir) ||
        resolve(staged.stagingDir) !== resolve(opStagedDir(filesDir, staged.publishId))
      ) {
        throw new Error('resource-package-skill-version-artifact-path-mismatch')
      }
      cleanupOpDirs(filesDir, staged.publishId)
      rmSync(versionDir, { recursive: true, force: true })
      const opId = staged.opId
      if (opId !== null)
        await databaseSessionFor(db).transaction(async (tx) => await abandonOperation(tx, opId))
    }
  }
}

async function rollForwardArtifacts(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly artifacts: readonly LegacyArtifact[]
  readonly log?: ResourcePackageApplyMaintenanceLog
}): Promise<void> {
  const pendingVersions: LegacySkillVersionArtifact[] = []
  let failure: Error | undefined
  for (const artifact of input.artifacts) {
    try {
      if (artifact.kind === 'skill-stage') {
        await databaseSessionFor(input.db).transaction(
          async (tx) => await finishOperation(tx, artifact.opId),
        )
        continue
      }
      if (artifact.kind === 'plugin-install') {
        const row = await pluginCachedPathQuery(input.db, artifact).get()
        if (row !== undefined && !existsSync(row.cachedPath)) {
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
      const operation = await skillOperationStateQuery(input.db, opId).get()
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
      }
    } catch (error) {
      failure ??= errorValue(error)
    }
  }
  for (const artifact of pendingVersions) unmarkSkillBootVerified(artifact.staged.skillId)
  for (const artifact of pendingVersions) {
    try {
      await publishStagedVersion(input.db, input.appHome, artifact)
    } catch (error) {
      failure ??= errorValue(error)
    }
  }
  if (failure !== undefined) throw failure
}

export function createSqliteResourcePackageApplyArtifactRecovery(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly pluginsDir: string
  readonly log?: ResourcePackageApplyMaintenanceLog
}): ResourcePackageApplyArtifactRecoveryPort {
  return Object.freeze({
    async rollForward(journal: ResourcePackageApplyJournalSnapshot) {
      // RFC-359 W10（判据缺口 13a）：回放之前先过**信封门**——committed 就必须带回执，
      // 且回执必须认领这一行。此前这里从头到尾不看回执，于是回执缺失 / 认领别的 journal 的
      // 损坏行也照常 roll-forward 并计一次 `rolledForward`，而 PostgreSQL 侧同一行是拒收的。
      // 判定与 PostgreSQL 侧共用中立的 `assertCommittedApplyReceipt`（纯函数，无引擎差异）；
      // 只判信封不判载荷——`applied[]` 逐条两侧格式不同（`opId` vs `operationId`），
      // 把 PostgreSQL 的载荷 schema 一起搬过来会让本引擎所有真实回执被 zod 拒收。
      assertCommittedApplyReceipt(journal)
      await rollForwardArtifacts({
        db: input.db,
        appHome: input.appHome,
        artifacts: parseArtifacts(journal.preparedArtifactsJson),
        ...(input.log === undefined ? {} : { log: input.log }),
      })
    },
    async compensate(journal: ResourcePackageApplyJournalSnapshot) {
      let failure: Error | undefined
      for (const artifact of [...parseArtifacts(journal.preparedArtifactsJson)].reverse()) {
        try {
          await compensateArtifact(input.db, input.appHome, input.pluginsDir, artifact)
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
