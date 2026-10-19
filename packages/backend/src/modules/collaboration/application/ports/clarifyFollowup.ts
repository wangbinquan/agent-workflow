import type { SaveClarifyDraftInput } from './collaborationRouteOperations'
import type {
  ClarifyDraftValue,
  ClarifyFollowup,
  ClarifyFollowupStart,
  ClarifyFollowupStatus,
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
  readonly instruction?: string
  readonly requestId: string
  readonly requestKey: string
  readonly target: ClarifyFollowupTarget
  readonly startedAt: number
  readonly abort: AbortController
  /** Set once the request passed its checks and the model is generating. */
  generating: boolean
  /** Settles when the request is accepted, replayed, or rejected by its checks. */
  readonly accepted: Promise<ClarifyFollowupStart>
  readonly result: Promise<{ questionIds: string[] }>
}
/** Process-local registry shared with the round seal: one generation per round. */
export interface ClarifyFollowupActivity {
  current(nodeRunId: string): ClarifyFollowupInFlight | undefined
  /** Registers a generation; another one for the round is a busy conflict. */
  begin(nodeRunId: string, inFlight: ClarifyFollowupInFlight): () => void
}
/** Tells the round's viewers that its follow-up state changed. */
export interface ClarifyFollowupEvents {
  changed(input: { taskId: string; nodeRunId: string; roundId: string }): void
}
export interface ClarifyFollowupOperations {
  /** Returns once the request is accepted; generation continues in the background. */
  start(
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<ClarifyFollowupStart>
  /** Starts and waits for the generated questions. */
  append(
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<{ questionIds: string[] }>
  /** The running generation, or the last failed one until it expires or another starts. */
  status(nodeRunId: string): ClarifyFollowupStatus | undefined
  cancel(nodeRunId: string, requestId: string): Promise<void>
}
