import type { TaskScopeOutcome } from '../../domain/taskEngine'
import type { WrapperScopeDescriptor } from '../../domain/executionScope'
import type { WrapperWorkspaceScene } from './wrapperWorkspace'

export interface WrapperScopeDriverPort {
  drive(input: {
    readonly scope: WrapperScopeDescriptor
    readonly iteration: number
    readonly workspace: WrapperWorkspaceScene
  }): Promise<TaskScopeOutcome>
}
