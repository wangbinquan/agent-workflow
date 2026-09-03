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
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  diffSkillVersions,
  getSkillVersionContent,
  listSkillVersions,
  restoreSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { unfuseAboveVersionSync } from '@/modules/memory/infrastructure/sqliteMemoryMembershipParticipant'
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
    async listVersions(id) {
      return listSkillVersions(db, fsOptions, id)
    },
    async diffVersions(id, from, to) {
      return diffSkillVersions(db, fsOptions, id, from, to)
    },
    async getVersionContent(id, version) {
      return getSkillVersionContent(db, fsOptions, id, version)
    },
    async restoreVersion(authority, current, version, input) {
      const result = restoreSkillVersion(
        db,
        fsOptions,
        current.id,
        version,
        authority.user.id,
        // RFC-353 T3：memory 那一半经注入，与 PostgreSQL 侧同源（那边一直是注入的）。
        { unfuseAboveVersion: (tx, selector) => unfuseAboveVersionSync(tx, selector) },
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
