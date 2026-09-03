import type { TaskScopeOutcome } from '../../domain/taskEngine'
import type { WrapperScopeDescriptor } from '../../domain/executionScope'
import type { WrapperWorkspaceScene } from './wrapperWorkspace'

export interface WrapperScopeDriverPort {
  drive(input: {
    readonly scope: WrapperScopeDescriptor
    /** RFC-354 — the wrapper generation row whose body is being driven: the body's frame. */
    readonly containerRunId: string
    readonly iteration: number
    readonly workspace: WrapperWorkspaceScene
  }): Promise<TaskScopeOutcome>
}
