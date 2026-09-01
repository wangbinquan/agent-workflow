import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { and, eq } from 'drizzle-orm'

import { intentApplyJournal, plugins, skills, skillVersions } from '@/db/schema'
import type { PostgresqlIntentApplyArtifact } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  swapInStaged,
} from '@/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import { hashRegularFileTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  skillFilesAbs,
  skillVersionAbs,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { markSkillBootVerified } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  decodeIntentJournalArtifacts,
  type IntentJournalArtifact,
} from '@/services/intent/journalArtifacts'
import { safeJoin } from '@/util/safePath'
import type { Logger } from '@/util/log'
import type { PostgresqlIntentApplyArtifactLifecycle } from './postgresqlIntentApplyOperations'

export type PostgresqlIntentApplyRecoveryArtifact =
  | PostgresqlIntentApplyArtifact
  | IntentJournalArtifact

function pathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertManagedPath(root: string, target: string): void {
  if (pathInside(root, target)) return
  throw new Error('intent-apply-maintenance-path-outside-managed-root')
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`intent-apply-artifact-${key}-invalid`)
  }
  return field
}

function positiveIntegerField(value: Readonly<Record<string, unknown>>, key: string): number {
  const field = value[key]
  if (!Number.isInteger(field) || (field as number) <= 0) {
    throw new Error(`intent-apply-artifact-${key}-invalid`)
  }
  return field as number
}

function decodePostgresqlArtifact(value: unknown): PostgresqlIntentApplyArtifact | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Readonly<Record<string, unknown>>
  switch (record.kind) {
    case 'plugin-install':
      return Object.freeze({
        kind: 'plugin-install',
        pluginId: stringField(record, 'pluginId'),
        generationId: stringField(record, 'generationId'),
        generationDir: stringField(record, 'generationDir'),
      })
    case 'skill-stage':
      if (!('operationId' in record) || !('stagingDirectory' in record)) return null
      return Object.freeze({
        kind: 'skill-stage',
        skillId: stringField(record, 'skillId'),
        operationId: stringField(record, 'operationId'),
        stagingDirectory: stringField(record, 'stagingDirectory'),
      })
    case 'skill-version-stage':
      if (!('operationId' in record) || !('stagingDirectory' in record)) return null
      return Object.freeze({
        kind: 'skill-version-stage',
        skillId: stringField(record, 'skillId'),
        operationId: stringField(record, 'operationId'),
        version: positiveIntegerField(record, 'version'),
        stagingDirectory: stringField(record, 'stagingDirectory'),
        versionDirectory: stringField(record, 'versionDirectory'),
      })
    default:
      return null
  }
}

/** Decode both native PostgreSQL rows and lossless rows migrated from SQLite. */
export function decodePostgresqlIntentApplyRecoveryArtifacts(
  json: string,
): readonly PostgresqlIntentApplyRecoveryArtifact[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (cause) {
    throw new Error('intent apply journal artifacts are not valid JSON', { cause })
  }
  if (!Array.isArray(value)) return decodeIntentJournalArtifacts(json)
  return value.map((entry) => {
    const postgresql = decodePostgresqlArtifact(entry)
    if (postgresql !== null) return postgresql
    const [legacy] = decodeIntentJournalArtifacts(JSON.stringify([entry]))
    if (legacy === undefined) throw new Error('intent apply journal artifact is missing')
    return legacy
  })
}

function operationIdOf(artifact: PostgresqlIntentApplyArtifact): string {
  return artifact.kind === 'plugin-install' ? artifact.generationId : artifact.operationId
}

function versionOf(
  artifact: Extract<PostgresqlIntentApplyArtifact, { kind: 'skill-stage' | 'skill-version-stage' }>,
): number {
  return artifact.kind === 'skill-stage' ? 1 : artifact.version
}

async function assertPluginPublished(input: {
  readonly db: PostgresqlDatabaseClient
  readonly artifact: Extract<PostgresqlIntentApplyRecoveryArtifact, { kind: 'plugin-install' }>
}): Promise<void> {
  const row = await input.db
    .select({ cachedPath: plugins.cachedPath })
    .from(plugins)
    .where(eq(plugins.id, input.artifact.pluginId))
    .limit(1)
    .get()
  if (row === undefined || !existsSync(row.cachedPath)) {
    throw new Error(`intent-apply-plugin-publication-missing:${input.artifact.pluginId}`)
  }
}

