// RFC-359 W8 —— 资源包导出时读一个托管技能的文件树：**一份实现，两个 provider 共用**。
//
// 此前这是一对分叉：`sqlitePackageSkillTree.ts` 的 `readSqlitePackageSkillTree` 与
// `postgresqlResourcePackageArtifacts.ts` 里的 `readPostgresqlPackageSkillTree`——同一个端口
// （`application/package/ports.ts` 的 `ResourcePackageSkillTree`）、同一张 `skills` 表、同一棵
// appHome 下的技能目录，却是两台机器。判为**真重复**：两侧的 DB 读法（`getSkillById`）本来就已经
// 吃 `ProviderNeutralDatabase`，剩下全是文件系统语义，没有任何一处需要按引擎分叉。
//
// 合一按**强侧抬齐**，五条差异逐条有实测来源
// （`tests/rfc359-w8-package-skill-tree-conformance.test.ts` 在两个旧实现上先跑出来的红）：
//
//   ① **读权威快照、不读活动目录**（取 SQLite 侧）。`skillReadRoot` 在
//      `versions/v{contentVersion}/files` 存在时读快照，这是 RFC-170 G1-1 定下的语义。
//      PostgreSQL 那份直读 `managed_path`（恒等于活动目录 `skills/{id}/files`），于是一个刚提交过
//      新版本、活动目录里还留着半截内容的技能，两个引擎导出的包**字节不同**。
//   ② **技能目录不是一个真目录就抛错**（取 PostgreSQL 侧）。SQLite 那份返回空文件表，导出照常
//      产出一个**零文件**的技能条目——用户拿到的是一个静悄悄残缺的包，回导后技能没有内容。
//      宁可 422 失败也不产出残包。
//   ③ **路径由技能 id 算出，不看 `managed_path`**（取 SQLite 侧）。`managed_path` 的唯一写出点
//      （`legacy/skill.ts:228,355`）永远写 `skills/{id}/files`，这一列是可推导的冗余；
//      PostgreSQL 那份把 NULL 当「技能中途消失」抛 `package-invalid`，对同一行两个引擎一边 422
//      一边成功。
//   ④ **条目顺序按全路径排序**（取 SQLite 侧）。PostgreSQL 那份是逐目录排序的深度优先，于是
//      `b.txt` 与 `b/c.txt` 的先后在两个引擎上相反——而这个顺序直接就是导出 ZIP 的条目次序
//      （`services/resourcePackage/export.ts:213-218`）。全路径排序与引擎、与目录递归次序都无关，
//      是这里唯一稳定的口径。
//   ⑤ **技能目录里出现符号链接 / 非常规条目就抛错**（取 PostgreSQL 侧）。SQLite 那份的 `walkDir`
//      静默跳过符号链接（"Symlinks intentionally skipped in v1"），导出的包因此**少文件且无提示**。
//      与②同一条理由：导出要么忠实，要么失败。**这是 SQLite 部署上的行为变更**——技能目录里
//      带符号链接的导出此前成功（少文件）、此后 422。
//
// 另有一条随①一起被带上来的：`getSkillById` 还带 `isSkillAvailableThisBoot` 这道启动复核门
// （`legacy/skillBootVerify.ts:89-96`），PostgreSQL 那份此前没有。启动复核激活后，未通过复核的
// 技能在两个引擎上都以 `package-invalid` 收场，与平台的快照权威模型一致。

import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseSkillMarkdown } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { ValidationError } from '@/util/errors'

import type { ResourcePackageSkillTree } from '../application/package/ports'
import { getSkillById, skillReadRoot } from './legacy/skill'

/** 技能主文档：不进 `files`，其 frontmatter / 正文单独投影。 */
export const SKILL_MAIN = 'SKILL.md'

/** 目标必须是一个**真目录**（不是符号链接、不是缺失、不是常规文件）。 */
export function assertRegularDirectory(path: string, code: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    throw new ValidationError(code, `resource package filesystem path is missing: ${path}`)
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) return
  throw new ValidationError(
    code,
    `resource package filesystem path is not a real directory: ${path}`,
  )
}

/**
 * 递归收集 `root` 下的全部常规文件（相对路径，`/` 分隔）。符号链接与非常规条目直接抛
 * `resource-package-skill-tree-invalid`——包要么忠实反映这棵树，要么导出失败。
 */
export function collectSkillFiles(root: string, relativeRoot: string, output: string[]): void {
  const absolute = relativeRoot === '' ? root : join(root, relativeRoot)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = relativeRoot === '' ? entry.name : `${relativeRoot}/${entry.name}`
    const childAbsolute = join(root, childRelative)
    const stat = lstatSync(childAbsolute)
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'resource-package-skill-tree-invalid',
        `skill tree contains a symbolic link: ${childAbsolute}`,
      )
    }
    if (stat.isDirectory()) {
      collectSkillFiles(root, childRelative, output)
      continue
    }
    if (!stat.isFile()) {
      throw new ValidationError(
        'resource-package-skill-tree-invalid',
        `skill tree contains a non-regular entry: ${childAbsolute}`,
      )
    }
    output.push(childRelative)
  }
}

/** 读一个托管技能的可打包文件树。两个 provider 共用；差异与取舍见文件头。 */
export async function readPackageSkillTree(
  db: ProviderNeutralDatabase,
  appHome: string,
  skillId: string,
): Promise<ResourcePackageSkillTree> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) {
    throw new ValidationError('package-invalid', `skill '${skillId}' vanished mid-export`)
  }
  const root = skillReadRoot(skill, { appHome })
  assertRegularDirectory(root, 'resource-package-skill-tree-invalid')

  const relativeFiles: string[] = []
  collectSkillFiles(root, '', relativeFiles)
  // 全路径一次排序：与目录递归次序、与 readdir 的返回次序都无关，两个引擎上逐字相同。
  relativeFiles.sort((left, right) => left.localeCompare(right))

  let frontmatterExtra: Record<string, unknown> = {}
  let bodyMd = ''
  if (relativeFiles.includes(SKILL_MAIN)) {
    const parsed = parseSkillMarkdown(readFileSync(join(root, SKILL_MAIN), 'utf8'))
    frontmatterExtra = parsed.frontmatterExtra
    bodyMd = parsed.bodyMd
  }
  const files = relativeFiles
    .filter((path) => path !== SKILL_MAIN)
    .map((path) => Object.freeze({ path, bytes: new Uint8Array(readFileSync(join(root, path))) }))
  return Object.freeze({ frontmatterExtra, bodyMd, files })
}
