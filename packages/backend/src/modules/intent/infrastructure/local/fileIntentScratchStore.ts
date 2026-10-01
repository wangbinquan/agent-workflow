import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IntentScratchStore } from '../../application/ports/intentScratchStore'

export function createFileIntentScratchStore(input: {
  readonly appHome: string
  readonly directoryName: string
}): IntentScratchStore {
  const root = join(input.appHome, input.directoryName)
  return Object.freeze({
    staleTurnIds(cutoff: number) {
      if (!existsSync(root)) return []
      const turnIds: string[] = []
      for (const turnId of readdirSync(root)) {
        try {
          if (statSync(join(root, turnId)).mtimeMs <= cutoff) turnIds.push(turnId)
        } catch {
          // A concurrent cleanup already settled this entry.
        }
      }
      return turnIds.sort()
    },
    remove(turnId: string) {
      rmSync(join(root, turnId), { recursive: true, force: true })
    },
  })
}
