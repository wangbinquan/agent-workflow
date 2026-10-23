// RFC-370 §10 V20 — strict version trees and fusion candidates kept in
// `skill_content_entries`. A candidate is its own tree namespace
// (`candidate:<id>`): never live, a version, staging or trash, so recovery and
// residue checks ignore it, and deleting the skill removes it with the rest.
import { candidateTree as legacyCandidateTree } from '@/platform/content/legacySkill'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ValidationError } from '@/util/errors'
import type { SkillPackageContentEntry } from '../application/skills/packageContentReader'
import {
  SKILL_CANDIDATE_ID,
  type SkillTreeContentStore,
} from '../application/skills/treeContentStore'
import {
  deleteTree,
  readTree,
  versionTree,
  writeTree,
  type SkillTreeFile,
} from './databaseSkillTrees'

export function candidateTree(candidateId: string): string {
  if (!SKILL_CANDIDATE_ID.test(candidateId))
    throw new ValidationError(
      'skill-candidate-invalid',
      `invalid skill candidate id: ${candidateId}`,
    )
  return legacyCandidateTree(candidateId)
}

function entries(files: readonly SkillTreeFile[]): readonly SkillPackageContentEntry[] | null {
  if (files.length === 0) return null
  return [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => Object.freeze({ path: file.path, bytes: file.bytes }))
}

export function createDatabaseSkillTreeContent(input: {
  readonly db: PersistenceDb
  readonly now?: () => number
}): SkillTreeContentStore {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const transaction = <T>(run: (handle: PersistenceDb) => Promise<T>): Promise<T> =>
    session.transaction(run)
  return Object.freeze({
    async readVersion(request: { readonly skillId: string; readonly version: number }) {
      return entries(await readTree(input.db, request.skillId, versionTree(request.version)))
    },
    async writeCandidate(request: {
      readonly skillId: string
      readonly candidateId: string
      readonly files: readonly SkillPackageContentEntry[]
    }) {
      const tree = candidateTree(request.candidateId)
      await transaction((handle) =>
        writeTree(
          handle,
          request.skillId,
          tree,
          request.files.map((file) => ({ path: file.path, bytes: file.bytes })),
          now(),
        ),
      )
    },
    async readCandidate(request: { readonly skillId: string; readonly candidateId: string }) {
      return entries(await readTree(input.db, request.skillId, candidateTree(request.candidateId)))
    },
    async discardCandidate(request: { readonly skillId: string; readonly candidateId: string }) {
      const tree = candidateTree(request.candidateId)
      await transaction((handle) => deleteTree(handle, request.skillId, tree))
    },
  } satisfies SkillTreeContentStore)
}
