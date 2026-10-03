import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SynchronousNodeRunPromptContentEffects } from '../../application/ports/nodeRunPromptContent'

/** The entire native prompt receiver captures one runs namespace. */
export function createFileNodeRunPromptContent(
  runsDir: string,
): SynchronousNodeRunPromptContentEffects {
  return Object.freeze({
    reference(taskId: string, nodeRunId: string) {
      // Keep durable prompts outside the runner's temporary node-run directory.
      return join(taskId, 'prompts', `${nodeRunId}.md`)
    },
    write(reference: string, prompt: string) {
      const abs = join(runsDir, reference)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, prompt, 'utf-8')
    },
    read(reference: string) {
      const abs = join(runsDir, reference)
      if (!existsSync(abs)) return null
      return readFileSync(abs, 'utf-8')
    },
  })
}
