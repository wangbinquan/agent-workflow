import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { fileSkillTreeReference, readFileSkillReference } from './fileSkillReferences'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { ValidationError } from '@/util/errors'
import type { SkillPackageContentEntry } from '../../application/skills/packageContentReader'
import {
  SKILL_CANDIDATE_ID,
  type SkillTreeContentStore,
} from '../../application/skills/treeContentStore'
import { normalizeSkillPath } from '../databaseSkillTrees'
import { skillRootAbs } from '../legacy/skillIdentityPaths'
import { assertRegularDirectory, collectSkillFiles } from './fileSkillPackageContentReader'

/** `skills/<id>/candidates/<candidate>/files`: beside the skill's live and version trees. */
function candidateRoot(appHome: string, skillId: string, candidateId: string): string {
  if (!SKILL_CANDIDATE_ID.test(candidateId))
    throw new ValidationError(
      'skill-candidate-invalid',
      `invalid skill candidate id: ${candidateId}`,
    )
  return join(skillRootAbs(appHome, skillId), 'candidates', candidateId)
}

function readTree(root: string): SkillPackageContentEntry[] {
  assertRegularDirectory(root, 'skill-tree-invalid')
  const paths: string[] = []
  collectSkillFiles(root, '', paths)
  return paths
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((path) => Object.freeze({ path, bytes: new Uint8Array(readFileSync(join(root, path))) }))
}

/** RFC-370 §10 V20 — the local skill storage's strict version trees and fusion candidates. */
export function createFileSkillTreeContentStore(
  appHome: string,
  db?: PersistenceDb,
): SkillTreeContentStore {
  return Object.freeze({
    async readVersion(input: { readonly skillId: string; readonly version: number }) {
      const tree = await readFileSkillReference(
        appHome,
        db,
        await fileSkillTreeReference(appHome, db, input.skillId, input.version),
      )
      return tree?.files ?? null
    },
    async writeCandidate(input: {
      readonly skillId: string
      readonly candidateId: string
      readonly files: readonly SkillPackageContentEntry[]
    }) {
      const root = candidateRoot(appHome, input.skillId, input.candidateId)
      // Written aside and renamed in, so a reader never meets half a candidate.
      const staging = `${root}.tmp-${ulid()}`
      try {
        const files = join(staging, 'files')
        mkdirSync(files, { recursive: true })
        for (const file of input.files) {
          const target = join(files, ...normalizeSkillPath(file.path).split('/'))
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, file.bytes)
        }
        rmSync(root, { recursive: true, force: true })
        renameSync(staging, root)
      } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        throw error
      }
    },
    async readCandidate(input: { readonly skillId: string; readonly candidateId: string }) {
      const files = join(candidateRoot(appHome, input.skillId, input.candidateId), 'files')
      return existsSync(files) ? readTree(files) : null
    },
    async discardCandidate(input: { readonly skillId: string; readonly candidateId: string }) {
      rmSync(candidateRoot(appHome, input.skillId, input.candidateId), {
        recursive: true,
        force: true,
      })
    },
  } satisfies SkillTreeContentStore)
}
