import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Task-container volume containment shared by its domain-owned commands. */
export function requireWorkPath(path: string, root: string): string {
  const full = resolve(path)
  const child = relative(root, full)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
    throw new Error('workspace-helper-path-outside-work-volume')
  return full
}
