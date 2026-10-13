/** Wait for the owning lifecycle's actual active ACK. Cancelling an unstarted
 * observer does not cancel business work or turn elapsed time into an ACK. */
export function waitForExecutionActivation(
  ready: Promise<boolean> | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (ready === undefined) return Promise.resolve(true)
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
    void ready.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
