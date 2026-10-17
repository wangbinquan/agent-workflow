import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstatSync } from 'node:fs'

/** Task-container volume containment shared by its domain-owned commands. */
export function requireWorkPath(path: string, root: string): string {
  const full = resolve(path)
  const child = relative(root, full)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
    throw new Error('workspace-helper-path-outside-work-volume')
  return full
}

/** Content operations reject symlink parents as well as lexical traversal. */
export function requireWorkPathWithoutSymlinks(path: string, root: string): string {
  const full = requireWorkPath(path, root)
  let parent = root
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('hosted-evidence-symlink-path')
  }
  return full
}
