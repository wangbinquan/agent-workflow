import { acquireLock, DaemonLockHeldError } from '@/util/lock'
import { join } from 'node:path'
/** Both publication and sweeping use the same process-owned filesystem lease. */
export function contentExclusive(appHome: string) {
  return async <T>(body: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      let lease
      try {
        lease = acquireLock(join(appHome, '.content-maintenance.lock'))
      } catch (error) {
        if (!(error instanceof DaemonLockHeldError) || Date.now() >= deadline) throw error
        await Bun.sleep(100)
        continue
      }
      try {
        return await body()
      } finally {
        lease.release()
      }
    }
  }
}
