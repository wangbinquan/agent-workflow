import type { HostExecutionAdmission } from '@/modules/system-operations/public/participants'
import type { TaskHostNewWorkAdmission } from '../application/ports/taskHostAdmission'
import type { TaskHostWriteContext } from '../application/ports/taskHostWriteContext'
import { captureTaskHostWriteContext } from '../application/taskHostWriteCapture'

/** Independent Task adapter: SO admission never enters Task application contracts. */
export function composeTaskHostExecutionAdmission(input: {
  readonly admission: HostExecutionAdmission
  readonly writes: TaskHostWriteContext
}): TaskHostNewWorkAdmission {
  const admission = input.admission
  const acquire = admission?.acquire
  const writes = input.writes
  if (typeof acquire !== 'function' || writes === undefined) {
    throw new Error('task-host-admission-incomplete')
  }
  return Object.freeze({
    acquire() {
      const result = acquire.call(admission, 'task')
      if (result.kind === 'unavailable') return result
      const original = result.lease
      const complete = original.complete
      if (typeof complete !== 'function') throw new Error('task-host-admission-incomplete')
      try {
        const capture = captureTaskHostWriteContext(writes, {
          generation: original.generation,
          reference: original.reference,
        })
        return {
          kind: 'admitted' as const,
          lease: Object.freeze({
            capture,
            stopped: original.stopped,
            complete: () => complete.call(original),
          }),
        }
      } catch (error) {
        complete.call(original)
        throw error
      }
    },
  })
}
