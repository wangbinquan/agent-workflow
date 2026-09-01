import {
  isProtectedSkillMainFile,
  parseSkillMarkdown,
  type FileNode,
  type Skill,
  type SkillCandidate,
  type SkillContent,
  type SkillVersionContent,
  type SkillVersionDiff,
} from '@agent-workflow/shared'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { stringify as stringifyYaml } from 'yaml'

import { agents, skillOperationLocks, skillOperations, skillVersions, skills } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { realpathInside, realpathWriteInside, safeJoin } from '@/util/safePath'

import type { SkillOperationContext } from '../public/participants'
import { cleanupOpDirs, opStagedDir, swapInStaged } from './legacy/skillFsPublish'
import { assertRegularFileTree, collectFiles, hashRegularFileTree } from './legacy/skillHash'
import {
  markSkillBootVerified,
  isSkillAvailableThisBoot,
  unmarkSkillBootVerified,
} from './legacy/skillBootVerify'
import {
  skillFilesAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from './legacy/skillIdentityPaths'
import { gitStyleDirDiff, type TreeEntry } from './legacy/skillVersion'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'
import type {
  PostgresqlSkillMemoryFusionParticipantFactory,
  PostgresqlSkillContentLifecycle,
  PostgresqlSkillDeletePlan,
  PostgresqlSkillVersionPlan,
} from './postgresqlSkillRepository'

const SKILL_MAIN = 'SKILL.md'

interface VersionOperationState<TResult> {
  readonly opId: string
  readonly skillId: string
  readonly versionIndex: number
  readonly filesDir: string
  readonly stagingDir: string
  readonly versionDir: string
  readonly filesPath: string
  readonly contentHash: string
  readonly result: TResult
  readonly createReservation: boolean
  published: boolean
  completed: boolean
}

function skillMarkdown(
  content: Pick<SkillContent, 'name' | 'description' | 'bodyMd' | 'frontmatterExtra'>,
): string {
  const yaml = stringifyYaml(
    { name: content.name, description: content.description, ...content.frontmatterExtra },
    { lineWidth: 0 },
  ).trimEnd()
  return `---\n${yaml}\n---\n\n${content.bodyMd}\n`
}

function contentOf(skill: Skill, directory: string): SkillContent {
  const mainPath = join(directory, SKILL_MAIN)
  if (!existsSync(mainPath)) {
    throw new NotFoundError('skill-md-missing', `SKILL.md not found for skill '${skill.name}'`)
  }
  const parsed = parseSkillMarkdown(readFileSync(realpathInside(directory, mainPath), 'utf8'))
  return Object.freeze({
    name: skill.name,
    description: parsed.description.length > 0 ? parsed.description : skill.description,
    bodyMd: parsed.bodyMd,
    frontmatterExtra: Object.freeze({ ...parsed.frontmatterExtra }),
  })
}

function fileTree(root: string): FileNode[] {
  if (!existsSync(root)) return []
  const out: FileNode[] = []
  const visit = (relativeRoot: string) => {
    const absoluteRoot = relativeRoot.length === 0 ? root : join(root, relativeRoot)
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`
      const absolute = join(root, path)
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        out.push({ path, type: 'dir' })
        visit(path)
      } else if (stat.isFile()) {
        out.push({ path, type: 'file', size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) })
      }
    }
  }
  visit('')
  return out
}

function treeOf(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  if (!existsSync(root)) return out
  const files: string[] = []
  collectFiles(root, '', files)
  for (const file of files) {
    const bytes = readFileSync(join(root, file))
    out.set(
      file,
      bytes.includes(0)
        ? { kind: 'binary', hash: sha256Hex(bytes) }
        : { kind: 'text', content: bytes.toString('utf8') },
    )
  }
  return out
}

function clearDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true })
}

function writeCandidate(root: string, candidate: SkillCandidate): void {
  clearDirectory(root)
  for (const file of candidate.files) {
    const target = realpathWriteInside(root, safeJoin(root, file.relPath))
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, file.bytes, { mode: 0o600 })
  }
  if (!existsSync(join(root, SKILL_MAIN))) {
    writeFileSync(
      join(root, SKILL_MAIN),
      skillMarkdown({
        name: candidate.name,
        description: candidate.description,
        bodyMd: candidate.bodyMd,
        frontmatterExtra: candidate.frontmatterExtra,
      }),
      { mode: 0o600 },
    )
  }
}

async function beginOperation(input: {
  readonly db: PostgresqlDatabaseClient
  readonly skillId: string
  readonly kind: 'reserve' | 'version-write' | 'delete'
  readonly targetVersion?: number
  readonly ownerUserId: string
  readonly preconditionJson: string
  readonly reserve?: {
    readonly name: string
    readonly description: string
    readonly managedPath: string
    readonly now: number
  }
}): Promise<string> {
  const opId = ulid()
  try {
    await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
      if (input.reserve !== undefined) {
        const collision = await transaction
          .select({ id: skills.id })
          .from(skills)
          .where(
            and(eq(skills.ownerUserId, input.ownerUserId), eq(skills.name, input.reserve.name)),
          )
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'skill-name-in-use',
            `skill '${input.reserve.name}' already exists`,
          )
        }
        await transaction
          .insert(skills)
          .values({
            id: input.skillId,
            name: input.reserve.name,
            description: input.reserve.description,
            managedPath: input.reserve.managedPath,
            ownerUserId: input.ownerUserId,
            visibility: 'private',
            aclRevision: 0,
            contentVersion: 0,
            metaRevision: 0,
            reservationState: 'reserving',
            versionState: 'snapshot-unverified',
            schemaVersion: 1,
            createdAt: input.reserve.now,
            updatedAt: input.reserve.now,
          })
          .run()
      }
      await transaction
        .insert(skillOperationLocks)
        .values({ lockedSkillId: input.skillId, opId })
        .run()
      await transaction
        .insert(skillOperations)
        .values({
          opId,
          skillId: input.skillId,
          kind: input.kind,
          phase: 'intent',
          active: 1,
          targetVersion: input.targetVersion ?? null,
          ownerUserId: input.ownerUserId,
          preconditionJson: input.preconditionJson,
        })
        .run()
    })
  } catch (error) {
    if (error instanceof ConflictError) throw error
    if (
      input.reserve !== undefined &&
      isPostgresqlUniqueViolation(error, ['skills_owner_name_unique'])
    ) {
      throw new ConflictError('skill-name-in-use', `skill '${input.reserve.name}' already exists`)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (/skill_operation_locks|unique|duplicate/i.test(message)) {
      throw new ConflictError('skill-operation-busy', `skill '${input.skillId}' is busy`)
    }
    throw error
  }
  return opId
}

async function setOperationPhase(
  db: PostgresqlDatabaseClient,
  opId: string,
  phase: string,
  values: Partial<typeof skillOperations.$inferInsert> = {},
): Promise<void> {
  await db
    .update(skillOperations)
    .set({ ...values, phase })
    .where(and(eq(skillOperations.opId, opId), eq(skillOperations.active, 1)))
    .run()
}

async function retireOperation(
  db: PostgresqlDatabaseClient,
  opId: string,
  phase: 'done' | 'aborted',
): Promise<void> {
  await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    await transaction
      .update(skillOperations)
      .set({ phase, active: 0 })
      .where(eq(skillOperations.opId, opId))
      .run()
    await transaction.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)).run()
  })
}

async function abandonReservation(
  db: PostgresqlDatabaseClient,
  skillId: string,
  opId: string,
): Promise<void> {
  await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    await transaction.delete(skills).where(eq(skills.id, skillId)).run()
    await transaction
      .update(skillOperations)
      .set({ phase: 'aborted', active: 0 })
      .where(eq(skillOperations.opId, opId))
      .run()
    await transaction.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)).run()
  })
}

async function prepareVersion<TResult>(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly authority: SkillOperationContext
  readonly skillId: string
  readonly skillName: string
  readonly versionIndex: number
  readonly currentVersion?: number
  readonly result: TResult
  readonly reserve?: {
    readonly description: string
    readonly now: number
  }
  readonly produce: (stagingDirectory: string) => void
}): Promise<VersionOperationState<TResult>> {
  const filesDir = skillFilesAbs(input.appHome, input.skillId)
  const versionDir = skillVersionAbs(input.appHome, input.skillId, input.versionIndex)
  const filesPath = skillVersionRelPath(input.skillId, input.versionIndex)
  const opId = await beginOperation({
    db: input.db,
    skillId: input.skillId,
    kind: input.reserve === undefined ? 'version-write' : 'reserve',
    targetVersion: input.versionIndex,
    ownerUserId: input.authority.user.id,
    preconditionJson: JSON.stringify({ skillId: input.skillId }),
    ...(input.reserve === undefined
      ? {}
      : {
          reserve: {
            name: input.skillName,
            description: input.reserve.description,
            managedPath: skillFilesRel(input.skillId),
            now: input.reserve.now,
          },
        }),
  })
  const stagingDir = opStagedDir(filesDir, opId)
  try {
    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
    if (input.currentVersion !== undefined) {
      const current = skillVersionAbs(input.appHome, input.skillId, input.currentVersion)
      if (!existsSync(current)) {
        throw new NotFoundError(
          'skill-version-not-found',
          `skill '${input.skillId}' has no version ${input.currentVersion}`,
        )
      }
      cpSync(current, stagingDir, { recursive: true })
    }
    input.produce(stagingDir)
    assertRegularFileTree(stagingDir)
    const contentHash = hashRegularFileTree(stagingDir)
    await setOperationPhase(input.db, opId, 'fs-staged', {
      stagingPath: relative(input.appHome, stagingDir),
      candidateFingerprint: contentHash,
    })
    rmSync(versionDir, { recursive: true, force: true })
    mkdirSync(dirname(versionDir), { recursive: true, mode: 0o700 })
    cpSync(stagingDir, versionDir, { recursive: true })
    assertRegularFileTree(versionDir)
    if (hashRegularFileTree(versionDir) !== contentHash) {
      throw new Error('skill-version-candidate-hash-mismatch')
    }
    const createReservation = input.reserve !== undefined
    const state: VersionOperationState<TResult> = {
      opId,
      skillId: input.skillId,
      versionIndex: input.versionIndex,
      filesDir,
      stagingDir,
      versionDir,
      filesPath,
      contentHash,
      result: input.result,
      createReservation,
      published: false,
      completed: false,
    }
    if (createReservation) {
      const reservedAt = input.reserve?.now
      if (reservedAt === undefined) throw new Error('skill reservation timestamp is missing')
      await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
        const reserved = await transaction
          .update(skills)
          .set({
            managedPath: skillFilesRel(input.skillId),
            contentVersion: 1,
            versionState: 'snapshot-authoritative',
            updatedAt: reservedAt,
          })
          .where(
            and(
              eq(skills.id, input.skillId),
              eq(skills.reservationState, 'reserving'),
              eq(skills.contentVersion, 0),
            ),
          )
          .returning({ id: skills.id })
          .get()
        if (reserved === undefined) throw new Error('skill reservation lost before versioning')
        await transaction
          .insert(skillVersions)
          .values({
            id: ulid(),
            skillId: input.skillId,
            versionIndex: 1,
            filesPath,
            source: 'initial',
            summary: 'Initial version',
            fusionId: null,
            restoredFromVersion: null,
            authorUserId: input.authority.user.id,
            contentHash,
            createdAt: reservedAt,
          })
          .run()
      })
      mkdirSync(dirname(filesDir), { recursive: true, mode: 0o700 })
      swapInStaged(filesDir, opId)
      if (hashRegularFileTree(filesDir) !== contentHash) {
        throw new Error('skill-live-publish-hash-mismatch')
      }
      await setOperationPhase(input.db, opId, 'fs-published', {
        candidatePath: relative(input.appHome, versionDir),
      })
      state.published = true
    } else {
      await setOperationPhase(input.db, opId, 'fs-versioned', {
        candidatePath: relative(input.appHome, versionDir),
      })
    }
    return state
  } catch (error) {
    cleanupOpDirs(filesDir, opId)
    rmSync(versionDir, { recursive: true, force: true })
    if (input.reserve !== undefined) {
      rmSync(skillRootAbs(input.appHome, input.skillId), { recursive: true, force: true })
      await abandonReservation(input.db, input.skillId, opId)
    } else {
      await retireOperation(input.db, opId, 'aborted')
    }
    throw error
  }
}

function versionPlan<TResult>(
  db: PostgresqlDatabaseClient,
  state: VersionOperationState<TResult>,
  input: { readonly description?: string; readonly createdAt?: number },
): PostgresqlSkillVersionPlan<TResult> {
  return Object.freeze({
    filesPath: state.filesPath,
    contentHash: state.contentHash,
    result: state.result,
    async commitInTransaction(transaction, versionIndex) {
      if (versionIndex !== state.versionIndex) {
        throw new Error(`skill-version-plan-mismatch:${state.versionIndex}:${versionIndex}`)
      }
      if (state.createReservation) {
        const ready = await transaction
          .update(skills)
          .set({
            ...(input.description === undefined ? {} : { description: input.description }),
            managedPath: skillFilesRel(state.skillId),
            metaRevision: 0,
            reservationState: 'ready',
            versionState: 'snapshot-authoritative',
            ...(input.createdAt === undefined ? {} : { updatedAt: input.createdAt }),
          })
          .where(
            and(
              eq(skills.id, state.skillId),
              eq(skills.reservationState, 'reserving'),
              eq(skills.contentVersion, 1),
            ),
          )
          .returning({ id: skills.id })
          .get()
        if (ready === undefined) throw new Error('skill-reservation-lost')
      }
      await transaction
        .update(skillOperations)
        .set({ phase: 'db-committed' })
        .where(and(eq(skillOperations.opId, state.opId), eq(skillOperations.active, 1)))
        .run()
      unmarkSkillBootVerified(state.skillId)
    },
    async publish() {
      if (state.published) {
        markSkillBootVerified(state.skillId)
        return
      }
      mkdirSync(dirname(state.filesDir), { recursive: true, mode: 0o700 })
      swapInStaged(state.filesDir, state.opId)
      if (hashRegularFileTree(state.filesDir) !== state.contentHash) {
        throw new Error('skill-live-publish-hash-mismatch')
      }
      cleanupOpDirs(state.filesDir, state.opId)
      await setOperationPhase(db, state.opId, 'fs-published')
      state.published = true
      markSkillBootVerified(state.skillId)
    },
    async complete() {
      if (state.completed) return
      await retireOperation(db, state.opId, 'done')
      state.completed = true
    },
    async abort({ databaseCommitted }) {
      if (databaseCommitted) return
      cleanupOpDirs(state.filesDir, state.opId)
      rmSync(state.versionDir, { recursive: true, force: true })
      if (state.createReservation) {
        rmSync(dirname(state.filesDir), { recursive: true, force: true })
        await abandonReservation(db, state.skillId, state.opId)
      } else {
        await retireOperation(db, state.opId, 'aborted')
      }
    },
  })
}

function authoritativeDirectory(appHome: string, skill: Skill): string {
  return skillVersionAbs(appHome, skill.id, skill.contentVersion)
}

function assertNotMainFile(path: string): void {
  if (!isProtectedSkillMainFile(path)) return
  throw new ValidationError('skill-main-file-protected', 'SKILL.md must be edited through save')
}

/**
 * Durable PostgreSQL skill lifecycle. The factory owns filesystem paths and
 * the skill-operation journal; bootstrap supplies only the provider and app root.
 */
export function createPostgresqlSkillContentLifecycle(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly memoryFusion: PostgresqlSkillMemoryFusionParticipantFactory
}): PostgresqlSkillContentLifecycle {
  return Object.freeze<PostgresqlSkillContentLifecycle>({
    async isAvailable(skill) {
      const directory = authoritativeDirectory(input.appHome, skill)
      return (
        isSkillAvailableThisBoot({
          id: skill.id,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
        }) && existsSync(directory)
      )
    },
    async prepareCreate(request) {
      const result: SkillContent = Object.freeze({
        name: request.input.name,
        description: request.input.description,
        bodyMd: request.input.bodyMd,
        frontmatterExtra: Object.freeze({ ...request.input.frontmatterExtra }),
      })
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.id,
        skillName: request.input.name,
        versionIndex: 1,
        result,
        reserve: { description: request.input.description, now: request.now },
        produce(stagingDirectory) {
          writeFileSync(join(stagingDirectory, SKILL_MAIN), skillMarkdown(result), {
            mode: 0o600,
          })
        },
      })
      return Object.freeze({
        ...versionPlan(input.db, state, {
          description: request.input.description,
          createdAt: request.now,
        }),
        managedPath: skillFilesRel(request.id),
      })
    },
    async prepareSave(request) {
      const current = contentOf(
        request.current,
        authoritativeDirectory(input.appHome, request.current),
      )
      const result: SkillContent = Object.freeze({
        name: request.current.name,
        description: request.input.description ?? current.description,
        bodyMd: request.input.bodyMd ?? current.bodyMd,
        frontmatterExtra: Object.freeze({
          ...(request.input.frontmatterExtra ?? current.frontmatterExtra),
        }),
      })
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.current.id,
        skillName: request.current.name,
        currentVersion: request.current.contentVersion,
        versionIndex: request.current.contentVersion + 1,
        result,
        produce(stagingDirectory) {
          const target = realpathWriteInside(stagingDirectory, join(stagingDirectory, SKILL_MAIN))
          writeFileSync(target, skillMarkdown(result), { mode: 0o600 })
        },
      })
      return versionPlan(input.db, state, {
        ...(request.input.description === undefined
          ? {}
          : { description: request.input.description }),
      })
    },
    async prepareImportCreate(request) {
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.id,
        skillName: request.targetName,
        versionIndex: 1,
        result: undefined,
        reserve: { description: request.candidate.description, now: request.now },
        produce: (stagingDirectory) => writeCandidate(stagingDirectory, request.candidate),
      })
      return Object.freeze({
        ...versionPlan(input.db, state, {
          description: request.candidate.description,
          createdAt: request.now,
        }),
        managedPath: skillFilesRel(request.id),
      })
    },
    async prepareImportOverwrite(request) {
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.current.id,
        skillName: request.targetName,
        currentVersion: request.current.contentVersion,
        versionIndex: request.current.contentVersion + 1,
        result: undefined,
        produce: (stagingDirectory) => writeCandidate(stagingDirectory, request.candidate),
      })
      return versionPlan(input.db, state, { description: request.candidate.description })
    },
    async prepareWriteFile(request) {
      assertNotMainFile(request.path)
      const result = Object.freeze({ path: request.path })
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.current.id,
        skillName: request.current.name,
        currentVersion: request.current.contentVersion,
        versionIndex: request.current.contentVersion + 1,
        result,
        produce(stagingDirectory) {
          const target = realpathWriteInside(
            stagingDirectory,
            safeJoin(stagingDirectory, request.path),
          )
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
          writeFileSync(target, request.input.content, { mode: 0o600 })
        },
      })
      return versionPlan(input.db, state, {})
    },
    async prepareDeleteFile(request) {
      assertNotMainFile(request.path)
      const result = Object.freeze({ path: request.path })
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.current.id,
        skillName: request.current.name,
        currentVersion: request.current.contentVersion,
        versionIndex: request.current.contentVersion + 1,
        result,
        produce(stagingDirectory) {
          const target = safeJoin(stagingDirectory, request.path)
          if (!existsSync(target)) {
            throw new NotFoundError(
              'skill-file-not-found',
              `file '${request.path}' not found in skill '${request.current.name}'`,
            )
          }
          realpathWriteInside(stagingDirectory, target)
          rmSync(target, { recursive: true, force: false })
        },
      })
      return versionPlan(input.db, state, {})
    },
    async prepareRestore(request) {
      const targetVersion = skillVersionAbs(input.appHome, request.current.id, request.version)
      if (!existsSync(targetVersion)) {
        throw new NotFoundError(
          'skill-version-not-found',
          `skill '${request.current.id}' has no version ${request.version}`,
        )
      }
      let unfusedMemoryIds: readonly string[] = Object.freeze([])
      const state = await prepareVersion({
        ...input,
        authority: request.authority,
        skillId: request.current.id,
        skillName: request.current.name,
        currentVersion: request.current.contentVersion,
        versionIndex: request.current.contentVersion + 1,
        result: undefined,
        produce(stagingDirectory) {
          clearDirectory(stagingDirectory)
          cpSync(targetVersion, stagingDirectory, { recursive: true })
        },
      })
      const base = versionPlan(input.db, state, {})
      return Object.freeze({
        filesPath: base.filesPath,
        contentHash: base.contentHash,
        get result() {
          return Object.freeze({ unfusedMemoryIds })
        },
        async commitInTransaction(transaction, versionIndex) {
          // The Memory-owned participant and Skill version bump share this
          // transaction, so fused provenance never observes a torn restore.
          unfusedMemoryIds = Object.freeze([
            ...(await input.memoryFusion.inTransaction(transaction).unfuseAboveVersion({
              skillId: request.current.id,
              aboveVersion: request.version,
            })),
          ])
          await base.commitInTransaction(transaction, versionIndex)
        },
        publish: () => base.publish(),
        complete: () => base.complete(),
        abort: (state) => base.abort(state),
      } satisfies PostgresqlSkillVersionPlan<Readonly<{ unfusedMemoryIds: readonly string[] }>>)
    },
    async prepareDelete(request): Promise<PostgresqlSkillDeletePlan> {
      const root = skillRootAbs(input.appHome, request.current.id)
      const opId = await beginOperation({
        db: input.db,
        skillId: request.current.id,
        kind: 'delete',
        ownerUserId: request.authority.user.id,
        preconditionJson: JSON.stringify({ skillId: request.current.id }),
      })
      const trash = join(input.appHome, 'skills', '.trash', `${request.current.id}-${opId}`)
      try {
        if (existsSync(root)) {
          mkdirSync(dirname(trash), { recursive: true, mode: 0o700 })
          renameSync(root, trash)
        }
        await setOperationPhase(input.db, opId, 'fs-staged', {
          backupPath: relative(input.appHome, trash),
        })
      } catch (error) {
        if (!existsSync(root) && existsSync(trash)) renameSync(trash, root)
        await retireOperation(input.db, opId, 'aborted')
        throw error
      }
      return Object.freeze({
        async commitInTransaction(transaction: PostgresqlResourceCatalogTransaction) {
          await transaction
            .update(skillOperations)
            .set({ phase: 'db-committed' })
            .where(and(eq(skillOperations.opId, opId), eq(skillOperations.active, 1)))
            .run()
          unmarkSkillBootVerified(request.current.id)
        },
        async publish() {
          rmSync(trash, { recursive: true, force: true })
        },
        async complete() {
          await retireOperation(input.db, opId, 'done')
        },
        async abort(state: { readonly databaseCommitted: boolean }) {
          if (state.databaseCommitted) return
          if (!existsSync(root) && existsSync(trash)) renameSync(trash, root)
          await retireOperation(input.db, opId, 'aborted')
        },
      })
    },
    async assertDeleteInTransaction(transaction, _authority, current) {
      const rows = await transaction
        .select({ id: agents.id, refs: agents.skills })
        .from(agents)
        .all()
      const referencing = rows.filter((row) => {
        try {
          const decoded: unknown = JSON.parse(row.refs)
          return (
            Array.isArray(decoded) &&
            decoded.some(
              (ref) =>
                typeof ref === 'object' &&
                ref !== null &&
                Reflect.get(ref, 'kind') === 'managed' &&
                Reflect.get(ref, 'skillId') === current.id,
            )
          )
        } catch {
          return false
        }
      })
      if (referencing.length > 0) {
        throw new ConflictError(
          'skill-in-use',
          `skill '${current.name}' is referenced by ${referencing.length} agent(s)`,
        )
      }
    },
    async readContent(skill) {
      return contentOf(skill, authoritativeDirectory(input.appHome, skill))
    },
    async listFiles(skill) {
      return fileTree(authoritativeDirectory(input.appHome, skill))
    },
    async readFile(skill, path) {
      const root = authoritativeDirectory(input.appHome, skill)
      const target = safeJoin(root, path)
      if (!existsSync(target)) {
        throw new NotFoundError(
          'skill-file-not-found',
          `file '${path}' not found in skill '${skill.name}'`,
        )
      }
      const real = realpathInside(root, target)
      if (statSync(real).isDirectory()) {
        throw new ValidationError('skill-file-is-dir', `'${path}' is a directory`)
      }
      return readFileSync(real, 'utf8')
    },
    async getVersionContent(skill, version): Promise<SkillVersionContent> {
      const root = skillVersionAbs(input.appHome, skill.id, version)
      if (!existsSync(root)) {
        throw new NotFoundError(
          'skill-version-not-found',
          `skill '${skill.id}' has no version ${version}`,
        )
      }
      return Object.freeze({
        versionIndex: version,
        content: contentOf(skill, root),
        files: fileTree(root),
      })
    },
    async diffVersions(skill, from, to): Promise<SkillVersionDiff> {
      const fromRoot = skillVersionAbs(input.appHome, skill.id, from)
      const toRoot = skillVersionAbs(input.appHome, skill.id, to)
      if (!existsSync(fromRoot) || !existsSync(toRoot)) {
        const missing = !existsSync(fromRoot) ? from : to
        throw new NotFoundError(
          'skill-version-not-found',
          `skill '${skill.id}' has no version ${missing}`,
        )
      }
      return Object.freeze({ from, to, diff: gitStyleDirDiff(treeOf(fromRoot), treeOf(toRoot)) })
    },
  })
}
