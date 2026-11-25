import { Paths } from '@/platform/configuration/installationPaths'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptOperations,
  NodeRunPromptRow,
  PromptStorage,
} from '../application/ports/nodeRunPromptContent'
import {
  readNodeRunPromptContent,
  requireNodeRunPromptContentEffects,
  storeNodeRunPromptContent,
} from '../application/nodeRunPrompt'
export {
  requireNodeRunPromptContentEffects,
  requireNodeRunPromptOperations,
} from '../application/nodeRunPrompt'
import { createFileNodeRunPromptContent } from '../infrastructure/local/fileNodeRunPromptContent'

export type { PromptStorage } from '../application/ports/nodeRunPromptContent'
/** RFC-526: the standalone selection's prompt content — local prompt files under a runs directory. */
export { createFileNodeRunPromptContent }

/** RFC-526: the caller's prompt content (standalone: `createFileNodeRunPromptContent(<appHome>/runs)`). */
export function composeNodeRunPromptOperations(
  content: NodeRunPromptContentEffects,
): NodeRunPromptOperations {
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
