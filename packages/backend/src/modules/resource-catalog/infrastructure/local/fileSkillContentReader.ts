import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { normalizeSkillPath } from '../databaseSkillTrees'
import {
  currentFileSkillReference,
  readFileSkillReference,
  readFileSkillReferenceFile,
} from './fileSkillReferences'
import { existsSync } from 'node:fs'
import { NotFoundError, ValidationError } from '@/util/errors'
import type {
  SkillContentReader,
  SkillContentReference,
} from '../../application/skills/contentReader'
import { skillFilesAbs, skillVersionAbs } from '../legacy/skillIdentityPaths'

/** Original RFC-170 snapshot preference, including the legacy live fallback. */
export function resolveFileSkillReadRoot(
  appHome: string,
  reference: SkillContentReference,
): string {
  const live = skillFilesAbs(appHome, reference.id)
  const snapshot = skillVersionAbs(appHome, reference.id, reference.contentVersion)
  return existsSync(snapshot) ? snapshot : live
}

/** Reads the explicit location for each live or immutable tree. */
export function createFileSkillContentReader(
  appHome: string,
  db?: PersistenceDb,
): SkillContentReader {
  const tree = async (reference: SkillContentReference) =>
    readFileSkillReference(appHome, db, await currentFileSkillReference(appHome, db, reference))
  return Object.freeze({
    async readMain(reference) {
      const file = await readFileSkillReferenceFile(
        appHome,
        db,
        await currentFileSkillReference(appHome, db, reference),
        'SKILL.md',
      )
      if (!file)
        throw new NotFoundError('skill-md-missing', `SKILL.md not found for skill ${reference.id}`)
      return file
    },
    async listFiles(reference) {
      return (await tree(reference))?.nodes ?? []
    },
    async readFile(reference, relPath) {
      const path = normalizeSkillPath(relPath)
      const bytes = await readFileSkillReferenceFile(
        appHome,
        db,
        await currentFileSkillReference(appHome, db, reference),
        path,
      )
      if (bytes !== null) return bytes
      const content = await tree(reference)
      if (content?.nodes.some((node) => node.path === path && node.type === 'dir'))
        throw new ValidationError('skill-file-is-dir', `'${relPath}' is a directory`)
      throw new NotFoundError(
        'skill-file-not-found',
        `file '${relPath}' not found in skill '${reference.name}'`,
      )
    },
  } satisfies SkillContentReader)
}
