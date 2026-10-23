import { legacyContentRef, type ContentRef } from './contentRef'

export function normalizeLegacyHostedArchive(reference: string): string {
  const parts = reference.split('/')
  if (
    !['cs-archive:tasks', 'cs-archive:runs', 'cs-archive:logs'].includes(parts[0]!) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[\\\0\r\n]/.test(part))
  )
    throw new Error('hosted-archive-reference-invalid')
  return reference
}
export function isLegacyHostedArchiveTemporary(reference: string): boolean {
  return /^cs-archive:tasks\/\.tmp-[^/]+$/.test(reference)
}
export function legacyHostedArchiveSource(
  reference: string,
): { kind: 'runs' | 'logs'; taskId: string } | null {
  const match = /^cs-archive:(runs|logs)\/([^/]+)$/.exec(reference)
  return match ? { kind: match[1] as 'runs' | 'logs', taskId: match[2]! } : null
}

export function decodeLegacyHostedArchive(reference: string): ContentRef<string> {
  return legacyContentRef('cs-archive', 'object', normalizeLegacyHostedArchive(reference))
}
export function legacyHostedArchiveRoot(kind: 'tasks' | 'runs' | 'logs'): string {
  return `cs-archive:${kind}`
}

export { encodeLegacyContent as encodeLegacyHostedArchive } from './contentRef'
