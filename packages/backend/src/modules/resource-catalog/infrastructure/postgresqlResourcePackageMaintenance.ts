import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { BUNDLE_RESOURCE_TYPES } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { plugins, skills, skillVersions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { safeJoin } from '@/util/safePath'
import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../application/resourcePackageMaintenance'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  restoreFromBackup,
  swapInStaged,
} from './legacy/skillFsPublish'
import { hashRegularFileTree } from './legacy/skillHash'
import { skillFilesAbs, skillVersionAbs } from './legacy/skillIdentityPaths'
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
 * 留在这里的只有**载荷层**：`applied[]` 逐条的 PostgreSQL 形状（`operationId` + `.strict()`）。
 * 它不能中立化——SQLite 生产写出的逐条是 `opId`，两套格式互不认识
 * （`tests/architecture/rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵）。
 */
function parseReceipt(journal: ResourcePackageApplyJournalSnapshot): ApplyReceipt {
  return ApplyReceiptSchema.parse(JSON.parse(assertCommittedApplyReceipt(journal)))
}

function assertManagedPath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return
  throw new Error('resource-package-maintenance-path-outside-managed-root')
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
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
  readonly liveDirectory: string
  readonly versionDirectory: string
}): void {
  const { artifact } = input
  const expectedLive = skillFilesAbs(input.appHome, artifact.skillId)
  const expectedVersion = skillVersionAbs(
    input.appHome,
    artifact.skillId,
    skillArtifactVersion(artifact),
  )
  if (
    resolve(input.liveDirectory) !== resolve(expectedLive) ||
    resolve(input.versionDirectory) !== resolve(expectedVersion) ||
    resolve(artifact.stagingDirectory) !== resolve(opStagedDir(expectedLive, artifact.operationId))
  ) {
    throw new Error('resource-package-skill-artifact-path-mismatch')
  }
  if (artifact.kind === 'skill-stage') {
    if (resolve(artifact.targetDirectory) !== resolve(expectedLive)) {
      throw new Error('resource-package-skill-artifact-target-mismatch')
    }
  } else if (resolve(artifact.versionDirectory) !== resolve(expectedVersion)) {
    throw new Error('resource-package-skill-artifact-version-mismatch')
  }
}

async function rollForwardSkillArtifact(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly artifact: PostgresqlSkillArtifact
}): Promise<void> {
  const version = skillArtifactVersion(input.artifact)
  const expectedLiveDirectory = skillFilesAbs(input.appHome, input.artifact.skillId)
  const expectedVersionDirectory = skillVersionAbs(input.appHome, input.artifact.skillId, version)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
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
    cleanupOpDirs(expectedLiveDirectory, input.artifact.operationId)
    rmSync(opCandidateDir(expectedVersionDirectory, input.artifact.operationId), {
      recursive: true,
      force: true,
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
  const liveDirectory = safeJoin(input.appHome, skill.managedPath)
  const versionDirectory = safeJoin(input.appHome, snapshot.filesPath)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
    liveDirectory,
    versionDirectory,
  })
  const candidateDirectory = opCandidateDir(versionDirectory, input.artifact.operationId)
  assertManagedPath(input.appHome, candidateDirectory)

  if (existsSync(versionDirectory)) {
    if (hashRegularFileTree(versionDirectory) !== snapshot.contentHash) {
      throw new Error('resource-package-skill-version-hash-mismatch')
    }
    rmSync(candidateDirectory, { recursive: true, force: true })
  } else {
    if (!existsSync(candidateDirectory)) {
      throw new Error('resource-package-skill-version-candidate-missing')
    }
    mkdirSync(dirname(versionDirectory), { recursive: true, mode: 0o700 })
    renameSync(candidateDirectory, versionDirectory)
  }
  swapInStaged(liveDirectory, input.artifact.operationId)
  if (hashRegularFileTree(liveDirectory) !== snapshot.contentHash) {
    throw new Error('resource-package-skill-live-hash-mismatch')
  }
  cleanupOpDirs(liveDirectory, input.artifact.operationId)
  markSkillBootVerified(input.artifact.skillId)
}

function compensateSkillArtifact(input: {
  readonly appHome: string
  readonly artifact: PostgresqlSkillArtifact
}): void {
  const version = skillArtifactVersion(input.artifact)
  const liveDirectory = skillFilesAbs(input.appHome, input.artifact.skillId)
  const versionDirectory = skillVersionAbs(input.appHome, input.artifact.skillId, version)
  assertSkillArtifactPaths({
    artifact: input.artifact,
    appHome: input.appHome,
    liveDirectory,
    versionDirectory,
  })
  restoreFromBackup(liveDirectory, input.artifact.operationId)
  cleanupOpDirs(liveDirectory, input.artifact.operationId)
  rmSync(opCandidateDir(versionDirectory, input.artifact.operationId), {
    recursive: true,
    force: true,
  })
}

export function createPostgresqlResourcePackageApplyArtifactRecovery(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly pluginsDir: string
}): ResourcePackageApplyArtifactRecoveryPort {
  return Object.freeze({
    async rollForward(journal: ResourcePackageApplyJournalSnapshot) {
      const receipt = parseReceipt(journal)
      let failure: Error | undefined
      for (const artifact of parseArtifacts(journal.preparedArtifactsJson)) {
        try {
          assertOperationInReceipt(receipt, artifact)
          if (artifact.kind === 'plugin-install') {
            const plugin = await input.db
              .select({ cachedPath: plugins.cachedPath })
              .from(plugins)
              .where(eq(plugins.id, artifact.pluginId))
              .get()
            if (plugin !== undefined && !existsSync(plugin.cachedPath)) {
              throw new Error(`resource-package-plugin-publication-missing:${artifact.pluginId}`)
            }
            continue
          }
          await rollForwardSkillArtifact({
            db: input.db,
            appHome: input.appHome,
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
            assertManagedPath(input.pluginsDir, artifact.generationDirectory)
            rmSync(artifact.generationDirectory, { recursive: true, force: true })
            continue
          }
          compensateSkillArtifact({ appHome: input.appHome, artifact })
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
