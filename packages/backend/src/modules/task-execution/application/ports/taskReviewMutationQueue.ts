// RFC-476 — task-execution's offered review mutation queue: the process-local per-task FIFO that review
// writes and task cancellation share (review decisions mutate sibling review rows; cancellation seals
// every open review row). Collaboration enters it through `public/participants`.
//
// Closed interfaces only: work units are objects with methods rather than callbacks, because the public
// surface rule counts function-typed parameters as open types.

/** One unit of work run inside a task's review mutation critical section. */
export interface TaskReviewMutation<T> {
  run(): Promise<T>
}

/** Work whose task is known only once a lookup the caller has just issued resolves. */
export interface TaskReviewScopedMutation<T> extends TaskReviewMutation<T> {
  /** The lookup found no task: settle without entering any queue (e.g. reject with the caller's not-found). */
  missing(): Promise<T>
}

/** The per-task FIFO shared by review writes and task cancellation. */
export interface TaskReviewMutationQueue {
  /** Join `taskId`'s queue now and run the work when its turn comes. */
  serialize<T>(taskId: string, mutation: TaskReviewMutation<T>): Promise<T>
  /**
   * Join the queue of the task `lookup` resolves to. The lookup counts as issued at this call: a task-keyed
   * entry issued after it waits for it to join first (first issued, first queued).
   */
  serializeAfterLookup<T>(
    lookup: Promise<string | null>,
    mutation: TaskReviewScopedMutation<T>,
  ): Promise<T>
}
