// RFC-424: the one-argument convenience over the single resume rollback target selector
// (modules/task-execution/application/resumeRollbackTargets.ts), moved verbatim from services/task.ts, where its only
// caller was the retired test-only resume entry. It treats the given rows as their own run history.
import { selectResumeRollbackTargets as selectResumeRollbackTargetsWithSelection } from '@/modules/task-execution/application/resumeRollbackTargets'
import { createRunHistorySnapshot } from '@/modules/task-execution/public/queries'

export function selectResumeRollbackTargets<
  R extends {
    id: string
    seq: number
    nodeId: string
    parentNodeRunId: string | null
    status: string
    childTaskId?: string | null
  },
>(runs: readonly R[]): Promise<R[]> {
  return selectResumeRollbackTargetsWithSelection(
    runs,
    createRunHistorySnapshot(
      '',
      runs.map((row) => ({ ...row, taskId: '' })),
    ),
    '',
  )
}
