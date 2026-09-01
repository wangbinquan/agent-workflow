/** Closed identity projection used by task visibility participants. */
export interface TaskAuthorizationSubject {
  readonly userId: string
  readonly canReadAllTasks: boolean
}

export interface TaskAuthorizationLookupInput {
  readonly subject: TaskAuthorizationSubject
  readonly taskId: string
}

export interface VisibleTaskIdsInput {
  readonly subject: TaskAuthorizationSubject
  readonly taskIds: readonly string[]
}

export interface TaskActingMembershipInput {
  readonly userId: string
  readonly taskId: string
}

/** Provider-neutral, Promise-shaped task visibility read port. */
export interface TaskAuthorizationQueries {
  canViewTask(input: TaskAuthorizationLookupInput): Promise<boolean>
  visibleTaskIds(input: VisibleTaskIdsInput): Promise<ReadonlySet<string>>
  canActOnTask(input: TaskActingMembershipInput): Promise<boolean>
}

/**
 * SQLite transaction-bound twin. It is intentionally synchronous so a caller
 * can revalidate visibility inside the exact `DbTxSync` commit boundary.
 */
export interface TaskAuthorizationParticipantInTx {
  canViewTask(input: TaskAuthorizationLookupInput): boolean
  visibleTaskIds(input: VisibleTaskIdsInput): ReadonlySet<string>
  canActOnTask(input: TaskActingMembershipInput): boolean
}

/** PostgreSQL transaction-bound twin for one already-reserved connection. */
export interface AsyncTaskAuthorizationParticipantInTx {
  canViewTask(input: TaskAuthorizationLookupInput): Promise<boolean>
  visibleTaskIds(input: VisibleTaskIdsInput): Promise<ReadonlySet<string>>
  canActOnTask(input: TaskActingMembershipInput): Promise<boolean>
}
