import { createLogger } from '@/util/log'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptRow,
  PromptStorage,
  SynchronousNodeRunPromptContentEffects,
} from './ports/nodeRunPromptContent'

const log = createLogger('node-run-prompt')
const PROMPT_SPILL_MIN_BYTES = 4_096

type EffectResult<T> = T | Promise<T>

function isAsyncEffect<T>(value: EffectResult<T>): value is Promise<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function finishEffect<T, U>(
  value: EffectResult<T>,
  complete: (value: T) => U,
  failed: (error: unknown) => U,
): EffectResult<U> {
  if (isAsyncEffect(value)) return Promise.resolve(value).then(complete, failed)
  return complete(value)
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unavailable error description'
  }
}

export function storeNodeRunPromptContent(
  content: SynchronousNodeRunPromptContentEffects,
  taskId: string,
  nodeRunId: string,
  prompt: string,
): PromptStorage
export function storeNodeRunPromptContent(
  content: NodeRunPromptContentEffects,
  taskId: string,
  nodeRunId: string,
  prompt: string,
): EffectResult<PromptStorage>
export function storeNodeRunPromptContent(
  content: NodeRunPromptContentEffects,
  taskId: string,
  nodeRunId: string,
  prompt: string,
): EffectResult<PromptStorage> {
  if (Buffer.byteLength(prompt, 'utf-8') < PROMPT_SPILL_MIN_BYTES) {
    return { promptText: prompt, promptPath: null }
  }
  const rel = content.reference(taskId, nodeRunId)
  const failed = (error: unknown): PromptStorage => {
    log.warn('prompt spill failed; keeping it in the row', {
      nodeRunId,
      error: messageOf(error),
    })
    return { promptText: prompt, promptPath: null }
  }
  try {
    return finishEffect(
      content.write(rel, prompt),
      () => ({ promptText: null, promptPath: rel }),
      failed,
    )
  } catch (error) {
    return failed(error)
  }
}

export function readNodeRunPromptContent(
  content: SynchronousNodeRunPromptContentEffects,
  row: NodeRunPromptRow | null | undefined,
): string | null
export function readNodeRunPromptContent(
  content: NodeRunPromptContentEffects,
  row: NodeRunPromptRow | null | undefined,
): EffectResult<string | null>
export function readNodeRunPromptContent(
  content: NodeRunPromptContentEffects,
  row: NodeRunPromptRow | null | undefined,
): EffectResult<string | null> {
  if (row === null || row === undefined) return null
  if (row.promptText !== null) return row.promptText
  if (row.promptPath === null) return null
  const reference = row.promptPath
  const failed = (error: unknown): null => {
    log.warn('prompt file unreadable', { path: reference, error: messageOf(error) })
    return null
  }
  try {
    return finishEffect(content.read(reference), (value) => value, failed)
  } catch (error) {
    return failed(error)
  }
}
