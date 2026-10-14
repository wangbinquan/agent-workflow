import type { SaveClarifyDraftInput } from './collaborationRouteOperations'
import type {
  ClarifyDraftValue,
  ClarifyFollowup,
  ClarifyFollowupTarget,
  ClarifyQuestion,
} from '@agent-workflow/shared'

export interface ClarifyFollowupSnapshot {
  canAppend: boolean
  roundId: string
  taskId: string
  askingNodeRunId: string
  questions: ClarifyQuestion[]
  drafts: Record<string, ClarifyDraftValue>
  instruction: string
  categoryPaths?: string[][]
}
/** Background from the original task, bounded by its provider: launcher input
 * values and the asking agent's authored instruction (template unexpanded). */
export interface ClarifyFollowupTaskContext {
  readonly inputs: readonly {
    readonly key: string
    readonly label: string
    readonly value: string
  }[]
  readonly instruction: string | null
  readonly truncated: boolean
}
export interface ClarifyFollowupGenerator {
  /** Optional: a generator without task facts still generates from the branch. */
  context?(input: {
    askingNodeRunId: string
    taskId: string
  }): Promise<ClarifyFollowupTaskContext | null>
  generate(input: {
    askingNodeRunId: string
    taskId: string
    requestId: string
    prompt: string
    signal: AbortSignal
  }): Promise<string>
}
export interface ClarifyFollowupStore {
  read(nodeRunId: string, target: ClarifyFollowupTarget): Promise<ClarifyFollowupSnapshot>
  append(
    nodeRunId: string,
    request: ClarifyFollowup,
    questions: ClarifyQuestion[],
    signal: AbortSignal,
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<void>
}
/** One generation of this process. It stays registered until it settles; an
 * aborted generation no longer holds the round seal but still occupies the round. */
export interface ClarifyFollowupInFlight {
  readonly requestId: string
  readonly requestKey: string
  readonly abort: AbortController
  readonly result: Promise<{ questionIds: string[] }>
}
/** Process-local registry shared with the round seal: one generation per round. */
export interface ClarifyFollowupActivity {
  current(nodeRunId: string): ClarifyFollowupInFlight | undefined
  /** Registers a generation; another one for the round is a busy conflict. */
  begin(nodeRunId: string, inFlight: ClarifyFollowupInFlight): () => void
}
export interface ClarifyFollowupOperations {
  append(
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<{ questionIds: string[] }>
  cancel(nodeRunId: string, requestId: string): Promise<void>
}
