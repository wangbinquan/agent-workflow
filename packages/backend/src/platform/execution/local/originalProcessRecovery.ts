import {
  awaitProcessTreeQuiesced,
  isProcessTreeAlive,
  killProcessTree,
  releaseProcessTreeOwnership,
} from '@/util/process'

/** The original managed child supplies this capability. It is never rebuilt
 * from a PID alone and never substitutes an execution or terminal outcome. */
export function retainOriginalProcessRecovery(input: {
  readonly pid: number
  readonly originalChildExited: () => boolean
}): () => Promise<boolean> {
  const pid = input.pid
  const originalChildExited = input.originalChildExited.bind(input)
  let acknowledged = false
  let recovery: Promise<boolean> | undefined
  return () => {
    if (acknowledged) return Promise.resolve(true)
    if (recovery) return recovery
    const pending = Promise.resolve()
      .then(async () => {
        if (!Number.isInteger(pid) || pid <= 0) return false
        const alive = isProcessTreeAlive(pid)
        if (alive !== false) {
          // A vanished leader is not authority to signal a potentially reused
          // PID/group. A retained Windows job can still prove physical death.
          if (originalChildExited()) return false
          killProcessTree(pid, 'SIGKILL')
          if ((await awaitProcessTreeQuiesced(pid)) !== 'dead') return false
        }
        releaseProcessTreeOwnership(pid)
        acknowledged = true
        return true
      })
      .finally(() => {
        if (recovery === pending) recovery = undefined
      })
    recovery = pending
    return pending
  }
}
