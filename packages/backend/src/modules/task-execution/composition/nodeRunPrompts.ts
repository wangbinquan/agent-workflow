import { Paths } from '@/util/paths'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptOperations,
  NodeRunPromptRow,
  PromptStorage,
} from '../application/ports/nodeRunPromptContent'
import { readNodeRunPromptContent, storeNodeRunPromptContent } from '../application/nodeRunPrompt'
import { createFileNodeRunPromptContent } from '../infrastructure/local/fileNodeRunPromptContent'

export type { PromptStorage } from '../application/ports/nodeRunPromptContent'

export function requireNodeRunPromptContentEffects(
  value: unknown,
): asserts value is NodeRunPromptContentEffects {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as NodeRunPromptContentEffects).reference !== 'function' ||
    typeof (value as NodeRunPromptContentEffects).write !== 'function' ||
    typeof (value as NodeRunPromptContentEffects).read !== 'function'
  ) {
    throw new TypeError('Node-run prompts require a complete content effects receiver')
  }
}

export function requireNodeRunPromptOperations(
  value: unknown,
): asserts value is NodeRunPromptOperations {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as NodeRunPromptOperations).store !== 'function' ||
    typeof (value as NodeRunPromptOperations).read !== 'function'
  ) {
    throw new TypeError('Node-run prompts require complete operations')
  }
}

/** Undefined alone selects the complete native receiver for this runs namespace. */
export function composeNodeRunPromptOperations(
  selected?: NodeRunPromptContentEffects,
  runsDir: string = Paths.runsDir,
): NodeRunPromptOperations {
  const content = selected === undefined ? createFileNodeRunPromptContent(runsDir) : selected
  requireNodeRunPromptContentEffects(content)
  return Object.freeze({
    async store(taskId: string, nodeRunId: string, prompt: string) {
      return await storeNodeRunPromptContent(content, taskId, nodeRunId, prompt)
    },
    async read(row: NodeRunPromptRow | null | undefined) {
      return await readNodeRunPromptContent(content, row)
    },
  })
}

/** Compatibility construction; an explicit operations receiver is never partly replaced. */
export function selectNodeRunPromptOperations(
  selected?: NodeRunPromptOperations,
  runsDir: string = Paths.runsDir,
): NodeRunPromptOperations {
  const operations =
    selected === undefined ? composeNodeRunPromptOperations(undefined, runsDir) : selected
  requireNodeRunPromptOperations(operations)
  return operations
}

/** Only the existing native helpers use this synchronous composition. */
export function composeLocalNodeRunPromptOperations(runsDir: string = Paths.runsDir) {
  const content = createFileNodeRunPromptContent(runsDir)
  return Object.freeze({
    reference: (taskId: string, nodeRunId: string) => content.reference(taskId, nodeRunId),
    store: (taskId: string, nodeRunId: string, prompt: string) =>
      storeNodeRunPromptContent(content, taskId, nodeRunId, prompt),
    read: (row: NodeRunPromptRow | null | undefined) => readNodeRunPromptContent(content, row),
  })
}

export function nodeRunPromptRelPath(taskId: string, nodeRunId: string): string {
  return composeLocalNodeRunPromptOperations().reference(taskId, nodeRunId)
}

export function storeNodeRunPrompt(
  taskId: string,
  nodeRunId: string,
  prompt: string,
  runsDir: string = Paths.runsDir,
): PromptStorage {
  return composeLocalNodeRunPromptOperations(runsDir).store(taskId, nodeRunId, prompt)
}

export function readNodeRunPrompt(
  row: { promptText: string | null; promptPath: string | null } | null | undefined,
  runsDir: string = Paths.runsDir,
): string | null {
  return composeLocalNodeRunPromptOperations(runsDir).read(row)
}
