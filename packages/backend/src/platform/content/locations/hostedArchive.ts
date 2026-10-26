import { legacyContentRef, type ContentRef } from '../contentRef'

export function normalizeHostedArchive(reference: string): string {
  const parts = reference.split('/')
  if (
    !['cs-archive:tasks', 'cs-archive:runs', 'cs-archive:logs'].includes(parts[0]!) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[\\\0\r\n]/.test(part))
  )
    throw new Error('hosted-archive-reference-invalid')
  return reference
}
export function isHostedArchiveTemporary(reference: string): boolean {
  return /^cs-archive:tasks\/\.tmp-[^/]+$/.test(reference)
}
export function hostedArchiveSource(
  reference: string,
): { kind: 'runs' | 'logs'; taskId: string } | null {
  const match = /^cs-archive:(runs|logs)\/([^/]+)$/.exec(reference)
  return match ? { kind: match[1] as 'runs' | 'logs', taskId: match[2]! } : null
}

export function decodeHostedArchive(reference: string): ContentRef<string> {
  return legacyContentRef('cs-archive', 'object', normalizeHostedArchive(reference))
}
export function hostedArchiveRoot(kind: 'tasks' | 'runs' | 'logs'): string {
  return `cs-archive:${kind}`
}

export { encodeLegacyContent as encodeLegacyHostedArchive } from '../contentRef'