async function rollForwardPostgresqlSkill(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly artifact: Extract<
    PostgresqlIntentApplyArtifact,
    { kind: 'skill-stage' | 'skill-version-stage' }
  >
}): Promise<void> {
  const version = versionOf(input.artifact)
  const skill = await input.db
    .select({ managedPath: skills.managedPath, contentVersion: skills.contentVersion })
    .from(skills)
    .where(eq(skills.id, input.artifact.skillId))
    .limit(1)
    .get()
  if (skill === undefined || skill.managedPath === null || skill.contentVersion < version) {
    throw new Error(`intent-apply-skill-publication-missing:${input.artifact.skillId}`)
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
    .limit(1)
    .get()
  if (snapshot === undefined || snapshot.contentHash === null) {
    throw new Error(`intent-apply-skill-snapshot-missing:${input.artifact.skillId}:${version}`)
  }

  const liveDirectory = safeJoin(input.appHome, skill.managedPath)
  const expectedLiveDirectory = skillFilesAbs(input.appHome, input.artifact.skillId)
  const versionDirectory = safeJoin(input.appHome, snapshot.filesPath)
  const expectedVersionDirectory = skillVersionAbs(input.appHome, input.artifact.skillId, version)
  const expectedStagingDirectory = opStagedDir(liveDirectory, input.artifact.operationId)
  if (
    resolve(liveDirectory) !== resolve(expectedLiveDirectory) ||
    resolve(versionDirectory) !== resolve(expectedVersionDirectory) ||
    resolve(input.artifact.stagingDirectory) !== resolve(expectedStagingDirectory) ||
    (input.artifact.kind === 'skill-version-stage' &&
      resolve(input.artifact.versionDirectory) !== resolve(versionDirectory))
  ) {
    throw new Error('intent-apply-skill-artifact-path-mismatch')
  }

  const candidateDirectory = opCandidateDir(versionDirectory, input.artifact.operationId)
  assertManagedPath(input.appHome, candidateDirectory)
  if (skill.contentVersion > version) {
    cleanupOpDirs(liveDirectory, input.artifact.operationId)
    rmSync(candidateDirectory, { recursive: true, force: true })
    return
  }
  if (existsSync(versionDirectory)) {
    if (hashRegularFileTree(versionDirectory) !== snapshot.contentHash) {
      throw new Error('intent-apply-skill-version-hash-mismatch')
    }
    rmSync(candidateDirectory, { recursive: true, force: true })
  } else {
    if (!existsSync(candidateDirectory)) {
      throw new Error('intent-apply-skill-version-candidate-missing')
    }
    mkdirSync(dirname(versionDirectory), { recursive: true, mode: 0o700 })
    renameSync(candidateDirectory, versionDirectory)
  }

  if (existsSync(input.artifact.stagingDirectory)) {
    swapInStaged(liveDirectory, input.artifact.operationId)
  }
  if (!existsSync(liveDirectory) || hashRegularFileTree(liveDirectory) !== snapshot.contentHash) {
    throw new Error('intent-apply-skill-live-hash-mismatch')
  }
  cleanupOpDirs(liveDirectory, input.artifact.operationId)
  markSkillBootVerified(input.artifact.skillId)
}

function compensatePostgresqlSkill(input: {
  readonly appHome: string
  readonly artifact: Extract<
    PostgresqlIntentApplyArtifact,
    { kind: 'skill-stage' | 'skill-version-stage' }
  >
}): void {
  const version = versionOf(input.artifact)
  const liveDirectory = skillFilesAbs(input.appHome, input.artifact.skillId)
  const versionDirectory = skillVersionAbs(input.appHome, input.artifact.skillId, version)
  if (
    resolve(input.artifact.stagingDirectory) !==
      resolve(opStagedDir(liveDirectory, input.artifact.operationId)) ||
    (input.artifact.kind === 'skill-version-stage' &&
      resolve(input.artifact.versionDirectory) !== resolve(versionDirectory))
  ) {
    throw new Error('intent-apply-skill-artifact-path-mismatch')
  }
  cleanupOpDirs(liveDirectory, input.artifact.operationId)
  rmSync(opCandidateDir(versionDirectory, input.artifact.operationId), {
    recursive: true,
    force: true,
  })
}

function compensateLegacyArtifact(input: {
  readonly appHome: string
  readonly pluginsDir: string
  readonly artifact: IntentJournalArtifact
}): void {
  switch (input.artifact.kind) {
    case 'legacy-plugin-install-untracked':
      return
    case 'plugin-install':
      assertManagedPath(input.pluginsDir, input.artifact.generationDir)
      rmSync(input.artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      assertManagedPath(input.appHome, input.artifact.skillDir)
      rmSync(input.artifact.skillDir, { recursive: true, force: true })
      return
    case 'skill-version-stage': {
      const staged = input.artifact.staged
      assertManagedPath(input.appHome, staged.filesDir)
      assertManagedPath(input.appHome, staged.versionDir)
      cleanupOpDirs(staged.filesDir, staged.publishId)
      rmSync(staged.versionDir, { recursive: true, force: true })
    }
  }
}

/** Real PostgreSQL artifact recovery shared by apply-time and boot/hourly convergence. */
export function createPostgresqlIntentApplyArtifactLifecycle(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly pluginsDir: string
}): PostgresqlIntentApplyArtifactLifecycle {
  return Object.freeze({
    async compensate(
      artifact: Parameters<PostgresqlIntentApplyArtifactLifecycle['compensate']>[0],
    ) {
      const postgresql = decodePostgresqlArtifact(artifact)
      if (postgresql?.kind === 'plugin-install') {
        assertManagedPath(input.pluginsDir, postgresql.generationDir)
        rmSync(postgresql.generationDir, { recursive: true, force: true })
        return
      }
      if (postgresql?.kind === 'skill-stage' || postgresql?.kind === 'skill-version-stage') {
        compensatePostgresqlSkill({ appHome: input.appHome, artifact: postgresql })
        return
      }
      compensateLegacyArtifact({
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
        artifact: artifact as IntentJournalArtifact,
      })
    },
    async rollForward(
      artifacts: Parameters<PostgresqlIntentApplyArtifactLifecycle['rollForward']>[0],
      log: Logger,
    ) {
      let complete = true
      for (const artifact of artifacts) {
        try {
          const postgresql = decodePostgresqlArtifact(artifact)
          if (postgresql?.kind === 'plugin-install') {
            await assertPluginPublished({ db: input.db, artifact: postgresql })
            continue
          }
          if (postgresql?.kind === 'skill-stage' || postgresql?.kind === 'skill-version-stage') {
            await rollForwardPostgresqlSkill({
              db: input.db,
              appHome: input.appHome,
              artifact: postgresql,
            })
            continue
          }
          if ((artifact as IntentJournalArtifact).kind === 'legacy-plugin-install-untracked') {
            continue
          }
          throw new Error('legacy intent artifact needs manual source-provider recovery')
        } catch (error) {
          complete = false
          log.warn('intent-apply-artifact-roll-forward-retryable', {
            kind: artifact.kind,
            operationId:
              decodePostgresqlArtifact(artifact) === null
                ? 'legacy'
                : operationIdOf(decodePostgresqlArtifact(artifact)!),
            err: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return complete
    },
  })
}

export interface PostgresqlIntentApplyJournalConvergence {
  converge(input: {
    readonly activeJournalIds: readonly string[]
  }): Promise<{ readonly failed: number; readonly rolledForward: number }>
}

const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

export function createPostgresqlIntentApplyJournalConvergence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly artifacts: PostgresqlIntentApplyArtifactLifecycle
  readonly now?: () => number
  readonly log: Logger
}): PostgresqlIntentApplyJournalConvergence {
  const now = input.now ?? Date.now
  return Object.freeze({
    async converge(command: { readonly activeJournalIds: readonly string[] }) {
      const active = new Set(command.activeJournalIds)
      const reapBefore = now() - CONVERGE_MIN_AGE_MS
      let failed = 0
      let rolledForward = 0
      for (const row of await input.db.select().from(intentApplyJournal)) {
        if (row.state === 'failed') continue
        let artifacts: readonly PostgresqlIntentApplyRecoveryArtifact[]
        try {
          artifacts = decodePostgresqlIntentApplyRecoveryArtifacts(row.preparedArtifactsJson)
        } catch (error) {
          input.log.warn('intent-journal-artifact-corrupt', {
            journalId: row.id,
            state: row.state,
            err: error instanceof Error ? error.message : String(error),
          })
          await input.db
            .update(intentApplyJournal)
            .set({
              error: `retryable: artifact decode failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              updatedAt: now(),
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
          continue
        }
        if (row.state === 'prepared' || row.state === 'applying') {
          if (active.has(row.id) || row.updatedAt > reapBefore) continue
          let compensationFailed = false
          for (const artifact of [...artifacts].reverse()) {
            try {
              await input.artifacts.compensate(artifact)
            } catch (error) {
              compensationFailed = true
              input.log.warn('intent-converge-compensation-failed', {
                journalId: row.id,
                kind: artifact.kind,
                err: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (compensationFailed) {
            await input.db
              .update(intentApplyJournal)
              .set({ error: 'retryable: compensation incomplete', updatedAt: now() })
              .where(
                and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)),
              )
            continue
          }
          const settled = await input.db
            .update(intentApplyJournal)
            .set({ state: 'failed', error: 'daemon-restart before commit', updatedAt: now() })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
            .returning({ id: intentApplyJournal.id })
            .get()
          if (settled !== undefined) failed += 1
          continue
        }
        const complete = await input.artifacts.rollForward(artifacts, input.log)
        if (complete) {
          rolledForward += 1
          if (row.error !== null) {
            await input.db
              .update(intentApplyJournal)
              .set({ error: null, updatedAt: now() })
              .where(
                and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
              )
          }
        } else {
          await input.db
            .update(intentApplyJournal)
            .set({
              error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
              updatedAt: now(),
            })
            .where(
              and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
            )
        }
      }
      return Object.freeze({ failed, rolledForward })
    },
  })
}
