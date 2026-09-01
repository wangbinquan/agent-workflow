import type { DbClient } from '@/db/client'
import type { TaskExecutionIntentPersistence } from '../application/ports/taskExecutionIntentPersistence'
import { SqliteTaskExecutionIntentStore } from './sqliteTaskExecutionIntent'
import { submitTaskContinuation } from './sqliteTaskExecutionIntentAdmission'

export class SqliteTaskExecutionIntentPersistence implements TaskExecutionIntentPersistence {
  private readonly store = new SqliteTaskExecutionIntentStore()

  constructor(private readonly db: DbClient) {}

  async hasPendingGateSuccessor(taskId: string): Promise<boolean> {
    return this.store.hasPendingGateSuccessor({ db: this.db, taskId })
  }

  async submit(input: Parameters<TaskExecutionIntentPersistence['submit']>[0]) {
    return this.store.submit({ db: this.db, ...input })
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ) {
    return submitTaskContinuation(this.db, input)
  }
}
