import { legacyContentRef, type ContentRef } from '../contentRef'

export const TASK_RETENTION_PREFIX = 'aw-hosted-task-retention:'
export function taskRetentionReference(owner: string, taskId: string, kind: string): string {
  return `${TASK_RETENTION_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(taskId)}/${kind}`
}
export function parseTaskRetention(reference: string): {
  owner: string
  taskId: string
  kind: string
} {
  const parts = reference.slice(TASK_RETENTION_PREFIX.length).split('/')
  if (parts.length !== 3 || !['runs', 'logs', 'scratch'].includes(parts[2]!))
    throw new Error('hosted-task-retention-reference-invalid')
  const owner = decodeURIComponent(parts[0]!)
  const taskId = decodeURIComponent(parts[1]!)
  if (
    !owner ||
    !taskId ||
    taskId.includes('/') ||
    taskId.includes('\\') ||
    taskId.includes('\0') ||
    taskId === '.' ||
    taskId === '..'
  )
    throw new Error('hosted-task-retention-reference-invalid')
  return { owner, taskId, kind: parts[2]! }
}
export function decodeTaskRetention(reference: string): ContentRef<string> {
  parseTaskRetention(reference)
  return legacyContentRef('aw-hosted-task-retention', 'object', reference)
}

export { encodeLegacyContent as encodeLegacyTaskRetention } from '../contentRef'
