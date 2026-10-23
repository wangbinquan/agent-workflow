// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'

export interface ClarifyRoundFixtureSpec {
  id: string
  taskId: string
  kind: 'self' | 'cross'
  askingNodeId: string
  askingNodeRunId: string
  askingShardKey?: string | null
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  targetConsumerNodeId?: string | null
  loopIter?: number
  containerRunId?: string | null
  iteration?: number
  questions: FixtureJson
  answers?: FixtureJson
  directive?: 'continue' | 'stop' | null
  status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'
  truncationWarnings?: FixtureJson
  designerRunTriggeredAt?: number | null
  abandonedAt?: number | null
  createdAt?: number
  answeredAt?: number | null
  answeredBy?: string | null
  submittedByRole?: string | null
  answerAttributions?: FixtureJson
  draftAnswers?: FixtureJson
}
