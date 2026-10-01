import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  SkillIdentityInspector,
  SkillIdentityInventoryRow,
  SkillIdentityOperationInspection,
  SkillIdentityHuskSweep,
} from '../../application/skills/identityInspector'
import {
  legacySkillRootAbs,
  realDirectoryChainState,
  rebaseSkillOperationPath,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from '../legacy/skillIdentityPaths'
import { hashRegularFileTree } from '../legacy/skillHash'
import { ValidationError } from '@/util/errors'

/** Existing physical proofs; row/version/operation authority is selected by AW. */
export function createFileSkillIdentityInspector(appHome: string): SkillIdentityInspector {
  return {
    prepare: () => ensureSkillFilesystemBoundary(appHome),
    assertOwnership: (rows, operations) =>
      preflightPhysicalOwnershipGraph(rows, operations, appHome),
    needsMigration(row) {
      const oldRoot = legacySkillRootAbs(appHome, row.name)
      const newRoot = skillRootAbs(appHome, row.id)
      const oldIdentity = pathEntryIdentity(oldRoot)
      const newIdentity = pathEntryIdentity(newRoot)
      const oldExists = oldIdentity !== null
      const newExists = newIdentity !== null
      const sameEntry = oldIdentity !== null && newIdentity !== null && oldIdentity === newIdentity
      if (row.canonicalMetadata && newExists) return false
      if (oldIdentity !== null && !isRealDirectory(oldRoot)) {
        throw new ValidationError(
          'skill-migration-root-invalid',
          `legacy root is not a real directory for skill ${row.id}`,
        )
      }
      if (newIdentity !== null && !isRealDirectory(newRoot)) {
        throw new ValidationError(
          'skill-migration-root-invalid',
          `canonical root is not a real directory for skill ${row.id}`,
        )
      }
      if (oldIdentity !== null && newIdentity !== null && !sameEntry) {
        throw new ValidationError(
          'skill-migration-root-collision',
          `skill ${row.id} has both legacy-name and canonical-id directories`,
        )
      }
      if (!oldExists && !newExists) {
        throw new ValidationError(
          'skill-migration-root-missing',
          `skill ${row.id} has no recoverable filesystem directory`,
        )
      }
      if (newExists && !oldExists && !row.canonicalMetadata) {
        throw new ValidationError(
          'skill-migration-untracked-canonical-root',
          `skill ${row.id} has an id directory but non-canonical DB paths`,
        )
      }
      return !row.canonicalMetadata || !newExists
    },
    prepareHuskSweep: (rows) => prepareHuskSweep(rows, appHome),
    assertCanonicalRoot(skillId) {
      if (!isRealDirectory(skillRootAbs(appHome, skillId))) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `canonical root is missing or not a real directory for skill ${skillId}`,
        )
      }
    },
    assertCanonicalLive(skillId) {
      if (
        realDirectoryChainState(skillRootAbs(appHome, skillId), skillFilesAbs(appHome, skillId)) !==
        'real-directory'
      ) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `managed_path does not point to a real files directory for skill ${skillId}`,
        )
      }
    },
    assertCanonicalVersion(skillId, version) {
      if (
        realDirectoryChainState(
          skillRootAbs(appHome, skillId),
          skillVersionAbs(appHome, skillId, version),
        ) !== 'real-directory'
      ) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `version directory missing for skill ${skillId} v${version}`,
        )
      }
    },
    assertNoResidue: () => assertNoOperationResidue(appHome),
    assertPublishedReserve(input) {
      const root =
        input.legacyName === undefined
          ? skillRootAbs(appHome, input.skillId)
          : legacySkillRootAbs(appHome, input.legacyName)
      const live = join(root, 'files'),
        version = join(root, 'versions', 'v1', 'files')
      if (
        realDirectoryChainState(root, live) !== 'real-directory' ||
        realDirectoryChainState(root, version) !== 'real-directory' ||
        !isRegularFile(join(live, 'SKILL.md')) ||
        !isRegularFile(join(version, 'SKILL.md'))
      ) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `reserve operation ${input.operationId} has no complete published v1 tree`,
        )
      }
      if (
        hashRegularFileTree(version) !== input.contentHash ||
        hashRegularFileTree(live) !== input.contentHash
      ) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `reserve operation ${input.operationId} published v1 does not match DB authority`,
        )
      }
    },
    assertCommittedDelete(input) {
      const expected = join(appHome, 'skills', '.trash', `${input.skillId}-${input.operationId}`)
      const actual = rebaseSkillOperationPath(appHome, input.backupReference, '.trash')
      if (actual !== expected) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `delete operation ${input.operationId} trash path does not match its identity`,
        )
      }
      const root =
        input.legacyName === undefined
          ? skillRootAbs(appHome, input.skillId)
          : legacySkillRootAbs(appHome, input.legacyName)
      if (pathEntryExists(root)) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `delete operation ${input.operationId} has a committed row deletion but live root remains`,
        )
      }
      if (input.legacyName !== undefined && pathEntryExists(skillRootAbs(appHome, input.skillId))) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `legacy delete operation ${input.operationId} has a committed row deletion but canonical root remains`,
        )
      }
    },
  }
}

