import type { DynamicWorkflowGenerationPort } from '../../application/ports/taskEngine'
import type { TaskEngine, TaskEngineContext, TaskEngineOutcome } from '../../domain/taskEngine'

export class DynamicWorkflowTaskEngine implements TaskEngine {
  readonly kind = 'dw-generate' as const

  constructor(private readonly generation: DynamicWorkflowGenerationPort) {}

  async drive(context: TaskEngineContext): Promise<TaskEngineOutcome> {
    return await this.generation.generate(context)
  }
}
