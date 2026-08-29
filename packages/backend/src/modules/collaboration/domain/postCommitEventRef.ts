// RFC-341 — collaboration-owned post-commit publication receipt.
//
// This is deliberately a context-local value shape. Collaboration may hand a
// committed receipt to bootstrap without exposing the platform event store's
// public type through its own contract.

export type CollaborationPostCommitEventRef = Readonly<{
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
