// One sequence can retain synchronous transaction callbacks and asynchronous drivers.
// These interpreters preserve the original Intent next/execute/error ordering.

export type TransactionProgramStep = () => void | Promise<void>

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

/** Keep the typed result in the operation's closure instead of casting a resume value. */
export function* transactionStep<T>(
  execute: () => T | PromiseLike<T>,
): Generator<TransactionProgramStep, T, void> {
  let result: { readonly value: T } | undefined
  yield () => {
    const value = execute()
    if (isThenable(value)) {
      return Promise.resolve(value).then((resolved) => {
        result = { value: resolved }
      })
    }
    result = { value }
  }
  if (result === undefined) throw new Error('transaction program resumed before its step completed')
  return result.value
}

export function executeTransactionStepSync(step: TransactionProgramStep): void {
  const result = step()
  if (result !== undefined) {
    // The step is rejected synchronously; its asynchronous failure must still be observed.
    void result.catch(() => {})
    throw new Error('synchronous transaction program received an asynchronous step')
  }
}

export function driveSyncProgram<Step, Result, Resume>(
  program: Generator<Step, Result, Resume>,
  execute: (step: Step) => Resume,
): Result {
  let state = program.next()
  while (!state.done) state = program.next(execute(state.value))
  return state.value
}

export async function driveAsyncProgram<Step, Result, Resume>(
  program: Generator<Step, Result, Resume>,
  execute: (step: Step) => Resume | PromiseLike<Resume>,
): Promise<Result> {
  let state = program.next()
  while (!state.done) state = program.next(await execute(state.value))
  return state.value
}
