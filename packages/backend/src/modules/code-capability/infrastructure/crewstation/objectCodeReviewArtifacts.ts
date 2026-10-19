// RFC-370 §10 V16 — hosted code-review artifacts as neutral object
// publications (owner `code-review`, scope = task id). Keys are immutable, so a
// structural diff is keyed by its terminal generation and each narrative takes
// the next number of its task's chain; the latest narrative is the last
// number still published. The publications and object store are injected by
// the hosted bootstrap; only their structural shape is named here.
import {
  changeNarrativeSchema,
  structuralDiffSchema,
  type ChangeNarrative,
  type StructuralDiff,
} from '@agent-workflow/shared'
import type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '../../application/ports/codeReviewArtifacts'

export const HOSTED_CODE_REVIEW_OWNER = 'code-review'

export interface HostedCodeReviewObjectReceipt {
  readonly id: string
  readonly sha256: string
  readonly size: number
}

/** The subset of the hosted object publication journal this owner uses. */
export interface HostedCodeReviewPublications {
  publish(
    requests: readonly {
      readonly owner: string
      readonly key: string
      readonly scope?: string | null
      readonly bytes: Uint8Array
    }[],
  ): Promise<readonly HostedCodeReviewObjectReceipt[]>
  find(owner: string, key: string): Promise<HostedCodeReviewObjectReceipt | null>
  release(selection: { readonly owner: string; readonly scope?: string }): Promise<number>
  scopes(
    owner: string,
    page: { readonly before: number; readonly after?: string; readonly limit: number },
  ): Promise<readonly string[]>
}

export interface HostedCodeReviewObjects {
  read(objectId: string): Promise<Uint8Array>
}

function diffKey(key: StructuralDiffArtifactKey & { readonly generation: string }): string {
  const name =
    key.nodeRunId !== undefined && key.nodeRunId !== ''
      ? `${key.scope}-${key.nodeRunId}`
      : key.scope
  return `${key.taskId}/structural/${name}/${key.generation}`
}

const narrativeKey = (taskId: string, index: number): string => `${taskId}/narrative/${index}`

export function createHostedCodeReviewArtifactStore(input: {
  readonly publications: HostedCodeReviewPublications
  readonly objects: HostedCodeReviewObjects
}): CodeReviewArtifactStore {
  /** Last narrative number seen per task: the chain is probed from there. */
  const latestSeen = new Map<string, number>()
  const readJson = async (key: string): Promise<unknown> => {
    const receipt = await input.publications.find(HOSTED_CODE_REVIEW_OWNER, key)
    if (receipt === null) return null
    try {
      return JSON.parse(
        Buffer.from(await input.objects.read(receipt.id)).toString('utf8'),
      ) as unknown
    } catch {
      return null
    }
  }
  /** The highest published narrative number of the task (0 when none). */
  const latestNarrative = async (taskId: string): Promise<number> => {
    let index = latestSeen.get(taskId) ?? 0
    if (
      index > 0 &&
      (await input.publications.find(HOSTED_CODE_REVIEW_OWNER, narrativeKey(taskId, index))) ===
        null
    )
      index = 0
    while (
      (await input.publications.find(HOSTED_CODE_REVIEW_OWNER, narrativeKey(taskId, index + 1))) !==
      null
    )
      index += 1
    if (index > 0) latestSeen.set(taskId, index)
    else latestSeen.delete(taskId)
    return index
  }
  const publish = async (taskId: string, key: string, value: unknown): Promise<void> => {
    await input.publications.publish([
      {
        owner: HOSTED_CODE_REVIEW_OWNER,
        key,
        scope: taskId,
        bytes: Buffer.from(JSON.stringify(value), 'utf8'),
      },
    ])
  }
  return Object.freeze<CodeReviewArtifactStore>({
    async readStructuralDiff(key) {
      if (key.generation === null) return null
      const parsed = structuralDiffSchema.safeParse(
        await readJson(diffKey({ ...key, generation: key.generation })),
      )
      return parsed.success ? parsed.data : null
    },
    async writeStructuralDiff(key, diff: StructuralDiff) {
      if (key.generation === null) return
      try {
        await publish(key.taskId, diffKey({ ...key, generation: key.generation }), diff)
      } catch {
        // Best effort (a standby process or a concurrent identical generation).
      }
    },
    async readNarrative(taskId) {
      const index = await latestNarrative(taskId)
      if (index === 0) return null
      const parsed = changeNarrativeSchema.safeParse(await readJson(narrativeKey(taskId, index)))
      return parsed.success ? parsed.data : null
    },
    async writeNarrative(taskId, narrative: ChangeNarrative) {
      const index = (await latestNarrative(taskId)) + 1
      await publish(taskId, narrativeKey(taskId, index), narrative)
      latestSeen.set(taskId, index)
    },
    async removeTask(taskId) {
      latestSeen.delete(taskId)
      await input.publications.release({ owner: HOSTED_CODE_REVIEW_OWNER, scope: taskId })
    },
  })
}
