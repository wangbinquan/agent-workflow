import type { WorkgroupTurnsDriverPort } from '../../application/ports/taskEngine'
import type { TaskEngine, TaskEngineContext, TaskEngineOutcome } from '../../domain/taskEngine'

export class WorkgroupTaskEngine implements TaskEngine {
  readonly kind = 'workgroup-turns' as const

  constructor(private readonly turns: WorkgroupTurnsDriverPort) {}

  async drive(context: TaskEngineContext): Promise<TaskEngineOutcome> {
    return await this.turns.driveTurns(context)
  }
}
