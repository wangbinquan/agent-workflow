import type { DbClient } from '@/db/client'
import { trySetTaskStatus } from '@/services/lifecycle'
import type { TaskRuntimeLifecyclePersistence } from '../application/ports/taskRuntimeLifecyclePersistence'

export class SqliteTaskRuntimeLifecyclePersistence implements TaskRuntimeLifecyclePersistence {
  constructor(private readonly db: DbClient) {}

  async trySet(input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0]): Promise<boolean> {
    return await trySetTaskStatus({ db: this.db, ...input })
  }
}
