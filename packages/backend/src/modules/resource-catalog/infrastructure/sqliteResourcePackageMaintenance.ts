import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { plugins, resourceBundleApplies, skillOperations, skills } from '@/db/schema'
import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalPort,
  ResourcePackageApplyJournalSnapshot,
  ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'
import { cleanupOpDirs, opStagedDir, swapInStaged } from './legacy/skillFsPublish'
import { hashRegularFileTree } from './legacy/skillHash'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from './legacy/skillIdentityPaths'
import { markSkillBootVerified, unmarkSkillBootVerified } from './legacy/skillBootVerify'
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

function assertManagedPath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return
  throw new Error('resource-package-maintenance-path-outside-managed-root')
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function publishStagedVersion(
  db: DbClient,
  appHome: string,
  artifact: LegacySkillVersionArtifact,
): void {
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
  if (opId !== null) dbTxSync(db, (tx) => finishOperation(tx, opId))
  markSkillBootVerified(staged.skillId)
}

function compensateArtifact(
  db: DbClient,
  appHome: string,
  pluginsDir: string,
  artifact: LegacyArtifact,
): void {
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
      dbTxSync(db, (tx) => {
        tx.delete(skills).where(eq(skills.id, artifact.skillId)).run()
        abandonOperation(tx, artifact.opId)
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
      if (opId !== null) dbTxSync(db, (tx) => abandonOperation(tx, opId))
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
        dbTxSync(input.db, (tx) => finishOperation(tx, artifact.opId))
        continue
      }
      if (artifact.kind === 'plugin-install') {
        const row = await input.db
          .select({ cachedPath: plugins.cachedPath })
          .from(plugins)
          .where(eq(plugins.id, artifact.pluginId))
          .get()
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
      const operation = input.db
        .select({ active: skillOperations.active, phase: skillOperations.phase })
        .from(skillOperations)
        .where(eq(skillOperations.opId, opId))
        .get()
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
      publishStagedVersion(input.db, input.appHome, artifact)
    } catch (error) {
      failure ??= errorValue(error)
    }
  }
  if (failure !== undefined) throw failure
}

export function createSqliteResourcePackageApplyJournalPort(
  db: DbClient,
): ResourcePackageApplyJournalPort {
  return Object.freeze({
    async list(): Promise<readonly ResourcePackageApplyJournalSnapshot[]> {
      const rows = await db.select().from(resourceBundleApplies)
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            id: row.id,
            state: row.state,
            preparedArtifactsJson: row.preparedArtifactsJson,
            receiptJson: row.receiptJson,
            updatedAt: row.updatedAt,
          }),
        ),
      )
    },
    async settleFailed(
      command: Parameters<ResourcePackageApplyJournalPort['settleFailed']>[0],
    ): Promise<boolean> {
      return dbTxSync<boolean>(db, (tx) => {
        const settled = tx
          .update(resourceBundleApplies)
          .set({ state: 'failed', error: command.error, updatedAt: command.updatedAt })
          .where(
            and(
              eq(resourceBundleApplies.id, command.id),
              eq(resourceBundleApplies.state, command.expectedState),
            ),
          )
          .returning({ id: resourceBundleApplies.id })
          .get()
        return settled !== undefined
      })
    },
  })
}

export function createSqliteResourcePackageApplyArtifactRecovery(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly pluginsDir: string
  readonly log?: ResourcePackageApplyMaintenanceLog
}): ResourcePackageApplyArtifactRecoveryPort {
  return Object.freeze({
    async rollForward(journal: ResourcePackageApplyJournalSnapshot) {
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
          compensateArtifact(input.db, input.appHome, input.pluginsDir, artifact)
        } catch (error) {
          failure ??= errorValue(error)
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
