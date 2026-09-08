// The actual harness cleanup sequence, with closed resource callbacks only.
// This diagnoses lifecycle failures; it does not stand in for PostgreSQL execution.
import { describe, expect, test } from 'bun:test'

import { closePostgresqlHarnessDatabases } from './helpers/eachProvider'

type CleanupDatabase = Parameters<typeof closePostgresqlHarnessDatabases>[0][number]

function resource(
  name: string,
  actions: string[],
  failures: ReadonlyMap<string, Error> = new Map(),
): CleanupDatabase {
  async function action(value: string): Promise<void> {
    actions.push(value)
    const error = failures.get(value)
    if (error !== undefined) throw error
  }
  return {
    runtime: { close: async () => await action(`close:${name}`) },
    raw: async (statement) => await action(`${name}:${statement}`),
  }
}

const DROP = 'primary:drop database if exists "created-only"'
const ORDER = ['close:additional', DROP, 'close:primary']

describe('RFC-359 PostgreSQL harness cleanup lifecycle', () => {
  test.each([
    {
      failingAction: 'close:additional',
      message: 'PostgreSQL harness cleanup: close additional runtime at index 1',
    },
    {
      failingAction: DROP,
      message: 'PostgreSQL harness cleanup: drop additional database created-only',
    },
    {
      failingAction: 'close:primary',
      message: 'PostgreSQL harness cleanup: close primary runtime',
    },
  ])('$failingAction retains its cause and completes every cleanup phase', async (input) => {
    const actions: string[] = []
    const nativeError = new Error('Idle timeout reached after 30s')
    const failures = new Map([[input.failingAction, nativeError]])
    let caught: unknown
    try {
      await closePostgresqlHarnessDatabases(
        [resource('primary', actions, failures), resource('additional', actions, failures)],
        ['created-only'],
      )
    } catch (error) {
      caught = error
    }
    expect(actions).toEqual(ORDER)
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error('cleanup should retain the failed phase')
    expect(caught.message).toBe(input.message)
    expect(caught.cause).toBe(nativeError)
  })

  test('multiple failures retain phase order and each original cause', async () => {
    const actions: string[] = []
    const nativeErrors = ORDER.map((action) => new Error(action))
    const failures = new Map(ORDER.map((action, index) => [action, nativeErrors[index]!]))
    let caught: unknown
    try {
      await closePostgresqlHarnessDatabases(
        [resource('primary', actions, failures), resource('additional', actions, failures)],
        ['created-only'],
      )
    } catch (error) {
      caught = error
    }
    expect(actions).toEqual(ORDER)
    expect(caught).toBeInstanceOf(AggregateError)
    if (!(caught instanceof AggregateError)) throw new Error('all failed phases should be retained')
    expect(caught.message).toBe('PostgreSQL harness cleanup failed')
    expect(caught.errors.map((error: Error) => error.cause)).toEqual(nativeErrors)
  })

  test('awaits additional closes in reverse order before dropping only created databases', async () => {
    const actions: string[] = []
    let release = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const last: CleanupDatabase = {
      runtime: {
        async close() {
          actions.push('close:last:start')
          await barrier
          actions.push('close:last:done')
        },
      },
      raw: async () => {
        throw new Error('cleanup must issue DROP only through the primary database')
      },
    }
    const cleanup = closePostgresqlHarnessDatabases(
      [resource('primary', actions), resource('additional', actions), last],
      ['created-first', 'created-last'],
    )
    try {
      expect(actions).toEqual(['close:last:start'])
    } finally {
      release()
      await cleanup
    }
    expect(actions).toEqual([
      'close:last:start',
      'close:last:done',
      'close:additional',
      'primary:drop database if exists "created-last"',
      'primary:drop database if exists "created-first"',
      'close:primary',
    ])
  })

  test('single-database cleanup only closes its runtime', async () => {
    const actions: string[] = []
    await closePostgresqlHarnessDatabases([resource('primary', actions)], [])
    expect(actions).toEqual(['close:primary'])
  })
})
