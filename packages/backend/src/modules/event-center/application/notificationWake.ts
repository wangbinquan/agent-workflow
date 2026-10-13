/** A notification wakes the selected loop; it never claims delivery work.
 * The latch also preserves wakes arriving during the owner's current cycle. */
export function createEventCenterNotificationWake() {
  let pending = false
  let waiting: (() => void) | undefined
  return {
    wake() {
      pending = true
      waiting?.()
    },
    wait(intervalMs: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.resolve()
      if (pending) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          if (waiting === finish) waiting = undefined
          pending = false
          resolve()
        }
        const timer = setTimeout(finish, intervalMs)
        timer.unref?.()
        waiting = finish
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted || pending) finish()
      })
    },
  }
}
