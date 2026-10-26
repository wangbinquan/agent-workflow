import { join } from 'node:path'
import { legacyContentRef, type ContentRef } from '../contentRef'

/** Directory inventories remain unchanged in II-a; this only owns their locations. */
export function decodeContentDirectory(reference: string): ContentRef<string> {
  return legacyContentRef(
    'content-directory',
    reference.startsWith('cs-archive:') ? 'object' : 'local-file',
    reference,
  )
}
export function taskContentDirectory(root: string, taskId: string): string {
  return join(root, taskId)
}
export function archiveEntry(
  resolve: (root: string, ...parts: string[]) => string,
  root: string,
  ...parts: string[]
): string {
  return resolve(decodeContentDirectory(root).location.value, ...parts)
}

export { encodeLegacyContent as encodeLegacyContentDirectory } from '../contentRef'
