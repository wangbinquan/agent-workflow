import type { WorkflowNode, ScriptLanguage } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { TaskScriptInterpreter } from '../../../application/ports/taskScriptRunFamily'

export interface ScriptAttemptArgs {
  signal?: AbortSignal
  node: WorkflowNode
  nodeRunId: string
  iteration: number
  retryIndex: number
  inputs: Record<string, string>
  interpreter: TaskScriptInterpreter
  isoHandle: IsoHandle | null
  isReadonly: boolean
  language: ScriptLanguage
}

export type ScriptAttemptOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; summary: string; message: string }
  | { kind: 'canceled'; message: string }
