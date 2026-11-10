// RFC-478 —— `services/task.ts` 退役后，它的内容整块落在下面这几个新文件里（design §1；并入既有文件的
// `buildSyncRunSummary` / `parseSnapshotDefinition` 与 `selectSyncRollbackTargets` 不在此列）。源码文本守卫原先把
// `services/task.ts` 当一整块语料读（「不得包含 X」「漏斗在场」），现在读它们的并集，判据不变。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TASK_SERVICE_SUCCESSORS = [
  'modules/task-execution/infrastructure/deferredRepositoryPreparation.ts',
  'modules/task-execution/infrastructure/taskDetailRead.ts',
  'modules/task-execution/application/workflowSyncPreviewQuery.ts',
  'modules/task-execution/domain/builtinWorkflowLayout.ts',
  'modules/task-execution/composition/taskDriveRuntimeOptions.ts',
] as const

/** The successors' sources joined (`src/`-relative paths above). */
export function readTaskServiceSuccessors(): string {
  const src = join(import.meta.dir, '..', '..', 'src')
  return TASK_SERVICE_SUCCESSORS.map((rel) => readFileSync(join(src, rel), 'utf8')).join('\n')
}
