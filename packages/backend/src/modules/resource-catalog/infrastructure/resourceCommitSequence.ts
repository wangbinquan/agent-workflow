/** Keep the same commit steps for synchronous participants and awaited transactions. */
export function continueResourceCommit<Value, Result>(
  value: Value | Promise<Value>,
  next: (value: Value) => Result | Promise<Result>,
): Result | Promise<Result> {
  return value instanceof Promise ? value.then(next) : next(value)
}

/** Each step settles before the next item is read from the original iterable. */
export function forEachResourceCommit<Value>(
  values: Iterable<Value>,
  step: (value: Value) => void | Promise<void>,
): void | Promise<void> {
  const iterator = values[Symbol.iterator]()
  function abort(error: unknown): never {
    try {
      iterator.return?.()
    } catch {
      // Like for-of, closing an iterator does not replace the original step error.
    }
    throw error
  }
  function advance(): void | Promise<void> {
    for (let item = iterator.next(); !item.done; item = iterator.next()) {
      let result: void | Promise<void>
      try {
        result = step(item.value)
      } catch (error) {
        return abort(error)
      }
      if (result instanceof Promise) return result.then(advance, abort)
    }
  }
  return advance()
}

/** Synchronous participants retain their void contract and cannot discard pending work. */
export function finishSynchronousResourceCommit(result: void | Promise<void>): void {
  if (result instanceof Promise) {
    throw new Error('synchronous resource commit received an asynchronous step')
  }
}
