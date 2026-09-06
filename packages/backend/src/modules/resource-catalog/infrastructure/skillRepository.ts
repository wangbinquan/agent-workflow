import type { ProviderNeutralDatabase } from '@/db/query'
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
  type SkillRestoreMembershipPort,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import type { SkillRepository } from '../application/skills/ports'

/**
 * Filesystem-backed explicit compatibility island for the Skill vertical slice.
 *
 * RFC-359 W4-D23c：一份仓库，两个数据库共用——底下那套成熟的崩溃安全版本 / 文件系统漏斗
 * 已在 D23b 迁到中立事务原语，PostgreSQL 的 3342 行原生重写随之退役。它仍留在这个基础设施端口
 * 后面（而不是搬进 application），是因为搬动会改到它的恢复协议；那是 T9 的事。
 *
 * Active transports consume module-owned handles.
 */
export function createSkillRepository(
  db: ProviderNeutralDatabase,
  fsOptions: SkillFsOptions,
  // RFC-353 T7：回滚时「哪些记忆退回待用」由 knowledge-evolution 的协调器裁定，
  // bootstrap 注入。此前这里直接 import memory 的 infrastructure——跨 context 内部 import。
  restoreMembership: SkillRestoreMembershipPort,
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
      return await listSkillVersions(db, fsOptions, id)
    },
    async diffVersions(id, from, to) {
      return await diffSkillVersions(db, fsOptions, id, from, to)
    },
    async getVersionContent(id, version) {
      return await getSkillVersionContent(db, fsOptions, id, version)
    },
    async restoreVersion(authority, current, version, input) {
      const result = await restoreSkillVersion(
        db,
        fsOptions,
        current.id,
        version,
        authority.user.id,
        restoreMembership,
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
