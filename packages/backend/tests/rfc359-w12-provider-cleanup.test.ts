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

type DropObservation = NonNullable<Parameters<typeof closePostgresqlHarnessDatabases>[2]>
type ObservationEvent = Parameters<DropObservation['report']>[0]

function controlledObservation(actions: string[]) {
  const sample = Promise.withResolvers<unknown>()
  const closed = Promise.withResolvers<void>()
  const events: ObservationEvent[] = []
  let onSlow: (() => void) | undefined
  const observation: DropObservation = {
    schedule(callback) {
      actions.push('observation:scheduled')
      onSlow = callback
      return () => actions.push('observation:timer-cleared')
    },
    start(input) {
      actions.push(`observation:start:${input.databaseName}`)
      return {
        result: sample.promise,
        async close() {
          actions.push('observation:close')
          await closed.promise
        },
      }
    },
    report(event) {
      events.push(event)
    },
  }
  return {
    observation,
    sample,
    closed,
    events,
    fire() {
      if (onSlow === undefined) throw new Error('slow DROP observation should be scheduled')
      onSlow()
    },
  }
}

describe('RFC-359 slow DROP observation preserves the real cleanup result', () => {
  test('fast DROP clears its timer without constructing an observation connection', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    await closePostgresqlHarnessDatabases(
      [resource('primary', actions)],
      ['created-only'],
      control.observation,
    )
    control.fire() // An already queued timer callback cannot revive a completed observation.
    expect(actions).toEqual([
      'observation:scheduled',
      DROP,
      'observation:timer-cleared',
      'close:primary',
    ])
    expect(control.events).toEqual([])
  })

  test('slow DROP reports the exact statement snapshot and closes only the observer', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    const drop = Promise.withResolvers<unknown>()
    const primary: CleanupDatabase = {
      runtime: resource('primary', actions).runtime,
      async raw(statement) {
        actions.push(`primary:${statement}`)
        return await drop.promise
      },
    }
    const cleanup = closePostgresqlHarnessDatabases(
      [primary],
      ['created-only'],
      control.observation,
    )
    control.fire()
    const snapshot = [{ pid: 42, wait_event: 'CheckpointStart', statement: 'drop' }]
    control.sample.resolve(snapshot)
    await control.sample.promise
    expect(control.events.map((event) => event.phase)).toEqual(['started', 'snapshot'])
    expect(control.events[1]?.snapshot).toBe(snapshot)
    expect(control.events[1]?.statement).toBe('drop database if exists "created-only"')
    expect(actions.filter((action) => action === DROP)).toHaveLength(1)
    expect(actions).not.toContain('close:primary')
    expect(actions.at(-1)).toBe('observation:close')
    drop.resolve(undefined)
    await cleanup // The observer close is still pending; it cannot extend the DROP budget.
    expect(actions.at(-1)).toBe('close:primary')
    expect(actions.filter((action) => action === 'observation:close')).toHaveLength(1)
    control.closed.resolve()
  })

  test('DROP failure stops an in-flight observation without awaiting or replacing its errors', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    const drop = Promise.withResolvers<unknown>()
    const nativeError = new Error('Idle timeout reached after 30s')
    const primary: CleanupDatabase = {
      runtime: resource('primary', actions).runtime,
      raw: async () => await drop.promise,
    }
    const cleanup = closePostgresqlHarnessDatabases(
      [primary],
      ['created-only'],
      control.observation,
    )
    control.fire()
    drop.reject(nativeError)
    const caught = await cleanup.catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error('the original DROP failure must survive')
    expect(caught.message).toBe('PostgreSQL harness cleanup: drop additional database created-only')
    expect(caught.cause).toBe(nativeError)
    expect(actions.slice(-3)).toEqual([
      'observation:timer-cleared',
      'observation:close',
      'close:primary',
    ])
    control.sample.reject(new Error('observation cancelled'))
    control.closed.reject(new Error('observation close failed'))
    await Promise.allSettled([control.sample.promise, control.closed.promise])
    expect(control.events.map((event) => event.phase)).toEqual(['started'])
  })

  test('observer construction and reporting failures cannot replace successful DROP', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    const drop = Promise.withResolvers<unknown>()
    const cleanup = closePostgresqlHarnessDatabases(
      [{ runtime: resource('primary', actions).runtime, raw: async () => await drop.promise }],
      ['created-only'],
      {
        ...control.observation,
        start() {
          actions.push('observation:start-failed')
          throw new Error('diagnostic connection unavailable')
        },
        report() {
          throw new Error('diagnostic sink unavailable')
        },
      },
    )
    control.fire()
    drop.resolve(undefined)
    await cleanup
    expect(actions).toEqual([
      'observation:scheduled',
      'observation:start-failed',
      'observation:timer-cleared',
      'close:primary',
    ])
  })
})

describe('RFC-359 cleanup diagnostics retain owner and failure boundaries', () => {
  test('an observation query failure is reported while the original DROP remains pending', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    const drop = Promise.withResolvers<unknown>()
    const observerError = new Error('read-only diagnostic query failed')
    const cleanup = closePostgresqlHarnessDatabases(
      [{ runtime: resource('primary', actions).runtime, raw: async () => await drop.promise }],
      ['created-only'],
      control.observation,
    )
    control.fire()
    control.sample.reject(observerError)
    await control.sample.promise.catch(() => {})
    expect(control.events.map((event) => event.phase)).toEqual(['started', 'failed'])
    expect(control.events[1]?.error).toBe(observerError)
    expect(actions.at(-1)).toBe('observation:close')
    expect(actions).not.toContain('close:primary')
    control.closed.resolve()
    drop.resolve(undefined)
    await cleanup
    expect(actions.at(-1)).toBe('close:primary')
  })

  test('the actual DROP keeps its raw query receiver and succeeds if the timer fails', async () => {
    const actions: string[] = []
    const control = controlledObservation(actions)
    const primary: CleanupDatabase = {
      runtime: resource('primary', actions).runtime,
      async raw(statement) {
        expect(this).toBe(primary)
        actions.push(statement)
      },
    }
    const timerError = new Error('diagnostic timer unavailable')
    await closePostgresqlHarnessDatabases([primary], ['created-only'], {
      ...control.observation,
      schedule() {
        throw timerError
      },
    })
    expect(actions).toEqual(['drop database if exists "created-only"', 'close:primary'])
    expect(control.events.map((event) => event.phase)).toEqual(['failed'])
    expect(control.events[0]?.error).toBe(timerError)
  })
})
