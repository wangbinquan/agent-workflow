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
export interface ClarifyFollowupGenerator {
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
export interface ClarifyFollowupOperations {
  append(
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<{ questionIds: string[] }>
  cancel(nodeRunId: string, requestId: string): Promise<void>
}
