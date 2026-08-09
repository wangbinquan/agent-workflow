// RFC-271 T23b —— 导出侧的技能文件树读取。
//
// 技能的**内容不在 DB 里**：`skills` 表只有 `managed_path`，SKILL.md 与全部辅助
// 文件都在 `${appHome}/skills/{id}/files/` 下。序列化段如果只读行，产出的 payload
// 恒为 `{frontmatterExtra:{}, bodyMd:'', files:[]}` —— 包能导出、能导入、跑起来是
// 一个**空技能**。那是最糟的失败形态：全程无报错。
//
// 为什么不直接复用 `readSkillFile`：它返回 utf-8 `string`，二进制辅助文件（图片 /
// 字体 / 预编译产物）会被解码破坏。这里要的是字节。
//
// 但**必须保留**它那条安全语义：`realpathInside` 挡 symlink 逃逸。技能目录里一个
// `secret -> ~/.ssh/id_rsa` 在在线读取里只是泄漏给该技能的读者，在导出里会被打进
// zip 搬到另一台机器——导出这条路径上，逃逸的后果只会更重，不会更轻。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { getSkillById, listSkillFiles, skillReadRoot } from '@/services/skill'
import { realpathInside } from '@/util/safePath'
import { ValidationError } from '@/util/errors'

/** SKILL.md 是**结构化**进 payload 的，不作为辅助文件重复打包一份。 */
const SKILL_MAIN = 'SKILL.md'

export interface SkillTree {
  /** SKILL.md 的 frontmatter（去掉 name/description —— 它们是行上的字段）。 */
  frontmatterExtra: Record<string, unknown>
  bodyMd: string
  /** 除 SKILL.md 外的全部文件，**字节原样**（含二进制）。 */
  files: Array<{ path: string; bytes: Uint8Array }>
}

/**
 * 读一个 managed 技能的完整文件树。
 *
 * 「整棵树进包，不设任何上限」是产品决策：一个技能带多大的辅助文件是作者的事，
 * 平台不替他截断——截断产出的是一个**看起来成功**的残包。
 */
export async function readSkillTree(
  db: DbClient,
  appHome: string,
  skillId: string,
): Promise<SkillTree> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) {
    throw new ValidationError('package-invalid', `skill '${skillId}' vanished mid-export`)
  }
  const root = skillReadRoot(skill, { appHome })

  let frontmatterExtra: Record<string, unknown> = {}
  let bodyMd = ''
  const mainPath = join(root, SKILL_MAIN)
  if (existsSync(mainPath)) {
    const raw = readFileSync(realpathInside(root, mainPath), 'utf-8')
    // `parseSkillMarkdown` 已经把 `name` / `description` 从 frontmatter 里剥掉了
    // ——它们是 DB 行上的字段，payload 里已经有；重复带一份会在导入后与用户改过的
    // 名字打架。
    const parsed = parseSkillMarkdown(raw)
    frontmatterExtra = parsed.frontmatterExtra
    bodyMd = parsed.bodyMd
  }

  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (const node of await listSkillFiles(db, { appHome }, skillId)) {
    if (node.type !== 'file' || node.path === SKILL_MAIN) continue
    const abs = realpathInside(root, join(root, node.path))
    // `listSkillFiles` 跳过 symlink，但树是在这两步之间可变的——真读之前再确认
    // 一次它仍是普通文件。
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    files.push({ path: node.path, bytes: new Uint8Array(readFileSync(abs)) })
  }
  // 字典序固定：包要逐字节可复现，条目顺序不能随文件系统的返回顺序漂移。
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { frontmatterExtra, bodyMd, files }
}

/** 包内的载体路径。`ref` 与 zip 条目路径**是同一个字符串**（provider 据它取字节）。 */
export function packagedSkillFileRef(slug: string, relPath: string): string {
  return `skills/${slug}/files/${relPath}`
}
