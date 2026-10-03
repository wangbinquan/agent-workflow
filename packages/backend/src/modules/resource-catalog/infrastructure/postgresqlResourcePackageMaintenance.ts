import type { ResourcePackageRecoveryEffectsFactory } from '../application/package/recoveryContentEffects'
import {
  selectedResourcePackageRecoveryEffects,
  withResourcePackageRecoveryEffects,
} from './recoveryContentEffects'
import { pluginCachedPathQuery } from './pluginCachedPathQuery'
import { errorValue } from './resourcePackageMaintenancePaths'

import { BUNDLE_RESOURCE_TYPES } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { skills, skillVersions } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'

import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../application/resourcePackageMaintenance'

import { markSkillBootVerified } from './legacy/skillBootVerify'
import { assertCommittedApplyReceipt } from '../domain/resourcePackageApplyReceipt'
import {
  resourcePackageSkillRecoveryDisposition,
  type ResourcePackageSkillRecoveryDisposition,
} from '../domain/resourcePackageSkillRecovery'

const PostgresqlArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plugin-install'),
      operationId: z.string().min(1),
      pluginId: z.string().min(1),
      generationId: z.string().min(1),
      generationDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-stage'),
      operationId: z.string().min(1),
      skillId: z.string().min(1),
      stagingDirectory: z.string().min(1),
      targetDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-version-stage'),
      operationId: z.string().min(1),
      skillId: z.string().min(1),
      publishId: z.string().min(1),
      version: z.number().int().positive(),
      stagingDirectory: z.string().min(1),
      versionDirectory: z.string().min(1),
    })
    .strict(),
])

const AppliedReceiptSchema = z
  .object({
    resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
    operationId: z.string().min(1),
    resourceId: z.string().min(1),
    action: z.enum(['create', 'update']),
    name: z.string(),
  })
  .strict()

