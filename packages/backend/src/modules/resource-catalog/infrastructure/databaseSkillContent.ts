// RFC-370 M0 — the skill content binding of a deployment without a persistent
// local disk: every content port over `skill_content_entries`.
//
// References keep the canonical relative layout (`skills/<id>/files`,
// `skills/<id>/versions/v<n>/files`, `skills/<id>/files.op-<pub>.staged`,
// `skills/.trash/<id>-<op>`) so the metadata AW persists for skills and their
// operations is identical in both deployments. Each step is one transaction:
// publishing swaps the live tree atomically, so recovery never meets a
// half-swapped tree, and a legacy name-keyed layout never exists here.
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { SkillContentReader, SkillContentReference } from '../application/skills/contentReader'
import type {
  SkillCreationContentStore,
  SkillTreeFiles,
} from '../application/skills/creationContentStore'
import type { SkillDeletionContentStore } from '../application/skills/deletionContentStore'
import type { SkillIdentityContentStore } from '../application/skills/identityContentStore'
import type { SkillIdentityInspector } from '../application/skills/identityInspector'
import type {
  SkillLifecycleContentStore,
  SkillSnapshotInspector,
} from '../application/skills/lifecycleContentStore'
import type { SkillPackageContentReader } from '../application/skills/packageContentReader'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'
import type {
  SkillVersionContentReader,
  SkillVersionTreeEntry,
} from '../application/skills/versionContentReader'
import type {
  SkillVersionContentChange,
  SkillVersionContentStore,
  SkillVersionPublication,
} from '../application/skills/versionContentStore'
import type { SkillVersionRecoveryContentStore } from '../application/skills/versionRecoveryContentStore'
import type { SkillContentBinding } from '../composition/skillContentBinding'
import type { SkillVersionPresenceQueries } from '../application/skills/contentAvailability'
import { skillFilesRel, skillRootRel, skillVersionRelPath } from './legacy/skillIdentityPaths'
import {
  LIVE_TREE,
  copyTree,
  decodeEntry,
  deleteTree,
  fileExists,
  fileNodesOf,
  hashSkillTree,
  isInsideSkillDirectory,
  liveTreeNames,
  normalizeSkillPath,
  readTree,
  readTreeRows,
  renameTree,
  stagingTree,
  trashTreeNames,
  trashTreeOf,
  trashTreePrefix,
  treeExists,
  versionTree,
  writeTree,
  type SkillTreeFile,
} from './databaseSkillTrees'
import { createDatabaseSkillTreeContent } from './databaseSkillTreeContent'

const MAIN = 'SKILL.md'
const OPERATION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const STAGING_REFERENCE = /^skills\/([^/]+)\/files\.op-([0-9A-HJKMNP-TV-Z]{26})\.staged$/

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

function stagingRef(skillId: string, publicationId: string): string {
  return `${skillRootRel(skillId)}/files.op-${publicationId}.staged`
}

function trashRef(skillId: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) {
    throw new Error(`delete operation has invalid op_id: ${operationId}`)
  }
  return `skills/.trash/${skillId}-${operationId}`
}

/** `writeFileSkillTree`: files except SKILL.md, then SKILL.md from the main content. */
function treeOfFiles(content: SkillTreeFiles): SkillTreeFile[] {
  const files = content.files
    .filter((file) => file.path !== MAIN && !file.path.endsWith('/'))
    .map((file) => ({ path: normalizeSkillPath(file.path), bytes: file.content }))
  return [...files, { path: MAIN, bytes: encode(content.mainContent) }]
}

function withFile(files: readonly SkillTreeFile[], path: string, text: string): SkillTreeFile[] {
  return [...files.filter((file) => file.path !== path), { path, bytes: encode(text) }]
}

function withoutPath(files: readonly SkillTreeFile[], path: string): SkillTreeFile[] {
  return files.filter((file) => file.path !== path && !isInsideSkillDirectory(file.path, path))
}

export interface DatabaseSkillContent extends SkillContentBinding {
  readonly packageContent: SkillPackageContentReader
  /** RFC-370 §10 V20: fusion seeds and proposal candidates. */
  readonly treeContent: SkillTreeContentStore
}

