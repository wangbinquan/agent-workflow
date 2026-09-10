import { expect, test } from 'bun:test'
import {
  agentSnapshot,
  workflowSnapshot,
  workgroupSnapshot,
} from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/resourceSnapshotProjection'

// RFC-359 W55 keeps the two original readers' complete field order and shallow-freeze contract.
// These opaque getter values exercise the projections directly, without either reader's fixture.
type Projection = typeof workflowSnapshot | typeof agentSnapshot | typeof workgroupSnapshot

function invokeProjection(project: Projection, input: object): object {
  const result: unknown = Reflect.apply(project, undefined, [input])
  if (typeof result !== 'object' || result === null) throw new Error('Expected a snapshot object')
  return result
}

function assertProjection(project: Projection, keys: readonly string[]): void {
  const reads: string[] = []
  const values = keys.map((key, index) => ({ key, index }))
  const input = {}
  for (const [index, key] of keys.entries()) {
    Object.defineProperty(input, key, {
      get() {
        reads.push(key)
        return values[index]
      },
    })
  }
  Object.defineProperty(input, 'unused', {
    get() {
      throw new Error('Unselected input getter must not run')
    },
  })

  const snapshot = invokeProjection(project, input)
  expect(reads).toEqual([...keys])
  expect(Object.keys(snapshot)).toEqual([...keys])
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(input)).toBe(false)
  for (const [index, key] of keys.entries()) {
    expect(Reflect.get(snapshot, key)).toBe(values[index])
    expect(Object.getOwnPropertyDescriptor(snapshot, key)).toEqual({
      value: values[index],
      writable: false,
      enumerable: true,
      configurable: false,
    })
    expect(Object.isFrozen(values[index])).toBe(false)
    expect(Reflect.set(snapshot, key, null)).toBe(false)
  }
  reads.length = 0
  const next = invokeProjection(project, input)
  expect(next).not.toBe(snapshot)
  expect(reads).toEqual([...keys])
  for (const [index, key] of keys.entries()) expect(Reflect.get(next, key)).toBe(values[index])

  for (const [failedIndex, failedKey] of keys.entries()) {
    const failure = new Error(`getter ${failedKey}`)
    const observed: string[] = []
    const failingInput = {}
    for (const [index, key] of keys.entries()) {
      Object.defineProperty(failingInput, key, {
        get() {
          observed.push(key)
          if (index === failedIndex) throw failure
          return values[index]
        },
      })
    }
    let caught: unknown
    try {
      invokeProjection(project, failingInput)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(observed).toEqual(keys.slice(0, failedIndex + 1))
  }
}

test('workflow snapshot retains all original fields, getter order and shallow freezing', () => {
  assertProjection(workflowSnapshot, ['id', 'name', 'version', 'definition'])
})

test('agent snapshot retains all original fields, getter order and shallow freezing', () => {
  assertProjection(agentSnapshot, [
    'id',
    'name',
    'description',
    'outputs',
    'outputKinds',
    'branchPorts',
    'inputs',
    'outputWrapperPortNames',
    'role',
    'syncOutputsOnIterate',
    'runtime',
    'permission',
    'skills',
    'dependsOn',
    'mcp',
    'plugins',
    'frontmatterExtra',
    'bodyMd',
    'schemaVersion',
    'createdAt',
    'updatedAt',
  ])
})

test('workgroup snapshot retains all original fields, getter order and shallow freezing', () => {
  assertProjection(workgroupSnapshot, [
    'id',
    'name',
    'description',
    'instructions',
    'mode',
    'outputContract',
    'leaderMemberId',
    'switches',
    'maxRounds',
    'completionGate',
    'clarifyBudget',
    'fanOut',
    'members',
    'version',
  ])
})
