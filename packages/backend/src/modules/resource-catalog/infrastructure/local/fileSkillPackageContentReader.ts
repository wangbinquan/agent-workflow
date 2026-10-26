import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  currentFileSkillReference,
  readFileSkillReference,
  fileSkillReferencePath,
} from './fileSkillReferences'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillPackageContentReader } from '../../application/skills/packageContentReader'
import { ValidationError } from '@/util/errors'

/** Original snapshot preference, full-tree checks and byte reads. */
export function createFileSkillPackageContentReader(
  appHome: string,
  db?: PersistenceDb,
): SkillPackageContentReader {
  return {
    async readTree(reference) {
      const ref = await currentFileSkillReference(appHome, db, reference)
      if (ref?.kind === 'local-file') {
        const root = fileSkillReferencePath(appHome, ref)
        assertRegularDirectory(root, 'resource-package-skill-tree-invalid')
        const paths: string[] = []
        collectSkillFiles(root, '', paths)
        return paths
          .sort()
          .map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(root, path))) }))
      }
      const tree = await readFileSkillReference(appHome, db, ref)
      if (!tree)
        throw new ValidationError('resource-package-skill-tree-invalid', 'skill tree is missing')
      return tree.files
    },
  }
}

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
