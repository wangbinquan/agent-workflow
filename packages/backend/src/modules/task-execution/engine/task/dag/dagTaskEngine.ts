import type { DagScopeDriverPort } from '../../../application/ports/taskEngine'
import type { TaskEngine, TaskEngineContext, TaskEngineOutcome } from '../../../domain/taskEngine'

export class DagTaskEngine implements TaskEngine {
  readonly kind = 'dag' as const

  constructor(private readonly scope: DagScopeDriverPort) {}

  async drive(context: TaskEngineContext): Promise<TaskEngineOutcome> {
    return await this.scope.driveTopLevel(context)
  }
}
