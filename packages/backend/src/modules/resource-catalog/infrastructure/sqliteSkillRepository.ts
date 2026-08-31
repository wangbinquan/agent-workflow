import type { DbClient } from '@/db/client'
import {
  createManagedSkill,
  deleteSkill,
  deleteSkillFile,
  getSkillById,
  getSkillPreconditionTokenById,
  listSkillFiles,
  listSkills,
  readSkillContent,
  readSkillFile,
  saveSkillWithToken,
  writeSkillFile,
  type SkillFsOptions,
} from '@/services/skill'
import {
  diffSkillVersions,
  getSkillVersionContent,
  listSkillVersions,
  restoreSkillVersion,
} from '@/services/skillVersion'
import type { SkillRepository } from '../application/skills/ports'

/**
 * SQLite/filesystem explicit compatibility island for the Skill vertical slice.
 *
 * Active transports consume module-owned handles; the mature crash-safe
 * version and filesystem funnels remain behind this infrastructure port until
 * T9 can move them without changing their recovery protocol.
 */
export function createSqliteSkillRepository(
  db: DbClient,
  fsOptions: SkillFsOptions,
): SkillRepository {
  const repository: SkillRepository = {
    list: () => listSkills(db),
    get: (id) => getSkillById(db, id),
    create: (authority, input) =>
      createManagedSkill(db, fsOptions, input, {
        ownerUserId: authority.user.id,
        actor: authority,
      }),
    async save(authority, current, input) {
      const { expectedToken, ...patch } = input
      return saveSkillWithToken(
        db,
        fsOptions,
        current.id,
        patch,
        expectedToken,
        authority.user.id,
        current.ownerUserId ?? null,
      )
    },
    delete: (authority, current, input) =>
      deleteSkill(db, fsOptions, current.id, authority, {
        token: input.expectedToken,
        aclRevision: input.expectedAclRevision,
        ownerUserId: current.ownerUserId ?? null,
      }),
    readContent: (id) => readSkillContent(db, fsOptions, id),
    listFiles: (id) => listSkillFiles(db, fsOptions, id),
    readFile: (id, path) => readSkillFile(db, fsOptions, id, path),
    async writeFile(authority, current, path, input) {
      await writeSkillFile(
        db,
        fsOptions,
        current.id,
        path,
        input.content,
        authority.user.id,
        current.ownerUserId ?? null,
        input.expectedToken,
      )
      return Object.freeze({
        ok: true as const,
        path,
        token: await getSkillPreconditionTokenById(db, current.id),
      })
    },
    async deleteFile(authority, current, path, expectedToken) {
      await deleteSkillFile(
        db,
        fsOptions,
        current.id,
        path,
        authority.user.id,
        current.ownerUserId ?? null,
        expectedToken,
      )
      return Object.freeze({
        deleted: Object.freeze({ skillId: current.id, name: current.name, path }),
        token: await getSkillPreconditionTokenById(db, current.id),
      })
    },
    listVersions: (id) => listSkillVersions(db, fsOptions, id),
    diffVersions: (id, from, to) => diffSkillVersions(db, fsOptions, id, from, to),
    getVersionContent: (id, version) => getSkillVersionContent(db, fsOptions, id, version),
    async restoreVersion(authority, current, version, input) {
      const result = restoreSkillVersion(
        db,
        fsOptions,
        current.id,
        version,
        authority.user.id,
        input.reason,
        current.ownerUserId ?? null,
        input.expectedToken,
      )
      return Object.freeze({
        version: result.version,
        unfusedMemoryIds: Object.freeze([...result.unfusedMemoryIds]),
        token: await getSkillPreconditionTokenById(db, current.id),
      })
    },
  }
  return Object.freeze(repository)
}