export function createDatabaseSkillContent(input: {
  readonly db: PersistenceDb
  readonly now?: () => number
}): DatabaseSkillContent {
  const db = input.db
  const session = databaseSessionFor(db)
  const now = input.now ?? Date.now
  const tx = <T>(run: (handle: PersistenceDb) => Promise<T>): Promise<T> => session.transaction(run)

  /** RFC-170 snapshot preference: the selected version when stored, else live. */
  const readRoot = async (reference: SkillContentReference): Promise<string> =>
    (await treeExists(db, reference.id, versionTree(reference.contentVersion)))
      ? versionTree(reference.contentVersion)
      : LIVE_TREE

  const content = Object.freeze({
    async readMain(reference) {
      const tree = await readRoot(reference)
      const main = (await readTreeRows(db, reference.id, tree)).find((row) => row.path === MAIN)
      if (main === undefined) {
        throw new NotFoundError('skill-md-missing', `SKILL.md not found for skill ${reference.id}`)
      }
      return decode(decodeEntry(main))
    },
    async listFiles(reference) {
      return fileNodesOf(await readTreeRows(db, reference.id, await readRoot(reference)))
    },
    async readFile(reference, relPath) {
      const path = normalizeSkillPath(relPath)
      const rows = await readTreeRows(db, reference.id, await readRoot(reference))
      const row = rows.find((candidate) => candidate.path === path)
      if (row !== undefined) return decode(decodeEntry(row))
      if (rows.some((candidate) => isInsideSkillDirectory(candidate.path, path))) {
        throw new ValidationError('skill-file-is-dir', `'${relPath}' is a directory`)
      }
      throw new NotFoundError(
        'skill-file-not-found',
        `file '${relPath}' not found in skill '${reference.name}'`,
      )
    },
  } satisfies SkillContentReader)

  const versionReader = Object.freeze({
    async readSnapshot(reference) {
      const rows = await readTreeRows(db, reference.skillId, versionTree(reference.version))
      const main = rows.find((row) => row.path === MAIN)
      return {
        main: main === undefined ? null : decode(decodeEntry(main)),
        files: fileNodesOf(rows),
      }
    },
    async readTree(reference) {
      const out = new Map<string, SkillVersionTreeEntry>()
      for (const file of await readTree(db, reference.skillId, versionTree(reference.version))) {
        out.set(
          file.path,
          file.bytes.includes(0)
            ? { kind: 'binary', hash: sha256Hex(Buffer.from(file.bytes)) }
            : { kind: 'text', content: decode(file.bytes) },
        )
      }
      return out
    },
  } satisfies SkillVersionContentReader)

  const creationContent = Object.freeze({
    plan(skillId) {
      return { skillId, rootRef: skillRootRel(skillId), liveRef: skillFilesRel(skillId) }
    },
    async initialize(plan, initial) {
      const files =
        initial.kind === 'main'
          ? [{ path: MAIN, bytes: encode(initial.content) }]
          : treeOfFiles(initial)
      await tx((handle) => writeTree(handle, plan.skillId, LIVE_TREE, files, now()))
    },
    async discard(root) {
      await tx(async (handle) => {
        for (const tree of await liveTreeNames(handle, root.skillId)) {
          await deleteTree(handle, root.skillId, tree)
        }
      })
    },
  } satisfies SkillCreationContentStore)

  const applyChange = async (
    handle: PersistenceDb,
    publication: SkillVersionPublication,
    change: SkillVersionContentChange,
    staged: readonly SkillTreeFile[],
  ): Promise<readonly SkillTreeFile[]> => {
    switch (change.kind) {
      case 'retain':
        return staged
      case 'write-main':
        return withFile(staged, MAIN, change.content)
      case 'write-file':
        return withFile(staged, normalizeSkillPath(change.path), change.content)
      case 'delete-file':
        return withoutPath(staged, normalizeSkillPath(change.path))
      case 'restore-version':
        return await readTree(handle, publication.skillId, versionTree(change.version))
      case 'replace-files':
        return treeOfFiles(change)
    }
  }

  const versionContent = Object.freeze({
    plan(planInput) {
      const liveRef = skillFilesRel(planInput.skillId)
      const staging = stagingRef(planInput.skillId, planInput.publicationId)
      const versionRef = skillVersionRelPath(planInput.skillId, planInput.version)
      return {
        ...planInput,
        liveRef,
        stagingRef: staging,
        versionRef,
        stagingJournalRef: staging,
        versionJournalRef: versionRef,
      }
    },
    async stage(publication, change, compareLive) {
      return await tx(async (handle) => {
        const live = await readTree(handle, publication.skillId, LIVE_TREE)
        const staged = await applyChange(handle, publication, change, live)
        await writeTree(
          handle,
          publication.skillId,
          stagingTree(publication.publicationId),
          staged,
          now(),
        )
        const contentHash = hashSkillTree(staged)
        return { contentHash, matchesLive: compareLive && contentHash === hashSkillTree(live) }
      })
    },
    async discardStage(publication) {
      await deleteTree(db, publication.skillId, stagingTree(publication.publicationId))
    },
    async captureVersion(publication) {
      await tx((handle) =>
        copyTree(
          handle,
          publication.skillId,
          stagingTree(publication.publicationId),
          versionTree(publication.version),
          now(),
        ),
      )
    },
    async publish(publication, contentHash) {
      await tx(async (handle) => {
        const staging = stagingTree(publication.publicationId)
        const staged = await readTree(handle, publication.skillId, staging)
        if (hashSkillTree(staged) !== contentHash) {
          throw new Error(
            `skill version ${publication.version} live publish does not match committed content hash`,
          )
        }
        await writeTree(handle, publication.skillId, LIVE_TREE, staged, now())
        await deleteTree(handle, publication.skillId, staging)
      })
    },
    async abort(publication) {
      await tx(async (handle) => {
        await deleteTree(handle, publication.skillId, stagingTree(publication.publicationId))
        await deleteTree(handle, publication.skillId, versionTree(publication.version))
      })
    },
  } satisfies SkillVersionContentStore)

  const deletionContent = Object.freeze({
    plan(planInput) {
      const backupRef = trashRef(planInput.skillId, planInput.operationId)
      if (planInput.recordedBackupRef != null && planInput.recordedBackupRef !== backupRef) {
        throw new Error(
          `delete operation ${planInput.operationId} backup path does not match its op identity`,
        )
      }
      return {
        skillId: planInput.skillId,
        operationId: planInput.operationId,
        rootRef: skillRootRel(planInput.skillId),
        backupRef,
        backupJournalRef: backupRef,
      }
    },
    async stage(plan) {
      await tx(async (handle) => {
        for (const tree of await liveTreeNames(handle, plan.skillId)) {
          await renameTree(handle, plan.skillId, tree, trashTreeOf(plan.operationId, tree))
        }
      })
    },
    async rollback(plan, recovery) {
      await tx(async (handle) => {
        const label = recovery ? 'delete recovery' : 'delete rollback'
        const live = await liveTreeNames(handle, plan.skillId)
        const trash = await trashTreeNames(handle, plan.skillId, plan.operationId)
        if (live.length > 0 && trash.length > 0) {
          throw new Error(`${label} collision for skill ${plan.skillId}`)
        }
        if (live.length === 0 && trash.length === 0) {
          throw new Error(`${label} lost both root and trash for skill ${plan.skillId}`)
        }
        const prefix = trashTreePrefix(plan.operationId)
        for (const tree of trash) {
          await renameTree(handle, plan.skillId, tree, tree.slice(prefix.length))
        }
      })
    },
    async discard(plan) {
      await tx(async (handle) => {
        for (const tree of await trashTreeNames(handle, plan.skillId, plan.operationId)) {
          await deleteTree(handle, plan.skillId, tree)
        }
      })
    },
  } satisfies SkillDeletionContentStore)

  const lifecycleContent = Object.freeze({
    hasLiveMain: (skillId) => fileExists(db, skillId, LIVE_TREE, MAIN),
    async captureInitial(skillId) {
      return await tx(async (handle) => {
        if (!(await fileExists(handle, skillId, LIVE_TREE, MAIN))) return null
        const live = await readTree(handle, skillId, LIVE_TREE)
        await writeTree(handle, skillId, versionTree(1), live, now())
        return hashSkillTree(live)
      })
    },
    async isRootEmpty(skillId) {
      return (await liveTreeNames(db, skillId)).length === 0
    },
    async removeRoot(skillId) {
      await tx(async (handle) => {
        for (const tree of await liveTreeNames(handle, skillId)) {
          await deleteTree(handle, skillId, tree)
        }
      })
    },
    async restoreLiveIfMissing(skillId, version) {
      await tx(async (handle) => {
        if (await fileExists(handle, skillId, LIVE_TREE, MAIN)) return
        if (!(await treeExists(handle, skillId, versionTree(version)))) return
        await copyTree(handle, skillId, versionTree(version), LIVE_TREE, now())
      })
    },
  } satisfies SkillLifecycleContentStore)

  const snapshotInspector = Object.freeze({
    async inspect(inspection) {
      const reject = (reason: string) => ({ ok: false as const, reason })
      for (const version of inspection.versions) {
        if (version.reference !== skillVersionRelPath(inspection.skillId, version.version)) {
          return reject(`version ${version.version} path is not canonical`)
        }
        const files = await readTree(db, inspection.skillId, versionTree(version.version))
        if (files.length === 0) return reject(`version ${version.version} directory missing`)
        if (!files.some((file) => file.path === MAIN)) {
          return reject(`version ${version.version} SKILL.md missing`)
        }
        if (hashSkillTree(files) !== version.contentHash) {
          return reject(`version ${version.version} hash mismatch (tampered/corrupt)`)
        }
      }
      const current = inspection.versions.find(
        (version) => version.version === inspection.currentVersion,
      )!
      const live = await readTree(db, inspection.skillId, LIVE_TREE)
      if (live.length === 0) return reject('canonical live files directory missing')
      if (hashSkillTree(live) !== current.contentHash) {
        return reject('canonical live tree differs from current committed version')
      }
      return { ok: true as const }
    },
  } satisfies SkillSnapshotInspector)

  const versionRecovery = Object.freeze({
    plan(planInput) {
      const staging = STAGING_REFERENCE.exec(planInput.stagingReference)
      if (staging === null || staging[1] !== planInput.skillId) {
        throw new Error(
          `version-write ${planInput.operationId} staging path does not match its identity/phase payload`,
        )
      }
      const versionRef = skillVersionRelPath(planInput.skillId, planInput.version)
      if (planInput.versionReference !== versionRef) {
        throw new Error(
          `version-write ${planInput.operationId} candidate path does not match its identity/phase payload`,
        )
      }
      return {
        skillId: planInput.skillId,
        operationId: planInput.operationId,
        version: planInput.version,
        publicationId: staging[2]!,
        rootRef: skillRootRel(planInput.skillId),
        liveRef: skillFilesRel(planInput.skillId),
        stagingRef: planInput.stagingReference,
        versionRef,
      }
    },
    matchesVersionReference: (plan, reference) => reference === plan.versionRef,
    async rollback(plan) {
      await tx(async (handle) => {
        if (!(await fileExists(handle, plan.skillId, LIVE_TREE, MAIN))) {
          throw new Error(
            `version-write ${plan.operationId} rollback cannot prove a canonical live tree`,
          )
        }
        await deleteTree(handle, plan.skillId, stagingTree(plan.publicationId))
        await deleteTree(handle, plan.skillId, versionTree(plan.version))
      })
    },
    async rollForward(plan, contentHash) {
      await tx(async (handle) => {
        const candidate = await readTree(handle, plan.skillId, versionTree(plan.version))
        if (candidate.length === 0 || hashSkillTree(candidate) !== contentHash) {
          throw new Error(
            `version-write ${plan.operationId} version snapshot does not match committed content hash`,
          )
        }
        const live = await readTree(handle, plan.skillId, LIVE_TREE)
        if (live.length === 0 || hashSkillTree(live) !== contentHash) {
          await writeTree(handle, plan.skillId, LIVE_TREE, candidate, now())
        }
        await deleteTree(handle, plan.skillId, stagingTree(plan.publicationId))
      })
    },
  } satisfies SkillVersionRecoveryContentStore)

  // Name-keyed legacy layouts never exist in database storage: rows are keyed by
  // the immutable skill id from their first write, so identity migration only
  // canonicalizes metadata and the physical moves are no-ops.
  const identityContent = Object.freeze({
    plan(identity) {
      return {
        ...identity,
        legacyRef: `skills/${identity.legacyName}`,
        canonicalRef: skillRootRel(identity.skillId),
      }
    },
    async captureSource(plan) {
      const trees = [...(await liveTreeNames(db, plan.skillId))].sort()
      const parts: string[] = []
      for (const tree of trees) {
        parts.push(`${tree}\u0000${hashSkillTree(await readTree(db, plan.skillId, tree))}`)
      }
      return sha256Hex(parts.join('\u0000'))
    },
    move: () => {},
    rollback: () => {},
    rollForward: () => {},
  } satisfies SkillIdentityContentStore)

  const postcondition = (message: string): never => {
    throw new ValidationError('skill-migration-postcondition-failed', message)
  }
  const identityInspector = Object.freeze({
    prepare: () => {},
    assertOwnership: () => {},
    needsMigration: (row) => !row.canonicalMetadata,
    prepareHuskSweep: () => ({ plan: () => null, discard: () => {} }),
    async assertCanonicalRoot(skillId) {
      if ((await liveTreeNames(db, skillId)).length === 0) {
        postcondition(`skill ${skillId} has no stored content`)
      }
    },
    async assertCanonicalLive(skillId) {
      if (!(await fileExists(db, skillId, LIVE_TREE, MAIN))) {
        postcondition(`skill ${skillId} has no live SKILL.md`)
      }
    },
    async assertCanonicalVersion(skillId, version) {
      if (!(await fileExists(db, skillId, versionTree(version), MAIN))) {
        postcondition(`skill ${skillId} v${version} has no SKILL.md`)
      }
    },
    async assertNoResidue() {
      const { skillContentEntries } = tablesOf(db)
      const residue = await db
        .selectDistinct({ skillId: skillContentEntries.skillId, tree: skillContentEntries.tree })
        .from(skillContentEntries)
      const leftovers = residue.filter(
        (row) => row.tree.startsWith('staging:') || row.tree.startsWith('trash:'),
      )
      if (leftovers.length > 0) {
        postcondition(`${leftovers.length} unfinished skill content tree(s) remain after recovery`)
      }
    },
    async assertPublishedReserve(reserve) {
      const live = await readTree(db, reserve.skillId, LIVE_TREE)
      const first = await readTree(db, reserve.skillId, versionTree(1))
      if (!live.some((file) => file.path === MAIN) || !first.some((file) => file.path === MAIN)) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `reserve operation ${reserve.operationId} has no complete published v1 tree`,
        )
      }
      if (
        hashSkillTree(first) !== reserve.contentHash ||
        hashSkillTree(live) !== reserve.contentHash
      ) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `reserve operation ${reserve.operationId} published v1 does not match DB authority`,
        )
      }
    },
    async assertCommittedDelete(deletion) {
      if (deletion.backupReference !== trashRef(deletion.skillId, deletion.operationId)) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `delete operation ${deletion.operationId} trash path does not match its identity`,
        )
      }
      if ((await liveTreeNames(db, deletion.skillId)).length > 0) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `delete operation ${deletion.operationId} has a committed row deletion but live root remains`,
        )
      }
    },
  } satisfies SkillIdentityInspector)

  const versionPresence = Object.freeze({
    exists: (reference) => treeExists(db, reference.id, versionTree(reference.contentVersion)),
  } satisfies SkillVersionPresenceQueries)

  const packageContent = Object.freeze({
    async readTree(reference) {
      const files = await readTree(db, reference.id, await readRoot(reference))
      if (files.length === 0) {
        throw new ValidationError(
          'resource-package-skill-tree-invalid',
          `skill ${reference.id} has no stored content`,
        )
      }
      return [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => Object.freeze({ path: file.path, bytes: file.bytes }))
    },
  } satisfies SkillPackageContentReader)

  return Object.freeze({
    rootReference: 'database:skill_content_entries',
    content,
    versionReader,
    lifecycleContent,
    deletionContent,
    versionContent,
    creationContent,
    versionPresence,
    snapshotInspector,
    versionRecovery,
    identityContent,
    identityInspector,
    packageContent,
    treeContent: createDatabaseSkillTreeContent({ db, now }),
  })
}
