import { posix } from 'node:path'

/** Validate before uploading or extracting a complete immutable plugin tree.
 * Links may address dependencies in this tree, but no entry may be written
 * through a link or file used as an ancestor. */
export function validatePluginMaterialTree(
  files: readonly (
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'symlink'; readonly path: string; readonly target: string }
  )[],
  entry: string,
): void {
  const entries = new Map(files.map((file) => [file.path, file]))
  if (entries.size !== files.length) throw new Error('hosted-plugin-duplicate-file')
  const safe = (path: string) =>
    path.length > 0 &&
    !/[\\\0]/.test(path) &&
    !path.startsWith('/') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  for (const file of files) {
    if (!safe(file.path)) throw new Error('hosted-plugin-file-path-invalid')
    for (let parent = posix.dirname(file.path); parent !== '.'; parent = posix.dirname(parent))
      if (entries.has(parent)) throw new Error('hosted-plugin-file-ancestor-conflict')
    if (file.kind === 'symlink') {
      const target = posix.normalize(posix.join(posix.dirname(file.path), file.target))
      if (/[\\\0]/.test(file.target) || posix.isAbsolute(file.target) || !safe(target))
        throw new Error('hosted-plugin-link-outside-generation')
      // Resolve chains (including links to directories), preserving the actual
      // link records for the runtime instead of silently copying their bytes.
      const seen = new Set<string>([file.path])
      let cursor = target
      for (;;) {
        const pieces = cursor.split('/')
        let replaced = false
        for (let n = 1; n <= pieces.length; n++) {
          const prefix = pieces.slice(0, n).join('/')
          const link = entries.get(prefix)
          if (link?.kind !== 'symlink') continue
          if (seen.has(prefix)) throw new Error('hosted-plugin-link-cycle')
          seen.add(prefix)
          cursor = posix.normalize(
            posix.join(posix.dirname(prefix), link.target, ...pieces.slice(n)),
          )
          if (!safe(cursor)) throw new Error('hosted-plugin-link-outside-generation')
          replaced = true
          break
        }
        if (!replaced) break
      }
      if (
        !entries.has(cursor) &&
        !files.some((candidate) => candidate.path.startsWith(cursor + '/'))
      )
        throw new Error('hosted-plugin-link-target-missing')
    }
  }
  if (
    entry !== '.' &&
    (!safe(entry) ||
      (!entries.has(entry) && !files.some((file) => file.path.startsWith(entry + '/'))))
  )
    throw new Error('hosted-plugin-entry-missing')
}