const ApplyReceiptSchema = z
  .object({
    journalId: z.string().min(1),
    applied: z.array(AppliedReceiptSchema),
    root: z
      .object({
        resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
        resourceId: z.string().min(1),
        name: z.string(),
        action: z.enum(['create', 'update', 'reuse']),
      })
      .strict()
      .optional(),
    skippedSecrets: z
      .array(
        z
          .object({
            resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
            resourceName: z.string(),
            field: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

type PostgresqlArtifact = z.infer<typeof PostgresqlArtifactSchema>
type PostgresqlSkillArtifact = Exclude<PostgresqlArtifact, { kind: 'plugin-install' }>
type ApplyReceipt = z.infer<typeof ApplyReceiptSchema>

function parseArtifacts(json: string): readonly PostgresqlArtifact[] {
  return z.array(PostgresqlArtifactSchema).parse(JSON.parse(json))
}

/**
 * RFC-359 W10（判据缺口 13a）：**信封那两条判据搬进中立的
 * `domain/resourcePackageApplyReceipt.ts`，两个引擎调同一份**——此前只有 PostgreSQL 有，
 * SQLite 上回执缺失 / 认领别的 journal 也照常 roll-forward 并报成功。
 *
 * 留在这里的只有**载荷层**：`applied[]` 逐条的 `operationId` + `.strict()` 形状。
 *
 * RFC-359（apply 引擎合一）：**两个 provider 现在都写这一种格式**——生产侧只剩一台 apply 引擎。
 * 旧的 SQLite 格式（逐条 `opId`）只可能来自**合一之前**留在盘上的半成品，由
 * `composeResourcePackageApplyArtifactRecoveryChain` 回落到 legacy 读回侧处理。
 */
function parseReceipt(journal: ResourcePackageApplyJournalSnapshot): ApplyReceipt {
  return ApplyReceiptSchema.parse(JSON.parse(assertCommittedApplyReceipt(journal)))
}

function assertOperationInReceipt(receipt: ApplyReceipt, artifact: PostgresqlArtifact): void {
  if (
    receipt.applied.some(
      (entry) =>
        entry.operationId === artifact.operationId &&
        entry.resourceId ===
          (artifact.kind === 'plugin-install' ? artifact.pluginId : artifact.skillId),
    )
  ) {
    return
  }
  throw new Error(`resource-package-artifact-receipt-missing:${artifact.operationId}`)
}

function skillArtifactVersion(artifact: PostgresqlSkillArtifact): number {
  return artifact.kind === 'skill-stage' ? 1 : artifact.version
}

// RFC-359 W9：代际判定搬进中立的 `domain/resourcePackageSkillRecovery.ts`，SQLite 侧的
// `publishStagedVersion` 现在调同一份（此前它一格都没有，见判据缺口 13b）。旧名保留为别名，
// 只为 `tests/rfc349-resource-package-maintenance.test.ts` 那组四分支单测不必跟着改。
export type PostgresqlResourcePackageSkillRecoveryDisposition =
  ResourcePackageSkillRecoveryDisposition
export const postgresqlResourcePackageSkillRecoveryDisposition =
  resourcePackageSkillRecoveryDisposition

function assertSkillArtifactPaths(input: {
  readonly artifact: PostgresqlSkillArtifact
  readonly appHome: string
  readonly effectsFactory: ResourcePackageRecoveryEffectsFactory
  readonly liveDirectory: string
  readonly versionDirectory: string
}): void {
  const { artifact } = input
  const factory = input.effectsFactory
  const expectedLive = factory.live(artifact.skillId)
  const expectedVersion = factory.version(artifact.skillId, skillArtifactVersion(artifact))
  if (
    factory.normalize(input.liveDirectory) !== factory.normalize(expectedLive) ||
    factory.normalize(input.versionDirectory) !== factory.normalize(expectedVersion) ||
    factory.normalize(artifact.stagingDirectory) !==
      factory.normalize(factory.staged(expectedLive, artifact.operationId))
  ) {
    throw new Error('resource-package-skill-artifact-path-mismatch')
  }
  if (artifact.kind === 'skill-stage') {
    if (factory.normalize(artifact.targetDirectory) !== factory.normalize(expectedLive)) {
      throw new Error('resource-package-skill-artifact-target-mismatch')
    }
  } else if (factory.normalize(artifact.versionDirectory) !== factory.normalize(expectedVersion)) {
    throw new Error('resource-package-skill-artifact-version-mismatch')
  }
}

async function rollForwardSkillArtifact(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly effectsFactory: ResourcePackageRecoveryEffectsFactory
  readonly artifact: PostgresqlSkillArtifact
}): Promise<void> {
  const factory = input.effectsFactory
  const version = skillArtifactVersion(input.artifact)
  const expectedLiveDirectory = factory.live(input.artifact.skillId)
  const expectedVersionDirectory = factory.version(input.artifact.skillId, version)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
    effectsFactory: factory,
    liveDirectory: expectedLiveDirectory,
    versionDirectory: expectedVersionDirectory,
  })
  const skill = await input.db
    .select({ managedPath: skills.managedPath, contentVersion: skills.contentVersion })
    .from(skills)
    .where(eq(skills.id, input.artifact.skillId))
    .get()
  const disposition = resourcePackageSkillRecoveryDisposition({
    currentContentVersion: skill?.contentVersion ?? null,
    artifactVersion: version,
  })
  if (disposition === 'cleanup-deleted' || disposition === 'cleanup-superseded') {
    await withResourcePackageRecoveryEffects(factory, async (effects) => {
      await effects.cleanupOperation(expectedLiveDirectory, input.artifact.operationId)
      await effects.removeDirectory(
        factory.candidate(expectedVersionDirectory, input.artifact.operationId),
      )
    })
    return
  }
  if (
    disposition === 'reject-missing-generation' ||
    skill === undefined ||
    skill.managedPath === null
  ) {
    throw new Error(`resource-package-skill-publication-missing:${input.artifact.skillId}`)
  }
  const snapshot = await input.db
    .select({ filesPath: skillVersions.filesPath, contentHash: skillVersions.contentHash })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, input.artifact.skillId),
        eq(skillVersions.versionIndex, version),
      ),
    )
    .get()
  if (snapshot === undefined || snapshot.contentHash === null) {
    throw new Error(`resource-package-skill-snapshot-missing:${input.artifact.skillId}:${version}`)
  }
  const liveDirectory = factory.storedReference(skill.managedPath)
  const versionDirectory = factory.storedReference(snapshot.filesPath)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
    effectsFactory: factory,
    liveDirectory,
    versionDirectory,
  })
  const candidateDirectory = factory.candidate(versionDirectory, input.artifact.operationId)
  factory.assertManaged(input.appHome, candidateDirectory)

  await withResourcePackageRecoveryEffects(factory, async (effects) => {
    if (await effects.exists(versionDirectory)) {
      if ((await effects.hashRegularTree(versionDirectory)) !== snapshot.contentHash) {
        throw new Error('resource-package-skill-version-hash-mismatch')
      }
      await effects.removeDirectory(candidateDirectory)
    } else {
      if (!(await effects.exists(candidateDirectory))) {
        throw new Error('resource-package-skill-version-candidate-missing')
      }
      await effects.createDirectory(factory.parent(versionDirectory), 0o700)
      await effects.move(candidateDirectory, versionDirectory)
    }
    await effects.swapStaged(liveDirectory, input.artifact.operationId)
    if ((await effects.hashRegularTree(liveDirectory)) !== snapshot.contentHash) {
      throw new Error('resource-package-skill-live-hash-mismatch')
    }
    await effects.cleanupOperation(liveDirectory, input.artifact.operationId)
  })
  markSkillBootVerified(input.artifact.skillId)
}

