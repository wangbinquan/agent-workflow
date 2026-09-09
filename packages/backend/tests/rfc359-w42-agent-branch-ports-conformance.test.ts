import { expect, test } from 'bun:test'
import { assertBranchPortsDeclared } from '@/modules/resource-catalog/infrastructure/agentBranchPorts'
import { ValidationError } from '@/util/errors'

// RFC-359 W42: both resource-catalog callers retain the same synchronous port checks.
function caughtFrom(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
}

test('W42 agents without branch ports do not read outputs', () => {
  for (const branchPorts of [undefined, []]) {
    const reads: string[] = []
    const input = {
      branchPorts,
      get outputs(): string[] {
        reads.push('outputs')
        throw new Error('outputs must remain unread')
      },
    }
    expect(assertBranchPortsDeclared(input)).toBeUndefined()
    expect(reads).toEqual([])
  }
})

test('W42 declared branch ports preserve empty names, Unicode and repeated input values', () => {
  const input = {
    outputs: ['default', '', '路径', 'repeat'],
    branchPorts: ['路径', 'repeat', 'repeat', ''],
  }
  expect(assertBranchPortsDeclared(input)).toBeUndefined()
  expect(input).toEqual({
    outputs: ['default', '', '路径', 'repeat'],
    branchPorts: ['路径', 'repeat', 'repeat', ''],
  })
})

test('W42 undeclared branch ports retain their ordered duplicate error details', () => {
  const input = {
    outputs: ['declared', '路径'],
    branchPorts: ['missing', 'declared', '', 'missing', '路径', 'other'],
  }
  const error = caughtFrom(() => assertBranchPortsDeclared(input))
  expect(error).toBeInstanceOf(ValidationError)
  if (!(error instanceof ValidationError)) throw error
  expect(error.constructor).toBe(ValidationError)
  expect(error.status).toBe(422)
  expect(error.toPayload()).toEqual({
    ok: false,
    code: 'branch-port-not-declared',
    message: 'agent branchPorts reference undeclared output port(s): missing, , missing, other',
    details: { notFound: ['missing', '', 'missing', 'other'] },
  })
  expect(input.branchPorts).toEqual(['missing', 'declared', '', 'missing', '路径', 'other'])
})

test('W42 input getter failures retain their identity and stop later reads', () => {
  for (const failingRead of ['branchPorts', 'outputs']) {
    const reads: string[] = []
    const failure = new Error(`input ${failingRead} failed`)
    const input = {
      get branchPorts(): string[] {
        reads.push('branchPorts')
        if (failingRead === 'branchPorts') throw failure
        return ['ready']
      },
      get outputs(): string[] {
        reads.push('outputs')
        throw failure
      },
    }
    expect(caughtFrom(() => assertBranchPortsDeclared(input))).toBe(failure)
    expect(reads).toEqual(
      failingRead === 'branchPorts' ? ['branchPorts'] : ['branchPorts', 'branchPorts', 'outputs'],
    )
  }
})

test('W42 branch declarations are read after outputs are obtained', () => {
  const reads: string[] = []
  let branchPorts = ['initial']
  const input = {
    get branchPorts(): string[] {
      reads.push('branchPorts')
      return branchPorts
    },
    get outputs(): string[] {
      reads.push('outputs')
      branchPorts = ['late']
      return ['initial']
    },
  }
  const error = caughtFrom(() => assertBranchPortsDeclared(input))
  expect(error).toBeInstanceOf(ValidationError)
  if (!(error instanceof ValidationError)) throw error
  expect(error.toPayload()).toEqual({
    ok: false,
    code: 'branch-port-not-declared',
    message: 'agent branchPorts reference undeclared output port(s): late',
    details: { notFound: ['late'] },
  })
  expect(reads).toEqual(['branchPorts', 'branchPorts', 'outputs', 'branchPorts'])
})