function prepareHuskSweep(
  allRows: readonly SkillIdentityInventoryRow[],
  appHome: string,
): SkillIdentityHuskSweep {
  const physicalOwners = new Map<string, Set<string>>()
  for (const row of allRows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const canonicalExists = pathEntryIdentity(canonicalRoot) !== null
    const paths = new Set<string>([canonicalRoot])
    if (!row.canonicalMetadata || !canonicalExists) paths.add(legacySkillRootAbs(appHome, row.name))
    for (const path of paths) {
      const identity = pathEntryIdentity(path)
      if (identity === null) continue
      const owners = physicalOwners.get(identity) ?? new Set<string>()
      owners.add(row.id)
      physicalOwners.set(identity, owners)
    }
  }
  return {
    plan(row) {
      const canonicalRoot = skillRootAbs(appHome, row.id)
      const canonicalExists = pathEntryIdentity(canonicalRoot) !== null
      const rowState = allRows.find((candidate) => candidate.id === row.id)
      const roots = new Set<string>(
        rowState?.canonicalMetadata && canonicalExists
          ? [canonicalRoot]
          : canonicalExists
            ? [canonicalRoot]
            : [legacySkillRootAbs(appHome, row.name)],
      )
      if (
        [...roots].some((root) => {
          const identity = pathEntryIdentity(root)
          if (identity === null) return false
          const owners = physicalOwners.get(identity)
          return (
            owners === undefined ||
            owners.size !== 1 ||
            !owners.has(row.id) ||
            !dirHasNoContent(root)
          )
        })
      )
        return null
      return { skillId: row.id, contentRefs: [...roots] }
    },
    discard(plan) {
      for (const root of plan.contentRefs) {
        if (probePath(root) === 'exists') rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

function assertNoOperationResidue(appHome: string): void {
  const skillsRoot = join(appHome, 'skills')
  if (!existsSync(skillsRoot)) return
  const trash = join(skillsRoot, '.trash')
  if (probePath(trash) === 'exists' && !isRealDirectory(trash)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skill delete trash is not a real directory',
    )
  }
  if (existsSync(trash) && readdirSync(trash).length > 0) {
    throw new ValidationError(
      'skill-migration-operation-residue',
      'skill delete trash still contains operation residue',
    )
  }

  const residue = /^files\.op-[0-9A-HJKMNP-TV-Z]{26}\.(?:staged|backup|candidate)$/
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.trash') continue
    const root = join(skillsRoot, entry.name)
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (residue.test(child.name)) {
        throw new ValidationError(
          'skill-migration-operation-residue',
          `skill operation residue remains at ${join(root, child.name)}`,
        )
      }
    }
  }
}

function ensureSkillFilesystemBoundary(appHome: string): void {
  const skillsRoot = join(appHome, 'skills')
  if (probePath(skillsRoot) === 'missing') {
    mkdirSync(skillsRoot, { recursive: true })
  }
  if (!isRealDirectory(skillsRoot)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skills root is not a real directory',
    )
  }

  const trash = join(skillsRoot, '.trash')
  if (probePath(trash) === 'exists' && !isRealDirectory(trash)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skill delete trash is not a real directory',
    )
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function probePath(path: string): 'exists' | 'missing' {
  try {
    lstatSync(path)
    return 'exists'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new ValidationError(
      'skill-migration-path-unreadable',
      `cannot prove skill path state at ${path}`,
    )
  }
}

function pathEntryExists(path: string): boolean {
  return probePath(path) === 'exists'
}

function pathEntryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path)
    return `${stat.dev}:${stat.ino}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ValidationError(
      'skill-migration-path-unreadable',
      `cannot prove skill path identity at ${path}`,
    )
  }
}

function dirHasNoContent(root: string): boolean {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return false
    if (!dirHasNoContent(join(root, entry.name))) return false
  }
  return true
}

interface PhysicalClaim {
  skillId: string
  path: string
  source: string
}

function preflightPhysicalOwnershipGraph(
  rows: readonly SkillIdentityInventoryRow[],
  active: readonly SkillIdentityOperationInspection[],
  appHome: string,
): Promise<void> {
  const claims = new Map<string, PhysicalClaim>()
  const rootClaims = new Map<string, PhysicalClaim>()
  const canonicalLogicalClaims = new Map<string, PhysicalClaim>()
  const addPhysicalClaim = (skillId: string, path: string, source: string): void => {
    const identity = pathEntryIdentity(path)
    if (identity === null) return
    if (!isRealDirectory(path)) {
      throw new ValidationError(
        'skill-migration-root-invalid',
        `${source} is not a real directory: ${path}`,
      )
    }
    const prior = claims.get(identity)
    if (prior !== undefined && prior.skillId !== skillId) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `${source} for skill ${skillId} shares a filesystem entry with ` +
          `${prior.source} for skill ${prior.skillId}`,
      )
    }
    claims.set(identity, { skillId, path, source })
  }
  const addRootClaim = (skillId: string, path: string, source: string): void => {
    const identity = pathEntryIdentity(path)
    if (identity === null) return
    const prior = rootClaims.get(skillId)
    if (prior !== undefined && pathEntryIdentity(prior.path) !== identity) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `${source} and ${prior.source} claim different roots for skill ${skillId}`,
      )
    }
    addPhysicalClaim(skillId, path, source)
    rootClaims.set(skillId, { skillId, path, source })
  }

  // Canonical roots are the only durable row ownership paths. Build them first
  // so a fully-canonical row's display-name alias can be recognized as another
  // row's legitimate canonical entry instead of being misclassified as residue.
  for (const row of rows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const logicalKey = resolve(canonicalRoot)
    const priorLogical = canonicalLogicalClaims.get(logicalKey)
    if (priorLogical !== undefined && priorLogical.skillId !== row.id) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `canonical roots for skills ${row.id} and ${priorLogical.skillId} resolve to the same path`,
      )
    }
    canonicalLogicalClaims.set(logicalKey, {
      skillId: row.id,
      path: canonicalRoot,
      source: 'canonical row root',
    })
    addRootClaim(row.id, canonicalRoot, 'canonical row root')
  }

  for (const row of rows) {
    const legacyRoot = legacySkillRootAbs(appHome, row.name)
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const legacyIdentity = pathEntryIdentity(legacyRoot)
    const canonicalIdentity = pathEntryIdentity(canonicalRoot)
    const dbCanonical = row.canonicalMetadata
    const needsLegacyOwnership = !dbCanonical || canonicalIdentity === null

    if (needsLegacyOwnership) {
      const logicalOwner = canonicalLogicalClaims.get(resolve(legacyRoot))
      if (logicalOwner !== undefined && logicalOwner.skillId !== row.id) {
        throw new ValidationError(
          'skill-migration-physical-ownership-collision',
          `legacy root for skill ${row.id} resolves to canonical root for ` +
            `skill ${logicalOwner.skillId}`,
        )
      }
      addRootClaim(row.id, legacyRoot, 'legacy row root')
    } else if (
      legacyIdentity !== null &&
      legacyIdentity !== canonicalIdentity &&
      !claims.has(legacyIdentity)
    ) {
      throw new ValidationError(
        'skill-migration-unclaimed-legacy-residue',
        `canonical skill ${row.id} has an unclaimed display-name directory`,
      )
    }
  }

  for (const op of active) {
    const identity = { skillId: op.skillId, legacyName: op.legacyName }
    const key = identity.legacyName ?? identity.skillId
    const operationRoot =
      identity.legacyName === undefined
        ? skillRootAbs(appHome, identity.skillId)
        : legacySkillRootAbs(appHome, identity.legacyName)
    if (identity.legacyName !== undefined) {
      const logicalOwner = canonicalLogicalClaims.get(resolve(operationRoot))
      if (logicalOwner !== undefined && logicalOwner.skillId !== op.skillId) {
        throw new ValidationError(
          'skill-migration-physical-ownership-collision',
          `active ${op.kind} operation for ${op.skillId} targets canonical root ` +
            `for ${logicalOwner.skillId}`,
        )
      }
    }
    addRootClaim(op.skillId, operationRoot, `active ${op.kind} operation root`)

    for (const [column, storedPath] of [
      ['staging_path', op.stagingPath],
      ['candidate_path', op.candidatePath],
      ['backup_path', op.backupPath],
    ] as const) {
      if (storedPath === null) continue
      const isDeleteTrash = op.kind === 'delete' && column === 'backup_path'
      const chainRoot = isDeleteTrash ? join(appHome, 'skills', '.trash') : operationRoot
      const rebased = rebaseSkillOperationPath(appHome, storedPath, isDeleteTrash ? '.trash' : key)
      const state = realDirectoryChainState(chainRoot, rebased)
      if (state === 'real-directory') {
        addPhysicalClaim(op.skillId, rebased, `active ${op.kind} ${column}`)
      }
    }
  }
}