async function compensateSkillArtifact(input: {
  readonly appHome: string
  readonly effectsFactory: ResourcePackageRecoveryEffectsFactory
  readonly artifact: PostgresqlSkillArtifact
}): Promise<void> {
  const factory = input.effectsFactory
  const version = skillArtifactVersion(input.artifact)
  const liveDirectory = factory.live(input.artifact.skillId)
  const versionDirectory = factory.version(input.artifact.skillId, version)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
    effectsFactory: factory,
    liveDirectory,
    versionDirectory,
  })
  await withResourcePackageRecoveryEffects(factory, async (effects) => {
    await effects.restoreBackup(liveDirectory, input.artifact.operationId)
    await effects.cleanupOperation(liveDirectory, input.artifact.operationId)
    await effects.removeDirectory(factory.candidate(versionDirectory, input.artifact.operationId))
  })
}

export function createPostgresqlResourcePackageApplyArtifactRecovery(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly pluginsDir: string
  readonly effectsFactory?: ResourcePackageRecoveryEffectsFactory
}): ResourcePackageApplyArtifactRecoveryPort {
  const factory = selectedResourcePackageRecoveryEffects(input.effectsFactory, input.appHome)
  return Object.freeze({
    async rollForward(journal: ResourcePackageApplyJournalSnapshot) {
      const receipt = parseReceipt(journal)
      let failure: Error | undefined
      for (const artifact of parseArtifacts(journal.preparedArtifactsJson)) {
        try {
          assertOperationInReceipt(receipt, artifact)
          if (artifact.kind === 'plugin-install') {
            const plugin = await pluginCachedPathQuery(input.db, artifact).get()
            if (
              plugin !== undefined &&
              !(await withResourcePackageRecoveryEffects(factory, (effects) =>
                effects.exists(plugin.cachedPath),
              ))
            ) {
              throw new Error(`resource-package-plugin-publication-missing:${artifact.pluginId}`)
            }
            continue
          }
          await rollForwardSkillArtifact({
            db: input.db,
            appHome: input.appHome,
            effectsFactory: factory,
            artifact,
          })
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
    async compensate(journal: ResourcePackageApplyJournalSnapshot) {
      let failure: Error | undefined
      for (const artifact of [...parseArtifacts(journal.preparedArtifactsJson)].reverse()) {
        try {
          if (artifact.kind === 'plugin-install') {
            factory.assertManaged(input.pluginsDir, artifact.generationDirectory)
            await withResourcePackageRecoveryEffects(factory, (effects) =>
              effects.removeDirectory(artifact.generationDirectory),
            )
            continue
          }
          await compensateSkillArtifact({
            appHome: input.appHome,
            artifact,
            effectsFactory: factory,
          })
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
