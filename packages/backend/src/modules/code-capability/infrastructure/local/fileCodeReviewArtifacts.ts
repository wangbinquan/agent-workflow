// RFC-370 §10 V16 — standalone code-review artifacts: the RFC-083 / RFC-239
// files under `<appHome>/structural-diffs/<taskId>/` (`<scope>[-<nodeRunId>].json`
// and `narrative-task.json`). A structural diff file also records the terminal
// generation it was computed in; files written before that carry none.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  changeNarrativeSchema,
  structuralDiffSchema,
  type ChangeNarrative,
  type StructuralDiff,
} from '@agent-workflow/shared'
import { appHome } from '@/util/paths'
import type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '../../application/ports/codeReviewArtifacts'

/** The stored diff carries its generation next to the diff fields. */
const GENERATION_FIELD = 'artifactGeneration'

// Resolved per call: tests point AGENT_WORKFLOW_HOME at a fixture per suite.
const taskDirectory = (taskId: string): string => join(appHome(), 'structural-diffs', taskId)

function diffPath(key: Omit<StructuralDiffArtifactKey, 'generation'>): string {
  const name =
    key.nodeRunId !== undefined && key.nodeRunId !== ''
      ? `${key.scope}-${key.nodeRunId}`
      : key.scope
  // taskId is a ULID (no path separators); scope/nodeRunId are bounded — safe.
  return join(taskDirectory(key.taskId), `${name}.json`)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

export function createFileCodeReviewArtifactStore(): CodeReviewArtifactStore {
  return Object.freeze<CodeReviewArtifactStore>({
    async readStructuralDiff(key) {
      const raw = await readJson(diffPath(key))
      if (raw === null || typeof raw !== 'object') return null
      const generation = (raw as Record<string, unknown>)[GENERATION_FIELD]
      if (key.generation !== null && generation !== key.generation) return null
      const parsed = structuralDiffSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    },
    async writeStructuralDiff(key, diff: StructuralDiff) {
      try {
        const path = diffPath(key)
        await mkdir(dirname(path), { recursive: true })
        const stored =
          key.generation === null ? diff : { ...diff, [GENERATION_FIELD]: key.generation }
        await writeFile(path, JSON.stringify(stored), 'utf8')
      } catch {
        // storage is an optimization; a failure must not affect the live response.
      }
    },
    async readNarrative(taskId) {
      const parsed = changeNarrativeSchema.safeParse(
        await readJson(join(taskDirectory(taskId), 'narrative-task.json')),
      )
      return parsed.success ? parsed.data : null
    },
    async writeNarrative(taskId, narrative: ChangeNarrative) {
      await mkdir(taskDirectory(taskId), { recursive: true })
      await writeFile(
        join(taskDirectory(taskId), 'narrative-task.json'),
        JSON.stringify(narrative),
        'utf8',
      )
    },
    async removeTask(taskId) {
      await rm(taskDirectory(taskId), { recursive: true, force: true })
    },
  })
}
