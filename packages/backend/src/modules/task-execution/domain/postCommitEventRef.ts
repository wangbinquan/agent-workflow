// RFC-341 — task-execution-owned post-commit publication receipt.
//
// The structural value crosses the bootstrap boundary, while the platform
// committed-event type remains private to infrastructure and composition.

export type TaskExecutionPostCommitEventRef = Readonly<{
  eventId: string
  payloadDigest: string
  producer: 'task-execution' | 'collaboration'
  family: 'task-lifecycle' | 'review' | 'clarify' | 'questions'
  aggregate: Readonly<{
    kind: 'task' | 'review-round' | 'clarify-round' | 'question-gate'
    id: string
    seq: number
  }>
  eventGroupId: string
  eventGroupOrdinal: number
  deliveryMode: 'shadow' | 'dispatchable'
  producerEpoch: number
}>
