import type { ValidateIO, ValidateResult } from './types'

/** The original two validation effects, with selected asynchronous receivers. */
export interface OutputValidationEffects {
  resolveWorktreePath(
    ...args: Parameters<ValidateIO['resolveWorktreePath']>
  ):
    | ReturnType<ValidateIO['resolveWorktreePath']>
    | Promise<ReturnType<ValidateIO['resolveWorktreePath']>>
  readFileUtf8(...args: Parameters<ValidateIO['readFileUtf8']>): string | Promise<string>
}

export type OutputValidationPolicy<T = ValidateResult> = Generator<() => unknown, T, unknown>

export function* outputValidationEffect<T>(call: () => T | Promise<T>): OutputValidationPolicy<T> {
  return (yield call) as T
}

/** Interpret the same policy for the original synchronous ValidateIO API. */
export function runNativeOutputValidationPolicy<T>(policy: OutputValidationPolicy<T>): T {
  let step = policy.next()
  while (!step.done) {
    let value: unknown
    try {
      value = step.value()
    } catch (error) {
      step = policy.throw(error)
      continue
    }
    step = policy.next(value)
  }
  return step.value
}

/** Await assimilates thenables; errors return to their original policy position. */
export async function runOutputValidationPolicy<T>(policy: OutputValidationPolicy<T>): Promise<T> {
  let step = policy.next()
  while (!step.done) {
    let value: unknown
    try {
      value = await step.value()
    } catch (error) {
      step = policy.throw(error)
      continue
    }
    step = policy.next(value)
  }
  return step.value
}
